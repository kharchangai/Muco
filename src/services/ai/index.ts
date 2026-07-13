// src/services/ai/index.ts
import { HumanMessage } from "@langchain/core/messages";
import { workflow } from "./graph";

const app = workflow.compile();

const throwIfAborted = (
  signal?: AbortSignal,
): void => {
  if (signal?.aborted) {
    throw new DOMException(
      "The operation was cancelled.",
      "AbortError",
    );
  }
};

export const chatWithMocu = async (
  userInput: string,
  signal?: AbortSignal,
): Promise<string> => {
  throwIfAborted(signal);

  try {
    const cleanUserInput = userInput.trim();

    if (!cleanUserInput) {
      throw new Error("User input cannot be empty.");
    }

    const inputs = {
      messages: [
        new HumanMessage(cleanUserInput),
      ],
    };

    /*
     * Passing signal to LangGraph lets supported nodes and nested
     * LangChain calls stop when AbortController.abort() is called.
     */
    const finalState = await app.invoke(
      inputs,
      {
        signal,
      },
    );

    throwIfAborted(signal);

    if (
      !finalState.messages ||
      finalState.messages.length === 0
    ) {
      return "No messages returned from graph.";
    }

    const lastMessage =
      finalState.messages[
        finalState.messages.length - 1
      ];

    const content = lastMessage.content;

    if (typeof content === "string") {
      return content.trim();
    }

    if (Array.isArray(content)) {
      return content
        .map((block) => {
          if (typeof block === "string") {
            return block;
          }

          if (
            block &&
            typeof block === "object" &&
            "text" in block &&
            typeof block.text === "string"
          ) {
            return block.text;
          }

          return "";
        })
        .join("")
        .trim();
    }

    if (content === null || content === undefined) {
      return "";
    }

    return JSON.stringify(content);
  } catch (error: unknown) {
    /*
     * An interruption is expected behavior, not an AI failure.
     * Re-throw it so App.tsx can silently stop the current pipeline.
     */
    if (
      error instanceof DOMException &&
      error.name === "AbortError"
    ) {
      throw error;
    }

    if (
      error instanceof Error &&
      error.name === "AbortError"
    ) {
      throw error;
    }

    console.error("Error in Mocu Graph:", error);

    return "I encountered an error while processing your request.";
  }
};