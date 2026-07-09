import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { join, appDataDir } from '@tauri-apps/api/path';
import { getAsyncLLM } from "./memory_tools"; 
import { StringOutputParser, StructuredOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence } from "@langchain/core/runnables";

import { 
  ROUTE_MEMORY_TYPE_PROMPT, 
  PERSONAL_FILE_DECISION_PROMPT, 
  SMART_MERGE_PROMPT 
} from "../prompts/memory-prompts";

// Define the Zod schema for standardizing LLM output
const fileDecisionSchema = z.object({
  action: z.enum(["UPDATE", "CREATE"]).describe("Whether to UPDATE an existing file or CREATE a new one."),
  filename: z.string().describe("The exact filename, e.g., user_profile.md"),
  description: z.string().optional().describe("A short 1-sentence description if creating a new file. Empty if updating."),
});

const jsonParser = StructuredOutputParser.fromZodSchema(fileDecisionSchema);
const stringParser = new StringOutputParser();

function getTodayDateString(): string {
  return new Date().toISOString().split('T')[0];
}

async function getMemoryPaths() {
  const baseDir = await appDataDir();
  const memoryRoot = await join(baseDir, "memory");
  const personalDir = await join(memoryRoot, "Personal");
  const shortDir = await join(memoryRoot, "Short_Term");

  if (!(await exists(memoryRoot))) await mkdir(memoryRoot, { recursive: true });
  if (!(await exists(personalDir))) await mkdir(personalDir, { recursive: true });
  if (!(await exists(shortDir))) await mkdir(shortDir, { recursive: true });

  return { personalDir, shortDir };
}

export const saveMemoryTool = tool(
  async ({ memoryToSave }) => {
    try {
      const llm = await getAsyncLLM();
      const { personalDir, shortDir } = await getMemoryPaths();
      
      let resultMessages: string[] = [];

      // A safe chain specifically for forcing output to be a plain String
      const safeStringChain = RunnableSequence.from([llm, stringParser]);

      console.log(`[Save Memory] Starting process for memory: "${memoryToSave}"`);

      // ==========================================
      // 1. ALWAYS SAVE TO SHORT-TERM (DAILY LOG) 
      // ==========================================
      const todayStr = getTodayDateString();
      const dailyFilename = `${todayStr}.md`;
      const dailyFilePath = await join(shortDir, dailyFilename);

      if (await exists(dailyFilePath)) {
        const currentContent = await readTextFile(dailyFilePath);
        console.log(`[Save Memory] Daily log exists. Merging new data...`);
        const mergedContent = await safeStringChain.invoke(SMART_MERGE_PROMPT(memoryToSave, currentContent));
        await writeTextFile(dailyFilePath, mergedContent.trim());
        resultMessages.push(`Added to daily log: ${dailyFilename}`);
      } else {
        console.log(`[Save Memory] No daily log found for today. Creating new...`);
        const initialContent = `# Daily Log - ${todayStr}\n\n- ${memoryToSave}`;
        await writeTextFile(dailyFilePath, initialContent);
        resultMessages.push(`Created new daily log: ${dailyFilename}`);
      }

      // ==========================================
      // 2. CHECK IF IT NEEDS TO BE PERSONAL KNOWLEDGE
      // ==========================================
      const routeRawString = await safeStringChain.invoke(ROUTE_MEMORY_TYPE_PROMPT + `\nMemory: "${memoryToSave}"`);
      const memoryType = routeRawString.trim().toUpperCase();

      console.log(`[Save Memory] Evaluated Route: ${memoryType}`);

      if (memoryType.includes("CORE_KNOWLEDGE") || memoryType.includes("PERSONAL")) {
        console.log(`[Save Memory] Action: Proceeding to PERSONAL storage logic.`);
        
        const guidePath = await join(personalDir, "guide.json");
        let guideData: Record<string, string> = {};

        if (await exists(guidePath)) {
          try {
            const rawGuide = await readTextFile(guidePath);
            guideData = JSON.parse(rawGuide);
          } catch (e) {
            console.warn(`[Save Memory] Warning: guide.json exists but is invalid JSON. Resetting to empty object.`);
          }
        } else {
          await writeTextFile(guidePath, JSON.stringify(guideData, null, 2));
        }

        console.log(`[Save Memory] Current guide tracking ${Object.keys(guideData).length} categories.`);

        const decisionPrompt = PERSONAL_FILE_DECISION_PROMPT(
          memoryToSave, 
          JSON.stringify(guideData),
          jsonParser.getFormatInstructions()
        );

        const decisionChain = RunnableSequence.from([llm, stringParser, jsonParser]);
        
        let decision: z.infer<typeof fileDecisionSchema>;
        try {
          decision = await decisionChain.invoke(decisionPrompt);
          console.log(`[Save Memory] Structured Decision Extracted:`, decision);
        } catch (parseError) {
          console.error(`[Save Memory] Parse Error! LLM failed to return valid JSON. Error:`, parseError);
          resultMessages.push("Note: Evaluated as CORE_KNOWLEDGE but failed to determine file structure.");
          return resultMessages.join(" | ");
        }

        if (decision.action === "UPDATE") {
          const filename = decision.filename.trim();
          const filePath = await join(personalDir, filename);
          
          let currentContent = "";
          if (await exists(filePath)) {
            currentContent = await readTextFile(filePath);
          }

          console.log(`[Save Memory] Updating personal file: ${filename}`);
          const mergedPersonalContent = await safeStringChain.invoke(SMART_MERGE_PROMPT(memoryToSave, currentContent));
          await writeTextFile(filePath, mergedPersonalContent.trim());
          resultMessages.push(`Updated personal memory: ${filename}`);

        } else if (decision.action === "CREATE") {
          const filename = decision.filename.trim();
          const description = decision.description || "Personal memory file.";
          const filePath = await join(personalDir, filename);
          
          console.log(`[Save Memory] Creating NEW personal file: ${filename}`);
          const initialContent = `# ${filename.replace(".md", "").toUpperCase()}\n\n- ${memoryToSave}`;
          await writeTextFile(filePath, initialContent);

          guideData[filename] = description;
          await writeTextFile(guidePath, JSON.stringify(guideData, null, 2));
          console.log(`[Save Memory] Updated guide.json with new file info.`);
          resultMessages.push(`Created personal file: ${filename}`);
        }
      } else {
        console.log(`[Save Memory] Action: SKIPPED personal storage (Not Core Knowledge).`);
      }

      console.log(`[Save Memory] Final Execution Summary:`, resultMessages.join(" | "));
      return resultMessages.join(" | ");

    } catch (error) {
      console.error("[Save Memory Tool] Critical Error:", error);
      return "An error occurred while saving the memory.";
    }
  },
  {
    name: "save_memory",
    description: "Evaluates and saves new user facts, events, or rules into the appropriate long-term or short-term storage files.",
    schema: z.object({
      memoryToSave: z.string().describe("The new information or event that needs to be stored."),
    }),
  }
);