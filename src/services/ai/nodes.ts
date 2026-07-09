import { SystemMessage, ToolMessage, HumanMessage } from "@langchain/core/messages";
import { GraphState } from "./state";
import { getAsyncLLM } from "./tools/memory_tools"; 
import { scheduleTool } from "./tools/schedule-tool";
import { memoryTool } from "./tools/memory_tools"; 
import { desktopVisionTool } from "./tools/desktop-vision-tool";
import { synthesizerTool } from "./tools/prompt_generator_agent";
import { terminalExecutionTool } from "./tools/terminal_execution_tool";
import { perplexitySearchTool } from "./tools/perplexity_search_tool"; // Updated import

// Import Langchain tool utilities and new pipeline
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { executeResearchPipeline } from "./tools/researchTool/pipeline";

// Import Tauri v2 FS APIs
import { readTextFile, exists } from '@tauri-apps/plugin-fs';
import { BaseDirectory } from '@tauri-apps/api/path';

// In-memory cache for speed
let cachedPromptInMemory: string | null = null;

// Helper function to strip markdown so TTS doesn't crash
const stripMarkdown = (text: string) => {
  if (!text) return "";
  return text
    .replace(/[*_#`~]/g, '') // Remove asterisks, hashtags, backticks, etc.
    .replace(/- /g, ', ')    // Convert list dashes to commas for natural pauses
    .trim();
};

const dispatchAgentActivity = (activity: string | null) => {
  if (typeof window !== "undefined") {
    const event = new CustomEvent("mocu_activity", { detail: activity });
    window.dispatchEvent(event);
  }
};

export const callMainAgent = async (state: typeof GraphState.State) => {
  const llm = await getAsyncLLM();

  // Create the tools
  const personalizationTool = synthesizerTool(llm);
  const terminalTool = terminalExecutionTool(llm);
  const perplexityTool = perplexitySearchTool; // Dynamically reads settings internally

  // Wrap the pipeline as a Langchain tool (without passing manual API key)
  const researchTool = tool(
    async (args) => {
      const result = await executeResearchPipeline(
        args.query,
        args.sourceFolderPath || undefined
      );
      return result || "Research completed, but no report was returned.";
    },
    {
      name: "execute_research_pipeline",
      description: "Run an in-depth autonomous research pipeline on a specific query or goal. Highly accurate. Optionally analyzes a local folder path if provided.",
      schema: z.object({
        query: z.string().describe("The main research goal or query."),
        sourceFolderPath: z.string().optional().describe("Absolute path to the local folder containing source files, if provided by the user.")
      })
    }
  );

  // Bind all tools including the updated research tool
  const llmWithTools = llm.bindTools([
    scheduleTool, 
    memoryTool, 
    desktopVisionTool, 
    personalizationTool,
    terminalTool,
    perplexityTool,
    researchTool
  ]);

  const cacheDir = "memory/observer";
  const cacheFile = "personalized_prompt.txt";
  const cachePath = `${cacheDir}/${cacheFile}`;

  // Read cached prompt only once at startup
  if (!cachedPromptInMemory) {
    try {
      const cacheExists = await exists(cachePath, { baseDir: BaseDirectory.AppData });
      if (cacheExists) {
        cachedPromptInMemory = await readTextFile(cachePath, { baseDir: BaseDirectory.AppData });
      } else {
        cachedPromptInMemory = "You are Mocu, a helpful, warm, and minimal AI assistant.";
      }
    } catch (error) {
      console.warn("[Main Agent] Failed to read cached personalized prompt:", error);
      cachedPromptInMemory = "You are Mocu, a helpful, warm, and minimal AI assistant.";
    }
  }

  // Generate Dynamic Current Date and Time
  const now = new Date();
  const currentDateTime = now.toLocaleString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric',
    hour: '2-digit', 
    minute: '2-digit' 
  });

  // Assemble the final system prompt
  const systemPrompt = `
    ${cachedPromptInMemory}
    
    [CURRENT SYSTEM DATE AND TIME]:
    - Today is: ${currentDateTime}
    - ALWAYS use this exact date and time as your reference for "today", "now", "yesterday", "tomorrow", or when doing web searches.
    
    [TOOL USAGE RULES]:
    - If the user wants to set, check, read, or cancel any timers, alarms, reminders, or calendar events, use the "schedule_action" tool.
    - If the user shares personal facts, preferences, or asks you to remember or recall something about them, use the "memory_action" tool.
    - If the user asks you to look at their screen, analyze their desktop, debug code visible on screen, or explain UI elements, use the "desktop_vision_action" tool.
    - If you notice a significant shift in the user's emotional state, a change in their goals/preferences, or when they share crucial new personal details, use the "generate_personalized_prompt" tool to update your personality and behavior accordingly.
    - If the user wants to interact with the OS terminal, run commands, manage files, check system status, create/edit files, run scripts, or check system time/date, use the "terminal_intent_executor" tool.

    👇 [SEARCH vs RESEARCH — CRITICAL DECISION RULE]:
    - Use "perplexity_search" ONLY for extremely simple, single-fact, throwaway questions that need a one-line answer (e.g., "current weather", "what time is it in Tokyo", "who is the president of X", "score of yesterday's match"). This tool is shallow and fast, but NOT accurate for complex or important topics.
    
    - Use "execute_research_pipeline" for EVERYTHING ELSE that requires depth, accuracy, or multi-step reasoning, including:
      • When the user explicitly says words like "research", "تحقیق کن", "دقیق بررسی کن", "تحلیل کن", "بررسی کامل کن".
      • When the user asks a question that needs a PRECISE, well-verified, or detailed answer (not just a quick guess).
      • When the user wants analysis of stocks, markets, news trends, technical/complex topics, or multi-source verification.
      • When the user wants their local files/folder analyzed.
    
    - CRITICAL: The "execute_research_pipeline" accepts an OPTIONAL "sourceFolderPath":
      • If the user explicitly gives a folder path OR says "analyze my files/folder", pass that absolute path as "sourceFolderPath".
      • If the user is just asking a deep/precise question WITHOUT mentioning any local files or folder, call "execute_research_pipeline" anyway and pass "sourceFolderPath" as an empty string (""). The tool is capable of researching purely from the web/autonomous search in that case — DO NOT ask the user for a folder path unless they clearly mean local file analysis.
      • Only ask the user for the folder path if they explicitly say something like "تحلیل فایل‌های من" or "تحقیق روی اسناد من" but forgot to give the path.
    
    - TIE-BREAKER RULE: If you are unsure whether a question needs a quick search or deep research, ALWAYS prefer "execute_research_pipeline". Depth and accuracy matter more than speed.

    [CRITICAL RULE FOR MULTIPLE TOOLS (STEP-BY-STEP REASONING)]:
    - NEVER call "memory_action" and "desktop_vision_action" at the exact same time if the memory depends on what is on the screen.
    - If you need to look at the screen to find information (like a movie name) BEFORE saving it, you MUST do it in two steps:
      Step 1: ONLY call "desktop_vision_action" to get the exact information.
      Step 2: WAIT for the vision tool to return the result.
      Step 3: THEN, call "memory_action" using the exact and accurate data you just received.
    
    [CRITICAL OUTPUT FORMAT RULES FOR TEXT-TO-SPEECH (TTS)]:
    - ALWAYS reply in the exact language the user is speaking (e.g., Persian/Farsi).
    - NEVER return an empty response. You MUST talk to the user.
    - NEVER use any markdown formatting. Absolutely NO asterisks (* or **), NO hashtags (#), NO underscores, and NO backticks.
    - NEVER use bullet points, dashes (-), or numbered lists.
    - NEVER use any emojis, emoticons, or special graphic characters as they cause errors in TTS processing. Use only plain text.
  `;

  let messagesToRun = [new SystemMessage(systemPrompt), ...state.messages];
  
  let response = await llmWithTools.invoke(messagesToRun);

  const toolResultsSummary: string[] = [];
  
  let stepCount = 0;
  const MAX_STEPS = 3;

  while (response.tool_calls && response.tool_calls.length > 0 && stepCount < MAX_STEPS) {
    console.log(`[Main Agent] Tool call detected (Step ${stepCount + 1}):`, response.tool_calls);
    
    const toolMessages: ToolMessage[] = [];
    
    for (const toolCall of response.tool_calls) {
      let toolResult = "";

      dispatchAgentActivity(toolCall.name);

      try {
        if (toolCall.name === "schedule_action") {
          toolResult = await scheduleTool.invoke({ userRequest: toolCall.args.userRequest, chatHistory: state.messages });
        } else if (toolCall.name === "memory_action") {
          toolResult = await memoryTool.invoke({ userRequest: toolCall.args.userRequest, chatHistory: state.messages });
        } else if (toolCall.name === "desktop_vision_action") {
          toolResult = await desktopVisionTool.invoke({ userRequest: toolCall.args.userRequest });
        } else if (toolCall.name === "generate_personalized_prompt") {
          toolResult = await personalizationTool.invoke({ recentMessages: toolCall.args.recentMessages });
          if (toolResult && !toolResult.startsWith("Error") && !toolResult.startsWith("Failed")) {
            cachedPromptInMemory = toolResult;
          }
        } else if (toolCall.name === "terminal_intent_executor") {
          toolResult = await terminalTool.invoke({ intent: toolCall.args.intent });
        } else if (toolCall.name === "perplexity_search") {
          toolResult = await perplexityTool.invoke({ query: toolCall.args.query });
        } 
        else if (toolCall.name === "execute_research_pipeline") {
          toolResult = await researchTool.invoke({ 
            query: toolCall.args.query, 
            sourceFolderPath: toolCall.args.sourceFolderPath || "" 
          });
        } 
        else {
          toolResult = "Unknown tool requested.";
        }
      } catch (toolError) {
        console.error(`[Main Agent] Error executing ${toolCall.name}:`, toolError);
        toolResult = `The tool '${toolCall.name}' failed, but continue naturally.`;
      }

      dispatchAgentActivity(null);

      toolMessages.push(
        new ToolMessage({
          content: toolResult || "Task completed successfully.",
          tool_call_id: toolCall.id!,
          name: toolCall.name,
        })
      );

      toolResultsSummary.push(`[Result from ${toolCall.name} in Step ${stepCount + 1}]: ${toolResult}`);
    }

    messagesToRun = [...messagesToRun, response, ...toolMessages];
    response = await llmWithTools.invoke(messagesToRun);
    stepCount++;
  }

  // After all tool steps are complete, build the clean final spoken response
  if (toolResultsSummary.length > 0) {
    const combinedResults = toolResultsSummary.join("\n\n");
    const lastMessage = state.messages[state.messages.length - 1];
    const originalUserRequest = typeof lastMessage.content === "string" ? lastMessage.content : "the user's request";

    const cleanContextPrompt = `
      The user's original request was: "${originalUserRequest}"
      
      I have executed the necessary tools step-by-step. Here are the raw results:
      ---
      ${combinedResults}
      ---
      
      Now, synthesize these results into a single, warm, and natural spoken response in the user's language (Persian/Farsi). 
      Do not mention the tool names. Do not use markdown. Just talk to the user as a friend confirming what was done. 
      If the tool produced a long report, summarize the MOST IMPORTANT conclusions for speech, and tell the user that the full detailed report is saved.
    `;

    const cleanMessages = [
      new SystemMessage(systemPrompt),
      ...state.messages,
      new HumanMessage(cleanContextPrompt)
    ];

    const finalResponse = await getAsyncLLM().then(plainLlm => plainLlm.invoke(cleanMessages));

    let finalContent = "";
    if (typeof finalResponse.content === "string") {
      finalContent = finalResponse.content;
    } else if (Array.isArray(finalResponse.content)) {
      finalContent = finalResponse.content.map((c: any) => c.text || "").join(" ");
    }

    finalContent = stripMarkdown(finalContent);

    if (!finalContent || finalContent.trim() === "") {
      finalContent = "Task completed successfully.";
    }

    response.content = finalContent;
  } else {
    if (typeof response.content === "string") {
      response.content = stripMarkdown(response.content);
    }
  }

  return { messages: [response] };
};