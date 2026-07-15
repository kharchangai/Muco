import {
  BaseDirectory,
  exists,
  readDir,
  readTextFile,
  remove,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { z } from "zod";

import type { MemoryNode } from "./enrichMemory";
import { textSimilarity } from "../textSimilarity";
import { getAsyncLLM } from "../memory_tools";
import { EVOLVE_NEIGHBOR_CONTEXT_PROMPT } from "./prompts";

const MEMORY_DIRECTORY = "memory";

type MemoryRelationship =
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
  links?: MemoryLink[];
};

type NeighborContext = {
  id: string;
  content: string;
  context: string;
  key: string[];
  tags: string[];
  relationship: Exclude<MemoryRelationship, "DUPLICATE">;
};

const evolvedNeighborSchema = z.object({
  context: z.string().min(1),
  key: z.array(z.string().min(1)),
  tags: z.array(z.string().min(1)),
});

type EvolvedNeighborFields = z.infer<typeof evolvedNeighborSchema>;

/**
 * Evolves the existing memory graph for a newly prepared memory.
 *
 * This function DOES NOT save the new memory file.
 * The caller must save `memoryToSave` after this function returns.
 *
 * Flow:
 * 1. Reads DUPLICATE memories before deletion.
 * 2. Transfers their useful outgoing links to the new memory.
 * 3. Redirects existing memory links that target duplicates to the new memory ID.
 * 4. Deletes duplicate memory files.
 * 5. Evolves COMPLEMENTS neighbors using the language model.
 * 6. Returns final links for the new memory.
 */
export async function evolveNeighborContext(
  memoryToSave: MemoryNodeWithLinks,
): Promise<MemoryLink[]> {
  const originalLinks = memoryToSave.links ?? [];

  if (originalLinks.length === 0) {
    memoryToSave.links = [];
    return [];
  }

  const duplicateLinks = originalLinks.filter(
    (link) => link.relationship === "DUPLICATE",
  );

  const nonDuplicateLinks = originalLinks.filter(
    (link) => link.relationship !== "DUPLICATE",
  );

  const replacementFileName = createMemoryFileName(memoryToSave.id);

  const duplicateIds = new Set(
    duplicateLinks.map((link) => link.targetId).filter(Boolean),
  );

  const duplicateFileNames = new Set(
    duplicateLinks.map((link) => link.targetFileName).filter(Boolean),
  );

  /*
   * Read duplicates before removing them. Their useful outgoing links
   * are transferred to the new memory.
   */
  const duplicateMemories = await readDuplicateMemories(duplicateLinks);

  const transferredLinks = collectTransferredLinks(
    memoryToSave,
    duplicateMemories,
    duplicateIds,
    duplicateFileNames,
  );

  const finalLinks = mergeMemoryLinks([
    ...nonDuplicateLinks,
    ...transferredLinks,
  ]).filter(
    (link) =>
      link.relationship !== "DUPLICATE" &&
      link.targetId !== memoryToSave.id &&
      link.targetFileName !== replacementFileName,
  );

  /*
   * The new memory is not written here.
   * Its ID and expected file name are enough for redirecting old links.
   */
  memoryToSave.links = finalLinks;

  if (duplicateLinks.length > 0) {
    await redirectDuplicateReferences(
      memoryToSave,
      duplicateIds,
      duplicateFileNames,
    );

    await deleteDuplicateNeighbors(duplicateLinks);
  }

  await evolveComplementNeighbors(memoryToSave, finalLinks);

  return memoryToSave.links;
}

/**
 * Reads duplicate memory files before they are deleted.
 */
async function readDuplicateMemories(
  duplicateLinks: MemoryLink[],
): Promise<MemoryNodeWithLinks[]> {
  const duplicateMemories: MemoryNodeWithLinks[] = [];

  const uniqueFileNames = [
    ...new Set(
      duplicateLinks
        .map((link) => link.targetFileName)
        .filter(Boolean),
    ),
  ];

  for (const fileName of uniqueFileNames) {
    try {
      const memory = await readMemoryFile(fileName);
      duplicateMemories.push(memory);
    } catch (error) {
      console.error(
        `Failed to read duplicate memory ${fileName}:`,
        error,
      );
    }
  }

  return duplicateMemories;
}

