import { ChatOpenAI } from "@langchain/openai";
import {
  BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import {
  AppSettings,
  readSettings,
} from "../store";

const MAX_HISTORY_MESSAGES = 12;

const getApiConfig = async (): Promise<AppSettings> => {
  const config = await readSettings();

  console.log("AI config:", {
    apiKey: config.apiKey ? "set" : "missing",
    baseUrl: config.baseUrl || "missing",
    llmModel: config.llmModel || "missing",
    sttModel: config.sttModel || "missing",
    ttsModel: config.ttsModel || "missing",
    ttsVoice: config.ttsVoice || "missing",
  });

  return config;
};

const normalizeBaseUrl = (baseUrl: string): string => {
  return baseUrl.trim().replace(/\/+$/, "");
};

const validateBaseConfig = (
  config: AppSettings,
): void => {
  if (!config.apiKey || config.apiKey.trim().length === 0) {
    throw new Error(
      "API Key is missing. Please configure it in Settings.",
    );
  }

  if (!config.baseUrl || config.baseUrl.trim().length === 0) {
    throw new Error(
      "Base URL is missing. Please configure it in Settings.",
    );
  }
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

const getChatModel = async (): Promise<ChatOpenAI> => {
  const config = await getApiConfig();

  validateBaseConfig(config);

  if (!config.llmModel || config.llmModel.trim().length === 0) {
    throw new Error(
      "LLM Model is missing. Please configure it in Settings.",
    );
  }

  return new ChatOpenAI({
    apiKey: config.apiKey,
    model: config.llmModel,
    configuration: {
      baseURL: normalizeBaseUrl(config.baseUrl),
    },
  });
};

let messageHistory: BaseMessage[] = [];

export async function transcribeAudio(
  audioBlob: Blob,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);

  const config = await getApiConfig();

  throwIfAborted(signal);
  validateBaseConfig(config);

  if (!config.sttModel || config.sttModel.trim().length === 0) {
    throw new Error(
      "STT Model is missing. Please configure it in Settings.",
    );
  }

  const baseUrl = normalizeBaseUrl(config.baseUrl);

  const formData = new FormData();

  /*
   * The browser records WebM or OGG in most cases.
   * The MIME type is preserved instead of always pretending it is WAV.
   */
  const extension = audioBlob.type.includes("ogg")
    ? "ogg"
    : audioBlob.type.includes("wav")
      ? "wav"
      : "webm";

  formData.append(
    "file",
    audioBlob,
    `audio.${extension}`,
  );

  formData.append("model", config.sttModel);

  const response = await fetch(
    `${baseUrl}/audio/transcriptions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
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
): Promise<string> {
  throwIfAborted(signal);

  const cleanUserInput = userInput.trim();

  if (!cleanUserInput) {
    throw new Error("User input cannot be empty.");
  }

  const model = await getChatModel();

  throwIfAborted(signal);

  const userMessage = new HumanMessage(cleanUserInput);

  /*
   * Do not mutate global history until the request completes.
   * This prevents cancelled user messages from becoming permanent context.
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

  if (typeof response.content === "string") {
    return response.content.trim();
  }

  if (Array.isArray(response.content)) {
    return response.content
      .map((part) => {
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
  }

  return "";
}

export async function generateSpeech(
  text: string,
  signal?: AbortSignal,
): Promise<Blob> {
  throwIfAborted(signal);

  const config = await getApiConfig();

  throwIfAborted(signal);
  validateBaseConfig(config);

  if (!config.ttsModel || config.ttsModel.trim().length === 0) {
    throw new Error(
      "TTS Model is missing. Please configure it in Settings.",
    );
  }

  if (!config.ttsVoice || config.ttsVoice.trim().length === 0) {
    throw new Error(
      "TTS Voice is missing. Please configure it in Settings.",
    );
  }

  const baseUrl = normalizeBaseUrl(config.baseUrl);

  /*
   * Keep punctuation because it improves TTS pauses and pronunciation.
   * Remove only basic Markdown formatting characters.
   */
  const cleanText = text
    .replace(/[*#_`]/g, "")
    .trim();

  if (!cleanText) {
    throw new Error(
      "Text is empty after cleaning. Cannot generate speech.",
    );
  }

  const payload = {
    model: config.ttsModel,
    input: cleanText,
    voice: config.ttsVoice,
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
        Authorization: `Bearer ${config.apiKey}`,
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