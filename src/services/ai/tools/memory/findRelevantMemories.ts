import {
  BaseDirectory,
  exists,
  readDir,
  readTextFile,
} from "@tauri-apps/plugin-fs";
import { z } from "zod";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import {
  extractAtomicMemories,
  type AtomicMemory,
} from "./atomicMemoryExtractor";
import { textSimilarity } from "../textSimilarity";
import { getAsyncLLM } from "../../llm";
import { MEMORY_RETRIEVAL_RERANK_PROMPT } from "./prompts";

const MEMORY_DIRECTORY = "memory";
const TAGS_FILE_NAME = "tags.json";

const SIMILARITY_THRESHOLD = 0.5;
const TOP_CANDIDATES_PER_ATOMIC_MEMORY = 10;
const MAX_CANDIDATES_FOR_RERANKING = 25;
const MAX_NEIGHBORS_PER_MEMORY = 3;

export type MemoryRelationship =
  | "COMPLEMENTS"
  | "CONTRADICTS"
  | "RELATED"
  | "DUPLICATE";

export const MemoryLinkSchema = z.object({
  targetId: z.string().trim().min(1),
  targetFileName: z.string().trim().min(1),
  relationship: z.enum([
    "COMPLEMENTS",
    "CONTRADICTS",
    "RELATED",
    "DUPLICATE",
  ]),
  similarity: z.number(),
  confidence: z.number(),
  reason: z.string(),
  createdAt: z.string(),
});

export type MemoryLink = z.infer<typeof MemoryLinkSchema>;

/**
 * This schema represents memory JSON files saved by createMemory().
 *
 * Unknown fields are allowed because MemoryNode may contain additional
 * fields such as createdAt, updatedAt, type, or other future fields.
 */
export const StoredMemorySchema = z.looseObject({
  id: z.string().trim().min(1),
  content: z.string().trim().min(1),
  context: z.string().catch(""),
  key: z.array(z.string()).catch([]),
  tags: z.array(z.string()).catch([]),
  embedding: z.array(z.number()).min(1),
  links: z.array(MemoryLinkSchema).catch([]),
});

export type StoredMemory = z.infer<typeof StoredMemorySchema>;

export type LoadedMemory = {
  fileName: string;
  filePath: string;
  memory: StoredMemory;
};

export type MemorySearchCandidate = {
  memoryId: string;
  fileName: string;
  filePath: string;
  score: number;
  matchedAtomicContents: string[];
  memory: StoredMemory;
};

const MemoryRerankItemSchema = z.object({
  memoryId: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  includeNeighbors: z.boolean(),
});

const MemoryRerankResultSchema = z.object({
  selectedMemories: z.array(MemoryRerankItemSchema),
});

export type MemoryRerankItem = z.infer<typeof MemoryRerankItemSchema>;

export type FindRelevantMemoriesResult = {
  userText: string;
  atomicMemories: AtomicMemory[];
  candidates: MemorySearchCandidate[];
  selectedMemories: StoredMemory[];
  neighborMemories: StoredMemory[];
  context: string;
};

/**
 * Raw JSON Schema for withStructuredOutput.
 *
 * Keep this schema simple because some OpenAI-compatible providers
 * reject unsupported JSON Schema keywords.
 */
const MemoryRerankJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    selectedMemories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          memoryId: {
            type: "string",
          },
          reason: {
            type: "string",
          },
          includeNeighbors: {
            type: "boolean",
          },
        },
        required: ["memoryId", "reason", "includeNeighbors"],
      },
    },
  },
  required: ["selectedMemories"],
} as const;

/**
 * Finds relevant long-term memories for one user message.
 *
 * Pipeline:
 * 1. Extract atomic statements from the user message.
 * 2. Read every memory/*.json file in AppData except tags.json.
 * 3. Create an embedding for every extracted atomic statement.
 * 4. Compare it with stored memory embeddings.
 * 5. Keep top 10 matches above similarity 0.5 for each atomic statement.
 * 6. Merge duplicate candidates.
 * 7. Ask the LLM to remove semantic false positives.
 * 8. Load direct linked neighbors only if the LLM requests them.
 * 9. Build final context for the main agent.
 */
