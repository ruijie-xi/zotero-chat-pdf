import { MODEL_BUDGET_FIELDS } from "./model-profile";
import { resolveModelCapabilities } from "./model-capabilities";
import type { ModelProfile } from "./model-profile";
import { buildLLMHeaders, createProviderSessionId, getProviderApiBase, LLMProvider, normalizeProvider, PROVIDER_MODELS, PROVIDER_PRESETS } from "./llm-provider";
import { config } from "../../package.json";
import { XUL_NS, XULMenuList } from "../utils/dom";
import { uiText } from "../utils/ui-text";
import {
  DEFAULT_SYSTEM_PROMPT_EN,
  DEFAULT_SYSTEM_PROMPT_CN,
  migrateDefaultPrompt,
} from "./prompts";
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
let refreshProfiles: (() => void) | undefined;

function getPrefFull(key: string): string {
  return (Zotero.Prefs.get(`${PREF_PREFIX}.${key}`, true) as string) ?? "";
}

function setPrefFull(key: string, value: string): void {
  Zotero.Prefs.set(`${PREF_PREFIX}.${key}`, value, true);
}

function getFieldValue(key: string, fallback = ""): string {
  const el = document.querySelector(
    `#zotero-prefpane-${ADDON_REF}-${key}`,
  ) as HTMLInputElement | XULMenuList | HTMLTextAreaElement | null;
  if (el && typeof el.value === "string") return el.value;
  return getPrefFull(key) || fallback;
}

function setFieldValue(key: string, value: string): void {
  const el = document.querySelector(
    `#zotero-prefpane-${ADDON_REF}-${key}`,
  ) as HTMLInputElement | XULMenuList | HTMLTextAreaElement | null;
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
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(profile => profile && typeof profile.name === "string" && typeof profile.model === "string" && typeof profile.apiBase === "string" && typeof profile.apiKey === "string") : [];
  } catch {
    return [];
  }
}

function saveProfiles(profiles: ModelProfile[]): void {
  Zotero.Prefs.set(`${PREF_PREFIX}.modelProfiles`, JSON.stringify(profiles), true);
}

function readModelFields(name: string, provider = normalizeProvider(getFieldValue("llmProvider"))): ModelProfile {
  const profile: ModelProfile = {
    name, provider,
    apiBase: getProviderApiBase({ provider, apiBase: getFieldValue("llmApiBase") }),
    apiKey: getFieldValue("llmApiKey"), model: getFieldValue("llmModel"),
    thinkingMode: getFieldValue("llmThinkingMode", "default"),
    thinkEffort: getFieldValue("llmThinkEffort", "default"),
    tokenizerMode: getFieldValue("tokenizerMode", "auto"),
  };
  for (const key of MODEL_BUDGET_FIELDS) profile[key] = Number(getFieldValue(key)) || 0;
  return profile;
}

function writeModelFields(profile: ModelProfile): void {
  const provider = normalizeProvider(profile.provider);
  const values = {
    llmProvider: provider, llmApiBase: getProviderApiBase({ ...profile, provider }),
    llmApiKey: profile.apiKey, llmModel: profile.model,
    llmThinkingMode: profile.thinkingMode || "default", llmThinkEffort: profile.thinkEffort || "default",
    tokenizerMode: profile.tokenizerMode || "auto",
  };
  for (const [key, value] of Object.entries(values)) {
    setPrefFull(key, value);
    setFieldValue(key, value);
  }
  for (const key of MODEL_BUDGET_FIELDS) {
    Zotero.Prefs.set(`${PREF_PREFIX}.${key}`, profile[key] || 0, true);
    setFieldValue(key, String(profile[key] || 0));
  }
  setPrefFull("activeProfile", profile.name);
  syncProviderUI();
  updateSettingsSummary();
}

function updateSettingsSummary(): void {
  const summary = document.querySelector(`#zotero-prefpane-${ADDON_REF}-modelRoleStatus`);
  if (!summary) return;
  const name = getFieldValue("pdfVisionProfile");
  const profile = loadProfiles().find(profile => profile.name === name);
  const current = getFieldValue("llmModel") || uiText("Not configured", "未配置");
  const activeName = getPrefFull("activeProfile"), active = loadProfiles().find(profile => profile.name === activeName);
  let edited = false;
  if (active) {
    const live = readModelFields(activeName);
    const normalized = { ...active, provider: normalizeProvider(active.provider), apiBase: getProviderApiBase(active), thinkingMode: active.thinkingMode || "default", thinkEffort: active.thinkEffort || "default", tokenizerMode: active.tokenizerMode || "auto" };
    edited = (["provider", "apiBase", "apiKey", "model", "thinkingMode", "thinkEffort", "tokenizerMode", ...MODEL_BUDGET_FIELDS] as const)
      .some(key => (live[key] ?? 0) !== (normalized[key] ?? 0));
  }
  const conversion = name ? profile ? `${name} (${profile.model})` : uiText(`Missing profile: ${name}. Choose a saved profile before converting.`, `配置“${name}”不存在，请先选择有效配置。`)
    : uiText(`Current chat model (${current})`, `跟随聊天模型（${current}）`);
  summary.textContent = uiText(`Chat: ${current} · PDF conversion: ${conversion}`, `聊天：${current} · PDF 转换：${conversion}`)
    + (edited ? uiText(` · Current fields differ from saved profile "${activeName}"`, ` · 当前字段已修改，尚未更新已保存配置“${activeName}”`) : "");
  summary.classList.toggle("chatpdf-preference-error", !!name && !profile);
}

