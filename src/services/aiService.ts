import { ChatOpenAI } from "@langchain/openai";
import {
  BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import {
  AppSettings,
  readSettings,
} from "../store";

export type LlmTier = "cheap" | "medium" | "expensive";

type LlmConfig = {
  baseUrl: string;
  model: string;
};

const MAX_HISTORY_MESSAGES = 12;

const getApiConfig = async (): Promise<AppSettings> => {
  const config = await readSettings();

  console.log("AI config:", {
    apiKey: config.apiKey ? "set" : "missing",

    cheapBaseUrl: config.cheapBaseUrl || "missing",
    cheapModel: config.cheapModel || "missing",

    mediumBaseUrl: config.mediumBaseUrl || "missing",
    mediumModel: config.mediumModel || "missing",

    expensiveBaseUrl: config.expensiveBaseUrl || "missing",
    expensiveModel: config.expensiveModel || "missing",

    sttModel: config.sttModel || "missing",
    ttsModel: config.ttsModel || "missing",
    ttsVoice: config.ttsVoice || "missing",
  });

  return config;
};

const normalizeBaseUrl = (baseUrl: string): string => {
  return baseUrl.trim().replace(/\/+$/, "");
};

const throwIfAborted = (
  signal?: AbortSignal,
): void => {
  if (signal?.aborted) {
    throw new DOMException(
      "The operation was cancelled.",
      "AbortError",
    );
  }
};

export const isAbortError = (
  error: unknown,
): boolean => {
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }

  if (error instanceof Error) {
    return error.name === "AbortError";
  }

  return false;
};

const validateApiKey = (
  config: AppSettings,
): void => {
  if (!config.apiKey || config.apiKey.trim().length === 0) {
    throw new Error(
      "API Key is missing. Please configure it in Settings.",
    );
  }
};

const getLlmConfig = (
  tier: LlmTier,
  config: AppSettings,
): LlmConfig => {
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
};

const validateLlmConfig = (
  tier: LlmTier,
  llmConfig: LlmConfig,
): void => {
  if (!llmConfig.baseUrl || llmConfig.baseUrl.trim().length === 0) {
    throw new Error(
      `${tier} LLM Base URL is missing. Please configure it in Settings.`,
    );
  }

  if (!llmConfig.model || llmConfig.model.trim().length === 0) {
    throw new Error(
      `${tier} LLM Model is missing. Please configure it in Settings.`,
    );
  }
};

export const getAsyncLLM = async (
  tier: LlmTier = "medium",
): Promise<ChatOpenAI> => {
  const config = await getApiConfig();

  validateApiKey(config);

  const llmConfig = getLlmConfig(tier, config);

  validateLlmConfig(tier, llmConfig);

  return new ChatOpenAI({
    apiKey: config.apiKey.trim(),
    model: llmConfig.model.trim(),
    configuration: {
      baseURL: normalizeBaseUrl(llmConfig.baseUrl),
    },
    dangerouslyAllowBrowser: true,
  });
};

let messageHistory: BaseMessage[] = [];

const getResponseText = (
  content: unknown,
): string => {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }

      return "";
    })
    .join("")
    .trim();
};

export async function transcribeAudio(
  audioBlob: Blob,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);

  const config = await getApiConfig();

  throwIfAborted(signal);
  validateApiKey(config);

  if (!config.expensiveBaseUrl?.trim()) {
    throw new Error(
      "Speech Base URL is missing. Configure the Expensive LLM Base URL in Settings.",
    );
  }

  if (!config.sttModel?.trim()) {
    throw new Error(
      "STT Model is missing. Please configure it in Settings.",
    );
  }

  const baseUrl = normalizeBaseUrl(config.expensiveBaseUrl);

  const formData = new FormData();

  const extension = audioBlob.type.includes("ogg")
    ? "ogg"
    : audioBlob.type.includes("wav")
      ? "wav"
      : audioBlob.type.includes("mpeg") ||
          audioBlob.type.includes("mp3")
        ? "mp3"
        : "webm";

  formData.append(
    "file",
    audioBlob,
    `audio.${extension}`,
  );

  formData.append("model", config.sttModel.trim());

  const response = await fetch(
    `${baseUrl}/audio/transcriptions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey.trim()}`,
      },
      body: formData,
      signal,
    },
  );

  throwIfAborted(signal);

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `STT Error (${response.status}): ${errorText}`,
    );
  }

  const data: unknown = await response.json();

  throwIfAborted(signal);

  if (
    typeof data === "object" &&
    data !== null &&
    "text" in data &&
    typeof data.text === "string"
  ) {
    return data.text.trim();
  }

  return "";
}

export async function runAgent(
  userInput: string,
  signal?: AbortSignal,
  tier: LlmTier = "expensive",
): Promise<string> {
  throwIfAborted(signal);

  const cleanUserInput = userInput.trim();

  if (!cleanUserInput) {
    throw new Error("User input cannot be empty.");
  }

  const model = await getAsyncLLM(tier);

  throwIfAborted(signal);

  const userMessage = new HumanMessage(cleanUserInput);

  /*
   * History is committed only after a successful request.
   * A cancelled or failed message will not become permanent context.
   */
  const requestMessages = [
    ...messageHistory,
    userMessage,
  ];

  const response = await model.invoke(
    requestMessages,
    {
      signal,
    },
  );

  throwIfAborted(signal);

  messageHistory = [
    ...requestMessages,
    response,
  ].slice(-MAX_HISTORY_MESSAGES);

  return getResponseText(response.content);
}

export async function generateSpeech(
  text: string,
  signal?: AbortSignal,
): Promise<Blob> {
  throwIfAborted(signal);

  const config = await getApiConfig();

  throwIfAborted(signal);
  validateApiKey(config);

  if (!config.expensiveBaseUrl?.trim()) {
    throw new Error(
      "Speech Base URL is missing. Configure the Expensive LLM Base URL in Settings.",
    );
  }

  if (!config.ttsModel?.trim()) {
    throw new Error(
      "TTS Model is missing. Please configure it in Settings.",
    );
  }

  if (!config.ttsVoice?.trim()) {
    throw new Error(
      "TTS Voice is missing. Please configure it in Settings.",
    );
  }

  const cleanText = text
    .replace(/[*#_`]/g, "")
    .trim();

  if (!cleanText) {
    throw new Error(
      "Text is empty after cleaning. Cannot generate speech.",
    );
  }

  const baseUrl = normalizeBaseUrl(config.expensiveBaseUrl);

  const payload = {
    model: config.ttsModel.trim(),
    input: cleanText,
    voice: config.ttsVoice.trim(),
  };

  console.log("Sending TTS request:", {
    model: payload.model,
    voice: payload.voice,
    textLength: payload.input.length,
  });

  const response = await fetch(
    `${baseUrl}/audio/speech`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal,
    },
  );

  throwIfAborted(signal);

  if (!response.ok) {
    const errorText = await response.text();

    console.error(
      "TTS request failed:",
      errorText,
    );

    throw new Error(
      `TTS Error (${response.status}): ${errorText}`,
    );
  }

  const speechBlob = await response.blob();

  throwIfAborted(signal);

  return speechBlob;
}

export function resetConversation(): void {
  messageHistory = [];
}