import { beforeEach, expect, it, vi } from "vitest";
import { createLibraryAccessControl } from "../src/modules/library-access-control";
let mode: any;
beforeEach(() => {
  mode = "ask"; document.body.innerHTML = '<div id="root"></div>';
  vi.mocked(Zotero.Prefs.get).mockImplementation(() => mode);
  vi.mocked(Zotero.Prefs.set).mockImplementation((_key, value) => { mode = value; });
  (window as any).ZoteroPane = { getSelectedCollection: () => ({ name: "Selected collection" }), getSelectedLibraryID: () => 1, getSelectedItems: () => [{}, {}] };
  Object.assign(Zotero.Libraries, { get: () => ({ name: "My library" }) });
});
it("shows a native permission menu in chat and persists commands without rebuilding controls", () => {
  const root = document.querySelector<HTMLElement>("#root")!, control = createLibraryAccessControl(root); root.append(control);
  const menu = control.querySelector("menulist") as any;
  expect(menu.namespaceURI).toContain("there.is.only.xul"); expect(menu.getAttribute("native")).toBe("true");
  expect(control.querySelectorAll("menuitem")).toHaveLength(5);
  menu.value = "selected"; menu.dispatchEvent(new Event("command"));
  expect(mode).toBe("selected"); expect(control.textContent).toContain("2 selected");
  expect(control.querySelector("menulist")).toBe(menu);
  mode = "collection"; control.dispatchEvent(new MouseEvent("mouseenter"));
  expect(control.textContent).toContain("Selected collection");
});
it("falls back to review for malformed stored values and reflects a revoked permission", () => {
  mode = "unknown"; const control = createLibraryAccessControl(document.querySelector("#root")!);
  const menu = control.querySelector("menulist") as any; expect(menu.value).toBe("ask");
  mode = "readonly"; menu.dispatchEvent(new Event("focus")); expect(menu.value).toBe("readonly");
});
