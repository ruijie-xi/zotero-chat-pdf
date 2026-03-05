import { config } from "../../package.json";
import {
  DEFAULT_SYSTEM_PROMPT_EN,
  DEFAULT_SYSTEM_PROMPT_CN,
} from "./chat-session";

const PREF_PREFIX = config.prefsPrefix;
const ADDON_REF = config.addonRef;

interface ModelProfile {
  name: string;
  apiBase: string;
  apiKey: string;
  model: string;
}

function getPrefFull(key: string): string {
  return (Zotero.Prefs.get(`${PREF_PREFIX}.${key}`, true) as string) ?? "";
}

function setPrefFull(key: string, value: string): void {
  Zotero.Prefs.set(`${PREF_PREFIX}.${key}`, value, true);
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
      modelEl.textContent = p.model;
      modelEl.style.cssText = "font-size: 11px; color: #888; max-width: 120px; overflow: hidden; text-overflow: ellipsis;";

      const loadBtn = document.createElement("button");
      loadBtn.textContent = "Load";
      loadBtn.style.cssText = "font-size: 11px; padding: 1px 8px; cursor: pointer;";
      loadBtn.addEventListener("click", () => {
        Zotero.Prefs.set(`${PREF_PREFIX}.llmApiBase`, p.apiBase, true);
        Zotero.Prefs.set(`${PREF_PREFIX}.llmApiKey`, p.apiKey, true);
        Zotero.Prefs.set(`${PREF_PREFIX}.llmModel`, p.model, true);
        Zotero.Prefs.set(`${PREF_PREFIX}.activeProfile`, p.name, true);
        // Refresh the displayed pref fields
        const apiBaseInput = document.querySelector(`#zotero-prefpane-${ADDON_REF}-llmApiBase`) as HTMLInputElement | null;
        const apiKeyInput = document.querySelector(`#zotero-prefpane-${ADDON_REF}-llmApiKey`) as HTMLInputElement | null;
        const modelInput = document.querySelector(`#zotero-prefpane-${ADDON_REF}-llmModel`) as HTMLInputElement | null;
        if (apiBaseInput) apiBaseInput.value = p.apiBase;
        if (apiKeyInput) apiKeyInput.value = p.apiKey;
        if (modelInput) modelInput.value = p.model;
        showProfileStatus(`Loaded profile "${p.name}"`);
        renderProfileList();
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "✕";
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
    const apiBase = (Zotero.Prefs.get(`${PREF_PREFIX}.llmApiBase`, true) as string) || "";
    const apiKey = (Zotero.Prefs.get(`${PREF_PREFIX}.llmApiKey`, true) as string) || "";
    const model = (Zotero.Prefs.get(`${PREF_PREFIX}.llmModel`, true) as string) || "";
    const profiles = loadProfiles();
    const existing = profiles.findIndex(p => p.name === name);
    const profile: ModelProfile = { name, apiBase, apiKey, model };
    if (existing >= 0) {
      profiles[existing] = profile;
    } else {
      profiles.push(profile);
    }
    saveProfiles(profiles);
    Zotero.Prefs.set(`${PREF_PREFIX}.activeProfile`, name, true);
    showProfileStatus(`Saved profile "${name}"`);
    profileNameInput.value = "";
    renderProfileList();
  });

  renderProfileList();
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
  initProfileUI();
  if (promptOk) return;
  if (retries > 0) {
    setTimeout(() => tryInit(retries - 1), 100);
  } else {
    Zotero.debug(`[ChatPDF] Preference pane init failed after retries`);
  }
}

tryInit(30); // retry up to 3 seconds
