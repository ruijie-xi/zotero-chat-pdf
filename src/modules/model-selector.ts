import { config } from "../../package.json";
import { XUL_NS, type XULMenuList } from "../utils/dom";
import { uiText } from "../utils/ui-text";
import { getLLMSettings } from "./llm-client";
import { activeModelProfile, applyModelProfile, loadModelProfiles, MODEL_BUDGET_FIELDS } from "./model-profile";

/** Keep every window's selector in sync with the shared request preferences. */
export function installModelSelector(select: XULMenuList, onChange: () => void): () => void {
  const doc = select.ownerDocument!;
  const win = doc.defaultView!;
  const popup = select.querySelector("menupopup")!;
  let timer: number | undefined;
  let disposed = false;
  const refresh = () => {
    if (disposed) return;
    if (timer !== undefined) win.clearTimeout(timer);
    timer = undefined;
    // Rebuilding children during a native command interrupts popup dismissal.
    // A settings edit while the menu is open is rendered after popuphidden.
    const popupState = (popup as Element & { state?: string }).state;
    if (popupState && popupState !== "closed") return;
    const profiles = loadModelProfiles();
    const settings = getLLMSettings();
    const active = activeModelProfile(settings, profiles);
    popup.replaceChildren();
    const option = (value: string, label: string) => {
      const item = doc.createElementNS(XUL_NS, "menuitem");
      item.setAttribute("value", value);
      item.setAttribute("label", label);
      popup.append(item);
    };
    if (!active) option("", uiText(`Current settings · ${settings.model}`, `当前配置 · ${settings.model}`));
    for (const profile of profiles) option(profile.name, profile.name);
    // No active saved profile must never look like the first saved profile was applied.
    select.value = active?.name || "";
    select.style.display = profiles.length ? "" : "none";
    let endpoint = "";
    try { endpoint = new URL(settings.apiBase).host; } catch { /* Invalid URLs are reported on send. */ }
    select.setAttribute("title", [active?.name || uiText("Current settings", "当前配置"), settings.model, endpoint].filter(Boolean).join("\n"));
    onChange();
  };
  const scheduleRefresh = () => {
    // Applying a profile writes several preferences; render the completed batch once.
    if (!disposed && timer === undefined) timer = win.setTimeout(refresh, 0);
  };
  const onCommand = (event: Event) => {
    const target = event.target as Element | null;
    if (target?.localName !== "menuitem" || target.parentElement !== popup) return;
    const selected = loadModelProfiles().find(profile => profile.name === target.getAttribute("value"));
    if (selected) applyModelProfile(selected);
    scheduleRefresh();
  };
  select.addEventListener("command", onCommand);
  popup.addEventListener("popuphidden", scheduleRefresh);
  const preferences = ["modelProfiles", "activeProfile", "llmProvider", "llmApiBase", "llmApiKey", "llmModel", "llmThinkingMode", "llmThinkEffort", "tokenizerMode", ...MODEL_BUDGET_FIELDS];
  const observers = preferences.map(key => Zotero.Prefs.registerObserver(`${config.prefsPrefix}.${key}`, scheduleRefresh, true));
  refresh();
  return () => {
    disposed = true;
    if (timer !== undefined) win.clearTimeout(timer);
    select.removeEventListener("command", onCommand);
    popup.removeEventListener("popuphidden", scheduleRefresh);
    for (const observer of observers) Zotero.Prefs.unregisterObserver(observer);
  };
}
