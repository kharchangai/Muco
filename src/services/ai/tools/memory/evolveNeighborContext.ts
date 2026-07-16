import {
  BaseDirectory,
  exists,
  readDir,
  readTextFile,
  remove,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { z } from "zod";

import { getAsyncLLM } from "../../llm";
import { textSimilarity } from "../textSimilarity";
import type { MemoryNode } from "./enrichMemory";
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

type EvolvedNeighborFields = z.infer<
  typeof evolvedNeighborSchema
>;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException(
      "The operation was cancelled.",
      "AbortError",
    );
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}

/**
 * Evolves the existing memory graph for a newly prepared memory.
 *
 * This function does not save the new memory file. The caller must save
 * memoryToSave only after this function completes successfully.
 *
 * Important: cancellation is cooperative. Tauri file operations already
 * started cannot reliably be interrupted or rolled back.
 */
export async function evolveNeighborContext(
  memoryToSave: MemoryNodeWithLinks,
  signal?: AbortSignal,
): Promise<MemoryLink[]> {
  throwIfAborted(signal);

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

  const replacementFileName = createMemoryFileName(
    memoryToSave.id,
  );

  const duplicateIds = new Set(
    duplicateLinks.map((link) => link.targetId).filter(Boolean),
  );

  const duplicateFileNames = new Set(
    duplicateLinks
      .map((link) => link.targetFileName)
      .filter(Boolean),
  );

  const duplicateMemories = await readDuplicateMemories(
    duplicateLinks,
    signal,
  );

  throwIfAborted(signal);

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

  memoryToSave.links = finalLinks;

  throwIfAborted(signal);

  if (duplicateLinks.length > 0) {
    await redirectDuplicateReferences(
      memoryToSave,
      duplicateIds,
      duplicateFileNames,
      signal,
    );

    throwIfAborted(signal);

    await deleteDuplicateNeighbors(
      duplicateLinks,
      signal,
    );
  }

  throwIfAborted(signal);

  await evolveComplementNeighbors(
    memoryToSave,
    finalLinks,
    signal,
  );

  throwIfAborted(signal);

  return memoryToSave.links;
}

async function readDuplicateMemories(
  duplicateLinks: MemoryLink[],
  signal?: AbortSignal,
): Promise<MemoryNodeWithLinks[]> {
  throwIfAborted(signal);

  const duplicateMemories: MemoryNodeWithLinks[] = [];

  const uniqueFileNames = [
    ...new Set(
      duplicateLinks
        .map((link) => link.targetFileName)
        .filter(Boolean),
    ),
  ];

  for (const fileName of uniqueFileNames) {
    throwIfAborted(signal);

    try {
      const memory = await readMemoryFile(fileName, signal);

      throwIfAborted(signal);

      duplicateMemories.push(memory);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      console.error(
        `Failed to read duplicate memory ${fileName}:`,
        error,
      );
    }
  }

  return duplicateMemories;
}

function collectTransferredLinks(
  memoryToSave: MemoryNodeWithLinks,
  duplicateMemories: MemoryNodeWithLinks[],
  duplicateIds: Set<string>,
  duplicateFileNames: Set<string>,
): MemoryLink[] {
  const replacementFileName = createMemoryFileName(
    memoryToSave.id,
  );

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
        link.targetFileName ===
          createMemoryFileName(duplicateMemory.id);

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

async function redirectDuplicateReferences(
  replacementMemory: MemoryNodeWithLinks,
  duplicateIds: Set<string>,
  duplicateFileNames: Set<string>,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);

  const replacementFileName = createMemoryFileName(
    replacementMemory.id,
  );

  const allFileNames = await readAllMemoryFileNames(signal);

  throwIfAborted(signal);

  for (const fileName of allFileNames) {
    throwIfAborted(signal);

    if (
      duplicateFileNames.has(fileName) ||
      fileName === replacementFileName
    ) {
      continue;
    }

    try {
      const memory = await readMemoryFile(fileName, signal);

      throwIfAborted(signal);

      const originalLinks = memory.links ?? [];

      const redirectedLinks = originalLinks
        .map((link) => {
          const pointsToDuplicate =
            duplicateIds.has(link.targetId) ||
            duplicateFileNames.has(link.targetFileName);

          if (!pointsToDuplicate) {
            return link;
          }

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

      throwIfAborted(signal);

      if (!areLinksEqual(originalLinks, mergedLinks)) {
        memory.links = mergedLinks;

        await writeMemoryFile(fileName, memory, signal);

        throwIfAborted(signal);

        console.log(
          `Duplicate references redirected in memory: ${fileName}`,
        );
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      console.error(
        `Failed to redirect duplicate references in ${fileName}:`,
        error,
      );

      throw error;
    }
  }
}

async function deleteDuplicateNeighbors(
  duplicateLinks: MemoryLink[],
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);

  const duplicateFileNames = [
    ...new Set(
      duplicateLinks
        .map((link) => link.targetFileName)
        .filter(Boolean),
    ),
  ];

  for (const fileName of duplicateFileNames) {
    throwIfAborted(signal);

    const filePath = createMemoryFilePath(fileName);

    try {
      const fileExists = await exists(filePath, {
        baseDir: BaseDirectory.AppData,
      });

      throwIfAborted(signal);

      if (!fileExists) {
        console.warn(
          `Duplicate file does not exist: ${fileName}`,
        );
        continue;
      }

      await remove(filePath, {
        baseDir: BaseDirectory.AppData,
      });

      throwIfAborted(signal);

      console.log(`Duplicate memory deleted: ${fileName}`);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      console.error(
        `Failed to delete duplicate memory ${fileName}:`,
        error,
      );

      throw error;
    }
  }
}

async function evolveComplementNeighbors(
  memoryToSave: MemoryNodeWithLinks,
  finalLinks: MemoryLink[],
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);

  const loadedNeighbors = await readNonDuplicateNeighbors(
    finalLinks,
    signal,
  );

  throwIfAborted(signal);

  const complementLinks = finalLinks.filter(
    (link) => link.relationship === "COMPLEMENTS",
  );

  for (const link of complementLinks) {
    throwIfAborted(signal);

    const targetNeighbor = loadedNeighbors.get(
      link.targetFileName,
    );

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
        signal,
      );

      throwIfAborted(signal);

      const updatedNeighbor: MemoryNodeWithLinks = {
        ...targetNeighbor,
        context: evolvedFields.context,
        key: evolvedFields.key,
        tags: evolvedFields.tags,
      };

      /*
       * embedMemory must accept and forward AbortSignal to its embedding
       * provider. For example:
       *
       * embedMemory(memory, signal?: AbortSignal)
       */
      updatedNeighbor.embedding =
        await textSimilarity.embedMemory(
          {
            content: updatedNeighbor.content,
            context: updatedNeighbor.context,
            key: updatedNeighbor.key,
            tags: updatedNeighbor.tags,
          },
          signal,
        );

      throwIfAborted(signal);

      await writeMemoryFile(
        link.targetFileName,
        updatedNeighbor,
        signal,
      );

      throwIfAborted(signal);

      loadedNeighbors.set(
        link.targetFileName,
        updatedNeighbor,
      );

      console.log(
        `Complement neighbor updated: ${link.targetFileName}`,
      );
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      /*
       * A normal neighbor failure is isolated so another complement neighbor
       * may still be evolved. Cancellation must never be isolated this way.
       */
      console.error(
        `Failed to update complement neighbor ${link.targetFileName}:`,
        error,
      );
    }
  }
}

