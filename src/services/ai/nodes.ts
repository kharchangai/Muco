import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";

import { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { GraphState } from "./state";

import {
  getAsyncLLM,
  memoryTool,
} from "./tools/memory_tools";

import { scheduleTool } from "./tools/schedule-tool";
import { desktopVisionTool } from "./tools/desktop-vision-tool";
import { synthesizerTool } from "./tools/prompt_generator_agent";
import { terminalExecutionTool } from "./tools/terminal_execution_tool";
import { perplexitySearchTool } from "./tools/perplexity_search_tool";
import { executeResearchPipeline } from "./tools/researchTool/pipeline";

import {
  exists,
  readTextFile,
} from "@tauri-apps/plugin-fs";

import { BaseDirectory } from "@tauri-apps/api/path";

let cachedPromptInMemory: string | null = null;

const DEFAULT_SYSTEM_PROMPT =
  "You are Mocu, a helpful, warm, and minimal AI assistant.";

const MAX_STEPS = 3;

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
    .replace(/!\[([^\]]*)\]\((?:[^)]+)\)/g, "$1")
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

export const callMainAgent = async (
  state: typeof GraphState.State,
  config?: RunnableConfig,
) => {
  const signal = config?.signal;

  throwIfAborted(signal);

  const llm = await getAsyncLLM();

  throwIfAborted(signal);

  const personalizationTool = synthesizerTool(llm);
  const terminalTool = terminalExecutionTool(llm);
  const perplexityTool = perplexitySearchTool;

  const researchTool = tool(
    async (args) => {
      throwIfAborted(signal);

      /*
       * To physically cancel this pipeline too, update
       * executeResearchPipeline to accept signal as its third argument
       * and pass it to every internal fetch/tool request.
       */
      const result = await executeResearchPipeline(
        args.query,
        args.sourceFolderPath || undefined,
        signal,
      );

      throwIfAborted(signal);

      return (
        result ||
        "Research completed, but no report was returned."
      );
    },
    {
      name: "execute_research_pipeline",
      description:
        "Run an in-depth autonomous research pipeline on a specific query or goal. Optionally analyze a local folder path if provided.",
      schema: z.object({
        query: z
          .string()
          .describe("The main research goal or query."),
        sourceFolderPath: z
          .string()
          .optional()
          .describe(
            "Absolute local source folder path, if provided by the user.",
          ),
      }),
    },
  );

  const llmWithTools = llm.bindTools([
    scheduleTool,
    memoryTool,
    desktopVisionTool,
    personalizationTool,
    terminalTool,
    perplexityTool,
    researchTool,
  ]);

  const cachePath =
    "memory/observer/personalized_prompt.txt";

  if (!cachedPromptInMemory) {
    try {
      throwIfAborted(signal);

      const cacheExists = await exists(
        cachePath,
        {
          baseDir: BaseDirectory.AppData,
        },
      );

      throwIfAborted(signal);

      if (cacheExists) {
        cachedPromptInMemory = await readTextFile(
          cachePath,
          {
            baseDir: BaseDirectory.AppData,
          },
        );
      } else {
        cachedPromptInMemory =
          DEFAULT_SYSTEM_PROMPT;
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      console.warn(
        "[Main Agent] Failed to read cached personalized prompt:",
        error,
      );

      cachedPromptInMemory =
        DEFAULT_SYSTEM_PROMPT;
    }
  }

  throwIfAborted(signal);

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

  const systemPrompt = `
${cachedPromptInMemory}

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
If the user shares personal facts or preferences, or asks to remember or recall something personal, use memory_action.
If the user asks to inspect the screen, desktop, UI, or code visible on screen, use desktop_vision_action.
If significant personal preferences, emotional state, or crucial personal information changes, use generate_personalized_prompt.
If the user asks to use the operating system terminal, execute commands, manage files, run scripts, or inspect system information, use terminal_intent_executor.

[SEARCH AND RESEARCH RULES]
Use perplexity_search by default for web searches, current information, news, facts, and requests such as search, find, latest, جستجو کن, پیدا کن, آخرین خبر را پیدا کن, and آخرین وضعیت.
Use execute_research_pipeline only for explicit deep research, comprehensive analysis, multi-source verification, or analysis of a local folder.
When a deep research request has no local folder, call execute_research_pipeline with an empty sourceFolderPath.
Ask for a folder path only if the user explicitly wants their own local files analyzed but did not provide a path.
When uncertain between search and research, choose perplexity_search.

[DEPENDENT TOOL RULE]
If screen information is needed before saving a memory, first call desktop_vision_action and wait for the result. Then call memory_action in a later step using the exact result.
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
     * Tools execute sequentially intentionally.
     * It prevents race conditions such as vision and memory running
     * simultaneously when memory depends on screen data.
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
        } else if (toolCall.name === "memory_action") {
          toolResult = await invokeToolWithSignal(
            memoryTool,
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
          toolCall.name === "generate_personalized_prompt"
        ) {
          toolResult = await invokeToolWithSignal(
            personalizationTool,
            {
              recentMessages:
                toolCall.args.recentMessages,
            },
            config ?? {},
          );

          if (
            toolResult &&
            !toolResult.startsWith("Error") &&
            !toolResult.startsWith("Failed")
          ) {
            cachedPromptInMemory = toolResult;
          }
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
        } else if (
          toolCall.name === "execute_research_pipeline"
        ) {
          toolResult = await invokeToolWithSignal(
            researchTool,
            {
              query: toolCall.args.query,
              sourceFolderPath:
                toolCall.args.sourceFolderPath || "",
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

    const lastMessage =
      state.messages[state.messages.length - 1];

    const originalUserRequest = lastMessage
      ? getTextContent(lastMessage.content)
      : "the user's request";

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

  return {
    messages: [response],
  };
};