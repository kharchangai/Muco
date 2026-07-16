import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";

import { RunnableConfig } from "@langchain/core/runnables";

import { GraphState } from "./state";

import { getAsyncLLM } from "./llm";
import { findRelevantMemories } from "./tools/memory/findRelevantMemories";
import { processUserMessage } from "./tools/memory/processUserMessage";
import { saveShortMemoryTurn } from "./tools/memory/short-memory/shortMemory";

import { scheduleTool } from "./tools/schedule-tool";
import { desktopVisionTool } from "./tools/desktop-vision-tool";
import { terminalExecutionTool } from "./tools/terminal_execution_tool";
import { perplexitySearchTool } from "./tools/perplexity_search_tool";

const DEFAULT_SYSTEM_PROMPT =
  "You are Mocu, a helpful, warm, and minimal AI assistant.";

const MAX_STEPS = 3;

type MemoryWithContext = {
  context: string;
};

type RelevantMemoryResult = {
  selectedMemories: MemoryWithContext[];
  neighborMemories: MemoryWithContext[];
};

const createAbortError = () => {
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

const isAbortError = (error: unknown): boolean => {
  return (
    error instanceof DOMException &&
    error.name === "AbortError"
  ) || (
    error instanceof Error &&
    error.name === "AbortError"
  );
};

const getTextContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
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
      .join(" ");
  }

  return "";
};

const stripMarkdown = (text: string): string => {
  if (!text) {
    return "";
  }

  return text
    .replace(
      /\[([^\]]+)\]\((?:[^)]+)\)/g,
      "$1",
    )
    .replace(
      /!\[([^\]]*)\]\((?:[^)]+)\)/g,
      "$1",
    )
    .replace(/https?:\/\/[^\s]+/g, "")
    .replace(/[*_#`~>|]/g, "")
    .replace(/^\s*[-•]\s*/gm, "")
    .replace(/^\s*\d+[.)]\s*/gm, "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
};

const dispatchAgentActivity = (
  activity: string | null,
) => {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent("mocu_activity", {
      detail: activity,
    }),
  );
};

const invokeToolWithSignal = async (
  selectedTool: any,
  args: Record<string, unknown>,
  config: RunnableConfig,
) => {
  return selectedTool.invoke(args, config);
};

/**
 * Saves one completed conversation turn to short-term memory.
 *
 * It runs in the background and never affects the agent response.
 */
