import React, { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { readSettings, saveSettings } from "../store";

export const Settings: React.FC = () => {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [llmModel, setLlmModel] = useState("");
  const [sttModel, setSttModel] = useState("");
  const [ttsModel, setTtsModel] = useState("");
  const [ttsVoice, setTtsVoice] = useState("");
  
  // Vision settings states
  const [visionApiKey, setVisionApiKey] = useState("");
  const [visionBaseUrl, setVisionBaseUrl] = useState("");
  const [visionModel, setVisionModel] = useState("");

  // Perplexity settings states
  const [perplexityApiKey, setPerplexityApiKey] = useState("");
  const [perplexityBaseUrl, setPerplexityBaseUrl] = useState("");
  const [perplexityModel, setPerplexityModel] = useState("");
  const [searchDepth, setSearchDepth] = useState(3);

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const appWindow = getCurrentWebviewWindow();

  useEffect(() => {
    let isMounted = true;

    const loadSettings = async () => {
      try {
        const settings = await readSettings();

        if (!isMounted) return;

        setApiKey(settings.apiKey || "");
        setBaseUrl(settings.baseUrl || "");
        setLlmModel(settings.llmModel || "");
        setSttModel(settings.sttModel || "");
        setTtsModel(settings.ttsModel || "");
        setTtsVoice(settings.ttsVoice || "");
        
        // Load Vision settings
        setVisionApiKey(settings.visionApiKey || "");
        setVisionBaseUrl(settings.visionBaseUrl || "");
        setVisionModel(settings.visionModel || "");

        setPerplexityApiKey(settings.perplexityApiKey || "");
        setPerplexityBaseUrl(settings.perplexityBaseUrl || "https://api.perplexity.ai");
        setPerplexityModel(settings.perplexityModel || "sonar");
        setSearchDepth(settings.searchDepth !== undefined ? settings.searchDepth : 3);

      } catch (error) {
        console.error("Failed to load settings:", error);
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    loadSettings();

    return () => {
      isMounted = false;
    };
  }, []);

  const handleSave = async () => {
    if (isSaving) return;
    setIsSaving(true);

    try {
      const settings = {
        apiKey,
        baseUrl,
        llmModel,
        sttModel,
        ttsModel,
        ttsVoice,
        // Vision settings
        visionApiKey,
        visionBaseUrl,
        visionModel,
        perplexityApiKey,
        perplexityBaseUrl,
        perplexityModel,
        searchDepth: Number(searchDepth),
      };

      await saveSettings(settings);
      await appWindow.close();
    } catch (error) {
      console.error("Failed to save settings:", error);
      setIsSaving(false);
    }
  };

  const handleCancel = async () => {
    await appWindow.close();
  };

  if (isLoading) {
    return (
      <div className="w-full h-screen flex items-center justify-center bg-[#070707] text-white select-none">
        <span className="text-xs text-white/40 tracking-wider animate-pulse">Loading settings...</span>
      </div>
    );
  }

  return (
    <div className="w-full h-screen flex flex-col justify-between p-6 bg-[#070707] text-white select-none font-sans">
      
      {/* Inline styles to hide scrollbars globally in this window */}
      <style>{`
        .no-scrollbar::-webkit-scrollbar {
          display: none;
        }
        .no-scrollbar {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
      `}</style>

      {/* Header */}
      <div className="border-b border-white/5 pb-4">
        <h3 className="text-[11px] font-bold tracking-widest text-white/50 uppercase">
          Mocu Settings
        </h3>
      </div>

      {/* Scrollable form container without visible scrollbar */}
      <div className="flex-1 overflow-y-auto no-scrollbar my-4 pr-0.5 flex flex-col gap-5 max-h-[calc(100vh-140px)]">
        
        {/* Section 1: General AI Settings */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] text-white/30 font-semibold uppercase tracking-wider pl-1">
              API Key
            </label>
            <input
              type="password"
              value={apiKey}
              disabled={isSaving}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Enter your LLM API Key"
              className="w-full bg-[#111111] border border-white/5 rounded-lg px-3 py-2.5 text-xs text-white placeholder-white/20 focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/5 transition-all disabled:opacity-50"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] text-white/30 font-semibold uppercase tracking-wider pl-1">
              Base URL
            </label>
            <input
              type="text"
              value={baseUrl}
              disabled={isSaving}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.openai.com/v1"
              className="w-full bg-[#111111] border border-white/5 rounded-lg px-3 py-2.5 text-xs text-white placeholder-white/20 focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/5 transition-all disabled:opacity-50"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] text-white/30 font-semibold uppercase tracking-wider pl-1">
              LLM Model
            </label>
            <input
              type="text"
              value={llmModel}
              disabled={isSaving}
              onChange={(event) => setLlmModel(event.target.value)}
              className="w-full bg-[#111111] border border-white/5 rounded-lg px-3 py-2.5 text-xs text-white focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/5 transition-all disabled:opacity-50"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] text-white/30 font-semibold uppercase tracking-wider pl-1">
              STT Model
            </label>
            <input
              type="text"
              value={sttModel}
              disabled={isSaving}
              onChange={(event) => setSttModel(event.target.value)}
              className="w-full bg-[#111111] border border-white/5 rounded-lg px-3 py-2.5 text-xs text-white focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/5 transition-all disabled:opacity-50"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] text-white/30 font-semibold uppercase tracking-wider pl-1">
                TTS Model
              </label>
              <input
                type="text"
                value={ttsModel}
                disabled={isSaving}
                onChange={(event) => setTtsModel(event.target.value)}
                className="w-full bg-[#111111] border border-white/5 rounded-lg px-3 py-2.5 text-xs text-white focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/5 transition-all disabled:opacity-50"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] text-white/30 font-semibold uppercase tracking-wider pl-1">
                TTS Voice
              </label>
              <input
                type="text"
                value={ttsVoice}
                disabled={isSaving}
                onChange={(event) => setTtsVoice(event.target.value)}
                className="w-full bg-[#111111] border border-white/5 rounded-lg px-3 py-2.5 text-xs text-white focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/5 transition-all disabled:opacity-50"
              />
            </div>
          </div>
        </div>

        {/* Section: Vision Model Settings */}
        <div className="bg-[#0c0c0c] border border-white/5 p-4 rounded-xl flex flex-col gap-4 mt-2">
          <div className="border-b border-white/5 pb-2">
            <h4 className="text-[10px] font-bold text-white/40 uppercase tracking-widest">
              Vision Model
            </h4>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] text-white/30 font-semibold uppercase tracking-wider pl-0.5">
              API Key
            </label>
            <input
              type="password"
              value={visionApiKey}
              disabled={isSaving}
              onChange={(event) => setVisionApiKey(event.target.value)}
              placeholder="Enter Vision Model API Key"
              className="w-full bg-[#141414] border border-white/5 rounded-lg px-3 py-2.5 text-xs text-white placeholder-white/20 focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/5 transition-all disabled:opacity-50"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] text-white/30 font-semibold uppercase tracking-wider pl-0.5">
              Base URL
            </label>
            <input
              type="text"
              value={visionBaseUrl}
              disabled={isSaving}
              onChange={(event) => setVisionBaseUrl(event.target.value)}
              placeholder="https://api.openai.com/v1"
              className="w-full bg-[#141414] border border-white/5 rounded-lg px-3 py-2.5 text-xs text-white placeholder-white/20 focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/5 transition-all disabled:opacity-50"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] text-white/30 font-semibold uppercase tracking-wider pl-0.5">
              Model Name
            </label>
            <input
              type="text"
              value={visionModel}
              disabled={isSaving}
              onChange={(event) => setVisionModel(event.target.value)}
              placeholder="gpt-4o-mini"
              className="w-full bg-[#141414] border border-white/5 rounded-lg px-3 py-2.5 text-xs text-white placeholder-white/20 focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/5 transition-all disabled:opacity-50"
            />
          </div>
        </div>

        {/* Section 2: Perplexity (Research Engine) Card */}
        <div className="bg-[#0c0c0c] border border-white/5 p-4 rounded-xl flex flex-col gap-4 mt-2">
          <div className="border-b border-white/5 pb-2">
            <h4 className="text-[10px] font-bold text-white/40 uppercase tracking-widest">
              Perplexity (Research Engine)
            </h4>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] text-white/30 font-semibold uppercase tracking-wider pl-0.5">
              API Key
            </label>
            <input
              type="password"
              value={perplexityApiKey}
              disabled={isSaving}
              onChange={(event) => setPerplexityApiKey(event.target.value)}
              placeholder="Enter Perplexity API Key"
              className="w-full bg-[#141414] border border-white/5 rounded-lg px-3 py-2.5 text-xs text-white placeholder-white/20 focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/5 transition-all disabled:opacity-50"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] text-white/30 font-semibold uppercase tracking-wider pl-0.5">
              Base URL
            </label>
            <input
              type="text"
              value={perplexityBaseUrl}
              disabled={isSaving}
              onChange={(event) => setPerplexityBaseUrl(event.target.value)}
              className="w-full bg-[#141414] border border-white/5 rounded-lg px-3 py-2.5 text-xs text-white focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/5 transition-all disabled:opacity-50"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] text-white/30 font-semibold uppercase tracking-wider pl-0.5">
                Model
              </label>
              <input
                type="text"
                value={perplexityModel}
                disabled={isSaving}
                onChange={(event) => setPerplexityModel(event.target.value)}
                className="w-full bg-[#141414] border border-white/5 rounded-lg px-3 py-2.5 text-xs text-white focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/5 transition-all disabled:opacity-50"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] text-white/30 font-semibold uppercase tracking-wider pl-0.5">
                Search Depth
              </label>
              <input
                type="number"
                min="1"
                max="10"
                value={searchDepth}
                disabled={isSaving}
                onChange={(event) => setSearchDepth(Number(event.target.value))}
                className="w-full bg-[#141414] border border-white/5 rounded-lg px-3 py-2.5 text-xs text-white focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/5 transition-all disabled:opacity-50"
              />
            </div>
          </div>
        </div>

      </div>

      {/* Action Buttons */}
      <div className="flex gap-3 pt-4 border-t border-white/5">
        <button
          type="button"
          onClick={handleCancel}
          disabled={isSaving}
          className="flex-1 bg-white/5 hover:bg-white/10 text-white text-xs font-semibold py-2.5 rounded-lg transition-colors disabled:opacity-50"
        >
          Cancel
        </button>

        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving}
          className="flex-1 bg-white text-black hover:bg-white/90 text-xs font-semibold py-2.5 rounded-lg transition-colors disabled:opacity-50"
        >
          {isSaving ? "Saving..." : "Save Changes"}
        </button>
      </div>
    </div>
  );
};