import { ChatOpenAI } from "@langchain/openai";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// Import Tauri v2 FS and Path APIs
import { writeTextFile, readTextFile, mkdir, exists } from '@tauri-apps/plugin-fs';
import { BaseDirectory } from '@tauri-apps/api/path';

// Import previous agents
import { updateFeelingsState } from "./observer_agent";
import { buildMemoryContext, ExtractedContext } from "./context_builder_agent";

// Import prompts
import { 
    PROMPT_GENERATOR_SYSTEM_PROMPT, 
    PROMPT_GENERATOR_HUMAN_PROMPT 
} from "../prompts/prompt_generator_prompts";

// Define the main function as a LangChain Tool
// LLM is injected as a parameter to the outer function so the created tool can use it
export const synthesizerTool = (llm: ChatOpenAI) => tool(
    async ({ recentMessages }) => {
        console.log("[Synthesizer Tool] Executing...");

        // ==========================================
        // STEP 1: Run updates and extractions IN PARALLEL for maximum speed
        // ==========================================
        console.log("[Synthesizer Tool] Running Feeling Updates and Memory Extraction in parallel...");
        
        let memoryContext: ExtractedContext[] = [];
        
        try {
            const [_, extractedContext] = await Promise.all([
                updateFeelingsState(recentMessages, llm),
                buildMemoryContext(recentMessages, llm)
            ]);
            memoryContext = extractedContext;
        } catch (error) {
            console.error("[Synthesizer Tool] Error during parallel execution of sub-agents:", error);
            return `Error in sub-agents: ${error}`; // Return error instead of throwing
        }

        // ==========================================
        // STEP 2: Read the newly updated feelings state using Tauri FS
        // ==========================================
        const feelingsPath = "memory/observer/feelings_state.json";
        let currentFeelings = "[]";
        
        try {
            const feelingsExist = await exists(feelingsPath, { baseDir: BaseDirectory.AppData });
            if (feelingsExist) {
                currentFeelings = await readTextFile(feelingsPath, { baseDir: BaseDirectory.AppData });
            }
        } catch (error) {
            console.warn("[Synthesizer Tool] Failed to read feelings state file:", error);
        }

        // Format the memory context into a readable string
        let memoryString = "No specific relevant memories found for this context.";
        if (memoryContext.length > 0) {
            memoryString = memoryContext.map(mem => 
                `[Source: ${mem.source_file}]\n${mem.relevant_info}`
            ).join("\n\n");
        }

        // ==========================================
        // STEP 3: Generate the Final Prompt
        // ==========================================
        console.log("[Synthesizer Tool] Generating the highly personalized System Prompt...");

        const parser = new StringOutputParser();
        const promptTemplate = ChatPromptTemplate.fromMessages([
            ["system", PROMPT_GENERATOR_SYSTEM_PROMPT],
            ["human", PROMPT_GENERATOR_HUMAN_PROMPT]
        ]);

        const chain = promptTemplate.pipe(llm).pipe(parser);

        try {
            const finalGeneratedPrompt = await chain.invoke({
                current_feelings: currentFeelings,
                relevant_memories: memoryString,
                recent_messages: recentMessages.join("\n")
            });

            // Save the generated prompt to a file for debugging/logging using Tauri FS
            const logsDir = "memory/logs";
            const latestPromptPath = `${logsDir}/latest_system_prompt.txt`;
            
            try {
                await mkdir(logsDir, { recursive: true, baseDir: BaseDirectory.AppData });
                await writeTextFile(latestPromptPath, finalGeneratedPrompt, { baseDir: BaseDirectory.AppData });
                console.log(`[Synthesizer Tool] Debug log saved to AppLocalData/${latestPromptPath}`);
            } catch (logError) {
                console.warn("[Synthesizer Tool] Failed to save latest prompt log:", logError);
            }

            console.log("[Synthesizer Tool] Final prompt successfully generated!");
            return finalGeneratedPrompt; // Tool output must be a string
            
        } catch (error) {
            console.error("[Synthesizer Tool] Failed to generate final prompt:", error);
            return `Failed to generate prompt: ${error}`; // Return error instead of throwing
        }
    },
    {
        name: "generate_personalized_prompt",
        description: "Use this tool when you need to synthesize memories, emotional state, and recent context to generate a highly personalized system prompt for the AI. Call this when there is a significant shift in the user's emotional state, a change in their goals/preferences, or when they share crucial new details.",
        schema: z.object({
            recentMessages: z.array(z.string()).describe("List of recent messages from the user and assistant to analyze for personalization."),
        }),
    }
);