export async function findRelevantMemories(
  userText: string,
): Promise<FindRelevantMemoriesResult> {
  const text = userText?.trim();

  if (!text) {
    return createEmptyResult("");
  }

  try {
    const atomicMemories = await extractAtomicMemories(text);

    if (atomicMemories.length === 0) {
      return {
        ...createEmptyResult(text),
        atomicMemories,
      };
    }

    const loadedMemories = await loadAllMemories();

    if (loadedMemories.length === 0) {
      return {
        ...createEmptyResult(text),
        atomicMemories,
      };
    }

    const candidates = await findSemanticCandidates(
      atomicMemories,
      loadedMemories,
    );

    if (candidates.length === 0) {
      return {
        ...createEmptyResult(text),
        atomicMemories,
      };
    }

    const candidatesForReranking = candidates.slice(
      0,
      MAX_CANDIDATES_FOR_RERANKING,
    );

    const rerankedMemories = await rerankMemoryCandidates(
      text,
      atomicMemories,
      candidatesForReranking,
    );

    const selectedMemories = getSelectedMemories(
      rerankedMemories,
      candidatesForReranking,
    );

    const neighborMemories = getRequestedNeighbors(
      rerankedMemories,
      selectedMemories,
      loadedMemories,
    );

    const context = buildMemoryContext(
      rerankedMemories,
      selectedMemories,
      neighborMemories,
    );

    return {
      userText: text,
      atomicMemories,
      candidates: candidatesForReranking,
      selectedMemories,
      neighborMemories,
      context,
    };
  } catch (error) {
    console.error("[Find relevant memories] Failed:", error);

    return createEmptyResult(text);
  }
}

/**
 * Reads all JSON files from AppData/memory except tags.json.
 *
 * This uses the same BaseDirectory.AppData approach as createMemory().
 */
async function loadAllMemories(): Promise<LoadedMemory[]> {
  const memoryDirectoryExists = await exists(MEMORY_DIRECTORY, {
    baseDir: BaseDirectory.AppData,
  });

  if (!memoryDirectoryExists) {
    return [];
  }

  const entries = await readDir(MEMORY_DIRECTORY, {
    baseDir: BaseDirectory.AppData,
  });

  const memoryFileNames = entries
    .filter((entry) => {
      if (entry.isDirectory) {
        return false;
      }

      const fileName = entry.name.toLowerCase();

      return fileName.endsWith(".json") && fileName !== TAGS_FILE_NAME;
    })
    .map((entry) => entry.name);

  const results = await Promise.allSettled(
    memoryFileNames.map(async (fileName): Promise<LoadedMemory> => {
      const filePath = `${MEMORY_DIRECTORY}/${fileName}`;

      const fileContent = await readTextFile(filePath, {
        baseDir: BaseDirectory.AppData,
      });

      const rawMemory = JSON.parse(fileContent);

      const parsedMemory = StoredMemorySchema.safeParse(rawMemory);

      if (!parsedMemory.success) {
        throw new Error(
          `Invalid memory file "${filePath}": ${parsedMemory.error.message}`,
        );
      }

      return {
        fileName,
        filePath,
        memory: parsedMemory.data,
      };
    }),
  );

  const loadedMemories: LoadedMemory[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      loadedMemories.push(result.value);
      continue;
    }

    console.warn(
      "[Find relevant memories] Failed to load a memory file:",
      result.reason,
    );
  }

  return loadedMemories;
}

/**
 * Finds semantic candidates for all extracted atomic memories.
 *
 * The stored memory embedding already represents:
 * content + context + key + tags.
 *
 * The new atomic memory has only content at this point, so it is embedded
 * with embedText() and compared directly against saved embeddings.
 */
