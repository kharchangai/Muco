import { z } from "zod";

import { getAsyncLLM } from "../../llm";
import { MEMORY_RELATIONSHIP_ANALYSIS_PROMPT } from "./prompts";

import type { MemoryNode } from "./enrichMemory";
import type { SimilarMemoryResult } from "./findSimilarMemories";

const relationshipSchema = z.object({
  relationship: z.enum([
    "COMPLEMENTS",
    "CONTRADICTS",
    "RELATED",
    "DUPLICATE",
    "UNRELATED",
  ]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  affectedFields: z.array(
    z.enum([
      "content",
      "context",
      "key",
      "tags",
      "links",
    ]),
  ),
  suggestedAction: z.enum([
    "KEEP_SEPARATE",
    "LINK",
    "MERGE",
    "REVIEW_CONFLICT",
  ]),
});

export type MemoryRelationship = z.infer<
  typeof relationshipSchema
>;

export type MemoryRelationshipAnalysis = {
  targetFileName: string;
  targetMemoryId: string;
  similarity: number;
  analysis: MemoryRelationship;
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

/**
 * Analyzes how a new memory affects every similar stored memory.
 *
 * One independent LLM request is sent for each similar memory.
 * This function only analyzes relationships and does not modify files.
 *
 * If the signal is aborted, AbortError is thrown and must be allowed
 * to propagate to the caller. Do not convert it into an empty array.
 */
export async function analyzeMemoryRelationships(
  newMemory: MemoryNode,
  similarMemories: SimilarMemoryResult[],
  signal?: AbortSignal,
): Promise<MemoryRelationshipAnalysis[]> {
  throwIfAborted(signal);

  if (similarMemories.length === 0) {
    return [];
  }

  /*
   * Promise.all starts all relationship analyses concurrently.
   * Every individual invoke receives the same AbortSignal. Therefore,
   * calling controller.abort() cancels all provider requests that support
   * abort signals.
   */
  const analyses = await Promise.all(
    similarMemories.map((similarMemory) =>
      analyzeSingleMemoryRelationship(
        newMemory,
        similarMemory,
        signal,
      ),
    ),
  );

  throwIfAborted(signal);

  return analyses;
}

async function analyzeSingleMemoryRelationship(
  newMemory: MemoryNode,
  similarMemory: SimilarMemoryResult,
  signal?: AbortSignal,
): Promise<MemoryRelationshipAnalysis> {
  throwIfAborted(signal);

  const llm = await getAsyncLLM("cheap");

  throwIfAborted(signal);

  const prompt = MEMORY_RELATIONSHIP_ANALYSIS_PROMPT
    .replace(
      "{newMemory}",
      JSON.stringify(
        toComparableMemory(newMemory),
        null,
        2,
      ),
    )
    .replace(
      "{targetMemory}",
      JSON.stringify(
        toComparableMemory(similarMemory.memory),
        null,
        2,
      ),
    );

  throwIfAborted(signal);

  const structuredLlm = llm.withStructuredOutput(
    relationshipSchema,
  );

  /*
   * LangChain passes the signal to the model/provider invocation.
   * OpenAI-compatible providers that support AbortSignal will terminate the
   * underlying HTTP request after controller.abort().
   */
  const analysis = await structuredLlm.invoke(
    prompt,
    {
      signal,
    },
  );

  throwIfAborted(signal);

  return {
    targetFileName: similarMemory.fileName,
    targetMemoryId: similarMemory.memory.id,
    similarity: similarMemory.similarity,
    analysis,
  };
}

/**
 * Embeddings are intentionally excluded because they are large numeric vectors
 * and do not help the language model reason about memory relationships.
 */
function toComparableMemory(memory: MemoryNode) {
  return {
    id: memory.id,
    content: memory.content,
    context: memory.context,
    key: memory.key,
    tags: memory.tags,
    links: memory.links,
    time: memory.time,
  };
}