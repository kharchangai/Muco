// main-agent.ts

import {
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";

import { RunnableConfig } from "@langchain/core/runnables";

import {
  isAbortError,
  throwIfAborted,
} from "./agent/abort";

import {
  getTextContent,
  getToolResultText,
  stripMarkdown,
  dispatchAgentActivity,
} from "./agent/helpers";

import {
  getLongTermMemoryContextForAgent,
  getShortMemoryContextForAgent,
  processMessageMemoryInBackground,
  saveShortMemoryInBackground,
} from "./agent/memory-manager";

import {
  buildMainAgentSystemPrompt,
  buildToolResultSummaryPrompt,
} from "./agent/prompts";

import { GraphState } from "./state";
import { getAsyncLLM } from "./llm";

import { ToolExecutor } from "./agent/tool-executor";

import { scheduleTool } from "./tools/schedule-tool";
import { desktopVisionTool } from "./tools/desktop-vision-tool";
import { terminalExecutionTool } from "./tools/terminal_execution_tool";
import { perplexitySearchTool } from "./tools/perplexity_search_tool";

const MAX_STEPS = 3;

type ToolArgs = Record<string, unknown>;

const getStringArg = (
  args: ToolArgs,
  key: string,
): string => {
  const value = args[key];

  return typeof value === "string" ? value : "";
};

const createToolExecutor = (
  terminalTool: {
    invoke: (
      args: ToolArgs,
      config?: RunnableConfig,
    ) => Promise<unknown>;
  },
  state: typeof GraphState.State,
  config: RunnableConfig,
): ToolExecutor => {
  const toolExecutor = new ToolExecutor();

  toolExecutor.registerTool({
    name: "schedule_action",
    description:
      "Creates, updates, or manages schedule actions.",
    execute: async (args) => {
      const toolArgs = args as ToolArgs;

      return scheduleTool.invoke(
        {
          userRequest: getStringArg(
            toolArgs,
            "userRequest",
          ),
          chatHistory: state.messages,
        },
        config,
      );
    },
  });

  toolExecutor.registerTool({
    name: "desktop_vision_action",
    description:
      "Performs desktop vision actions.",
    execute: async (args) => {
      const toolArgs = args as ToolArgs;

      return desktopVisionTool.invoke(
        {
          userRequest: getStringArg(
            toolArgs,
            "userRequest",
          ),
        },
        config,
      );
    },
  });

  toolExecutor.registerTool({
    name: "terminal_intent_executor",
    description:
      "Executes a terminal task based on a user intent.",
    execute: async (args) => {
      const toolArgs = args as ToolArgs;

      return terminalTool.invoke(
        {
          intent: getStringArg(toolArgs, "intent"),
        },
        config,
      );
    },
  });

  toolExecutor.registerTool({
    name: "perplexity_search",
    description:
      "Searches the web using Perplexity.",
    execute: async (args) => {
      const toolArgs = args as ToolArgs;

      return perplexitySearchTool.invoke(
        {
          query: getStringArg(toolArgs, "query"),
        },
        config,
      );
    },
  });

  return toolExecutor;
};

export const callMainAgent = async (
  state: typeof GraphState.State,
  config?: RunnableConfig,
) => {
  const runnableConfig = config ?? {};
  const signal = runnableConfig.signal;

  throwIfAborted(signal);

  const lastMessage =
    state.messages[state.messages.length - 1];

  const userText = lastMessage
    ? getTextContent(lastMessage.content).trim()
    : "";

  const shortMemoryContext =
    await getShortMemoryContextForAgent(
      userText,
      signal,
    );

  processMessageMemoryInBackground(
    userText,
    signal,
  );

  const relevantMemoryContext =
    await getLongTermMemoryContextForAgent(
      userText,
      signal,
    );

  throwIfAborted(signal);

  const llm = await getAsyncLLM("expensive");

  throwIfAborted(signal);

  const terminalTool = terminalExecutionTool(llm);

  const llmWithTools = llm.bindTools([
    scheduleTool,
    desktopVisionTool,
    terminalTool,
    perplexitySearchTool,
  ]);

  const toolExecutor = createToolExecutor(
    terminalTool,
    state,
    runnableConfig,
  );

  const currentDateTime = new Date().toLocaleString(
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

  const systemPrompt = buildMainAgentSystemPrompt({
    shortMemoryContext,
    longTermMemoryContext: relevantMemoryContext,
    currentDateTime,
  });

  let messagesToRun: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    ...state.messages,
  ];

  let response = await llmWithTools.invoke(
    messagesToRun,
    runnableConfig,
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

    for (const toolCall of response.tool_calls) {
      throwIfAborted(signal);

      const toolCallId = toolCall.id;

      if (!toolCallId) {
        throw new Error(
          `Missing tool call ID for ${toolCall.name}.`,
        );
      }

      let toolResult = "";

      dispatchAgentActivity(toolCall.name);

      try {
        const rawToolResult = await toolExecutor.execute(
          toolCall.name,
          (toolCall.args ?? {}) as ToolArgs,
        );

        throwIfAborted(signal);

        toolResult = getToolResultText(rawToolResult);
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

      const normalizedToolResult =
        toolResult ||
        "Task completed successfully.";

      toolMessages.push(
        new ToolMessage({
          content: normalizedToolResult,
          tool_call_id: toolCallId,
          name: toolCall.name,
        }),
      );

      toolResultsSummary.push(
        `[Result from ${toolCall.name} in Step ${stepCount + 1}]: ${normalizedToolResult}`,
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
      runnableConfig,
    );

    throwIfAborted(signal);

    stepCount += 1;
  }

  if (toolResultsSummary.length > 0) {
    throwIfAborted(signal);

    const cleanContextPrompt =
      buildToolResultSummaryPrompt({
        originalUserRequest:
          userText || "the user's request",
        toolResultsSummary,
      });

    const cleanMessages: BaseMessage[] = [
      new SystemMessage(systemPrompt),
      ...state.messages,
      new HumanMessage(cleanContextPrompt),
    ];

    const plainLlm = await getAsyncLLM();

    throwIfAborted(signal);

    const finalResponse = await plainLlm.invoke(
      cleanMessages,
      runnableConfig,
    );

    throwIfAborted(signal);

    const finalContent = stripMarkdown(
      getTextContent(finalResponse.content),
    );

    response.content =
      finalContent ||
      "Task completed successfully.";
  } else {
    const finalContent = stripMarkdown(
      getTextContent(response.content),
    );

    response.content =
      finalContent ||
      "Task completed successfully.";
  }

  const completedMessages: BaseMessage[] = [
    ...state.messages,
    response,
  ];

  saveShortMemoryInBackground(
    completedMessages,
  );

  return {
    messages: [response],
  };
};