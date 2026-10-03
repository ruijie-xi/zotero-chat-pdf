import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_BUDGET_FIELDS } from "../src/modules/model-profile";
import { XUL_NS, XULMenuList } from "../src/utils/dom";

let prefs: Record<string, any>;
function field(key: string): HTMLInputElement | XULMenuList | HTMLTextAreaElement {
  return document.querySelector(`#zotero-prefpane-chatpdf-${key}`)!;
}
function change(key: string, value: string): void {
  field(key).value = value;
  field(key).dispatchEvent(new Event(field(key).localName === "menulist" ? "command" : "change"));
}
function loadProfile(name: string): void {
  const row = [...document.querySelectorAll("#zotero-prefpane-chatpdf-profileList > div")].find(row => row.firstElementChild?.textContent === name)!;
  (row.querySelector("button") as HTMLButtonElement).click();
}

beforeEach(async () => {
  vi.resetModules();
  prefs = { llmApiBase: "https://custom.example/v1", llmApiKey: "custom-key-for-tests", llmModel: "existing-model", llmThinkingMode: "enabled", llmThinkEffort: "high", tokenizerMode: "deepseek-v4-estimate", contextWindowTokens: 50000, maxOutputTokens: 10000, requestedOutputTokens: 5000, activeProfile: "Legacy", modelProfiles: JSON.stringify([{ name: "Legacy", apiBase: "https://legacy.example/v1", apiKey: "legacy-key", model: "legacy-model", contextWindowTokens: 40000, maxOutputTokens: 8000, tokenizerMode: "deepseek-v4-estimate" }]) };
  vi.mocked(Zotero.Prefs.get).mockImplementation(key => prefs[String(key).split(".").at(-1)!]);
  vi.mocked(Zotero.Prefs.set).mockImplementation((key, value) => { prefs[String(key).split(".").at(-1)!] = value; });
  // Exercise the actual pane markup and HTML namespaces with Zotero's preference binding simulated.
  const source = readFileSync("addon/content/preferences.xhtml", "utf8").replaceAll("__addonRef__", "chatpdf");
  const xml = new DOMParser().parseFromString(`<section xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul" xmlns:html="http://www.w3.org/1999/xhtml">${source}</section>`, "text/xml");
  expect(xml.querySelector("parsererror")).toBeNull();
  document.body.replaceChildren(document.importNode(xml.documentElement, true));
  // jsdom has no Gecko XUL custom elements. Supply only the value property;
  // popup opening and actual option activation are checked in isolated Zotero.
  for (const el of document.querySelectorAll("menulist")) Object.defineProperty(el, "value", { value: "", writable: true });
  for (const el of document.querySelectorAll<HTMLInputElement | XULMenuList>("[preference]")) {
    const key = el.getAttribute("preference")!;
    if (prefs[key] !== undefined) el.value = String(prefs[key]);
    else if (el.getAttribute("type") === "number") el.value = "0";
    el.addEventListener(el.localName === "menulist" ? "command" : "change", () => { prefs[key] = el.getAttribute("type") === "number" ? Number(el.value) : el.value; });
  }
  await import("../src/modules/preference-script");
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.mocked(Zotero.Prefs.get).mockReset();
  vi.mocked(Zotero.Prefs.set).mockReset();
});