async function readNonDuplicateNeighbors(
  links: MemoryLink[],
  signal?: AbortSignal,
): Promise<Map<string, MemoryNodeWithLinks>> {
  throwIfAborted(signal);

  const neighbors = new Map<string, MemoryNodeWithLinks>();

  const uniqueFileNames = [
    ...new Set(
      links
        .map((link) => link.targetFileName)
        .filter(Boolean),
    ),
  ];

  for (const fileName of uniqueFileNames) {
    throwIfAborted(signal);

    try {
      const memory = await readMemoryFile(fileName, signal);

      throwIfAborted(signal);

      neighbors.set(fileName, memory);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      console.error(
        `Failed to read neighbor ${fileName}:`,
        error,
      );
    }
  }

  return neighbors;
}

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

    const neighbor = loadedNeighbors.get(
      link.targetFileName,
    );

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

async function evolveNeighborWithLLM(
  newMemory: MemoryNodeWithLinks,
  targetNeighbor: MemoryNodeWithLinks,
  neighborContexts: NeighborContext[],
  signal?: AbortSignal,
): Promise<EvolvedNeighborFields> {
  throwIfAborted(signal);

  const model = await getAsyncLLM("cheap");

  throwIfAborted(signal);

  const structuredModel = model.withStructuredOutput(
    evolvedNeighborSchema,
  );

  const result = await structuredModel.invoke(
    [
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
    ],
    {
      signal,
    },
  );

  throwIfAborted(signal);

  return result;
}

function mergeMemoryLinks(
  links: MemoryLink[],
): MemoryLink[] {
  const linksByTargetId = new Map<string, MemoryLink>();

  for (const link of links) {
    if (!link.targetId || !link.targetFileName) {
      continue;
    }

    const existingLink = linksByTargetId.get(
      link.targetId,
    );

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

async function readAllMemoryFileNames(
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);

  const directoryExists = await exists(MEMORY_DIRECTORY, {
    baseDir: BaseDirectory.AppData,
  });

  throwIfAborted(signal);

  if (!directoryExists) {
    return [];
  }

  const entries = await readDir(MEMORY_DIRECTORY, {
    baseDir: BaseDirectory.AppData,
  });

  throwIfAborted(signal);

  return entries
    .filter(
      (entry) =>
        entry.isFile &&
        typeof entry.name === "string" &&
        entry.name.endsWith(".json"),
    )
    .map((entry) => entry.name);
}

async function readMemoryFile(
  fileName: string,
  signal?: AbortSignal,
): Promise<MemoryNodeWithLinks> {
  throwIfAborted(signal);

  const filePath = createMemoryFilePath(fileName);

  const fileExists = await exists(filePath, {
    baseDir: BaseDirectory.AppData,
  });

  throwIfAborted(signal);

  if (!fileExists) {
    throw new Error(
      `Memory file does not exist: ${fileName}`,
    );
  }

  const fileContent = await readTextFile(filePath, {
    baseDir: BaseDirectory.AppData,
  });

  throwIfAborted(signal);

  try {
    return JSON.parse(fileContent) as MemoryNodeWithLinks;
  } catch {
    throw new Error(
      `Memory file contains invalid JSON: ${fileName}`,
    );
  }
}

async function writeMemoryFile(
  fileName: string,
  memory: MemoryNodeWithLinks,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);

  const filePath = createMemoryFilePath(fileName);

  await writeTextFile(
    filePath,
    JSON.stringify(memory, null, 2),
    {
      baseDir: BaseDirectory.AppData,
    },
  );

  throwIfAborted(signal);
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