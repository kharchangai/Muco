import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readSettings } from "../../../store";

/**
 * Perplexity Search Tool.
 * Automatically reads configuration (API Key, Base URL, Model Name) from settings.
 */
export const perplexitySearchTool = tool(
  async ({ query }) => {
    console.log(`[Perplexity Tool] Initiating search for query: "${query}"`);

    let settings;
    try {
      settings = await readSettings();
    } catch (error) {
      console.error("[Perplexity Tool] Failed to read settings:", error);
      return "Error: Failed to load application settings.";
    }

    const apiKey = settings.perplexityApiKey;
    const baseUrl = settings.perplexityBaseUrl || "https://api.perplexity.ai";
    const modelName = settings.perplexityModel || "sonar";

    console.log(`[Perplexity Tool] Using Base URL: ${baseUrl} and Model: ${modelName}`);

    if (!apiKey) {
      console.error("[Perplexity Tool] Error: API Key is missing.");
      return "Error: Perplexity API key is not configured. Please check your settings.";
    }

    // Clean the Base URL to avoid trailing slash issues
    const cleanBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    const url = `${cleanBaseUrl}/chat/completions`;

    // Standard OpenAI/Perplexity Chat Completion Payload
    const payload = {
      model: modelName,
      messages: [
        {
          role: "system",
          content: "You are a precise web search assistant. Search the web and provide a factual, clear, and up-to-date summary answering the user's query. Provide links or sources if available."
        },
        {
          role: "user",
          content: query
        }
      ],
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Perplexity Tool] API error response: ${response.status} - ${errorText}`);
        return `Error: Perplexity API returned status ${response.status}. Details: ${errorText}`;
      }

      const data = await response.json();
      
      // Extract the content from the standard OpenAI-compatible response structure
      const resultText = data.choices?.[0]?.message?.content;

      if (!resultText) {
        console.warn("[Perplexity Tool] Received empty response from API.");
        return "No results found or empty response returned from the search API.";
      }

      console.log("[Perplexity Tool] Search completed successfully.");
      return resultText;

    } catch (error) {
      console.error("[Perplexity Tool] Network or system error:", error);
      return `Error: Failed to connect to Perplexity API. Details: ${error}`;
    }
  },
  {
    name: "perplexity_search",
    description: "Search the live web using Perplexity to find real-time information, weather, news, current events, or general facts.",
    schema: z.object({
      query: z.string().describe("The search query to look up (e.g., 'who won the latest Formula 1 race')."),
    }),
  }
);