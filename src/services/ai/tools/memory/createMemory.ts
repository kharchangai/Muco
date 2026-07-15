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

export type MemoryRelationship =
  | "COMPLEMENTS"
  | "CONTRADICTS"
  | "RELATED"
  | "DUPLICATE";

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

/**
 * Creates and stores one complete memory file from an atomic memory text.
 *
 * Pipeline:
 * 1. Enrich the atomic memory.
 * 2. Find similar stored memories.
 * 3. Analyze the relationship with every similar memory.
 * 4. Create links from useful relationships.
 * 5. Evolve or delete neighboring memories when required.
 * 6. Remove duplicate links from the new memory.
 * 7. Save the final memory as a JSON file.
 */
export async function createMemory(
  atomicMemory: string,
): Promise<CreatedMemoryResult> {
  if (!atomicMemory.trim()) {
    throw new Error("Atomic memory content cannot be empty.");
  }

  const enrichedMemory = await enrichAtomicMemory(atomicMemory);

  const similarMemories = await findSimilarMemories(enrichedMemory);

  const relationshipAnalyses = await analyzeMemoryRelationships(
    enrichedMemory,
    similarMemories,
  );

  const links = createMemoryLinks(relationshipAnalyses);

  const memoryToSave: MemoryNodeWithLinks = {
    ...enrichedMemory,
    links,
  };

  /*
   * Wait for neighbor processing to finish.
   *
   * The returned list does not contain DUPLICATE links, so it must replace
   * the original links before the new memory is written to disk.
   */
  memoryToSave.links = await evolveNeighborContext(memoryToSave);

  const filePath = await saveMemoryFile(memoryToSave);

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
 * UNRELATED memories and low-confidence relationships are excluded.
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
      if (
        !isMemoryRelationship(analysis.relationship) ||
        analysis.confidence < 0.5
      ) {
        return [];
      }

      if (!targetMemoryId?.trim() || !targetFileName?.trim()) {
        console.warn(
          "A memory relationship was ignored because its target is invalid.",
        );

        return [];
      }

      return [
        {
          targetId: targetMemoryId,
          targetFileName,
          relationship: analysis.relationship,
          similarity,
          confidence: analysis.confidence,
          reason: analysis.reason,
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
  return (
    relationship === "COMPLEMENTS" ||
    relationship === "CONTRADICTS" ||
    relationship === "RELATED" ||
    relationship === "DUPLICATE"
  );
}

/**
 * Saves a memory as memory/{memory.id}.json inside AppData.
 */
async function saveMemoryFile(
  memory: MemoryNodeWithLinks,
): Promise<string> {
  if (!memory.id?.trim()) {
    throw new Error(
      "Memory cannot be saved because it has no valid id.",
    );
  }

  await ensureMemoryDirectoryExists();

  const fileName = `${memory.id}.json`;
  const filePath = `${MEMORY_DIRECTORY}/${fileName}`;

  await writeTextFile(
    filePath,
    JSON.stringify(memory, null, 2),
    {
      baseDir: BaseDirectory.AppData,
    },
  );

  return filePath;
}

/**
 * Creates the memory directory when it does not already exist.
 */
async function ensureMemoryDirectoryExists(): Promise<void> {
  const memoryDirectoryExists = await exists(
    MEMORY_DIRECTORY,
    {
      baseDir: BaseDirectory.AppData,
    },
  );

  if (memoryDirectoryExists) {
    return;
  }

  await mkdir(MEMORY_DIRECTORY, {
    baseDir: BaseDirectory.AppData,
    recursive: true,
  });
}