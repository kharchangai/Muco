import { ChatOpenAI } from "@langchain/openai";
import { readSettings } from "../../store";

export type LlmTier = "cheap" | "medium" | "expensive";

type LlmTierConfig = {
  baseUrl: string;
  model: string;
};

function normalizeBaseUrl(baseUrl: string): string | undefined {
  const normalized = baseUrl.trim().replace(/\/+$/, "");

  return normalized || undefined;
}

function getTierConfig(
  tier: LlmTier,
  config: Awaited<ReturnType<typeof readSettings>>,
): LlmTierConfig {
  switch (tier) {
    case "cheap":
      return {
        baseUrl: config.cheapBaseUrl || "",
        model: config.cheapModel || "",
      };

    case "medium":
      return {
        baseUrl: config.mediumBaseUrl || "",
        model: config.mediumModel || "",
      };

    case "expensive":
      return {
        baseUrl: config.expensiveBaseUrl || "",
        model: config.expensiveModel || "",
      };
  }
}

export const getAsyncLLM = async (
  tier: LlmTier = "medium",
): Promise<ChatOpenAI> => {
  const config = await readSettings();

  const apiKey = config.apiKey || "";
  const selectedModel = getTierConfig(tier, config);

  if (!selectedModel.model.trim()) {
    throw new Error(
      `The ${tier} LLM model is not configured. Open Settings and set its model name.`,
    );
  }

  if (!selectedModel.baseUrl.trim()) {
    throw new Error(
      `The ${tier} LLM base URL is not configured. Open Settings and set its base URL.`,
    );
  }

  return new ChatOpenAI({
    apiKey,
    model: selectedModel.model.trim(),
    configuration: {
      baseURL: normalizeBaseUrl(selectedModel.baseUrl),
    },
    dangerouslyAllowBrowser: true,
  });
};