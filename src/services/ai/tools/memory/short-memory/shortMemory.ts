import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

import type { BaseMessage } from "@langchain/core/messages";

import { textSimilarity } from "../../textSimilarity";

const MEMORY_DIRECTORY = "memory";
const SHORT_MEMORY_DIRECTORY =
  `${MEMORY_DIRECTORY}/short-memory`;

export type ShortMemoryTurn = {
  id: string;
  createdAt: string;
  user: {
    content: string;
  };
  assistant: {
    content: string;
  };
  embedding: number[];
};

type ShortMemoryDailyFile = {
  date: string;
  turns: ShortMemoryTurn[];
};

/**
 * Appends one completed user/assistant turn to today's short-memory file.
 *
 * The user message and assistant response are combined into one text,
 * embedded, and saved with the rest of the turn data.
 */
export async function saveShortMemoryTurn(
  state: {
    messages: BaseMessage[];
  },
): Promise<void> {
  await ensureDirectory(SHORT_MEMORY_DIRECTORY);

  const date = getLocalDateKey();
  const filePath = `${SHORT_MEMORY_DIRECTORY}/${date}.json`;

  const dailyMemory = await readOrCreateDailyMemoryFile(
    filePath,
    date,
  );

  const turnData = createTurnDataFromState(state.messages);

  if (!turnData) {
    console.warn(
      "[Short Memory] A complete user/assistant turn was not found.",
    );

    return;
  }

  /*
   * The user message and assistant response are embedded together.
   * This creates one semantic vector for the complete conversation turn.
   */
  const embeddingText = createTurnEmbeddingText(
    turnData.user.content,
    turnData.assistant.content,
  );

  let embedding: number[];

  try {
    embedding = await textSimilarity.embedText(embeddingText);
  } catch (error) {
    console.error(
      "[Short Memory] Failed to create embedding for turn.",
      error,
    );

    return;
  }

  const turn: ShortMemoryTurn = {
    ...turnData,
    embedding,
  };

  dailyMemory.turns.push(turn);

  await writeTextFile(
    filePath,
    JSON.stringify(dailyMemory, null, 2),
    {
      baseDir: BaseDirectory.AppData,
    },
  );

  console.log(
    `[Short Memory] Turn saved with embedding: ${filePath}`,
  );
}

/**
 * Creates turn data without the embedding.
 */
function createTurnDataFromState(
  messages: BaseMessage[] | undefined,
): Omit<ShortMemoryTurn, "embedding"> | null {
  const userMessage = findLastMessageByType(
    messages,
    "human",
  );

  const assistantMessage = findLastMessageByType(
    messages,
    "ai",
  );

  const userContent = userMessage
    ? getTextContent(userMessage.content).trim()
    : "";

  const assistantContent = assistantMessage
    ? getTextContent(assistantMessage.content).trim()
    : "";

  if (!userContent || !assistantContent) {
    return null;
  }

  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    user: {
      content: userContent,
    },
    assistant: {
      content: assistantContent,
    },
  };
}

/**
 * Creates the text that will be sent to the embedding model.
 */
function createTurnEmbeddingText(
  userContent: string,
  assistantContent: string,
): string {
  return [
    `User: ${userContent}`,
    `Assistant: ${assistantContent}`,
  ].join("\n");
}

/**
 * Finds the latest message with the requested LangChain message type.
 *
 * `message.getType()` is deprecated in recent LangChain versions.
 * Use `message.type` instead.
 */
function findLastMessageByType(
  messages: BaseMessage[] | undefined,
  messageType: "human" | "ai",
): BaseMessage | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message.type === messageType) {
      return message;
    }
  }

  return undefined;
}

async function readOrCreateDailyMemoryFile(
  filePath: string,
  date: string,
): Promise<ShortMemoryDailyFile> {
  const fileExists = await exists(filePath, {
    baseDir: BaseDirectory.AppData,
  });

  if (!fileExists) {
    return {
      date,
      turns: [],
    };
  }

  const content = await readTextFile(filePath, {
    baseDir: BaseDirectory.AppData,
  });

  try {
    const parsed = JSON.parse(content) as Partial<ShortMemoryDailyFile>;

    if (!Array.isArray(parsed.turns)) {
      throw new Error("The turns field is invalid.");
    }

    return {
      date:
        typeof parsed.date === "string" && parsed.date
          ? parsed.date
          : date,
      turns: parsed.turns,
    };
  } catch (error) {
    console.error(
      `[Short Memory] Invalid JSON in ${filePath}. A new daily file will be created.`,
      error,
    );

    return {
      date,
      turns: [],
    };
  }
}

async function ensureDirectory(
  directoryPath: string,
): Promise<void> {
  const directoryExists = await exists(directoryPath, {
    baseDir: BaseDirectory.AppData,
  });

  if (directoryExists) {
    return;
  }

  await mkdir(directoryPath, {
    baseDir: BaseDirectory.AppData,
    recursive: true,
  });
}

/**
 * Uses the local date instead of UTC.
 */
function getLocalDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (
        item &&
        typeof item === "object" &&
        "text" in item &&
        typeof item.text === "string"
      ) {
        return item.text;
      }

      return "";
    })
    .filter(Boolean)
    .join(" ");
}