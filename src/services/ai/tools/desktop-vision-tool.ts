import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { invoke } from "@tauri-apps/api/core";
import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { readSettings } from "../../../store"; // Adjust the relative path if your store file is located elsewhere

export const desktopVisionTool = tool(
  async ({ userRequest }) => {
    try {
      console.log("[Vision Tool] Loading settings from store...");
      const settings = await readSettings();

      // Determine which API key, base URL, and model to use.
      // We prioritize the dedicated Vision settings. If they are empty,
      // we fallback to the general LLM settings as a backup.
      const apiKey = settings.visionApiKey || settings.apiKey;
      const baseURL = settings.visionBaseUrl || settings.baseUrl;
      const modelName = settings.visionModel || settings.llmModel || "gpt-4o-mini";

      if (!apiKey) {
        return "Error: No API Key configured. Please set your API Key in the settings menu.";
      }

      console.log("[Vision Tool] Triggering Rust capture_desktop command...");
      const base64Image: string = await invoke("capture_desktop");
      
      if (!base64Image) {
        return "Failed to capture the desktop screenshot.";
      }

      console.log(`[Vision Tool] Screenshot captured successfully. Initializing Vision LLM (${modelName})...`);

      // Initialize ChatOpenAI using the dynamic settings retrieved from the store
      const visionLlm = new ChatOpenAI({
        model: modelName,
        apiKey: apiKey,
        configuration: {
          baseURL: baseURL || undefined // Uses default OpenAI base URL if empty
        },
      });

      console.log("[Vision Tool] Sending multimodal request to the vision model...");

      // Ensure the base64 string has the correct data URI format for standard APIs
      const formattedImageUrl = base64Image.startsWith("data:image") 
        ? base64Image 
        : `data:image/png;base64,${base64Image}`;

      const response = await visionLlm.invoke([
        new HumanMessage({
          content: [
            {
              type: "text",
              text: `You are looking at the user's screen. Analyze this image to answer the user's request.
              
              User Request: "${userRequest}"

              Provide a clear, direct, and helpful answer based on what you see.`
            },
            {
              type: "image_url",
              image_url: {
                url: formattedImageUrl
              }
            }
          ]
        })
      ]);

      console.log("[Vision Tool] Analysis complete.");
      
      const resultText = typeof response.content === 'string' 
        ? response.content 
        : Array.isArray(response.content) 
          ? response.content.map(item => (typeof item === 'string' ? item : (item as any).text || '')).join(' ')
          : JSON.stringify(response.content);

      console.log("[Vision Tool] Extracted text analysis:", resultText);
      
      return resultText;

    } catch (error) {
      console.error("[Vision Tool Error]:", error);
      return "An error occurred while capturing or analyzing your desktop screen.";
    }
  },
  {
    name: "desktop_vision_action",
    description: "Use this tool ONLY when the user asks you to look at their screen, analyze their desktop, debug code visible on screen, or explain UI elements.",
    schema: z.object({
      userRequest: z.string().describe("The specific question, error message, or instruction the user has about their current screen."),
    }),
  }
);