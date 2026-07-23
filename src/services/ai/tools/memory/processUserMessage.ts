import {
  BaseDirectory,
  exists,
  mkdir,
} from "@tauri-apps/plugin-fs";
import { z } from "zod";

import {
  extractAtomicMemories,
  type AtomicMemory,
} from "./atomicMemoryExtractor";
import {
  createMemory,
  type CreatedMemoryResult,
} from "./createMemory";
import { getAsyncLLM } from "../../llm";
import { MEMORY_GATE_PROMPT } from "./prompts";

const MEMORY_DIRECTORY = "memory";

const memoryGateSchema = z.object({
  shouldUseMemory: z.boolean(),
  reason: z.string().min(1),
});

export type MemoryGateResult = z.infer<typeof memoryGateSchema>;

export type MemoryCreationFailure = {
  atomicMemory: string;
  error: string;
};

export type ProcessUserMessageResult = {
  userText: string;
  gate: MemoryGateResult | null;
  atomicMemories: AtomicMemory[];
  createdMemories: CreatedMemoryResult[];
  failures: MemoryCreationFailure[];
};

type LlmContent =
  | string
  | Array<
      | string
      | {
          type?: string;
          text?: string;
          content?: string;
        }
    >
  | null
  | undefined;

const createAbortError = (): DOMException => {
  return new DOMException(
    "The operation was cancelled.",
    "AbortError",
  );
};

const throwIfAborted = (
  signal?: AbortSignal,
): void => {
  if (signal?.aborted) {
    throw createAbortError();
  }
};

export const isAbortError = (
  error: unknown,
): boolean => {
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }

  if (error instanceof Error) {
    return error.name === "AbortError";
  }

  return false;
};

/**
 * Processes one raw user message for long-term memory.
 */
