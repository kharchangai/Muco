import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, BaseMessage } from "@langchain/core/messages";
import { readSettings, AppSettings } from "../store";

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

const validateBaseConfig = (config: AppSettings) => {
  if (!config.apiKey || config.apiKey.trim().length === 0) {
    throw new Error("API Key is missing. Please configure it in Settings.");
  }

  if (!config.baseUrl || config.baseUrl.trim().length === 0) {
    throw new Error("Base URL is missing. Please configure it in Settings.");
  }
};

const getChatModel = async () => {
  const config = await getApiConfig();

  validateBaseConfig(config);

  if (!config.llmModel || config.llmModel.trim().length === 0) {
    throw new Error("LLM Model is missing. Please configure it in Settings.");
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

export async function transcribeAudio(audioBlob: Blob): Promise<string> {
  const config = await getApiConfig();

  validateBaseConfig(config);

  if (!config.sttModel || config.sttModel.trim().length === 0) {
    throw new Error("STT Model is missing. Please configure it in Settings.");
  }

  const baseUrl = normalizeBaseUrl(config.baseUrl);

  const formData = new FormData();
  formData.append("file", audioBlob, "audio.wav");
  formData.append("model", config.sttModel);

  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`STT Error: ${errorText}`);
  }

  const data = await response.json();

  return typeof data.text === "string" ? data.text.trim() : "";
}

export async function runAgent(userInput: string): Promise<string> {
  const model = await getChatModel();

  messageHistory.push(new HumanMessage(userInput));

  const response = await model.invoke(messageHistory);

  messageHistory.push(response);

  return typeof response.content === "string" ? response.content : "";
}

export async function generateSpeech(text: string): Promise<Blob> {
  const config = await getApiConfig();

  validateBaseConfig(config);

  if (!config.ttsModel || config.ttsModel.trim().length === 0) {
    throw new Error("TTS Model is missing. Please configure it in Settings.");
  }

  if (!config.ttsVoice || config.ttsVoice.trim().length === 0) {
    throw new Error("TTS Voice is missing. Please configure it in Settings.");
  }

  const baseUrl = normalizeBaseUrl(config.baseUrl);

  // Clean text from basic markdown that might crash the TTS API
  const cleanText = text.replace(/[*#_`]/g, '').trim();

  if (!cleanText) {
    throw new Error("Text is empty after cleaning. Cannot generate speech.");
  }

  // حذف کامل response_format برای استفاده از فرمت پیش‌فرض سرور آوال‌-ای
  const payload = {
    model: config.ttsModel,
    input: cleanText,
    voice: config.ttsVoice
  };

  console.log("🔊 Sending TTS Payload:", payload);

  const response = await fetch(`${baseUrl}/audio/speech`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("❌ AvalAI TTS Error Details:", errorText);
    throw new Error(`TTS Error (${response.status}): ${errorText}`);
  }

  return await response.blob();
}

export function resetConversation() {
  messageHistory = [];
}