import { z } from "zod";
import {
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";

import { getAsyncLLM } from "../../llm";
import { ATOMIC_MEMORY_EXTRACTION_PROMPT } from "./prompts";

export const AtomicMemorySchema = z.object({
  content: z.string().trim().min(1),
});

export const AtomicMemoryExtractionSchema = z.object({
  memories: z.array(AtomicMemorySchema),
});

export type AtomicMemory = z.infer<
  typeof AtomicMemorySchema
>;

/**
 * Raw JSON Schema for the provider.
 *
 * Do not add `description`, `title`, `default`, or `$ref` here.
 * Some OpenAI-compatible providers reject schemas where `$ref`
 * is combined with additional JSON Schema keywords.
 */
const AtomicMemoryExtractionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    memories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: {
            type: "string",
          },
        },
        required: ["content"],
      },
    },
  },
  required: ["memories"],
} as const;

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

const isAbortError = (
  error: unknown,
): boolean => {
  return (
    error instanceof DOMException &&
    error.name === "AbortError"
  ) || (
    error instanceof Error &&
    error.name === "AbortError"
  );
};

/**
 * Extracts independent atomic memory candidates from a raw user message.
 *
 * Cancellation behavior:
 * - Throws AbortError when the signal is aborted.
 * - Passes the signal to the structured LLM invocation.
 * - Does not convert cancellation into an empty array, because the caller
 *   must stop the complete memory pipeline immediately.
 *
 * This function only extracts standalone memory statements.
 * It does not create IDs, keys, tags, contexts, embeddings, links,
 * timestamps, files, or database records.
 */
export async function extractAtomicMemories(
  userText: string,
  signal?: AbortSignal,
): Promise<AtomicMemory[]> {
  throwIfAborted(signal);

  const text = userText?.trim();

  if (!text) {
    return [];
  }

  try {
    const model = await getAsyncLLM("medium");

    throwIfAborted(signal);

    const structuredModel = model.withStructuredOutput(
      AtomicMemoryExtractionJsonSchema,
      {
        name: "atomic_memory_extraction",
      },
    );

    const result = await structuredModel.invoke(
      [
        new SystemMessage(
          ATOMIC_MEMORY_EXTRACTION_PROMPT,
        ),
        new HumanMessage(text),
      ],
      {
        signal,
      },
    );

    throwIfAborted(signal);

    const validatedResult =
      AtomicMemoryExtractionSchema.safeParse(result);

    if (!validatedResult.success) {
      console.error(
        "[Atomic memory extraction] Invalid structured response:",
        validatedResult.error,
      );

      return [];
    }

    return validatedResult.data.memories;
  } catch (error) {
    /*
     * Cancellation must be propagated to processUserMessage.
     * Returning [] here would make the upper layer think extraction
     * completed normally and may allow later work to continue.
     */
    if (isAbortError(error)) {
      throw error;
    }

    console.error(
      "[Atomic memory extraction] Failed:",
      error,
    );

    return [];
  }
}