import { config } from "../../package.json";
import {
  DEFAULT_SYSTEM_PROMPT_EN,
  DEFAULT_SYSTEM_PROMPT_CN,
} from "./chat-session";
import {
  buildChatCompletionBody,
  ChatMessage,
  getChatCompletionUrl,
  normalizeThinkEffort,
  normalizeThinkingMode,
  ThinkEffort,
  ThinkingMode,
} from "./llm-client";

const PREF_PREFIX = config.prefsPrefix;
const ADDON_REF = config.addonRef;

interface ModelProfile {
  name: string;
  apiBase: string;
  apiKey: string;
  model: string;
  thinkingMode?: string;
  thinkEffort?: string;
}

function getPrefFull(key: string): string {
  return (Zotero.Prefs.get(`${PREF_PREFIX}.${key}`, true) as string) ?? "";
}

function setPrefFull(key: string, value: string): void {
  Zotero.Prefs.set(`${PREF_PREFIX}.${key}`, value, true);
}

function getFieldValue(key: string, fallback = ""): string {
  const el = document.querySelector(
    `#zotero-prefpane-${ADDON_REF}-${key}`,
  ) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
  if (el && typeof el.value === "string") return el.value;
  return getPrefFull(key) || fallback;
}

function setFieldValue(key: string, value: string): void {
  const el = document.querySelector(
    `#zotero-prefpane-${ADDON_REF}-${key}`,
  ) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
  if (el && typeof el.value === "string") el.value = value;
}

