import { config } from "../../package.json";
import {
  DEFAULT_SYSTEM_PROMPT_EN,
  DEFAULT_SYSTEM_PROMPT_CN,
} from "./chat-session";

const PREF_PREFIX = config.prefsPrefix;
const ADDON_REF = config.addonRef;

function getPrefFull(key: string): string {
  return Zotero.Prefs.get(`${PREF_PREFIX}.${key}`, true) as string ?? "";
}

function setPrefFull(key: string, value: string): void {
  Zotero.Prefs.set(`${PREF_PREFIX}.${key}`, value, true);
}

function initPromptUI() {
  const textarea = document.getElementById(
    `zotero-prefpane-${ADDON_REF}-systemPrompt`,
  ) as HTMLTextAreaElement | null;
  const langSelect = document.getElementById(
    `zotero-prefpane-${ADDON_REF}-promptLang`,
  ) as HTMLSelectElement | null;
  const resetBtn = document.getElementById(
    `zotero-prefpane-${ADDON_REF}-promptReset`,
  ) as HTMLButtonElement | null;

  if (!textarea || !langSelect || !resetBtn) return;

  // Initialize: if pref is empty, show EN default as placeholder
  const current = getPrefFull("systemPrompt");
  if (!current) {
    // Detect which default matches better for initial lang selection
    langSelect.value = "en";
  } else {
    // Detect language from content
    langSelect.value =
      current.includes("你是") || current.includes("文档") || current.includes("用户")
        ? "cn"
        : "en";
  }

  // Language selector: load default for selected language
  langSelect.addEventListener("change", () => {
    const lang = langSelect.value;
    const prompt = lang === "cn" ? DEFAULT_SYSTEM_PROMPT_CN : DEFAULT_SYSTEM_PROMPT_EN;
    textarea.value = prompt;
    setPrefFull("systemPrompt", prompt);
  });

  // Reset button: reset to default for current language
  resetBtn.addEventListener("click", () => {
    const lang = langSelect.value;
    const prompt = lang === "cn" ? DEFAULT_SYSTEM_PROMPT_CN : DEFAULT_SYSTEM_PROMPT_EN;
    textarea.value = prompt;
    setPrefFull("systemPrompt", prompt);
  });
}

// Run when the preference pane is loaded
if (document.readyState === "complete") {
  initPromptUI();
} else {
  document.addEventListener("DOMContentLoaded", initPromptUI);
}
