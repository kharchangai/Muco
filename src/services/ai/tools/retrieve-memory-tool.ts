import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { StringOutputParser, StructuredOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence } from "@langchain/core/runnables";
import { readTextFile, readDir, exists, mkdir } from '@tauri-apps/plugin-fs';
import { join, appDataDir } from '@tauri-apps/api/path';
import { getAsyncLLM } from "./memory_tools"; 

import { 
  SELECT_MEMORY_FILES_PROMPT, 
  EXTRACT_FROM_SINGLE_FILE_PROMPT 
} from "../prompts/memory-prompts";

const stringParser = new StringOutputParser();

const fileSelectionSchema = z.object({
  personal: z.array(z.string()).default([]),
  shortTerm: z.array(z.string()).default([]),
});

const jsonParser = StructuredOutputParser.fromZodSchema(fileSelectionSchema);

// Helper function to get memory paths securely in Tauri
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

// Helper to extract content using Rust's fs
async function extractFromFile(llm: ChatOpenAI, filePath: string, fileName: string, userQuery: string): Promise<string | null> {
  try {
    if (!(await exists(filePath))) return null;
    
    const content = await readTextFile(filePath);
    if (!content.trim()) return null;

    const prompt = EXTRACT_FROM_SINGLE_FILE_PROMPT(userQuery, fileName, content);
    
    // Safely execute using RunnableSequence instead of .pipe
    const chain = RunnableSequence.from([llm, stringParser]);
    const result = (await chain.invoke(prompt)).trim();

    if (result === "NONE" || !result) return null;
    
    return `[Source: ${fileName}]\n${result}`;
  } catch (error) {
    console.error(`[Retrieve Tool] Error extracting from ${fileName}:`, error);
    return null;
  }
}

export const retrieveMemoryTool = tool(
  async ({ userQuery }) => {
    try {
      // FIX: Added 'await' because getAsyncLLM returns a Promise
      const llm = await getAsyncLLM();
      const { personalDir, shortDir } = await getMemoryPaths();

      // Read guide.json
      let personalGuide = "{}";
      const guidePath = await join(personalDir, "guide.json");
      if (await exists(guidePath)) {
        try { personalGuide = await readTextFile(guidePath); } catch {}
      }

      // Read short term directory
      let shortTermFiles: string[] = [];
      try {
        const entries = await readDir(shortDir);
        shortTermFiles = entries.map(e => e.name || "").filter(name => name.endsWith(".md"));
      } catch {}

      const todayStr = new Date().toISOString().split('T')[0];

      // File Selection Logic
      const basePrompt = SELECT_MEMORY_FILES_PROMPT(userQuery, todayStr, personalGuide, shortTermFiles);
      const selectPrompt = `${basePrompt}\n\n${jsonParser.getFormatInstructions()}`;
      
      // FIX: Use RunnableSequence instead of chained .pipe()
      const selectionChain = RunnableSequence.from([llm, stringParser, jsonParser]);
      
      let selectedFiles: z.infer<typeof fileSelectionSchema>;
      try {
        selectedFiles = await selectionChain.invoke(selectPrompt);
      } catch {
        selectedFiles = { personal: [], shortTerm: [] };
      }

      // Prepare extraction tasks with Async Paths
      const tasks: Promise<string | null>[] = [];
      
      for (const file of selectedFiles.personal) {
        const filePath = await join(personalDir, file);
        tasks.push(extractFromFile(llm, filePath, `Personal/${file}`, userQuery));
      }

      for (const file of selectedFiles.shortTerm) {
        const filePath = await join(shortDir, file);
        tasks.push(extractFromFile(llm, filePath, `Short_Term/${file}`, userQuery));
      }

      const results = (await Promise.all(tasks)).filter((m): m is string => m !== null);

      return results.length > 0 
        ? results.join("\n\n") 
        : "No relevant historical details found in the selected files.";

    } catch (error) {
      console.error("[Retrieve Tool] Execution Error:", error);
      return "An error occurred while retrieving memories.";
    }
  },
  {
    name: "retrieve_memory",
    description: "Searches the memory directory for relevant past facts or daily logs and extracts only the strictly needed parts to answer the query.",
    schema: z.object({
      userQuery: z.string().describe("The user query or topic to search in the history."),
    }),
  }
);