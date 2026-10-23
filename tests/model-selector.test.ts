import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../package.json";
import { XUL_NS, type XULMenuList } from "../src/utils/dom";
import { installModelSelector } from "../src/modules/model-selector";
import { applyModelProfile, type ModelProfile } from "../src/modules/model-profile";

const google: ModelProfile = { name: "google", apiBase: "https://generativelanguage.googleapis.com/v1beta/openai/", apiKey: "google-test-key", model: "gemini-test" };
const deepseek: ModelProfile = { name: "deepseek", apiBase: "https://api.deepseek.com/v1", apiKey: "deepseek-test-key", model: "deepseek-test" };
let prefs: Record<string, unknown>;
let observers: Map<symbol, { key: string; callback: () => void }>;
let cleanups: Array<() => void>;
const set = (key: string, value: unknown) => {
  prefs[key] = value;
  for (const observer of observers.values()) if (observer.key === `${config.prefsPrefix}.${key}`) observer.callback();
};
const selector = () => {
  const select = document.createElementNS(XUL_NS, "menulist") as XULMenuList;
  // jsdom does not implement XUL widgets; native command/value ordering is checked separately in Zotero.
  Object.defineProperty(select, "value", { writable: true, value: "" });
  Object.defineProperty(select, "style", { value: document.createElement("div").style });
  select.append(document.createElementNS(XUL_NS, "menupopup"));
  document.body.append(select);
  const changed = vi.fn();
  const cleanup = installModelSelector(select, changed);
  cleanups.push(cleanup);
  return { select, changed, cleanup };
};
beforeEach(() => {
  vi.useFakeTimers();
  observers = new Map(); cleanups = [];
  prefs = { modelProfiles: JSON.stringify([google, deepseek]) };
  vi.mocked(Zotero.Prefs.get).mockImplementation(key => prefs[String(key).split(".").at(-1)!] as never);
  vi.mocked(Zotero.Prefs.set).mockImplementation((key, value) => set(String(key).split(".").at(-1)!, value));
  vi.stubGlobal("Zotero", { ...Zotero, Prefs: {
    ...Zotero.Prefs,
    registerObserver: (key: string, callback: () => void) => { const id = Symbol(); observers.set(id, { key, callback }); return id; },
    unregisterObserver: (id: symbol) => observers.delete(id),
  } });
  applyModelProfile(deepseek);
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  document.body.replaceChildren();
  vi.unstubAllGlobals(); vi.mocked(Zotero.Prefs.get).mockReset(); vi.mocked(Zotero.Prefs.set).mockReset(); vi.useRealTimers();
});

describe("chat model selector", () => {
  it("applies the clicked native menu item even before the menulist value updates", () => {
    const { select } = selector();
    expect(select.value).toBe("deepseek");
    select.querySelector('[value="google"]')!.dispatchEvent(new Event("command", { bubbles: true }));
    vi.runAllTimers();
    expect(prefs).toMatchObject({ activeProfile: "google", llmApiBase: google.apiBase, llmModel: google.model, llmApiKey: google.apiKey });
    expect(select.value).toBe("google");
    expect(select.getAttribute("title")).toContain("generativelanguage.googleapis.com");
    expect(select.getAttribute("title")).not.toContain(google.apiKey);
  });

  it.each(["", "deleted-profile", "google"])("shows current settings when saved profile %j is absent or does not match the route", active => {
    prefs.activeProfile = active;
    const { select } = selector();
    expect(select.value).toBe("");
    expect(select.querySelector('[value=""]')!.getAttribute("label")).toContain(deepseek.model);
    expect(prefs.llmModel).toBe(deepseek.model);
  });

  it("updates all open panels after a settings change and removes deleted profiles", () => {
    const first = selector(); const second = selector();
    applyModelProfile(google);
    vi.runAllTimers();
    for (const panel of [first, second]) {
      expect(panel.select.value).toBe("google");
      expect(panel.changed).toHaveBeenCalledTimes(2);
    }
    set("modelProfiles", JSON.stringify([deepseek]));
    vi.runAllTimers();
    for (const panel of [first, second]) {
      expect(panel.select.value).toBe("");
      expect(panel.select.querySelector('[value="google"]')).toBeNull();
    }
  });

  it("invalidates a stale name when endpoint, model or credential is edited", () => {
    const { select } = selector();
    set("llmApiKey", "changed-test-key");
    vi.runAllTimers();
    expect(select.value).toBe("");
    applyModelProfile(deepseek);
    set("llmApiBase", "https://another.example/v1");
    vi.runAllTimers();
    expect(select.value).toBe("");
    applyModelProfile(deepseek);
    set("llmModel", "another-model");
    vi.runAllTimers();
    expect(select.value).toBe("");
  });

  it("unsubscribes and cancels queued refreshes when a panel is closed", () => {
    const { select, changed, cleanup } = selector();
    applyModelProfile(google);
    cleanup();
    expect(observers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.runAllTimers();
    expect(changed).toHaveBeenCalledOnce();
    select.querySelector('[value="deepseek"]')!.dispatchEvent(new Event("command", { bubbles: true }));
    expect(prefs.activeProfile).toBe("google");
  });

  it("waits for the native popup to close before replacing its children", () => {
    const { select } = selector();
    const popup = select.querySelector("menupopup")!;
    Object.defineProperty(popup, "state", { writable: true, value: "open" });
    const item = popup.firstElementChild;
    applyModelProfile(google);
    vi.runAllTimers();
    expect(popup.firstElementChild).toBe(item);
    Object.assign(popup, { state: "closed" });
    popup.dispatchEvent(new Event("popuphidden"));
    vi.runAllTimers();
    expect(select.value).toBe("google");
  });
});
