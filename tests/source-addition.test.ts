import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ state: null as any }));
vi.mock("../src/modules/panel-state", async original => ({
  ...await original<typeof import("../src/modules/panel-state")>(), getPanelState: () => mocks.state,
}));
vi.mock("../src/modules/send-handler", () => ({ handleSend: vi.fn(), autoSaveSession: vi.fn(async () => {}) }));
vi.mock("../src/modules/zotero-items", async original => ({
  ...await original<typeof import("../src/modules/zotero-items")>(), addZoteroItemToSession: vi.fn(),
}));
import { ChatSession } from "../src/modules/chat-session";
import { addItemToSession } from "../src/modules/chat-panel";
import { addZoteroItemToSession } from "../src/modules/zotero-items";
import { autoSaveSession } from "../src/modules/send-handler";

let root: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="chatpdf-root"><div id="chatpdf-source-chips"></div></div>';
  root = document.querySelector("#chatpdf-root")!;
  mocks.state = { session: new ChatSession(), chatInput: null, backgroundStreams: new Map() };
});
it("persists an added ready PDF before any chat request or conversion callback", async () => {
  vi.mocked(addZoteroItemToSession).mockImplementation(async (_item, session) => {
    const source = session.addSource("PDF12345", "Paper", undefined, 1);
    return { sourceKey: source.id, message: "Added" };
  });
  await addItemToSession({} as any, root);
  expect(root.querySelector(".chatpdf-source-chip-ready")?.textContent).toContain("Paper");
  expect(autoSaveSession).toHaveBeenCalledWith(root);
});
it("does not refresh or save a different chat if the active session changed during addition", async () => {
  vi.mocked(addZoteroItemToSession).mockImplementation(async (_item, session) => {
    const source = session.addSource("PDF12345", "Paper", undefined, 1);
    mocks.state.session = new ChatSession();
    return { sourceKey: source.id, message: "Added" };
  });
  await addItemToSession({} as any, root);
  expect(root.querySelector(".chatpdf-source-chip")).toBeNull();
  expect(autoSaveSession).not.toHaveBeenCalled();
});
