import { config } from "../../package.json";
import {
  DEFAULT_SYSTEM_PROMPT_EN,
  DEFAULT_SYSTEM_PROMPT_CN,
} from "./chat-session";

const PREF_PREFIX = config.prefsPrefix;
const ADDON_REF = config.addonRef;

function getPrefFull(key: string): string {
  return (Zotero.Prefs.get(`${PREF_PREFIX}.${key}`, true) as string) ?? "";
}

function setPrefFull(key: string, value: string): void {
  Zotero.Prefs.set(`${PREF_PREFIX}.${key}`, value, true);
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
  if (initPromptUI()) return;
  if (retries > 0) {
    setTimeout(() => tryInit(retries - 1), 100);
  } else {
    Zotero.debug(`[ChatPDF] Preference pane init failed after retries`);
  }
}

tryInit(30); // retry up to 3 seconds
