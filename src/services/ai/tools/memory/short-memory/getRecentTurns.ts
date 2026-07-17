import {
  BaseDirectory,
  exists,
  readDir,
  readTextFile,
} from "@tauri-apps/plugin-fs";

export interface MemoryMessage {
  content: string;
}

export interface ShortTermTurn {
  id: string;
  createdAt: string;
  user: MemoryMessage;
  assistant: MemoryMessage;
  embedding?: number[];
}

export interface AgentHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

interface ShortTermMemoryFile {
  date: string;
  turns: ShortTermTurn[];
}

const SHORT_MEMORY_DIR = "memory/short-memory";
const REQUIRED_TURN_COUNT = 5;

function isDateMemoryFile(fileName: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.json$/.test(fileName);
}

function isValidTurn(value: unknown): value is ShortTermTurn {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const turn = value as Partial<ShortTermTurn>;

  return (
    typeof turn.id === "string" &&
    typeof turn.createdAt === "string" &&
    typeof turn.user?.content === "string" &&
    typeof turn.assistant?.content === "string"
  );
}

function isValidMemoryFile(value: unknown): value is ShortTermMemoryFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const memoryFile = value as Partial<ShortTermMemoryFile>;

  return (
    typeof memoryFile.date === "string" &&
    Array.isArray(memoryFile.turns)
  );
}

async function getAvailableMemoryFiles(): Promise<string[]> {
  const folderExists = await exists(SHORT_MEMORY_DIR, {
    baseDir: BaseDirectory.AppData,
  });

  if (!folderExists) {
    return [];
  }

  try {
    const entries = await readDir(SHORT_MEMORY_DIR, {
      baseDir: BaseDirectory.AppData,
    });

    return entries
      .filter((entry) => !entry.isDirectory && isDateMemoryFile(entry.name))
      .map((entry) => entry.name)
      .sort((first, second) => second.localeCompare(first));
  } catch (error) {
    console.error("Failed to read short-memory directory:", error);
    return [];
  }
}

async function readTurnsFromFile(fileName: string): Promise<ShortTermTurn[]> {
  const filePath = `${SHORT_MEMORY_DIR}/${fileName}`;

  try {
    const content = await readTextFile(filePath, {
      baseDir: BaseDirectory.AppData,
    });

    const parsed: unknown = JSON.parse(content);

    if (!isValidMemoryFile(parsed)) {
      console.warn(`Invalid memory file format: ${filePath}`);
      return [];
    }

    return parsed.turns.filter(isValidTurn);
  } catch (error) {
    console.error(`Failed to read memory file: ${filePath}`, error);
    return [];
  }
}

/**
 * Gets the latest stored conversation turns.
 * Returned turns are ordered from oldest to newest.
 * This function preserves internal memory data and is useful
 * for memory-layer operations.
 */
async function getLatestStoredTurns(
  limit: number,
): Promise<ShortTermTurn[]> {
  if (limit <= 0) {
    return [];
  }

  const files = await getAvailableMemoryFiles();

  if (files.length === 0) {
    return [];
  }

  const collectedTurns: ShortTermTurn[] = [];

  for (const fileName of files) {
    const turns = await readTurnsFromFile(fileName);

    collectedTurns.push(...turns);

    if (collectedTurns.length >= limit) {
      break;
    }
  }

  return collectedTurns
    .sort(
      (first, second) =>
        new Date(second.createdAt).getTime() -
        new Date(first.createdAt).getTime(),
    )
    .slice(0, limit)
    .reverse();
}

/**
 * Returns recent conversation history in a compact format
 * suitable for the main Agent / LLM.
 *
 * Internal fields such as id, embedding and createdAt are omitted
 * to avoid unnecessary tokens in the LLM context.
 *
 * Messages are ordered from oldest to newest.
 */
export async function getRecentTurns(
  limit: number = REQUIRED_TURN_COUNT,
): Promise<AgentHistoryMessage[]> {
  const turns = await getLatestStoredTurns(limit);

  return turns.flatMap((turn) => [
    {
      role: "user" as const,
      content: turn.user.content,
    },
    {
      role: "assistant" as const,
      content: turn.assistant.content,
    },
  ]);
}