function initSettingsLayout(): void {
  const bind = (key: string, event: string, listener: () => void) => {
    const element = document.querySelector(`#zotero-prefpane-${ADDON_REF}-${key}`) as HTMLElement | null;
    if (!element || element.hasAttribute("data-layout-bound")) return;
    element.setAttribute("data-layout-bound", "true"); element.addEventListener(event, listener);
  };
  const showEngine = () => {
    const engine = getFieldValue("pdfConversionEngine", "vision");
    for (const kind of ["vision", "mineru"]) {
      const group = document.querySelector(`#zotero-prefpane-${ADDON_REF}-${kind}Settings`) as HTMLElement | null;
      if (group) group.hidden = engine !== kind;
    }
  };
  const showWeb = () => {
    const enabled = document.querySelector(`#zotero-prefpane-${ADDON_REF}-enableWebTools`) as HTMLInputElement | null;
    const group = document.querySelector(`#zotero-prefpane-${ADDON_REF}-webSettings`) as HTMLElement | null;
    if (group) group.hidden = !enabled?.checked;
  };
  bind("pdfConversionEngine", "command", showEngine);
  bind("enableWebTools", "change", showWeb);
  for (const key of ["llmProvider", "llmModel", "llmApiBase", "llmApiKey", "llmThinkingMode", "llmThinkEffort", "tokenizerMode", ...MODEL_BUDGET_FIELDS]) {
    const element = document.querySelector(`#zotero-prefpane-${ADDON_REF}-${key}`);
    bind(key, element?.localName === "menulist" ? "command" : "change", updateSettingsSummary);
  }
  showEngine(); showWeb(); updateSettingsSummary();
}

function syncProviderUI(): void {
  const select = document.querySelector(`#zotero-prefpane-${ADDON_REF}-llmProvider`) as XULMenuList | null;
  if (!select) return;
  const provider = normalizeProvider(getFieldValue("llmProvider"));
  select.value = provider;
  select.setAttribute("data-current-provider", provider);
  const base = document.querySelector(`#zotero-prefpane-${ADDON_REF}-llmApiBase`) as HTMLInputElement | null;
  if (base) base.readOnly = provider !== "custom";
  const hint = document.querySelector(`#zotero-prefpane-${ADDON_REF}-providerHint`) as HTMLElement | null;
  if (hint) hint.hidden = provider !== "opencode-go";
  const models = document.querySelector(`#zotero-prefpane-${ADDON_REF}-providerModels`) as XULMenuList | null;
  if (models) {
    const popup = models.querySelector("menupopup")!;
    popup.replaceChildren();
    models.hidden = provider === "custom";
    for (const model of PROVIDER_MODELS[provider]) {
      const option = document.createElementNS(XUL_NS, "menuitem");
      option.setAttribute("value", model);
      option.setAttribute("label", model);
      popup.appendChild(option);
    }
  }
}