/**
 * Transfers non-duplicate links of deleted memories to the new memory.
 *
 * Links that point to another duplicate, the replacement memory,
 * or the duplicate memory itself are excluded.
 */
function collectTransferredLinks(
  memoryToSave: MemoryNodeWithLinks,
  duplicateMemories: MemoryNodeWithLinks[],
  duplicateIds: Set<string>,
  duplicateFileNames: Set<string>,
): MemoryLink[] {
  const replacementFileName = createMemoryFileName(memoryToSave.id);
  const transferredLinks: MemoryLink[] = [];

  for (const duplicateMemory of duplicateMemories) {
    for (const link of duplicateMemory.links ?? []) {
      const pointsToDuplicate =
        duplicateIds.has(link.targetId) ||
        duplicateFileNames.has(link.targetFileName);

      const pointsToReplacement =
        link.targetId === memoryToSave.id ||
        link.targetFileName === replacementFileName;

      const pointsToItself =
        link.targetId === duplicateMemory.id ||
        link.targetFileName === createMemoryFileName(duplicateMemory.id);

      if (
        link.relationship === "DUPLICATE" ||
        pointsToDuplicate ||
        pointsToReplacement ||
        pointsToItself
      ) {
        continue;
      }

      transferredLinks.push(link);
    }
  }

  return transferredLinks;
}

/**
 * Scans all existing memory files and redirects every link that points
 * to a duplicate memory toward the replacement memory.
 *
 * The replacement file does not need to exist at this point.
 * Its future file name is derived from replacementMemory.id.
 */
async function redirectDuplicateReferences(
  replacementMemory: MemoryNodeWithLinks,
  duplicateIds: Set<string>,
  duplicateFileNames: Set<string>,
): Promise<void> {
  const replacementFileName = createMemoryFileName(replacementMemory.id);
  const allFileNames = await readAllMemoryFileNames();

  for (const fileName of allFileNames) {
    /*
     * Duplicate files will be deleted later.
     * The replacement file is not expected to exist yet, but this check
     * also makes the function safe if it already exists.
     */
    if (
      duplicateFileNames.has(fileName) ||
      fileName === replacementFileName
    ) {
      continue;
    }

    try {
      const memory = await readMemoryFile(fileName);
      const originalLinks = memory.links ?? [];

      const redirectedLinks = originalLinks
        .map((link) => {
          const pointsToDuplicate =
            duplicateIds.has(link.targetId) ||
            duplicateFileNames.has(link.targetFileName);

          if (!pointsToDuplicate) {
            return link;
          }

          /*
           * DUPLICATE is meaningful only while its target exists.
           * After redirecting, it becomes RELATED.
           */
          const relationship =
            link.relationship === "DUPLICATE"
              ? "RELATED"
              : link.relationship;

          return {
            ...link,
            targetId: replacementMemory.id,
            targetFileName: replacementFileName,
            relationship,
            reason: `${link.reason} Redirected from a removed duplicate memory.`,
          };
        })
        .filter(
          (link) =>
            link.targetId !== memory.id &&
            link.targetFileName !== fileName,
        );

      const mergedLinks = mergeMemoryLinks(redirectedLinks);

      if (!areLinksEqual(originalLinks, mergedLinks)) {
        memory.links = mergedLinks;

        await writeMemoryFile(fileName, memory);

        console.log(
          `Duplicate references redirected in memory: ${fileName}`,
        );
      }
    } catch (error) {
      console.error(
        `Failed to redirect duplicate references in ${fileName}:`,
        error,
      );

      throw error;
    }
  }
}

/**
 * Deletes duplicate memory files after all old graph references
 * have been redirected.
 */
