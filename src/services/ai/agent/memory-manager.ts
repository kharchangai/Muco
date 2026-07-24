import {
  BaseMessage,
} from "@langchain/core/messages";

import {
  isAbortError,
  throwIfAborted,
} from "./abort";

import {
  getTextContent,
  isRecord,
} from "./helpers";

import { findRelevantMemories } from "../tools/memory/findRelevantMemories";
import { processUserMessage } from "../tools/memory/processUserMessage";
import { saveShortMemoryTurn } from "../tools/memory/short-memory/shortMemory";
import { getMemoryForAgent } from "../tools/memory/short-memory/memoryGate";

export type MemoryWithContext = {
  context: string;
};

export type RelevantMemoryResult = {
  selectedMemories?: MemoryWithContext[];
  neighborMemories?: MemoryWithContext[];
};

export type ShortMemoryRole =
  | "user"
  | "assistant"
  | "human"
  | "ai";

export type ShortMemoryMessage = {
  role?: ShortMemoryRole;
  type?: ShortMemoryRole;
  content?: unknown;
  createdAt?: string;
  userContent?: string;
  assistantContent?: string;
};

export type ShortMemoryGateResult = {
  messages?: unknown[];
  decision?: {
    useRecentTurns?: boolean;
    recentTurnCount?: number;
    useRelevantMemorySearch?: boolean;
    reason?: string;
  };
};

/**
 * Saves a completed conversation turn in the background.
 *
 * This operation never blocks the final agent response.
 */
export const saveShortMemoryInBackground = (
  messages: BaseMessage[],
): void => {
  void saveShortMemoryTurn({ messages })
    .then(() => {
      console.log(
        "[Short Memory] Turn saved successfully.",
      );
    })
    .catch((error) => {
      console.error(
        "[Short Memory] Failed to save turn:",
        error,
      );
    });
};

/**
 * Creates the long-term memory block sent to the main agent.
 *
 * Only memory contexts are returned.
 * Internal IDs, tags, embeddings, scores, paths, and metadata are not
 * included in the final prompt context.
 */
export const buildMemoryContextsForMainAgent = (
  selectedMemories: MemoryWithContext[] = [],
  neighborMemories: MemoryWithContext[] = [],
): string => {
  const contexts = [
    ...selectedMemories,
    ...neighborMemories,
  ]
    .map((memory) => memory.context?.trim())
    .filter(
      (context): context is string =>
        typeof context === "string" &&
        context.length > 0,
    );

  if (contexts.length === 0) {
    return "";
  }

  return contexts
    .map(
      (context, index) =>
        `[Memory Context ${index + 1}]\n${context}`,
    )
    .join("\n\n");
};

/**
 * Converts supported message roles to the two roles that are sent to
 * the main agent.
 */
export const normalizeShortMemoryRole = (
  role: unknown,
): "user" | "assistant" | null => {
  if (role === "user" || role === "human") {
    return "user";
  }

  if (role === "assistant" || role === "ai") {
    return "assistant";
  }

  return null;
};

/**
 * Extracts short-memory messages from direct or nested search results.
 *
 * Supported formats:
 *
 * {
 *   role: "user",
 *   content: "..."
 * }
 *
 * {
 *   userContent: "...",
 *   assistantContent: "..."
 * }
 *
 * {
 *   messages: [...]
 * }
 */
export const extractShortMemoryMessages = (
  value: unknown,
): ShortMemoryMessage[] => {
  const extractedMessages: ShortMemoryMessage[] = [];
  const visited = new Set<object>();

  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) {
        visit(child);
      }

      return;
    }

    if (!isRecord(item)) {
      return;
    }

    if (visited.has(item)) {
      return;
    }

    visited.add(item);

    const role = normalizeShortMemoryRole(
      item.role ?? item.type,
    );

    const content = getTextContent(item.content);
    const createdAt =
      typeof item.createdAt === "string"
        ? item.createdAt
        : undefined;

    if (role && content.trim()) {
      extractedMessages.push({
        role,
        content: content.trim(),
        createdAt,
      });
    }

    const userContent =
      typeof item.userContent === "string"
        ? item.userContent.trim()
        : "";

    if (userContent) {
      extractedMessages.push({
        role: "user",
        content: userContent,
        createdAt,
      });
    }

    const assistantContent =
      typeof item.assistantContent === "string"
        ? item.assistantContent.trim()
        : "";

    if (assistantContent) {
      extractedMessages.push({
        role: "assistant",
        content: assistantContent,
        createdAt,
      });
    }

    if (Array.isArray(item.messages)) {
      visit(item.messages);
    }
  };

  visit(value);

  return extractedMessages;
};

/**
 * Removes duplicate short-memory messages while preserving the original
 * order of the first occurrence.
 */
