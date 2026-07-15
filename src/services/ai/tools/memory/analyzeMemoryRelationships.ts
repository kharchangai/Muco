import { z } from "zod";

import { MEMORY_RELATIONSHIP_ANALYSIS_PROMPT } from "./prompts";
import { getAsyncLLM } from "../memory_tools";

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
    z.enum(["content", "context", "key", "tags", "links"]),
  ),
  suggestedAction: z.enum([
    "KEEP_SEPARATE",
    "LINK",
    "MERGE",
    "REVIEW_CONFLICT",
  ]),
});

export type MemoryRelationship = z.infer<typeof relationshipSchema>;

export type MemoryRelationshipAnalysis = {
  targetFileName: string;
  targetMemoryId: string;
  similarity: number;
  analysis: MemoryRelationship;
};

/**
 * Analyzes how a new memory affects every similar stored memory.
 *
 * One independent LLM request is sent for each similar memory.
 * This function only analyzes relationships and does not modify files.
 */
export async function analyzeMemoryRelationships(
  newMemory: MemoryNode,
  similarMemories: SimilarMemoryResult[],
): Promise<MemoryRelationshipAnalysis[]> {
  if (similarMemories.length === 0) {
    return [];
  }

  const analyses = await Promise.all(
    similarMemories.map((similarMemory) =>
      analyzeSingleMemoryRelationship(newMemory, similarMemory),
    ),
  );

  return analyses;
}

async function analyzeSingleMemoryRelationship(
  newMemory: MemoryNode,
  similarMemory: SimilarMemoryResult,
): Promise<MemoryRelationshipAnalysis> {
  const llm = await getAsyncLLM();

  const prompt = MEMORY_RELATIONSHIP_ANALYSIS_PROMPT
    .replace("{newMemory}", JSON.stringify(toComparableMemory(newMemory), null, 2))
    .replace(
      "{targetMemory}",
      JSON.stringify(toComparableMemory(similarMemory.memory), null, 2),
    );

  const structuredLlm = llm.withStructuredOutput(relationshipSchema);

  const analysis = await structuredLlm.invoke(prompt);

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