async function deleteDuplicateNeighbors(
  duplicateLinks: MemoryLink[],
): Promise<void> {
  const duplicateFileNames = [
    ...new Set(
      duplicateLinks
        .map((link) => link.targetFileName)
        .filter(Boolean),
    ),
  ];

  for (const fileName of duplicateFileNames) {
    const filePath = createMemoryFilePath(fileName);

    try {
      const fileExists = await exists(filePath, {
        baseDir: BaseDirectory.AppData,
      });

      if (!fileExists) {
        console.warn(`Duplicate file does not exist: ${fileName}`);
        continue;
      }

      await remove(filePath, {
        baseDir: BaseDirectory.AppData,
      });

      console.log(`Duplicate memory deleted: ${fileName}`);
    } catch (error) {
      console.error(
        `Failed to delete duplicate memory ${fileName}:`,
        error,
      );

      throw error;
    }
  }
}

/**
 * Updates context, key, tags, and embedding of COMPLEMENTS neighbors.
 */
async function evolveComplementNeighbors(
  memoryToSave: MemoryNodeWithLinks,
  finalLinks: MemoryLink[],
): Promise<void> {
  const loadedNeighbors = await readNonDuplicateNeighbors(finalLinks);

  const complementLinks = finalLinks.filter(
    (link) => link.relationship === "COMPLEMENTS",
  );

  for (const link of complementLinks) {
    const targetNeighbor = loadedNeighbors.get(link.targetFileName);

    if (!targetNeighbor) {
      console.error(
        `Complement neighbor could not be loaded: ${link.targetFileName}`,
      );
      continue;
    }

    const neighborContexts = createNeighborContexts(
      finalLinks,
      loadedNeighbors,
      link.targetFileName,
    );

    try {
      const evolvedFields = await evolveNeighborWithLLM(
        memoryToSave,
        targetNeighbor,
        neighborContexts,
      );

      const updatedNeighbor: MemoryNodeWithLinks = {
        ...targetNeighbor,
        context: evolvedFields.context,
        key: evolvedFields.key,
        tags: evolvedFields.tags,
      };

      updatedNeighbor.embedding = await textSimilarity.embedMemory({
        content: updatedNeighbor.content,
        context: updatedNeighbor.context,
        key: updatedNeighbor.key,
        tags: updatedNeighbor.tags,
      });

      await writeMemoryFile(link.targetFileName, updatedNeighbor);

      loadedNeighbors.set(link.targetFileName, updatedNeighbor);

      console.log(`Complement neighbor updated: ${link.targetFileName}`);
    } catch (error) {
      console.error(
        `Failed to update complement neighbor ${link.targetFileName}:`,
        error,
      );
    }
  }
}

/**
 * Reads each non-duplicate neighbor only once.
 */
async function readNonDuplicateNeighbors(
  links: MemoryLink[],
): Promise<Map<string, MemoryNodeWithLinks>> {
  const neighbors = new Map<string, MemoryNodeWithLinks>();

  const uniqueFileNames = [
    ...new Set(
      links
        .map((link) => link.targetFileName)
        .filter(Boolean),
    ),
  ];

  for (const fileName of uniqueFileNames) {
    try {
      const memory = await readMemoryFile(fileName);
      neighbors.set(fileName, memory);
    } catch (error) {
      console.error(`Failed to read neighbor ${fileName}:`, error);
    }
  }

  return neighbors;
}

/**
 * Creates context data from all available neighbors except the target.
 */
function createNeighborContexts(
  links: MemoryLink[],
  loadedNeighbors: Map<string, MemoryNodeWithLinks>,
  targetFileName: string,
): NeighborContext[] {
  const contexts: NeighborContext[] = [];

  for (const link of links) {
    if (link.targetFileName === targetFileName) {
      continue;
    }

    const neighbor = loadedNeighbors.get(link.targetFileName);

    if (!neighbor) {
      continue;
    }

    contexts.push({
      id: neighbor.id,
      content: neighbor.content,
      context: neighbor.context,
      key: neighbor.key,
      tags: neighbor.tags,
      relationship: link.relationship as Exclude<
        MemoryRelationship,
        "DUPLICATE"
      >,
    });
  }

  return contexts;
}

/**
 * Uses the language model to evolve only context, key, and tags.
 */
