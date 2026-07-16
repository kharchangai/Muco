import { load, Store } from "@tauri-apps/plugin-store";

export type AppSettings = {
  // LLM settings
  apiKey: string;

  cheapBaseUrl: string;
  cheapModel: string;

  mediumBaseUrl: string;
  mediumModel: string;

  expensiveBaseUrl: string;
  expensiveModel: string;

  // Speech settings
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;

  // Embedding settings
  embeddingApiKey: string;
  embeddingBaseUrl: string;
  embeddingModel: string;

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

function getValidSearchDepth(value: number | null | undefined): number {
  if (!Number.isFinite(value)) {
    return 3;
  }

  const depth = Math.floor(value);

  if (depth < 1) {
    return 1;
  }

  if (depth > 10) {
    return 10;
  }

  return depth;
}

export async function readSettings(): Promise<AppSettings> {
  const store = await getSettingsStore();

  await reloadStore(store);

  const rawDepth = await store.get<number>("MOCU_SEARCH_DEPTH");

  const legacyBaseUrl = (
    (await store.get<string>("MOCU_BASE_URL")) || ""
  ).trim();

  const legacyLlmModel = (
    (await store.get<string>("MOCU_LLM_MODEL")) || ""
  ).trim();

  const expensiveBaseUrl = (
    (await store.get<string>("MOCU_EXPENSIVE_BASE_URL")) || legacyBaseUrl
  ).trim();

  const expensiveModel = (
    (await store.get<string>("MOCU_EXPENSIVE_MODEL")) || legacyLlmModel
  ).trim();

  return {
    // LLM settings
    apiKey: ((await store.get<string>("MOCU_API_KEY")) || "").trim(),

    cheapBaseUrl: (
      (await store.get<string>("MOCU_CHEAP_BASE_URL")) || ""
    ).trim(),
    cheapModel: ((await store.get<string>("MOCU_CHEAP_MODEL")) || "").trim(),

    mediumBaseUrl: (
      (await store.get<string>("MOCU_MEDIUM_BASE_URL")) || ""
    ).trim(),
    mediumModel: (
      (await store.get<string>("MOCU_MEDIUM_MODEL")) || ""
    ).trim(),

    // Falls back to old settings for migration compatibility.
    expensiveBaseUrl,
    expensiveModel,

    // Speech settings
    sttModel: ((await store.get<string>("MOCU_STT_MODEL")) || "").trim(),
    ttsModel: ((await store.get<string>("MOCU_TTS_MODEL")) || "").trim(),
    ttsVoice: ((await store.get<string>("MOCU_TTS_VOICE")) || "").trim(),

    // Embedding settings
    embeddingApiKey: (
      (await store.get<string>("MOCU_EMBEDDING_API_KEY")) || ""
    ).trim(),
    embeddingBaseUrl: (
      (await store.get<string>("MOCU_EMBEDDING_BASE_URL")) || ""
    ).trim(),
    embeddingModel: (
      (await store.get<string>("MOCU_EMBEDDING_MODEL")) || ""
    ).trim(),

    // Vision settings
    visionApiKey: (
      (await store.get<string>("MOCU_VISION_API_KEY")) || ""
    ).trim(),
    visionBaseUrl: (
      (await store.get<string>("MOCU_VISION_BASE_URL")) || ""
    ).trim(),
    visionModel: (
      (await store.get<string>("MOCU_VISION_MODEL")) || ""
    ).trim(),

    // Perplexity settings
    perplexityApiKey: (
      (await store.get<string>("MOCU_PERPLEXITY_API_KEY")) || ""
    ).trim(),
    perplexityBaseUrl: (
      (await store.get<string>("MOCU_PERPLEXITY_BASE_URL")) ||
      "https://api.perplexity.ai"
    ).trim(),
    perplexityModel: (
      (await store.get<string>("MOCU_PERPLEXITY_MODEL")) || "sonar"
    ).trim(),
    searchDepth: getValidSearchDepth(rawDepth),
  };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const store = await getSettingsStore();

  // LLM settings
  await store.set("MOCU_API_KEY", (settings.apiKey || "").trim());

  await store.set(
    "MOCU_CHEAP_BASE_URL",
    (settings.cheapBaseUrl || "").trim(),
  );
  await store.set(
    "MOCU_CHEAP_MODEL",
    (settings.cheapModel || "").trim(),
  );

  await store.set(
    "MOCU_MEDIUM_BASE_URL",
    (settings.mediumBaseUrl || "").trim(),
  );
  await store.set(
    "MOCU_MEDIUM_MODEL",
    (settings.mediumModel || "").trim(),
  );

  await store.set(
    "MOCU_EXPENSIVE_BASE_URL",
    (settings.expensiveBaseUrl || "").trim(),
  );
  await store.set(
    "MOCU_EXPENSIVE_MODEL",
    (settings.expensiveModel || "").trim(),
  );

  // Speech settings
  await store.set("MOCU_STT_MODEL", (settings.sttModel || "").trim());
  await store.set("MOCU_TTS_MODEL", (settings.ttsModel || "").trim());
  await store.set("MOCU_TTS_VOICE", (settings.ttsVoice || "").trim());

  // Embedding settings
  await store.set(
    "MOCU_EMBEDDING_API_KEY",
    (settings.embeddingApiKey || "").trim(),
  );
  await store.set(
    "MOCU_EMBEDDING_BASE_URL",
    (settings.embeddingBaseUrl || "").trim(),
  );
  await store.set(
    "MOCU_EMBEDDING_MODEL",
    (settings.embeddingModel || "").trim(),
  );

  // Vision settings
  await store.set(
    "MOCU_VISION_API_KEY",
    (settings.visionApiKey || "").trim(),
  );
  await store.set(
    "MOCU_VISION_BASE_URL",
    (settings.visionBaseUrl || "").trim(),
  );
  await store.set(
    "MOCU_VISION_MODEL",
    (settings.visionModel || "").trim(),
  );

  // Perplexity settings
  await store.set(
    "MOCU_PERPLEXITY_API_KEY",
    (settings.perplexityApiKey || "").trim(),
  );
  await store.set(
    "MOCU_PERPLEXITY_BASE_URL",
    (
      settings.perplexityBaseUrl || "https://api.perplexity.ai"
    ).trim(),
  );
  await store.set(
    "MOCU_PERPLEXITY_MODEL",
    (settings.perplexityModel || "sonar").trim(),
  );
  await store.set(
    "MOCU_SEARCH_DEPTH",
    getValidSearchDepth(settings.searchDepth),
  );

  await store.save();
  await reloadStore(store);
}