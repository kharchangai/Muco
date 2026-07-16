import {
  BaseDirectory,
  exists,
  mkdir,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

import {
  analyzeMemoryRelationships,
  type MemoryRelationshipAnalysis,
} from "./analyzeMemoryRelationships";
import {
  enrichAtomicMemory,
  type MemoryNode,
} from "./enrichMemory";
import { findSimilarMemories } from "./findSimilarMemories";
import { evolveNeighborContext } from "./evolveNeighborContext";

const MEMORY_DIRECTORY = "memory";

const MEMORY_RELATIONSHIPS = [
  "COMPLEMENTS",
  "CONTRADICTS",
  "RELATED",
  "DUPLICATE",
] as const;

export type MemoryRelationship =
  (typeof MEMORY_RELATIONSHIPS)[number];

export type MemoryLink = {
  targetId: string;
  targetFileName: string;
  relationship: MemoryRelationship;
  similarity: number;
  confidence: number;
  reason: string;
  createdAt: string;
};

export type MemoryNodeWithLinks = MemoryNode & {
  links: MemoryLink[];
};

export type CreatedMemoryResult = {
  memory: MemoryNodeWithLinks;
  similarMemoriesCount: number;
  relationshipAnalyses: MemoryRelationshipAnalysis[];
  filePath: string;
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
 * Creates and stores one complete memory file from an atomic memory text.
 *
 * Cancellation behavior:
 * - Checks cancellation before and after every pipeline stage.
 * - Passes the signal to all downstream functions.
 * - Throws AbortError when cancelled.
 * - Does not save the new memory when cancellation happens before saving.
 *
 * Pipeline:
 * 1. Enrich the atomic memory.
 * 2. Find similar stored memories.
 * 3. Analyze relationships with similar memories.
 * 4. Create links from valid relationship analyses.
 * 5. Evolve neighboring memories when required.
 * 6. Replace links with the final evolved links.
 * 7. Save the final memory JSON file.
 *
 * Important:
 * Tauri file operations cannot necessarily be interrupted after they begin.
 * Cancellation checks ensure that no next stage starts after cancellation.
 */
export async function createMemory(
  atomicMemory: string,
  signal?: AbortSignal,
): Promise<CreatedMemoryResult> {
  throwIfAborted(signal);

  const content = atomicMemory?.trim();

  if (!content) {
    throw new Error("Atomic memory content cannot be empty.");
  }

  /*
   * enrichAtomicMemory must accept:
   * (atomicMemory: string, signal?: AbortSignal)
   */
  const enrichedMemory = await enrichAtomicMemory(
    content,
    signal,
  );

  throwIfAborted(signal);

  /*
   * findSimilarMemories must accept:
   * (memory: MemoryNode, signal?: AbortSignal)
   */
  const similarMemories = await findSimilarMemories(
    enrichedMemory,
    signal,
  );

  throwIfAborted(signal);

  /*
   * analyzeMemoryRelationships must accept:
   * (
   *   sourceMemory: MemoryNode,
   *   similarMemories: SimilarMemory[],
   *   signal?: AbortSignal,
   * )
   */
  const relationshipAnalyses =
    await analyzeMemoryRelationships(
      enrichedMemory,
      similarMemories,
      signal,
    );

  throwIfAborted(signal);

  const links = createMemoryLinks(
    relationshipAnalyses,
  );

  const memoryToSave: MemoryNodeWithLinks = {
    ...enrichedMemory,
    links,
  };

  throwIfAborted(signal);

  /*
   * evolveNeighborContext must accept:
   * (memoryToSave: MemoryNodeWithLinks, signal?: AbortSignal)
   *
   * This operation can update or delete neighbor files. It is important that
   * evolveNeighborContext checks signal before each write/remove operation.
   */
  memoryToSave.links = await evolveNeighborContext(
    memoryToSave,
    signal,
  );

  throwIfAborted(signal);

  const filePath = await saveMemoryFile(
    memoryToSave,
    signal,
  );

  throwIfAborted(signal);

  return {
    memory: memoryToSave,
    similarMemoriesCount: similarMemories.length,
    relationshipAnalyses,
    filePath,
  };
}

/**
 * Converts useful relationship analyses to links stored on the new memory.
 *
 * UNRELATED memories, invalid targets, invalid confidence values, and
 * low-confidence relationships are excluded.
 */
function createMemoryLinks(
  relationshipAnalyses: MemoryRelationshipAnalysis[],
): MemoryLink[] {
  const createdAt = new Date().toISOString();

  return relationshipAnalyses.flatMap(
    ({
      targetFileName,
      targetMemoryId,
      similarity,
      analysis,
    }): MemoryLink[] => {
      const confidence = Number(analysis.confidence);

      if (
        !isMemoryRelationship(analysis.relationship) ||
        !Number.isFinite(confidence) ||
        confidence < 0.5
      ) {
        return [];
      }

      if (!targetMemoryId?.trim() || !targetFileName?.trim()) {
        console.warn(
          "[Memory creation] A relationship was ignored because its target is invalid.",
        );

        return [];
      }

      return [
        {
          targetId: targetMemoryId.trim(),
          targetFileName: targetFileName.trim(),
          relationship: analysis.relationship,
          similarity: Number.isFinite(similarity)
            ? similarity
            : 0,
          confidence,
          reason: analysis.reason?.trim() || "",
          createdAt,
        },
      ];
    },
  );
}

/**
 * Checks whether a relationship can be stored as a memory link.
 */
function isMemoryRelationship(
  relationship: string,
): relationship is MemoryRelationship {
  return MEMORY_RELATIONSHIPS.includes(
    relationship as MemoryRelationship,
  );
}

/**
 * Saves a memory as memory/{memory.id}.json inside AppData.
 *
 * The signal cannot force-stop an already-running Tauri write operation,
 * but cancellation is checked before and after the write.
 */
async function saveMemoryFile(
  memory: MemoryNodeWithLinks,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);

  if (!memory.id?.trim()) {
    throw new Error(
      "Memory cannot be saved because it has no valid id.",
    );
  }

  await ensureMemoryDirectoryExists(signal);

  throwIfAborted(signal);

  /*
   * IDs are generated internally. This check prevents accidental path
   * traversal if an invalid ID ever reaches this layer.
   */
  const fileId = sanitizeMemoryId(memory.id);
  const fileName = `${fileId}.json`;
  const filePath = `${MEMORY_DIRECTORY}/${fileName}`;

  try {
    await writeTextFile(
      filePath,
      JSON.stringify(memory, null, 2),
      {
        baseDir: BaseDirectory.AppData,
      },
    );
  } catch (error) {
    console.error(
      "[Memory creation] Failed to save memory file:",
      filePath,
      error,
    );

    throw new Error(
      `Failed to save memory "${fileId}": ${getErrorMessage(error)}`,
    );
  }

  throwIfAborted(signal);

  return filePath;
}

/**
 * Creates the memory directory when it does not already exist.
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

/**
 * Converts an ID into a safe filename fragment.
 */
function sanitizeMemoryId(id: string): string {
  const sanitizedId = id
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_");

  if (!sanitizedId) {
    throw new Error(
      "Memory cannot be saved because its id is invalid.",
    );
  }

  return sanitizedId;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}