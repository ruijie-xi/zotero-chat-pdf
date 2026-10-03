import { describe, expect, it } from "vitest";
import { filterHistory } from "../src/modules/history-search";
import type { SessionMeta } from "../src/modules/chat-history";
const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({ id, title: "Notes", sourceTitles: [], createdAt: 1, updatedAt: 1, messageCount: 2, ...extra });
const filters = { query: "", includeEmpty: false, pinnedOnly: false };
describe("history metadata search", () => {
  it("matches paper titles and chat titles together, with case and width normalization", () => {
    const bank = [meta("match", { title: "Hamiltonian questions", sourceTitles: ["Time integration"] }), meta("other", { title: "Hamiltonian questions" })];
    expect(filterHistory(bank, { ...filters, query: "ＨＡＭＩＬＴＯＮＩＡＮ integration" }).map(m => m.id)).toEqual(["match"]);
  });
  it("hides known empty chats without hiding unknown older counts or deleting anything", () => {
    const bank = [meta("empty", { messageCount: 0 }), meta("legacy", { messageCount: undefined }), meta("chat")];
    expect(filterHistory(bank, filters).map(m => m.id)).toEqual(["chat", "legacy"]);
    expect(filterHistory(bank, { ...filters, includeEmpty: true })).toHaveLength(3);
    expect(bank).toHaveLength(3);
  });
  it("places pins first and combines paper scope with pinned-only filtering", () => {
    const bank = [meta("new", { updatedAt: 100 }), meta("pin", { pinned: true, referencedParentKeys: ["PDF"] }), meta("elsewhere", { pinned: true })];
    expect(filterHistory(bank, filters)[0].pinned).toBe(true);
    expect(filterHistory(bank, { ...filters, parentKey: "PDF", pinnedOnly: true }).map(m => m.id)).toEqual(["pin"]);
  });
});
