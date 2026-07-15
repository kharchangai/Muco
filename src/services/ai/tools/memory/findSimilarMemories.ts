import {
  BaseDirectory,
  exists,
  readDir,
  readTextFile,
} from "@tauri-apps/plugin-fs";

import { textSimilarity } from "../textSimilarity";
import type { MemoryNode } from "./enrichMemory";

const MEMORY_DIRECTORY = "memory";
const TAGS_FILE_NAME = "tags.json";

const SIMILARITY_THRESHOLD = 0.5;
const MAX_SIMILAR_MEMORIES = 10;

type StoredMemory = {
  fileName: string;
  memory: MemoryNode;
};

export type SimilarMemoryResult = {
  fileName: string;
  similarity: number;
  memory: MemoryNode;
};

/**
 * Finds stored memories with embeddings similar to the provided memory.
 *
 * This method does not generate embeddings again. It compares the embedding
 * already present on the enriched memory against embeddings read from files.
 */
export async function findSimilarMemories(
  enrichedMemory: MemoryNode,
): Promise<SimilarMemoryResult[]> {
  if (!hasValidEmbedding(enrichedMemory)) {
    throw new Error(
      "The provided enriched memory does not contain a valid embedding.",
    );
  }

  const memoryDirectoryExists = await exists(MEMORY_DIRECTORY, {
    baseDir: BaseDirectory.AppData,
  });

  if (!memoryDirectoryExists) {
    return [];
  }

  const storedMemories = await readStoredMemories();

  if (storedMemories.length === 0) {
    return [];
  }

  /*
   * Different embedding models may produce vectors with different dimensions.
   * Only compare vectors produced by compatible embedding models.
   */
  const compatibleMemories = storedMemories.filter(
    ({ memory }) =>
      memory.embedding.length === enrichedMemory.embedding.length,
  );

  if (compatibleMemories.length === 0) {
    return [];
  }

  const memoriesByFileName = new Map(
    compatibleMemories.map((storedMemory) => [
      storedMemory.fileName,
      storedMemory.memory,
    ]),
  );

  const comparisonResult = textSimilarity.compareEmbeddingToList(
    enrichedMemory.embedding,
    compatibleMemories.map((storedMemory) => ({
      id: storedMemory.fileName,
      embedding: storedMemory.memory.embedding,
    })),
  );

  return comparisonResult.matches
    .filter((match) => match.score >= SIMILARITY_THRESHOLD)
    .slice(0, MAX_SIMILAR_MEMORIES)
    .flatMap((match): SimilarMemoryResult[] => {
      const memory = memoriesByFileName.get(match.id);

      if (!memory) {
        return [];
      }

      return [
        {
          fileName: match.id,
          similarity: match.score,
          memory,
        },
      ];
    });
}

async function readStoredMemories(): Promise<StoredMemory[]> {
  const entries = await readDir(MEMORY_DIRECTORY, {
    baseDir: BaseDirectory.AppData,
  });

  const storedMemories: StoredMemory[] = [];

  for (const entry of entries) {
    if (!entry.isFile) {
      continue;
    }

    if (!entry.name.endsWith(".json")) {
      continue;
    }

    if (entry.name === TAGS_FILE_NAME) {
      continue;
    }

    const storedMemory = await readMemory(entry.name);

    if (storedMemory) {
      storedMemories.push(storedMemory);
    }
  }

  return storedMemories;
}

async function readMemory(fileName: string): Promise<StoredMemory | null> {
  const filePath = `${MEMORY_DIRECTORY}/${fileName}`;

  try {
    const fileContent = await readTextFile(filePath, {
      baseDir: BaseDirectory.AppData,
    });

    const parsedMemory: unknown = JSON.parse(fileContent);

    if (!hasValidEmbedding(parsedMemory)) {
      console.warn(
        `Skipping memory file because it has no valid embedding: ${fileName}`,
      );

      return null;
    }

    return {
      fileName,
      memory: parsedMemory as MemoryNode,
    };
  } catch (error) {
    console.warn(`Unable to read memory file: ${fileName}`, error);

    return null;
  }
}

function hasValidEmbedding(
  value: unknown,
): value is { embedding: number[] } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const memory = value as {
    embedding?: unknown;
  };

  return (
    Array.isArray(memory.embedding) &&
    memory.embedding.length > 0 &&
    memory.embedding.every(
      (item) => typeof item === "number" && Number.isFinite(item),
    )
  );
}