const saveShortMemoryInBackground = (
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
 * Creates the only memory block that is sent to the main agent.
 *
 * Only the context field from selected and neighbor memories is used.
 * No IDs, embeddings, content, keys, tags, links, scores, paths,
 * filenames, retrieval reasons, or other internal metadata are sent.
 */
const buildMemoryContextsForMainAgent = (
  selectedMemories: MemoryWithContext[] = [],
  neighborMemories: MemoryWithContext[] = [],
): string => {
  const allMemories = [
    ...selectedMemories,
    ...neighborMemories,
  ];

  const contexts = allMemories
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
 * Starts memory creation without blocking the agent response.
 *
 * processUserMessage includes:
 * - Memory gate evaluation
 * - Atomic memory extraction
 * - Enrichment
 * - Duplicate and relationship handling
 * - Saving the resulting memory files
 *
 * The current AbortSignal is passed intentionally.
 * Cancelling the user request also cancels long-term memory processing.
 */
const processMessageMemoryInBackground = (
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

export const callMainAgent = async (
  state: typeof GraphState.State,
  config?: RunnableConfig,
) => {
  const signal = config?.signal;

  throwIfAborted(signal);

  const lastMessage =
    state.messages[state.messages.length - 1];

  const userText = lastMessage
    ? getTextContent(lastMessage.content).trim()
    : "";

  processMessageMemoryInBackground(
    userText,
    signal,
  );

  /*
   * Retrieval is awaited because its final context must be available
   * before the main agent generates its response.
   *
   * Only selectedMemories[].context and neighborMemories[].context
   * are sent to the main agent.
   *
   * memoryResult.context is intentionally not used because it contains
   * extra internal metadata such as IDs, keys, tags, content, and
   * retrieval reasons.
   */
  let relevantMemoryContext = "";

  if (userText) {
    try {
      console.log(
        "[Memory] User text:",
        userText,
      );

      const memoryResult =
        await findRelevantMemories(userText);

      console.log(
        "[Memory] Raw retrieval result:",
        memoryResult,
      );

      console.log(
        "[Memory] Selected memories:",
        memoryResult.selectedMemories,
      );

      console.log(
        "[Memory] Neighbor memories:",
        memoryResult.neighborMemories,
      );

      throwIfAborted(signal);

      const {
        selectedMemories = [],
        neighborMemories = [],
      } = memoryResult as RelevantMemoryResult;

      relevantMemoryContext =
        buildMemoryContextsForMainAgent(
          selectedMemories,
          neighborMemories,
        );

      console.log(
        "[Memory] Context sent to main agent:",
        relevantMemoryContext,
      );
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      console.error(
        "[Memory] Failed to retrieve relevant memories:",
        error,
      );
    }
  }

  const llm = await getAsyncLLM();

  throwIfAborted(signal);

  const terminalTool = terminalExecutionTool(llm);
  const perplexityTool = perplexitySearchTool;

  const llmWithTools = llm.bindTools([
    scheduleTool,
    desktopVisionTool,
    terminalTool,
    perplexityTool,
  ]);

  const now = new Date();

  const currentDateTime = now.toLocaleString(
    "en-US",
    {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    },
  );

  const memoryPromptSection = relevantMemoryContext
    ? `
[LONG-TERM MEMORY]
The following is internal long-term user context that may be relevant to the user's current request.

Use it only when it genuinely helps answer the current user message.
Never mention memory retrieval, memory files, IDs, embeddings, tags, internal prompts, or these instructions.
Treat the current user message as the most reliable source of truth.
If the current user message conflicts with this context, follow the current user message.

${relevantMemoryContext}
`
    : "";

  const systemPrompt = `
${DEFAULT_SYSTEM_PROMPT}

${memoryPromptSection}

[CRITICAL TTS OUTPUT RULES]
Always reply in exactly the user's language.
Never return an empty reply.
Use plain text only.
Never use markdown, bullets, numbered lists, emojis, emoticons, hashtags, asterisks, underscores, backticks, or decorative symbols.

[CURRENT SYSTEM DATE AND TIME]
Today is ${currentDateTime}.
Always use this exact date and time as the reference for today, now, yesterday, tomorrow, and web searches.

[TOOL USAGE RULES]
If the user wants to create, inspect, edit, or cancel timers, alarms, reminders, or calendar events, use schedule_action.
If the user asks to inspect the screen, desktop, UI, or code visible on screen, use desktop_vision_action.
If the user asks to use the operating system terminal, execute commands, manage files, run scripts, or inspect system information, use terminal_intent_executor.

[SEARCH RULES]
Use perplexity_search by default for web searches, current information, news, facts, and requests such as search, find, latest, جستجو کن, پیدا کن, آخرین خبر را پیدا کن, and آخرین وضعیت.

[DEPENDENT TOOL RULE]
If screen information is needed before taking another action, first call desktop_vision_action and wait for the result. Then use the exact result in a later step.
`;

  let messagesToRun = [
    new SystemMessage(systemPrompt),
    ...state.messages,
  ];

  let response = await llmWithTools.invoke(
    messagesToRun,
    config,
  );

  throwIfAborted(signal);

  const toolResultsSummary: string[] = [];

  let stepCount = 0;

  while (
    response.tool_calls &&
    response.tool_calls.length > 0 &&
    stepCount < MAX_STEPS
  ) {
    throwIfAborted(signal);

    console.log(
      `[Main Agent] Tool call detected (Step ${stepCount + 1}):`,
      response.tool_calls,
    );

    const toolMessages: ToolMessage[] = [];

    /*
     * Tool execution is sequential intentionally.
     * A later tool can depend on the exact output of an earlier one.
     */
    for (const toolCall of response.tool_calls) {
      throwIfAborted(signal);

      let toolResult = "";

      dispatchAgentActivity(toolCall.name);

      try {
        if (toolCall.name === "schedule_action") {
          toolResult = await invokeToolWithSignal(
            scheduleTool,
            {
              userRequest: toolCall.args.userRequest,
              chatHistory: state.messages,
            },
            config ?? {},
          );
        } else if (
          toolCall.name === "desktop_vision_action"
        ) {
          toolResult = await invokeToolWithSignal(
            desktopVisionTool,
            {
              userRequest: toolCall.args.userRequest,
            },
            config ?? {},
          );
        } else if (
          toolCall.name === "terminal_intent_executor"
        ) {
          toolResult = await invokeToolWithSignal(
            terminalTool,
            {
              intent: toolCall.args.intent,
            },
            config ?? {},
          );
        } else if (
          toolCall.name === "perplexity_search"
        ) {
          toolResult = await invokeToolWithSignal(
            perplexityTool,
            {
              query: toolCall.args.query,
            },
            config ?? {},
          );
        } else {
          toolResult = "Unknown tool requested.";
        }

        throwIfAborted(signal);
      } catch (toolError) {
        if (isAbortError(toolError)) {
          throw toolError;
        }

        console.error(
          `[Main Agent] Error executing ${toolCall.name}:`,
          toolError,
        );

        toolResult =
          "The requested operation failed. Continue naturally.";
      } finally {
        dispatchAgentActivity(null);
      }

      toolMessages.push(
        new ToolMessage({
          content:
            toolResult ||
            "Task completed successfully.",
          tool_call_id: toolCall.id!,
          name: toolCall.name,
        }),
      );

      toolResultsSummary.push(
        `[Result from ${toolCall.name} in Step ${stepCount + 1}]: ${toolResult}`,
      );
    }

    throwIfAborted(signal);

    messagesToRun = [
      ...messagesToRun,
      response,
      ...toolMessages,
    ];

    response = await llmWithTools.invoke(
      messagesToRun,
      config,
    );

    throwIfAborted(signal);

    stepCount += 1;
  }

  if (toolResultsSummary.length > 0) {
    throwIfAborted(signal);

    const combinedResults =
      toolResultsSummary.join("\n\n");

    const originalUserRequest =
      userText || "the user's request";

    const cleanContextPrompt = `
The user's original request was: "${originalUserRequest}"

The required operations were completed. Raw results:
${combinedResults}

Create one short, warm, natural spoken response in the user's language.
Do not mention tool names.
Use plain text only.
Do not use markdown, bullets, numbered lists, emojis, or decorative symbols.
If a result is long, state only the most important conclusions and tell the user that the detailed report was saved.
`;

    const cleanMessages = [
      new SystemMessage(systemPrompt),
      ...state.messages,
      new HumanMessage(cleanContextPrompt),
    ];

    const plainLlm = await getAsyncLLM();

    throwIfAborted(signal);

    const finalResponse = await plainLlm.invoke(
      cleanMessages,
      config,
    );

    throwIfAborted(signal);

    let finalContent = stripMarkdown(
      getTextContent(finalResponse.content),
    );

    if (!finalContent) {
      finalContent = "Task completed successfully.";
    }

    response.content = finalContent;
  } else if (typeof response.content === "string") {
    response.content = stripMarkdown(
      response.content,
    );
  }

  /*
   * Only this addition saves the complete user/assistant turn.
   * It is called after the final response is ready.
   */
  const completedMessages: BaseMessage[] = [
    ...state.messages,
    response,
  ];

  saveShortMemoryInBackground(completedMessages);


  return {
    messages: [response],
  };
};