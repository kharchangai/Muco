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
 *
 * Cancellation behavior:
 * - If the signal is already aborted, throws AbortError immediately.
 * - Stops before every next pipeline stage.
 * - Passes the signal to LLM-based extraction and memory creation.
 * - Does not convert AbortError to a normal memory failure.
 *
 * Pipeline:
 * 1. Evaluate the memory gate.
 * 2. Ensure AppData/memory exists.
 * 3. Extract atomic memory candidates.
 * 4. Create memories sequentially.
 */
export async function processUserMessage(
  userText: string,
  signal?: AbortSignal,
): Promise<ProcessUserMessageResult> {
  throwIfAborted(signal);

  const text = userText?.trim();

  const emptyResult: ProcessUserMessageResult = {
    userText: text ?? "",
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

    gate = await evaluateMemoryGate(
      text,
      signal,
    );

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
     * If the gate cannot make a decision, do not accidentally run
     * the expensive memory pipeline.
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

    await ensureMemoryDirectoryExists(
      signal,
    );

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

    /*
     * extractAtomicMemories must accept:
     * (userText: string, signal?: AbortSignal)
     */
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
   * Keep this sequential.
   *
   * createMemory may search, evolve, redirect, update, or save files that
   * are relevant to the next atomic memory in the same user message.
   */
  for (const atomicMemory of atomicMemories) {
    throwIfAborted(signal);

    try {
      /*
       * createMemory must accept:
       * (content: string, signal?: AbortSignal)
       */
      const createdMemory = await createMemory(
        atomicMemory.content,
        signal,
      );

      throwIfAborted(signal);

      createdMemories.push(createdMemory);
    } catch (error) {
      /*
       * Cancellation must immediately stop the entire pipeline.
       * It is not a per-memory failure.
       */
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
 * Uses the cheap model to decide whether a raw user message is worth
 * sending to the long-term memory pipeline.
 */
async function evaluateMemoryGate(
  userText: string,
  signal?: AbortSignal,
): Promise<MemoryGateResult> {
  throwIfAborted(signal);

  const model = await getAsyncLLM("medium");

  throwIfAborted(signal);

  const structuredModel = model.withStructuredOutput(
    memoryGateSchema,
  );

  const result = await structuredModel.invoke(
    [
      {
        role: "system",
        content: MEMORY_GATE_PROMPT,
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            userText,
          },
          null,
          2,
        ),
      },
    ],
    {
      signal,
    },
  );

  throwIfAborted(signal);

  return result;
}

/**
 * Ensures AppData/memory exists.
 *
 * Tauri file operations cannot always be interrupted once started,
 * but checks before and after prevent the next pipeline stage from running.
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