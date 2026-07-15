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
import { getAsyncLLM } from "../memory_tools";
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

/**
 * Processes one raw user message for long-term memory.
 *
 * Pipeline:
 * 1. Evaluate whether the raw message is worth processing as long-term memory.
 * 2. Stop immediately when the memory gate rejects the message.
 * 3. Ensure AppData/memory exists.
 * 4. Extract atomic memory candidates from the raw user message.
 * 5. Create one complete memory for every extracted atomic memory.
 * 6. Return the gate decision, created memories, and per-memory failures.
 *
 * createMemory is responsible for:
 * - Enrichment
 * - Similarity search
 * - Relationship analysis
 * - Link creation
 * - Neighbor evolution
 * - Duplicate handling
 * - Saving memory/{id}.json
 */
export async function processUserMessage(
  userText: string,
): Promise<ProcessUserMessageResult> {
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
    gate = await evaluateMemoryGate(text);
  } catch (error) {
    console.error(
      "[Memory processing] Failed to evaluate memory gate:",
      error,
    );

    /*
     * Fail closed:
     * If the gate cannot make a decision, do not run the expensive memory
     * pipeline accidentally. The next user message can be processed normally.
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
    await ensureMemoryDirectoryExists();
  } catch (error) {
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
    atomicMemories = await extractAtomicMemories(text);
  } catch (error) {
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
   * Processing is intentionally sequential.
   *
   * A memory created earlier in the same user message can be found and linked
   * when createMemory processes the next atomic memory.
   *
   * Do not use Promise.all here because concurrent createMemory calls may
   * read, update, redirect, or remove the same memory files at the same time.
   */
  for (const atomicMemory of atomicMemories) {
    try {
      const createdMemory = await createMemory(atomicMemory.content);

      createdMemories.push(createdMemory);
    } catch (error) {
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

  return {
    userText: text,
    gate,
    atomicMemories,
    createdMemories,
    failures,
  };
}

/**
 * Uses the language model to decide whether a raw user message is worth
 * sending to the long-term memory pipeline.
 */
async function evaluateMemoryGate(
  userText: string,
): Promise<MemoryGateResult> {
  const model = await getAsyncLLM();

  const structuredModel = model.withStructuredOutput(
    memoryGateSchema,
  );

  return structuredModel.invoke([
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
  ]);
}

/**
 * Ensures that AppData/memory exists before memory extraction and creation.
 */
async function ensureMemoryDirectoryExists(): Promise<void> {
  const memoryDirectoryExists = await exists(MEMORY_DIRECTORY, {
    baseDir: BaseDirectory.AppData,
  });

  if (memoryDirectoryExists) {
    return;
  }

  await mkdir(MEMORY_DIRECTORY, {
    baseDir: BaseDirectory.AppData,
    recursive: true,
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}