function initProviderUI(): boolean {
  const select = document.querySelector(`#zotero-prefpane-${ADDON_REF}-llmProvider`) as XULMenuList | null;
  if (!select) return false;
  if (select.hasAttribute("data-provider-bound")) return true;
  select.setAttribute("data-provider-bound", "true");
  // Keep credentials, overrides and unsaved custom edits separate while this pane is open.
  const drafts = new Map<LLMProvider, ModelProfile>();
  select.value = normalizeProvider(getPrefFull("llmProvider"));
  syncProviderUI();
  select.addEventListener("command", () => {
    const previous = normalizeProvider(select.getAttribute("data-current-provider"));
    const provider = normalizeProvider(select.value);
    drafts.set(previous, readModelFields(getPrefFull("activeProfile"), previous));
    let next = drafts.get(provider);
    if (!next) {
      const preset = provider === "custom" ? undefined : PROVIDER_PRESETS[provider];
      next = { name: "", provider, apiBase: preset?.apiBase || "", apiKey: "",
        model: preset?.model || "", tokenizerMode: preset?.tokenizerMode || "auto",
        thinkingMode: "default", thinkEffort: "default" };
    }
    writeModelFields(next);
  });
  const models = document.querySelector(`#zotero-prefpane-${ADDON_REF}-providerModels`) as XULMenuList | null;
  models?.addEventListener("command", () => {
    const model = models.value;
    if (!PROVIDER_MODELS[normalizeProvider(select.value)].includes(model)) return;
    setFieldValue("llmModel", model);
    setPrefFull("llmModel", model);
    document.querySelector(`#zotero-prefpane-${ADDON_REF}-llmModel`)?.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return true;
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
    const suggestions = document.querySelector(`#zotero-prefpane-${ADDON_REF}-pdfVisionProfiles > menupopup`);
    if (suggestions) {
      const selected = getFieldValue("pdfVisionProfile");
      const options = [{ value: "", label: uiText("Use current chat model", "跟随当前聊天模型") }, ...profiles.map(profile => ({ value: profile.name, label: profile.name }))];
      if (selected && !profiles.some(profile => profile.name === selected)) {
        options.push({ value: selected, label: uiText(`Missing: ${selected}`, `配置不存在：${selected}`) });
      }
      // Keep a clicked native menuitem attached until Gecko closes its popup.
      const existing = new Map([...suggestions.children].map(option => [option.getAttribute("value") || "", option]));
      for (const [index, option] of options.entries()) {
        const item = existing.get(option.value) || document.createElementNS(XUL_NS, "menuitem");
        item.setAttribute("value", option.value); item.setAttribute("label", option.label);
        if (suggestions.children[index] !== item) suggestions.insertBefore(item, suggestions.children[index] || null);
      }
      for (const [value, item] of existing) if (!options.some(option => option.value === value)) item.remove();
      (suggestions.parentElement as unknown as XULMenuList).value = selected;
    }
    const activeProfile = Zotero.Prefs.get(`${PREF_PREFIX}.activeProfile`, true) as string || "";

    if (profiles.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = uiText("No profiles saved", "尚未保存模型配置");
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
      loadBtn.textContent = uiText("Load", "加载");
      loadBtn.style.cssText = "font-size: 11px; padding: 1px 8px; cursor: pointer;";
      loadBtn.addEventListener("click", () => {
        writeModelFields(p);
        showProfileStatus(uiText(`Loaded profile "${p.name}"`, `已加载配置“${p.name}”`));
        renderProfileList();
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = uiText("Delete", "删除");
      const usedForConversion = getFieldValue("pdfVisionProfile") === p.name;
      deleteBtn.disabled = usedForConversion;
      deleteBtn.title = usedForConversion ? uiText("Used for PDF conversion. Select another conversion profile before deleting.", "此配置正在用于 PDF 转换，请先切换转换模型，再删除。") : "";
      deleteBtn.style.cssText = "font-size: 11px; padding: 1px 6px; cursor: pointer;";
      deleteBtn.addEventListener("click", () => {
        if (getFieldValue("pdfVisionProfile") === p.name) return;
        const updated = loadProfiles().filter(x => x.name !== p.name);
        saveProfiles(updated);
        if (activeProfile === p.name) {
          Zotero.Prefs.set(`${PREF_PREFIX}.activeProfile`, "", true);
        }
        showProfileStatus(uiText(`Deleted profile "${p.name}"`, `已删除配置“${p.name}”`));
        renderProfileList();
        updateSettingsSummary();
      });

      row.appendChild(nameEl);
      row.appendChild(modelEl);
      row.appendChild(loadBtn);
      row.appendChild(deleteBtn);
      profileList.appendChild(row);
    }
    updateSettingsSummary();
  }

  profileSaveBtn.addEventListener("click", () => {
    const name = profileNameInput.value.trim();
    if (!name) { showProfileStatus(uiText("Enter a profile name", "请填写配置名称"), true); return; }
    const profiles = loadProfiles();
    const existing = profiles.findIndex(p => p.name === name);
    const profile = readModelFields(name);
    if (existing >= 0) {
      profiles[existing] = profile;
    } else {
      profiles.push(profile);
    }
    saveProfiles(profiles);
    writeModelFields(profile);
    showProfileStatus(uiText(`Saved profile "${name}"`, `已保存配置“${name}”`));
    profileNameInput.value = "";
    renderProfileList();
  });

  refreshProfiles = renderProfileList;
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
  const sessionId = createProviderSessionId();

  function writeDebug(value: unknown) {
    debugOut.style.display = "";
    debugOut.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }

  testBtn.addEventListener("click", async () => {
    const provider = normalizeProvider(getFieldValue("llmProvider"));
    const apiBase = getProviderApiBase({ provider, apiBase: getFieldValue("llmApiBase", "https://api.deepseek.com/v1") });
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
      provider,
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
        headers: buildLLMHeaders({ provider, apiBase, apiKey, sessionId }),
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
  const current = migrateDefaultPrompt(getPrefFull("systemPrompt"));
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
  textarea.addEventListener("input", () => { if (statusEl) statusEl.textContent = uiText("Unsaved prompt changes — click Save prompt", "提示词有未保存的修改，请点击“保存提示词”"); });

  // Reset to English default
  resetENBtn.addEventListener("click", () => {
    textarea.value = DEFAULT_SYSTEM_PROMPT_EN;
    setPrefFull("systemPrompt", DEFAULT_SYSTEM_PROMPT_EN);
    showStatus(uiText("English default saved", "已保存英文默认提示词"));
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
    showStatus(uiText("Prompt saved", "提示词已保存"));
  });

  return true;
}

// Zotero 7 preference pane scripts run in the main window context.
// The pane XHTML may not be in the DOM yet, so retry until elements appear.
function tryInit(retries: number) {
  const providerOk = initProviderUI();
  const promptOk = initPromptUI();
  const testOk = initLLMTestUI();
  initProfileUI();
  initSettingsLayout();
  const visionProfiles = document.querySelector(`#zotero-prefpane-${ADDON_REF}-pdfVisionProfiles`) as XULMenuList | null;
  if (visionProfiles && !visionProfiles.hasAttribute("data-initialized")) {
    visionProfiles.setAttribute("data-initialized", "true");
    visionProfiles.addEventListener("command", () => {
      setPrefFull("pdfVisionProfile", visionProfiles.value);
      setFieldValue("pdfVisionProfile", visionProfiles.value);
      refreshProfiles?.();
      updateSettingsSummary();
    });
  }
  for (const key of ["llmApiBase", "llmModel", "llmApiKey"]) {
    const field = document.querySelector(`#zotero-prefpane-${ADDON_REF}-${key}`) as HTMLInputElement | null;
    if (!field || field.dataset.budgetBound) continue;
    field.dataset.budgetBound = "true";
    field.addEventListener("change", () => {
      // Direct edits select a new endpoint/model/account. Do not inherit another model's overrides.
      for (const budgetKey of MODEL_BUDGET_FIELDS) {
        Zotero.Prefs.set(`${PREF_PREFIX}.${budgetKey}`, 0, true);
        setFieldValue(budgetKey, "0");
      }
      const tokenizerMode = normalizeProvider(getFieldValue("llmProvider")) === "opencode-go" ? "deepseek-v4-estimate" : "auto";
      setPrefFull("tokenizerMode", tokenizerMode);
      setFieldValue("tokenizerMode", tokenizerMode);
      setPrefFull("activeProfile", "");
      refreshProfiles?.();
      updateSettingsSummary();
    });
  }
  const refresh = document.querySelector(`#zotero-prefpane-${ADDON_REF}-refreshModelLimits`) as HTMLButtonElement | null;
  if (refresh && !refresh.dataset.initialized) {
    refresh.dataset.initialized = "true";
    const sessionId = createProviderSessionId();
    refresh.addEventListener("click", async () => {
      // Preferences and the panel have separate bundles; invalidate both through a shared revision.
      Zotero.Prefs.set(`${PREF_PREFIX}.modelCapabilitiesRevision`, Date.now(), true);
      const status = document.querySelector(`#zotero-prefpane-${ADDON_REF}-modelLimitsStatus`)!;
      refresh.disabled = true;
      try {
        const modelSettings = { ...readModelFields(""), provider: normalizeProvider(getFieldValue("llmProvider")), sessionId, thinkingMode: normalizeThinkingMode(getFieldValue("llmThinkingMode")), thinkEffort: normalizeThinkEffort(getFieldValue("llmThinkEffort")) };
        const limits = await resolveModelCapabilities(modelSettings, undefined, true);
        status.textContent = `${limits.source}: context ${limits.contextWindow || "separate"}, input ${limits.inputLimit || "shared"}, model max output ${limits.maxOutput}; generation ${limits.generation.outputTokens} tokens including thinking (${limits.generation.source}). Local counts are estimates.`;
      } catch (error: any) { status.textContent = error.message; }
      finally { refresh.disabled = false; }
    });
  }
  if (promptOk && testOk && providerOk) return;
  if (retries > 0) {
    setTimeout(() => tryInit(retries - 1), 100);
  } else {
    Zotero.debug(`[ChatPDF] Preference pane init failed after retries`);
  }
}

tryInit(30); // retry up to 3 seconds