async function findSemanticCandidates(
  atomicMemories: AtomicMemory[],
  loadedMemories: LoadedMemory[],
): Promise<MemorySearchCandidate[]> {
  const storedEmbeddings = loadedMemories.map(({ memory }) => ({
    id: memory.id,
    embedding: memory.embedding,
  }));

  const loadedMemoryById = new Map(
    loadedMemories.map((item) => [item.memory.id, item]),
  );

  const candidateMap = new Map<string, MemorySearchCandidate>();

  for (const atomicMemory of atomicMemories) {
    const atomicEmbedding = await textSimilarity.embedText(
      atomicMemory.content,
    );

    const comparison = textSimilarity.compareEmbeddingToList(
      atomicEmbedding,
      storedEmbeddings,
    );

    const topMatches = comparison.matches
      .filter((match) => match.score >= SIMILARITY_THRESHOLD)
      .slice(0, TOP_CANDIDATES_PER_ATOMIC_MEMORY);

    for (const match of topMatches) {
      const loadedMemory = loadedMemoryById.get(match.id);

      if (!loadedMemory) {
        continue;
      }

      const existingCandidate = candidateMap.get(match.id);

      if (!existingCandidate) {
        candidateMap.set(match.id, {
          memoryId: match.id,
          fileName: loadedMemory.fileName,
          filePath: loadedMemory.filePath,
          score: match.score,
          matchedAtomicContents: [atomicMemory.content],
          memory: loadedMemory.memory,
        });

        continue;
      }

      if (!existingCandidate.matchedAtomicContents.includes(
        atomicMemory.content,
      )) {
        existingCandidate.matchedAtomicContents.push(atomicMemory.content);
      }

      if (match.score > existingCandidate.score) {
        existingCandidate.score = match.score;
      }
    }
  }

  return [...candidateMap.values()].sort(
    (first, second) => second.score - first.score,
  );
}

/**
 * Lets the LLM evaluate semantic relevance of candidates.
 *
 * It receives only candidates found by embedding search and can select
 * only IDs from that candidate list.
 */
async function rerankMemoryCandidates(
  userText: string,
  atomicMemories: AtomicMemory[],
  candidates: MemorySearchCandidate[],
): Promise<MemoryRerankItem[]> {
  if (candidates.length === 0) {
    return [];
  }

  try {
    const model = await getAsyncLLM("cheap");

    const structuredModel = model.withStructuredOutput(
      MemoryRerankJsonSchema,
      {
        name: "memory_retrieval_rerank",
      },
    );

    const result = await structuredModel.invoke([
      new SystemMessage(MEMORY_RETRIEVAL_RERANK_PROMPT),
      new HumanMessage(
        createMemoryRerankInput(
          userText,
          atomicMemories,
          candidates,
        ),
      ),
    ]);

    const validatedResult = MemoryRerankResultSchema.safeParse(result);

    if (!validatedResult.success) {
      console.error(
        "[Find relevant memories] Invalid rerank response:",
        validatedResult.error,
      );

      return [];
    }

    const allowedMemoryIds = new Set(
      candidates.map((candidate) => candidate.memoryId),
    );

    return validatedResult.data.selectedMemories.filter((item) =>
      allowedMemoryIds.has(item.memoryId),
    );
  } catch (error) {
    console.error("[Find relevant memories] Reranking failed:", error);

    return [];
  }
}

/**
 * Creates the input given to the memory retrieval evaluator.
 */
function createMemoryRerankInput(
  userText: string,
  atomicMemories: AtomicMemory[],
  candidates: MemorySearchCandidate[],
): string {
  const atomicMemoriesText = atomicMemories
    .map((memory, index) => `${index + 1}. ${memory.content}`)
    .join("\n");

  const candidatesText = candidates
    .map((candidate, index) => {
      const { memory } = candidate;

      return [
        `Candidate ${index + 1}`,
        `Memory ID: ${memory.id}`,
        `File name: ${candidate.fileName}`,
        `Similarity score: ${candidate.score}`,
        `Matched atomic statements: ${candidate.matchedAtomicContents.join(" | ")}`,
        `Content: ${memory.content}`,
        `Context: ${memory.context}`,
        `Key: ${memory.key.join(", ")}`,
        `Tags: ${memory.tags.join(", ")}`,
        `Direct link count: ${memory.links.length}`,
      ].join("\n");
    })
    .join("\n\n---\n\n");

  return [
    "Current user message:",
    userText,
    "",
    "Atomic statements extracted from the message:",
    atomicMemoriesText,
    "",
    "Memory candidates retrieved by embeddings:",
    candidatesText,
  ].join("\n");
}

/**
 * Gets full selected memory objects from IDs selected by the LLM.
 */