describe("provider selection in preferences", () => {
  it("uses native Zotero menus for every dropdown and persists command selections", () => {
    expect(document.querySelectorAll("select, datalist")).toHaveLength(0);
    expect(document.querySelectorAll("menulist")).toHaveLength(6);
    for (const [key, value] of [["llmProvider", "deepseek"], ["llmThinkingMode", "disabled"], ["llmThinkEffort", "max"], ["debugLogMode", "off"], ["tokenizerMode", "deepseek-v4-estimate"]]) {
      const menu = field(key);
      expect(menu.namespaceURI).toBe(XUL_NS);
      expect(menu.getAttribute("native")).toBe("true");
      expect(menu.querySelector(`menupopup > menuitem[value="${value}"]`)).not.toBeNull();
      change(key, value);
      expect(prefs[key]).toBe(value);
    }
  });

  it("chooses a suggested model through a menu command while retaining free text input", () => {
    change("llmProvider", "opencode-go");
    change("providerModels", "deepseek-v4-pro");
    expect(field("llmModel").localName).toBe("input");
    expect(field("llmModel").value).toBe("deepseek-v4-pro");
    expect(prefs.llmModel).toBe("deepseek-v4-pro");
    expect(prefs.tokenizerMode).toBe("deepseek-v4-estimate");
    change("llmProvider", "custom");
    expect((field("providerModels") as XULMenuList).hidden).toBe(true);
  });
  it("preserves existing custom configuration and restores its unsaved draft when switching back", () => {
    expect(field("llmProvider").value).toBe("custom");
    expect(field("llmApiBase").value).toBe(prefs.llmApiBase);
    expect((field("llmApiBase") as HTMLInputElement).readOnly).toBe(false);
    change("llmProvider", "opencode-go");
    expect(prefs.llmApiBase).toBe("https://opencode.ai/zen/go/v1");
    expect(prefs.llmApiKey).toBe("");
    expect(prefs.llmModel).toBe("deepseek-v4.1-flash");
    expect(prefs.tokenizerMode).toBe("deepseek-v4-estimate");
    for (const key of MODEL_BUDGET_FIELDS) expect(prefs[key]).toBe(0);
    expect((field("llmApiBase") as HTMLInputElement).readOnly).toBe(true);
    expect((document.querySelector("#zotero-prefpane-chatpdf-providerHint") as HTMLElement).hidden).toBe(false);
    expect(document.querySelectorAll("#zotero-prefpane-chatpdf-providerModels menuitem")).toHaveLength(4);
    change("llmProvider", "custom");
    expect(prefs).toMatchObject({ llmApiBase: "https://custom.example/v1", llmApiKey: "custom-key-for-tests", llmModel: "existing-model", contextWindowTokens: 50000, maxOutputTokens: 10000, requestedOutputTokens: 5000, activeProfile: "Legacy" });
  });

  it("saves and loads provider-specific profiles and loads legacy profiles as custom", () => {
    change("llmProvider", "opencode-go");
    change("llmApiKey", "go-key-for-tests");
    change("llmModel", "deepseek-v4-pro");
    expect(prefs.tokenizerMode).toBe("deepseek-v4-estimate");
    field("profileName").value = "Go";
    (field("profileSaveBtn") as unknown as HTMLButtonElement).click();
    const saved = JSON.parse(prefs.modelProfiles).find((p: any) => p.name === "Go");
    expect(saved).toMatchObject({ provider: "opencode-go", apiBase: "https://opencode.ai/zen/go/v1", apiKey: "go-key-for-tests", model: "deepseek-v4-pro", tokenizerMode: "deepseek-v4-estimate" });
    expect(saved).not.toHaveProperty("sessionId");
    change("llmProvider", "deepseek");
    expect(prefs).toMatchObject({ llmApiBase: "https://api.deepseek.com/v1", llmApiKey: "", llmModel: "deepseek-flash", tokenizerMode: "auto" });
    loadProfile("Go");
    expect(field("llmProvider").value).toBe("opencode-go");
    expect(prefs.llmApiKey).toBe("go-key-for-tests");
    loadProfile("Legacy");
    expect(field("llmProvider").value).toBe("custom");
    expect(prefs).toMatchObject({ llmProvider: "custom", llmApiBase: "https://legacy.example/v1", llmApiKey: "legacy-key", contextWindowTokens: 40000, maxOutputTokens: 8000 });
    expect((field("llmApiBase") as HTMLInputElement).readOnly).toBe(false);
  });

  it("uses the selected Go provider and a stable session ID for repeated API tests", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "OK" } }] }) }));
    vi.stubGlobal("fetch", fetch);
    change("llmProvider", "opencode-go");
    change("llmApiKey", "go-key-for-tests");
    for (let i = 0; i < 2; i++) {
      (field("llmTestBtn") as unknown as HTMLButtonElement).click();
      await vi.waitFor(() => expect((field("llmTestBtn") as unknown as HTMLButtonElement).disabled).toBe(false));
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(calls[0][1].headers).toMatchObject({ Authorization: "Bearer go-key-for-tests", "x-opencode-session": expect.any(String), "User-Agent": expect.stringMatching(/^ChatPDF\//) });
    expect(calls[1][1].headers).toEqual(calls[0][1].headers);
    expect(document.querySelector("#zotero-prefpane-chatpdf-llmTestDebug")!.textContent).not.toContain("go-key-for-tests");
  });
});
