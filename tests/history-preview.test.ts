import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../src/modules/history-query", () => ({ readHistory: mocks.read }));
import { parseHistoryCitation, installHistoryCitationLinks, previewHistory } from "../src/modules/history-preview";
import { renderMarkdownInto } from "../src/modules/markdown-renderer";
import { ChatSession } from "../src/modules/chat-session";
import { getPanelState, destroyPanelState } from "../src/modules/panel-state";
const revision = "a".repeat(64), href = `zotero://chatpdf/history/saved-one?revision=${revision}&message=1`;
beforeEach(() => {
  destroyPanelState(window);
  document.body.innerHTML = '<div id="chatpdf-root"><textarea>keep my draft</textarea><div id="answer"></div></div>';
  mocks.read.mockReset();
  mocks.read.mockResolvedValue({ session_id: "saved-one", title: "Historical discussion", revision,
    records: [{ message_index: 1, role: "assistant", content: "Original **answer**", status: "cancelled", char_start: 0, char_end: 19, total_chars: 19, sources: [] }], next_cursor: null });
});
it("opens sanitized versioned citations without changing the active chat or draft", async () => {
  const root = document.querySelector<HTMLElement>("#chatpdf-root")!;
  const session = getPanelState(root).session;
  installHistoryCitationLinks(root);
  renderMarkdownInto(document.querySelector("#answer")!, `[Past answer](${href})`);
  (root.querySelector("a") as HTMLAnchorElement).click();
  await vi.waitFor(() => expect(root.querySelector(".chatpdf-history-preview-content")?.textContent).toBe("Original answer\n"));
  expect(mocks.read).toHaveBeenCalledWith({ session_id: "saved-one", revision, message_index: 1 }, new Set(), expect.anything());
  expect(getPanelState(root).session).toBe(session);
  expect(root.querySelector("textarea")!.value).toBe("keep my draft");
  (root.querySelector(".chatpdf-history-preview-close") as HTMLButtonElement).click();
  expect(root.querySelector('[role="dialog"]')).toBeNull();
});
it("ignores a pending preview after close and reports stale citations", async () => {
  const root = document.querySelector<HTMLElement>("#chatpdf-root")!;
  mocks.read.mockRejectedValueOnce(new Error("History changed"));
  await previewHistory(root, parseHistoryCitation(href));
  expect(root.textContent).toContain("History changed");
  let finish!: (value: any) => void;
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = previewHistory(root, parseHistoryCitation(href));
  (root.querySelector(".chatpdf-history-preview-close") as HTMLButtonElement).click();
  finish({ records: [] }); await pending;
  expect(root.querySelector('[role="dialog"]')).toBeNull();
});
it("rejects invalid IDs, duplicate parameters and invented positions", () => {
  for (const link of [href + "&message=2", href.replace("saved-one", "../prefs"), href.replace("message=1", "message=-1"), href.replace(revision, "old")]) expect(() => parseHistoryCitation(link)).toThrow();
});
it("preserves stable message identities through save and restore", () => {
  const session = new ChatSession(); session.addUserMessage("Question"); session.addAssistantMessage("Answer");
  const original = session.getHistory().map(m => m.id);
  expect(new Set(original).size).toBe(2);
  expect(ChatSession.fromSavedSession(session.toSavedSession()).getHistory().map(m => m.id)).toEqual(original);
});