function getSelectedMemories(
  rerankedMemories: MemoryRerankItem[],
  candidates: MemorySearchCandidate[],
): StoredMemory[] {
  const candidateById = new Map(
    candidates.map((candidate) => [candidate.memoryId, candidate]),
  );

  const selectedMemoryMap = new Map<string, StoredMemory>();

  for (const item of rerankedMemories) {
    const candidate = candidateById.get(item.memoryId);

    if (candidate) {
      selectedMemoryMap.set(candidate.memoryId, candidate.memory);
    }
  }

  return [...selectedMemoryMap.values()];
}

/**
 * Loads direct linked neighbors requested by the LLM.
 *
 * The memory link format is:
 * {
 *   targetId,
 *   targetFileName,
 *   relationship,
 *   similarity,
 *   confidence,
 *   reason,
 *   createdAt
 * }
 *
 * Only link.targetId is required here because all loaded memories are
 * indexed by their actual memory.id.
 */
function getRequestedNeighbors(
  rerankedMemories: MemoryRerankItem[],
  selectedMemories: StoredMemory[],
  loadedMemories: LoadedMemory[],
): StoredMemory[] {
  const memoryById = new Map(
    loadedMemories.map((item) => [item.memory.id, item.memory]),
  );

  const selectedMemoryIds = new Set(
    selectedMemories.map((memory) => memory.id),
  );

  const neighborMap = new Map<string, StoredMemory>();

  for (const rerankedMemory of rerankedMemories) {
    if (!rerankedMemory.includeNeighbors) {
      continue;
    }

    const selectedMemory = memoryById.get(rerankedMemory.memoryId);

    if (!selectedMemory || selectedMemory.links.length === 0) {
      continue;
    }

    const directLinks = selectedMemory.links.slice(
      0,
      MAX_NEIGHBORS_PER_MEMORY,
    );

    for (const link of directLinks) {
      if (selectedMemoryIds.has(link.targetId)) {
        continue;
      }

      const neighborMemory = memoryById.get(link.targetId);

      if (!neighborMemory) {
        console.warn(
          `[Find relevant memories] Linked memory was not found: ${link.targetId}`,
        );

        continue;
      }

      neighborMap.set(neighborMemory.id, neighborMemory);
    }
  }

  return [...neighborMap.values()];
}

/**
 * Builds the final long-term-memory context passed to the main agent.
 */
function buildMemoryContext(
  rerankedMemories: MemoryRerankItem[],
  selectedMemories: StoredMemory[],
  neighborMemories: StoredMemory[],
): string {
  if (selectedMemories.length === 0 && neighborMemories.length === 0) {
    return "";
  }

  const reasonByMemoryId = new Map(
    rerankedMemories.map((item) => [item.memoryId, item.reason]),
  );

  const selectedMemoryText = selectedMemories
    .map((memory, index) => {
      const reason = reasonByMemoryId.get(memory.id);

      return formatMemoryForAgent(
        `Relevant Memory ${index + 1}`,
        memory,
        reason,
      );
    })
    .join("\n\n");

  const neighborMemoryText = neighborMemories
    .map((memory, index) =>
      formatMemoryForAgent(
        `Supporting Linked Memory ${index + 1}`,
        memory,
      ),
    )
    .join("\n\n");

  return [
    "Relevant long-term memories:",
    selectedMemoryText,
    neighborMemoryText
      ? `Supporting linked memories:\n${neighborMemoryText}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Formats one memory for inclusion in the main agent context.
 */
function formatMemoryForAgent(
  label: string,
  memory: StoredMemory,
  retrievalReason?: string,
): string {
  return [
    `[${label}]`,
    `ID: ${memory.id}`,
    `Content: ${memory.content}`,
    memory.context ? `Context: ${memory.context}` : "",
    memory.key.length > 0 ? `Key: ${memory.key.join(", ")}` : "",
    memory.tags.length > 0 ? `Tags: ${memory.tags.join(", ")}` : "",
    retrievalReason ? `Retrieval reason: ${retrievalReason}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function createEmptyResult(
  userText: string,
): FindRelevantMemoriesResult {
  return {
    userText,
    atomicMemories: [],
    candidates: [],
    selectedMemories: [],
    neighborMemories: [],
    context: "",
  };
}