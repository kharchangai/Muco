import { ChatOpenAI } from "@langchain/openai";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";

// Import Tauri v2 FS and Path APIs to replace Node.js 'fs' and 'path'
import { writeTextFile, readTextFile, mkdir, exists } from '@tauri-apps/plugin-fs';
import { BaseDirectory } from '@tauri-apps/api/path';

import { 
    OBSERVER_SYSTEM_PROMPT, 
    OBSERVER_HUMAN_PROMPT 
} from "../prompts/observer_prompts";

export interface MicroInsight {
    insight_name: string;
    intensity: number;
    stability: 'transient' | 'stable';
    first_detected: string;
    last_updated: string;
    context: string;
}

export async function updateFeelingsState(
    recentMessages: string[],
    llm: ChatOpenAI
): Promise<void> {
    
    // 1. Initialize LangChain's JSON Output Parser
    const parser = new JsonOutputParser<MicroInsight[]>();

    // 2. Setup the Chat Prompt Template
    const promptTemplate = ChatPromptTemplate.fromMessages([
        ["system", OBSERVER_SYSTEM_PROMPT],
        ["human", OBSERVER_HUMAN_PROMPT]
    ]);

    // 3. Create the Chain
    const chain = promptTemplate.pipe(llm).pipe(parser);

    // Define storage paths within Tauri's AppLocalData directory
    const outputDir = "memory/observer";
    const fileName = "feelings_state.json";
    const outputPath = `${outputDir}/${fileName}`;

    // 4. Read existing data if the file exists (Handle Cold Start)
    let existingInsights: MicroInsight[] = [];
    try {
        const fileExists = await exists(outputPath, { baseDir: BaseDirectory.AppData });
        if (fileExists) {
            const fileContent = await readTextFile(outputPath, { baseDir: BaseDirectory.AppData });
            existingInsights = JSON.parse(fileContent);
        }
    } catch (error) {
        console.warn("[Observer] Could not read or parse existing feelings_state.json, starting fresh:", error);
    }

    const currentTime = new Date().toISOString();

    try {
        console.log("[Observer] Analyzing and merging emotional and behavioral states...");

        // 5. Invoke the LLM to compare, update, and merge
        const updatedInsights = await chain.invoke({
            current_time: currentTime,
            existing_insights: JSON.stringify(existingInsights, null, 2),
            new_messages: recentMessages.join("\n")
        });

        // 6. Ensure directory exists and write the updated state using Tauri FS API
        await mkdir(outputDir, { recursive: true, baseDir: BaseDirectory.AppData });

        await writeTextFile(
            outputPath, 
            JSON.stringify(updatedInsights, null, 2), 
            { baseDir: BaseDirectory.AppData }
        );
        
        console.log(`[Observer] Feelings state successfully updated and saved to AppLocalData/${outputPath}`);
        
    } catch (error) {
        console.error("[Observer] Failed to update feelings state:", error);
        throw error;
    }
}