function maskApiKey(apiKey: string): string {
  if (!apiKey) return "(not configured)";
  if (apiKey.length <= 8) return "(configured)";
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

function loadProfiles(): ModelProfile[] {
  try {
    const raw = Zotero.Prefs.get(`${PREF_PREFIX}.modelProfiles`, true) as string;
    if (!raw) return [];
    return JSON.parse(raw) as ModelProfile[];
  } catch {
    return [];
  }
}

function saveProfiles(profiles: ModelProfile[]): void {
  Zotero.Prefs.set(`${PREF_PREFIX}.modelProfiles`, JSON.stringify(profiles), true);
}

function initProfileUI() {
  const profileList = document.querySelector(`#zotero-prefpane-${ADDON_REF}-profileList`) as HTMLElement | null;
  const profileNameInput = document.querySelector(`#zotero-prefpane-${ADDON_REF}-profileName`) as HTMLInputElement | null;
  const profileSaveBtn = document.querySelector(`#zotero-prefpane-${ADDON_REF}-profileSaveBtn`) as HTMLButtonElement | null;
  const profileStatus = document.querySelector(`#zotero-prefpane-${ADDON_REF}-profileStatus`) as HTMLElement | null;

  if (!profileList || !profileNameInput || !profileSaveBtn) return false;
  if ((profileSaveBtn as any).dataset.chatpdfInitialized === "true") return true;
  (profileSaveBtn as any).dataset.chatpdfInitialized = "true";

  function showProfileStatus(msg: string, isError = false) {
    if (!profileStatus) return;
    profileStatus.textContent = msg;
    profileStatus.style.color = isError ? "#ff3b30" : "#34c759";
    setTimeout(() => { profileStatus.textContent = ""; }, 2500);
  }

  function renderProfileList() {
    if (!profileList) return;
    profileList.innerHTML = "";
    const profiles = loadProfiles();
    const activeProfile = Zotero.Prefs.get(`${PREF_PREFIX}.activeProfile`, true) as string || "";

    if (profiles.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No profiles saved";
      empty.style.cssText = "padding: 8px; font-size: 11px; color: #999;";
      profileList.appendChild(empty);
      return;
    }

    for (const p of profiles) {
      const row = document.createElement("div");
      row.style.cssText = "display: flex; align-items: center; padding: 4px 8px; border-bottom: 1px solid var(--fill-quinary, #eee); gap: 6px;";
      if (p.name === activeProfile) row.style.background = "var(--color-accent10, rgba(66,133,244,0.08))";

      const nameEl = document.createElement("span");
      nameEl.textContent = p.name;
      nameEl.style.cssText = "flex: 1; font-size: 12px; font-weight: 500;";

      const modelEl = document.createElement("span");
      const effortLabel = p.thinkEffort && p.thinkEffort !== "default" ? ` / ${p.thinkEffort}` : "";
      modelEl.textContent = `${p.model}${effortLabel}`;
      modelEl.style.cssText = "font-size: 11px; color: #888; max-width: 120px; overflow: hidden; text-overflow: ellipsis;";

      const loadBtn = document.createElement("button");
      loadBtn.textContent = "Load";
      loadBtn.style.cssText = "font-size: 11px; padding: 1px 8px; cursor: pointer;";
      loadBtn.addEventListener("click", () => {
        Zotero.Prefs.set(`${PREF_PREFIX}.llmApiBase`, p.apiBase, true);
        Zotero.Prefs.set(`${PREF_PREFIX}.llmApiKey`, p.apiKey, true);
        Zotero.Prefs.set(`${PREF_PREFIX}.llmModel`, p.model, true);
        Zotero.Prefs.set(`${PREF_PREFIX}.llmThinkingMode`, p.thinkingMode || "default", true);
        Zotero.Prefs.set(`${PREF_PREFIX}.llmThinkEffort`, p.thinkEffort || "default", true);
        Zotero.Prefs.set(`${PREF_PREFIX}.activeProfile`, p.name, true);
        // Refresh the displayed pref fields
        setFieldValue("llmApiBase", p.apiBase);
        setFieldValue("llmApiKey", p.apiKey);
        setFieldValue("llmModel", p.model);
        setFieldValue("llmThinkingMode", p.thinkingMode || "default");
        setFieldValue("llmThinkEffort", p.thinkEffort || "default");
        showProfileStatus(`Loaded profile "${p.name}"`);
        renderProfileList();
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "Delete";
      deleteBtn.style.cssText = "font-size: 11px; padding: 1px 6px; cursor: pointer;";
      deleteBtn.addEventListener("click", () => {
        const updated = loadProfiles().filter(x => x.name !== p.name);
        saveProfiles(updated);
        if (activeProfile === p.name) {
          Zotero.Prefs.set(`${PREF_PREFIX}.activeProfile`, "", true);
        }
        showProfileStatus(`Deleted profile "${p.name}"`);
        renderProfileList();
      });

      row.appendChild(nameEl);
      row.appendChild(modelEl);
      row.appendChild(loadBtn);
      row.appendChild(deleteBtn);
      profileList.appendChild(row);
    }
  }

  profileSaveBtn.addEventListener("click", () => {
    const name = profileNameInput.value.trim();
    if (!name) { showProfileStatus("Enter a profile name", true); return; }
    const apiBase = getFieldValue("llmApiBase");
    const apiKey = getFieldValue("llmApiKey");
    const model = getFieldValue("llmModel");
    const thinkingMode = getFieldValue("llmThinkingMode", "default");
    const thinkEffort = getFieldValue("llmThinkEffort", "default");
    const profiles = loadProfiles();
    const existing = profiles.findIndex(p => p.name === name);
    const profile: ModelProfile = { name, apiBase, apiKey, model, thinkingMode, thinkEffort };
    if (existing >= 0) {
      profiles[existing] = profile;
    } else {
      profiles.push(profile);
    }
    saveProfiles(profiles);
    setPrefFull("llmApiBase", apiBase);
    setPrefFull("llmApiKey", apiKey);
    setPrefFull("llmModel", model);
    setPrefFull("llmThinkingMode", thinkingMode);
    setPrefFull("llmThinkEffort", thinkEffort);
    Zotero.Prefs.set(`${PREF_PREFIX}.activeProfile`, name, true);
    showProfileStatus(`Saved profile "${name}"`);
    profileNameInput.value = "";
    renderProfileList();
  });

  renderProfileList();
  return true;
}

function initLLMTestUI() {
  const testBtn = document.querySelector(
    `#zotero-prefpane-${ADDON_REF}-llmTestBtn`,
  ) as HTMLButtonElement | null;
  const promptEl = document.querySelector(
    `#zotero-prefpane-${ADDON_REF}-llmTestPrompt`,
  ) as HTMLTextAreaElement | null;
  const debugEl = document.querySelector(
    `#zotero-prefpane-${ADDON_REF}-llmTestDebug`,
  ) as HTMLElement | null;

  if (!testBtn || !promptEl || !debugEl) return false;
  if ((testBtn as any).dataset.chatpdfInitialized === "true") return true;
  (testBtn as any).dataset.chatpdfInitialized = "true";
  const debugOut = debugEl;

  function writeDebug(value: unknown) {
    debugOut.style.display = "";
    debugOut.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }

  testBtn.addEventListener("click", async () => {
    const apiBase = getFieldValue("llmApiBase", "https://api.deepseek.com/v1");
    const apiKey = getFieldValue("llmApiKey");
    const model = getFieldValue("llmModel", "deepseek-chat");
    const thinkingMode: ThinkingMode = normalizeThinkingMode(getFieldValue("llmThinkingMode", "default"));
    const thinkEffort: ThinkEffort = normalizeThinkEffort(getFieldValue("llmThinkEffort", "default"));
    const prompt = promptEl.value.trim() || "Reply with exactly: ChatPDF LLM test OK.";
    const url = getChatCompletionUrl(apiBase);
    const isGemini = /generativelanguage\.googleapis\.com/i.test(url);

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: "You are testing ChatPDF's LLM configuration. Follow the user prompt exactly.",
      },
      { role: "user", content: prompt },
    ];

    const body = buildChatCompletionBody(
      { model, thinkingMode, thinkEffort },
      messages,
      {
        stream: false,
        includeUsage: true,
        includeThinkingParams: !isGemini,
      },
    );
    if (isGemini) {
      body.extra_body = { google: { thinking_config: { include_thoughts: true } } };
    }

    const requestDebug = {
      url,
      apiKey: maskApiKey(apiKey),
      model,
      prompt,
      thinkingMode,
      thinkEffort,
      thinkingParametersSent: !isGemini,
      body,
    };

    if (!apiKey) {
      writeDebug({
        ok: false,
        error: "LLM API key is not configured.",
        request: requestDebug,
      });
      return;
    }

    testBtn.disabled = true;
    testBtn.textContent = "Testing...";
    writeDebug({
      status: "Sending test request...",
      request: requestDebug,
    });

    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      const rawText = await res.text();
      let parsed: any = null;
      try {
        parsed = rawText ? JSON.parse(rawText) : null;
      } catch {
        parsed = null;
      }

      const message = parsed?.choices?.[0]?.message;
      writeDebug({
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        durationMs: Date.now() - started,
        request: requestDebug,
        response: {
          model: parsed?.model,
          finishReason: parsed?.choices?.[0]?.finish_reason,
          content: message?.content,
          reasoningContent: message?.reasoning_content,
          usage: parsed?.usage,
          raw: parsed ?? rawText,
        },
      });
    } catch (err: any) {
      writeDebug({
        ok: false,
        durationMs: Date.now() - started,
        request: requestDebug,
        error: {
          name: err?.name,
          message: err?.message || String(err),
          stack: err?.stack,
        },
      });
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = "Test LLM";
    }
  });

  return true;
}