export const removeDuplicateShortMemoryMessages = (
  messages: ShortMemoryMessage[],
): ShortMemoryMessage[] => {
  const seen = new Set<string>();
  const uniqueMessages: ShortMemoryMessage[] = [];

  for (const message of messages) {
    const role = normalizeShortMemoryRole(
      message.role ?? message.type,
    );

    const content = getTextContent(
      message.content,
    ).trim();

    if (!role || !content) {
      continue;
    }

    const key = [
      role,
      content,
      message.createdAt ?? "",
    ].join("::");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    uniqueMessages.push({
      role,
      content,
      createdAt: message.createdAt,
    });
  }

  return uniqueMessages;
};

/**
 * Converts retrieved short-memory messages into a safe prompt context.
 *
 * Only user content, assistant content, and optional dates are included.
 * Internal metadata is intentionally omitted.
 */
export const buildShortMemoryContextForMainAgent = (
  result: ShortMemoryGateResult,
): string => {
  const extractedMessages =
    extractShortMemoryMessages(result.messages);

  const validMessages =
    removeDuplicateShortMemoryMessages(
      extractedMessages,
    );

  if (validMessages.length === 0) {
    return "";
  }

  return validMessages
    .map((message) => {
      const role =
        message.role === "user"
          ? "User"
          : "Assistant";

      const content = getTextContent(
        message.content,
      ).trim();

      const date =
        typeof message.createdAt === "string" &&
        message.createdAt.trim()
          ? `\nDate: ${message.createdAt.trim()}`
          : "";

      return `${role}: ${content}${date}`;
    })
    .join("\n\n");
};

/**
 * Retrieves relevant short-term conversation context for the main agent.
 *
 * Any retrieval failure returns an empty context so memory failures never
 * prevent the user from receiving an answer.
 */
export const getShortMemoryContextForAgent = async (
  userText: string,
  signal?: AbortSignal,
): Promise<string> => {
  if (!userText.trim()) {
    return "";
  }

  try {
    throwIfAborted(signal);

    console.log(
      "[Short Memory] Running memory gate for:",
      userText,
    );

    const rawShortMemoryResult =
      await getMemoryForAgent(userText);

    throwIfAborted(signal);

    const shortMemoryResult =
      rawShortMemoryResult as ShortMemoryGateResult;

    console.log(
      "[Short Memory] Gate decision:",
      shortMemoryResult.decision,
    );

    console.log(
      "[Short Memory] Retrieved result:",
      shortMemoryResult,
    );

    console.log(
      "[Short Memory] Retrieved messages:",
      shortMemoryResult.messages,
    );

    const extractedMessages =
      extractShortMemoryMessages(
        shortMemoryResult.messages,
      );

    console.log(
      "[Short Memory] Extracted messages:",
      extractedMessages,
    );

    const shortMemoryContext =
      buildShortMemoryContextForMainAgent(
        shortMemoryResult,
      );

    if (shortMemoryContext) {
      console.log(
        "[Short Memory] Context prepared for main agent:",
        shortMemoryContext,
      );
    } else {
      console.log(
        "[Short Memory] No context found for main agent.",
      );
    }

    return shortMemoryContext;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    console.error(
      "[Short Memory] Failed to get memory for agent:",
      error,
    );

    return "";
  }
};

/**
 * Retrieves relevant long-term memory context for the main agent.
 *
 * Any retrieval failure returns an empty context so memory failures never
 * prevent the user from receiving an answer.
 */
export const getLongTermMemoryContextForAgent = async (
  userText: string,
  signal?: AbortSignal,
): Promise<string> => {
  if (!userText.trim()) {
    return "";
  }

  try {
    throwIfAborted(signal);

    console.log(
      "[Memory] User text:",
      userText,
    );

    const memoryResult =
      await findRelevantMemories(userText);

    throwIfAborted(signal);

    console.log(
      "[Memory] Raw retrieval result:",
      memoryResult,
    );

    const {
      selectedMemories = [],
      neighborMemories = [],
    } = memoryResult as RelevantMemoryResult;

    console.log(
      "[Memory] Selected memories:",
      selectedMemories,
    );

    console.log(
      "[Memory] Neighbor memories:",
      neighborMemories,
    );

    const relevantMemoryContext =
      buildMemoryContextsForMainAgent(
        selectedMemories,
        neighborMemories,
      );

    if (relevantMemoryContext) {
      console.log(
        "[Memory] Context sent to main agent:",
        relevantMemoryContext,
      );
    } else {
      console.log(
        "[Memory] No long-term context found.",
      );
    }

    return relevantMemoryContext;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    console.error(
      "[Memory] Failed to retrieve relevant memories:",
      error,
    );

    return "";
  }
};

/**
 * Starts long-term memory processing without blocking the agent response.
 *
 * If the user cancels the request, memory processing is cancelled too.
 */
export const processMessageMemoryInBackground = (
  userText: string,
  signal?: AbortSignal,
): void => {
  if (!userText.trim() || signal?.aborted) {
    return;
  }

  void processUserMessage(userText, signal)
    .then((result) => {
      console.log(
        "[Memory] Background processing completed:",
        result,
      );
    })
    .catch((error) => {
      if (isAbortError(error)) {
        console.log(
          "[Memory] Background processing cancelled.",
        );

        return;
      }

      console.error(
        "[Memory] Background processing failed:",
        error,
      );
    });
};