async function evolveNeighborWithLLM(
  newMemory: MemoryNodeWithLinks,
  targetNeighbor: MemoryNodeWithLinks,
  neighborContexts: NeighborContext[],
): Promise<EvolvedNeighborFields> {
  const model = await getAsyncLLM();

  const structuredModel = model.withStructuredOutput(
    evolvedNeighborSchema,
  );

  return structuredModel.invoke([
    {
      role: "system",
      content: EVOLVE_NEIGHBOR_CONTEXT_PROMPT,
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          newMemory: {
            id: newMemory.id,
            content: newMemory.content,
            context: newMemory.context,
            key: newMemory.key,
            tags: newMemory.tags,
          },
          targetNeighbor: {
            id: targetNeighbor.id,
            content: targetNeighbor.content,
            context: targetNeighbor.context,
            key: targetNeighbor.key,
            tags: targetNeighbor.tags,
          },
          otherNeighbors: neighborContexts,
        },
        null,
        2,
      ),
    },
  ]);
}

/**
 * Retains one link per target ID.
 *
 * Higher similarity wins. If similarity is equal,
 * higher confidence wins.
 */
function mergeMemoryLinks(links: MemoryLink[]): MemoryLink[] {
  const linksByTargetId = new Map<string, MemoryLink>();

  for (const link of links) {
    if (!link.targetId || !link.targetFileName) {
      continue;
    }

    const existingLink = linksByTargetId.get(link.targetId);

    if (!existingLink) {
      linksByTargetId.set(link.targetId, link);
      continue;
    }

    const shouldReplace =
      link.similarity > existingLink.similarity ||
      (link.similarity === existingLink.similarity &&
        link.confidence > existingLink.confidence);

    if (shouldReplace) {
      linksByTargetId.set(link.targetId, link);
    }
  }

  return [...linksByTargetId.values()];
}

function areLinksEqual(
  firstLinks: MemoryLink[],
  secondLinks: MemoryLink[],
): boolean {
  return JSON.stringify(firstLinks) === JSON.stringify(secondLinks);
}

/**
 * Reads all JSON file names from AppData/memory.
 */
async function readAllMemoryFileNames(): Promise<string[]> {
  const directoryExists = await exists(MEMORY_DIRECTORY, {
    baseDir: BaseDirectory.AppData,
  });

  if (!directoryExists) {
    return [];
  }

  const entries = await readDir(MEMORY_DIRECTORY, {
    baseDir: BaseDirectory.AppData,
  });

  return entries
    .filter(
      (entry) =>
        entry.isFile &&
        typeof entry.name === "string" &&
        entry.name.endsWith(".json"),
    )
    .map((entry) => entry.name);
}

/**
 * Reads one memory JSON file from AppData/memory.
 */
async function readMemoryFile(
  fileName: string,
): Promise<MemoryNodeWithLinks> {
  const filePath = createMemoryFilePath(fileName);

  const fileExists = await exists(filePath, {
    baseDir: BaseDirectory.AppData,
  });

  if (!fileExists) {
    throw new Error(`Memory file does not exist: ${fileName}`);
  }

  const fileContent = await readTextFile(filePath, {
    baseDir: BaseDirectory.AppData,
  });

  try {
    return JSON.parse(fileContent) as MemoryNodeWithLinks;
  } catch {
    throw new Error(`Memory file contains invalid JSON: ${fileName}`);
  }
}

/**
 * Writes an existing memory JSON file.
 *
 * This function is used only for old neighbors and graph updates.
 * It is not used to save memoryToSave.
 */
async function writeMemoryFile(
  fileName: string,
  memory: MemoryNodeWithLinks,
): Promise<void> {
  const filePath = createMemoryFilePath(fileName);

  await writeTextFile(
    filePath,
    JSON.stringify(memory, null, 2),
    {
      baseDir: BaseDirectory.AppData,
    },
  );
}

function createMemoryFileName(memoryId: string): string {
  if (!memoryId.trim()) {
    throw new Error("Memory ID is invalid.");
  }

  return `${memoryId}.json`;
}

function createMemoryFilePath(fileName: string): string {
  const safeFileName = fileName.split(/[\\/]/).pop();

  if (!safeFileName || !safeFileName.endsWith(".json")) {
    throw new Error("Memory file name is invalid.");
  }

  return `${MEMORY_DIRECTORY}/${safeFileName}`;
}