function initPromptUI() {
  const textarea = document.querySelector(
    `#zotero-prefpane-${ADDON_REF}-systemPrompt`,
  ) as HTMLTextAreaElement | null;
  const resetENBtn = document.querySelector(
    `#zotero-prefpane-${ADDON_REF}-promptResetEN`,
  ) as HTMLButtonElement | null;
  const resetCNBtn = document.querySelector(
    `#zotero-prefpane-${ADDON_REF}-promptResetCN`,
  ) as HTMLButtonElement | null;
  const saveBtn = document.querySelector(
    `#zotero-prefpane-${ADDON_REF}-promptSave`,
  ) as HTMLButtonElement | null;
  const statusEl = document.querySelector(
    `#zotero-prefpane-${ADDON_REF}-promptStatus`,
  ) as HTMLElement | null;

  if (!textarea || !resetENBtn || !resetCNBtn || !saveBtn) {
    // Elements not in DOM yet — retry
    Zotero.debug(`[ChatPDF] Preference pane elements not found, retrying...`);
    return false;
  }
  if ((saveBtn as any).dataset.chatpdfInitialized === "true") return true;
  (saveBtn as any).dataset.chatpdfInitialized = "true";

  Zotero.debug(`[ChatPDF] Preference pane elements found, initializing prompt UI`);

  // Initialize: always show the current prompt (default EN if empty)
  const current = getPrefFull("systemPrompt");
  textarea.value = current || DEFAULT_SYSTEM_PROMPT_EN;

  // If pref was empty, persist the default so it's explicit
  if (!current) {
    setPrefFull("systemPrompt", DEFAULT_SYSTEM_PROMPT_EN);
  }

  function showStatus(msg: string) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    setTimeout(() => {
      statusEl.textContent = "";
    }, 2000);
  }

  // Reset to English default
  resetENBtn.addEventListener("click", () => {
    textarea.value = DEFAULT_SYSTEM_PROMPT_EN;
    setPrefFull("systemPrompt", DEFAULT_SYSTEM_PROMPT_EN);
    showStatus("Reset to English default");
  });

  // Reset to Chinese default
  resetCNBtn.addEventListener("click", () => {
    textarea.value = DEFAULT_SYSTEM_PROMPT_CN;
    setPrefFull("systemPrompt", DEFAULT_SYSTEM_PROMPT_CN);
    showStatus("已重置为中文默认");
  });

  // Save button: persist the current textarea content
  saveBtn.addEventListener("click", () => {
    const value = textarea.value.trim();
    setPrefFull("systemPrompt", value);
    showStatus("Saved!");
  });

  return true;
}

// Zotero 7 preference pane scripts run in the main window context.
// The pane XHTML may not be in the DOM yet, so retry until elements appear.
function tryInit(retries: number) {
  const promptOk = initPromptUI();
  const testOk = initLLMTestUI();
  initProfileUI();
  if (promptOk && testOk) return;
  if (retries > 0) {
    setTimeout(() => tryInit(retries - 1), 100);
  } else {
    Zotero.debug(`[ChatPDF] Preference pane init failed after retries`);
  }
}

tryInit(30); // retry up to 3 seconds
