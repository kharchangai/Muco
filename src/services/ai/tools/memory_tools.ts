import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { StringOutputParser, StructuredOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence } from "@langchain/core/runnables";
import { MEMORY_DECISION_PROMPT } from "../prompts/memory-prompts";
import { BaseDirectory, exists, mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import { readSettings } from "../../../store";
import { saveMemoryTool } from "./save-memory-tool";
import { retrieveMemoryTool } from "./retrieve-memory-tool";

const fsOptions = { baseDir: BaseDirectory.AppData };

async function ensureMemoryReady(): Promise<void> {
  try {
    const memoryRoot = "memory";
    const personalDir = "memory/Personal";
    const shortDir = "memory/Short_Term";
    const longDir = "memory/Long_Term";
    const personalGuidePath = "memory/Personal/guide.json";

    if (!(await exists(memoryRoot, fsOptions))) {
      await mkdir(memoryRoot, { ...fsOptions, recursive: true });
    }
    if (!(await exists(personalDir, fsOptions))) {
      await mkdir(personalDir, { ...fsOptions, recursive: true });
    }
    if (!(await exists(shortDir, fsOptions))) {
      await mkdir(shortDir, { ...fsOptions, recursive: true });
    }
    if (!(await exists(longDir, fsOptions))) {
      await mkdir(longDir, { ...fsOptions, recursive: true });
    }
    if (!(await exists(personalGuidePath, fsOptions))) {
      await writeTextFile(personalGuidePath, JSON.stringify({}, null, 2), fsOptions);
    }
  } catch (error) {
    console.error("[Memory Tool] Directory initialization failed:", error);
  }
}

export const getAsyncLLM = async () => {
  const config = await readSettings();

  const apiKey = config.apiKey || "";
  const baseUrl = config.baseUrl || "";
  const llmModel = config.llmModel || "";

  return new ChatOpenAI({
    apiKey: apiKey,
    model: llmModel,
    configuration: { 
      baseURL: baseUrl.trim().replace(/\/+$/, "")
    },
    dangerouslyAllowBrowser: true,
  });
};

const decisionSchema = z.object({
  actions: z.array(z.enum(["SAVE", "RETRIEVE"])).describe("List of necessary actions. Empty array [] if NONE is needed."),
});

const stringParser = new StringOutputParser();
const jsonParser = StructuredOutputParser.fromZodSchema(decisionSchema);

// Memory Tool Definition
export const memoryTool = tool(
  async (input: { userRequest: string; chatHistory?: any[] }) => {
    try {
      const { userRequest, chatHistory } = input;
      if (!userRequest) return "No request provided.";

      await ensureMemoryReady();

      const recentHistoryMessages = chatHistory
        ? chatHistory
            .slice(Math.max(0, chatHistory.length - 11))
            .map(msg => `${msg._getType() === 'human' ? 'User' : 'Mocu'}: ${msg.content}`)
        : [];

      const formattedHistory = recentHistoryMessages.length > 0
        ? recentHistoryMessages.join("\n")
        : "No previous history in this session.";

      const prompt = `${MEMORY_DECISION_PROMPT}\n\nRecent History:\n${formattedHistory}\n\nUser's Latest Input:\n"${userRequest}"\n\n${jsonParser.getFormatInstructions()}`;

      const modelInstance = await getAsyncLLM();
      
      const decisionChain = RunnableSequence.from([
        modelInstance,
        stringParser,
        jsonParser
      ]);

      let decision: z.infer<typeof decisionSchema>;
      
      try {
        decision = await decisionChain.invoke(prompt);
      } catch (error) {
        console.warn("[Memory Tool] Parser failed, fallback to empty actions:", error);
        decision = { actions: [] }; 
      }

      const { actions } = decision;

      if (actions.length === 0) {
        return "Memory check complete. No relevant memories needed to be saved or retrieved."; 
      }

      let combinedContext = "";

      if (actions.includes("SAVE")) {
        // 🔥 CHANGE: Fire and Forget - no await!
        saveMemoryTool.invoke({ memoryToSave: userRequest })
          .then((saveResult) => {
            console.log("[Memory Tool] Background save completed:", saveResult);
          })
          .catch((error) => {
            console.error("[Memory Tool] Background save failed:", error);
          });
        
        // Don't wait - immediately continue
        combinedContext += `[System Note: Save operation initiated in background.]\n\n`;
      }

      if (actions.includes("RETRIEVE")) {
        // RETRIEVE still uses await because we need the data
        try {
          const retrievedResult = await retrieveMemoryTool.invoke({ userQuery: userRequest });
          combinedContext += `[Historical Memory Context]:\n${retrievedResult}\n`;
        } catch (error) {
          console.error("[Memory Tool] Retrieval failed:", error);
        }
      }

      return combinedContext.trim();

    } catch (error) {
      console.error("[Memory Tool] Critical execution error:", error);
      return "An error occurred while accessing the memory system.";
    }
  },
  {
    name: "memory_action",
    description: "Use this tool to SAVE new facts/preferences about the user, or RETRIEVE past memories/context about the user.",
    schema: z.object({
      userRequest: z.string().describe("The user's input related to the memory operation."),
    }),
  }
);