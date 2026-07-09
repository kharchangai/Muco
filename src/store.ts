import { load, Store } from "@tauri-apps/plugin-store";

export type AppSettings = {
  apiKey: string;
  baseUrl: string;
  llmModel: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  // Vision settings
  visionApiKey: string;
  visionBaseUrl: string;
  visionModel: string;
  // Perplexity settings
  perplexityApiKey: string;
  perplexityBaseUrl: string;
  perplexityModel: string;
  searchDepth: number;
};

let settingsStore: Store | null = null;

export async function getSettingsStore(): Promise<Store> {
  if (!settingsStore) {
    settingsStore = await load("settings.json", {
      autoSave: false,
    });
  }

  return settingsStore;
}

async function reloadStore(store: Store): Promise<void> {
  const maybeReload = store as Store & {
    reload?: () => Promise<void>;
    load?: () => Promise<void>;
  };

  if (typeof maybeReload.reload === "function") {
    await maybeReload.reload();
    return;
  }

  if (typeof maybeReload.load === "function") {
    await maybeReload.load();
  }
}

export async function readSettings(): Promise<AppSettings> {
  const store = await getSettingsStore();

  await reloadStore(store);

  // Validate search depth and default to 3 if missing or invalid
  const rawDepth = await store.get<number>("MOCU_SEARCH_DEPTH");
  const depth = rawDepth !== null && rawDepth !== undefined ? rawDepth : 3;

  return {
    apiKey: ((await store.get<string>("MOCU_API_KEY")) || "").trim(),
    baseUrl: ((await store.get<string>("MOCU_BASE_URL")) || "").trim(),
    llmModel: ((await store.get<string>("MOCU_LLM_MODEL")) || "").trim(),
    sttModel: ((await store.get<string>("MOCU_STT_MODEL")) || "").trim(),
    ttsModel: ((await store.get<string>("MOCU_TTS_MODEL")) || "").trim(),
    ttsVoice: ((await store.get<string>("MOCU_TTS_VOICE")) || "").trim(),
    // Read Vision settings
    visionApiKey: ((await store.get<string>("MOCU_VISION_API_KEY")) || "").trim(),
    visionBaseUrl: ((await store.get<string>("MOCU_VISION_BASE_URL")) || "").trim(),
    visionModel: ((await store.get<string>("MOCU_VISION_MODEL")) || "").trim(),
    // Read Perplexity settings
    perplexityApiKey: ((await store.get<string>("MOCU_PERPLEXITY_API_KEY")) || "").trim(),
    perplexityBaseUrl: ((await store.get<string>("MOCU_PERPLEXITY_BASE_URL")) || "https://api.perplexity.ai").trim(),
    perplexityModel: ((await store.get<string>("MOCU_PERPLEXITY_MODEL")) || "sonar").trim(),
    searchDepth: depth,
  };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const store = await getSettingsStore();

  await store.set("MOCU_API_KEY", settings.apiKey.trim());
  await store.set("MOCU_BASE_URL", settings.baseUrl.trim());
  await store.set("MOCU_LLM_MODEL", settings.llmModel.trim());
  await store.set("MOCU_STT_MODEL", settings.sttModel.trim());
  await store.set("MOCU_TTS_MODEL", settings.ttsModel.trim());
  await store.set("MOCU_TTS_VOICE", settings.ttsVoice.trim());
  // Save Vision settings
  await store.set("MOCU_VISION_API_KEY", (settings.visionApiKey || "").trim());
  await store.set("MOCU_VISION_BASE_URL", (settings.visionBaseUrl || "").trim());
  await store.set("MOCU_VISION_MODEL", (settings.visionModel || "").trim());
  // Save Perplexity settings
  await store.set("MOCU_PERPLEXITY_API_KEY", (settings.perplexityApiKey || "").trim());
  await store.set("MOCU_PERPLEXITY_BASE_URL", (settings.perplexityBaseUrl || "https://api.perplexity.ai").trim());
  await store.set("MOCU_PERPLEXITY_MODEL", (settings.perplexityModel || "sonar").trim());
  await store.set("MOCU_SEARCH_DEPTH", typeof settings.searchDepth === "number" ? settings.searchDepth : 3);

  await store.save();

  await reloadStore(store);
}