export async function processUserMessage(
  userText: string,
  signal?: AbortSignal,
): Promise<ProcessUserMessageResult> {
  throwIfAborted(signal);

  const text = typeof userText === "string"
    ? userText.trim()
    : "";

  const emptyResult: ProcessUserMessageResult = {
    userText: text,
    gate: null,
    atomicMemories: [],
    createdMemories: [],
    failures: [],
  };

  if (!text) {
    return emptyResult;
  }

  let gate: MemoryGateResult;

  try {
    throwIfAborted(signal);

    gate = await evaluateMemoryGate(text, signal);

    throwIfAborted(signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    console.error(
      "[Memory processing] Failed to evaluate memory gate:",
      error,
    );

    /*
     * Fail closed:
     * If the decision cannot be parsed, do not run the long-term
     * memory extraction and creation pipeline.
     */
    return {
      ...emptyResult,
      failures: [
        {
          atomicMemory: text,
          error: `Memory gate evaluation failed: ${getErrorMessage(error)}`,
        },
      ],
    };
  }

  if (!gate.shouldUseMemory) {
    console.log(
      `[Memory gate] Skipped message. Reason: ${gate.reason}`,
    );

    return {
      ...emptyResult,
      gate,
    };
  }

  try {
    throwIfAborted(signal);

    await ensureMemoryDirectoryExists(signal);

    throwIfAborted(signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    console.error(
      "[Memory processing] Failed to ensure memory directory:",
      error,
    );

    return {
      ...emptyResult,
      gate,
      failures: [
        {
          atomicMemory: text,
          error: getErrorMessage(error),
        },
      ],
    };
  }

  let atomicMemories: AtomicMemory[];

  try {
    throwIfAborted(signal);

    atomicMemories = await extractAtomicMemories(
      text,
      signal,
    );

    throwIfAborted(signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    console.error(
      "[Memory processing] Failed to extract atomic memories:",
      error,
    );

    return {
      ...emptyResult,
      gate,
      failures: [
        {
          atomicMemory: text,
          error: `Atomic memory extraction failed: ${getErrorMessage(error)}`,
        },
      ],
    };
  }

  if (atomicMemories.length === 0) {
    return {
      ...emptyResult,
      gate,
      atomicMemories,
    };
  }

  const createdMemories: CreatedMemoryResult[] = [];
  const failures: MemoryCreationFailure[] = [];

  /*
   * This must stay sequential because each created memory can affect
   * duplicate detection, linking, and updates for the next memory.
   */
  for (const atomicMemory of atomicMemories) {
    throwIfAborted(signal);

    try {
      const createdMemory = await createMemory(
        atomicMemory.content,
        signal,
      );

      throwIfAborted(signal);

      createdMemories.push(createdMemory);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      console.error(
        "[Memory processing] Failed to create memory:",
        atomicMemory.content,
        error,
      );

      failures.push({
        atomicMemory: atomicMemory.content,
        error: getErrorMessage(error),
      });
    }
  }

  throwIfAborted(signal);

  return {
    userText: text,
    gate,
    atomicMemories,
    createdMemories,
    failures,
  };
}

/**
 * Uses a normal LLM invoke call instead of withStructuredOutput().
 *
 * This avoids provider-specific structured-output failures, including
 * "Text: undefined" from OpenAI-compatible providers.
 */
async function evaluateMemoryGate(
  userText: string,
  signal?: AbortSignal,
): Promise<MemoryGateResult> {
  throwIfAborted(signal);

  const model = await getAsyncLLM("medium");

  throwIfAborted(signal);

  const response = await model.invoke(
    [
      {
        role: "system",
        content: buildMemoryGatePrompt(),
      },
      {
        role: "user",
        content: JSON.stringify({ userText }),
      },
    ],
    {
      signal,
    },
  );

  throwIfAborted(signal);

  return parseMemoryGateResponse(response.content);
}

function buildMemoryGatePrompt(): string {
  return `${MEMORY_GATE_PROMPT}

Return exactly one valid JSON object and nothing else.

Do not use Markdown.
Do not wrap the JSON in a code block.
Do not write explanations before or after the JSON.

The required JSON format is:

{
  "shouldUseMemory": boolean,
  "reason": string
}

Rules:
- "shouldUseMemory" must be true only if the user message contains
  durable, useful information that should be stored in long-term memory.
- "reason" must be a short non-empty string.
`;
}

function parseMemoryGateResponse(
  content: LlmContent,
): MemoryGateResult {
  const responseText = getTextFromLlmContent(content);

  if (!responseText) {
    throw new Error(
      "Memory gate model returned an empty response.",
    );
  }

  const jsonText = extractFirstJsonObject(responseText);

  if (!jsonText) {
    throw new Error(
      `Memory gate response did not contain a JSON object. Response: ${responseText}`,
    );
  }

  let parsedValue: unknown;

  try {
    parsedValue = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(
      `Memory gate returned invalid JSON: ${getErrorMessage(error)}`,
    );
  }

  return memoryGateSchema.parse(parsedValue);
}

function getTextFromLlmContent(
  content: LlmContent,
): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (!part || typeof part !== "object") {
        return "";
      }

      if (typeof part.text === "string") {
        return part.text;
      }

      if (typeof part.content === "string") {
        return part.content;
      }

      return "";
    })
    .join("")
    .trim();
}

/**
 * Extracts the first complete JSON object while respecting quoted strings,
 * escaped quotes, and braces inside JSON string values.
 */
function extractFirstJsonObject(
  responseText: string,
): string | null {
  const text = responseText
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();

  const startIndex = text.indexOf("{");

  if (startIndex === -1) {
    return null;
  }

  let depth = 0;
  let isInsideString = false;
  let isEscaped = false;

  for (
    let index = startIndex;
    index < text.length;
    index += 1
  ) {
    const character = text[index];

    if (isInsideString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (character === "\\") {
        isEscaped = true;
        continue;
      }

      if (character === '"') {
        isInsideString = false;
      }

      continue;
    }

    if (character === '"') {
      isInsideString = true;
      continue;
    }

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character === "}") {
      depth -= 1;

      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

/**
 * Ensures AppData/memory exists.
 */
async function ensureMemoryDirectoryExists(
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);

  const memoryDirectoryExists = await exists(
    MEMORY_DIRECTORY,
    {
      baseDir: BaseDirectory.AppData,
    },
  );

  throwIfAborted(signal);

  if (memoryDirectoryExists) {
    return;
  }

  await mkdir(MEMORY_DIRECTORY, {
    baseDir: BaseDirectory.AppData,
    recursive: true,
  });

  throwIfAborted(signal);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}