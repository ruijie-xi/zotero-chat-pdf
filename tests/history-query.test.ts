import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
const storage = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), stamps: new Map<string, number>(), serial: 0 }));
vi.mock("../src/utils/cache-dir", () => ({ getCacheDir: () => "/history-test", ensureDir: vi.fn(async () => {}) }));
vi.mock("../src/utils/atomic-storage", () => ({
  withStorageLock: async (_key: string, fn: () => unknown) => fn(),
  atomicWriteJson: async (path: string, data: unknown) => { storage.files.set(path, new TextEncoder().encode(JSON.stringify(data))); storage.stamps.set(path, ++storage.serial); },
  atomicWrite: async (path: string, data: Uint8Array) => storage.files.set(path, data),
}));
import { saveSession, loadSession, deleteSession, updateSessionTitle, type SavedSession } from "../src/modules/chat-history";
import { queryHistory, readHistory, assertHistoryRefs } from "../src/modules/history-query";
import { projectHistory } from "../src/modules/history-record";
import { executeTool } from "../src/modules/tools";
import { ChatSession } from "../src/modules/chat-session";
import { callChannelTool, resetToolChannel } from "../src/modules/tool-channel";
import { setToolEnabled } from "../src/modules/tool-settings";

const fixture = (id: string, extra: Partial<SavedSession> = {}): SavedSession => ({ id, schemaVersion: 6, title: "Research", sourceKeys: [], sourceTitles: [], sources: [],
  createdAt: 100, updatedAt: 200, messages: [{ role: "user", content: "为什么选择边界条件？" }, { role: "assistant", content: "为了保持能量守恒。", status: "complete" }], ...extra });
beforeEach(() => {
  storage.files.clear(); storage.stamps.clear(); storage.serial++;
  storage.files.set("/history-test/history/_index.json", new TextEncoder().encode("[]"));
  Object.defineProperty(window, "crypto", { value: webcrypto, configurable: true });
  Object.assign(IOUtils, {
    exists: vi.fn(async (path: string) => storage.files.has(path)), read: vi.fn(async (path: string) => storage.files.get(path)!),
    stat: vi.fn(async (path: string) => ({ lastModified: storage.stamps.get(path) || storage.serial, size: storage.files.get(path)?.length || 0 })),
    remove: vi.fn(async (path: string) => storage.files.delete(path)),
    getChildren: vi.fn(async (path: string) => [...storage.files.keys()].filter(key => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/"))),
  });
  vi.mocked(Zotero.Libraries.getAll).mockReturnValue([{ libraryID: 1 }, { libraryID: 2 }] as any);
  vi.mocked(Zotero.Items.getByLibraryAndKey).mockImplementation((library, key) =>
    ["PDF", "PARENT", "NOTE"].includes(key) ? { key, libraryID: library, parentItem: key === "PARENT" ? undefined : { key: "PARENT" } } as any : false);
  const prefs: Record<string, any> = {};
  vi.mocked(Zotero.Prefs.get).mockImplementation(key => prefs[String(key)]);
  vi.mocked(Zotero.Prefs.set).mockImplementation((key, value) => { prefs[String(key)] = value; });
  resetToolChannel();
});

describe("cross-chat history retrieval", () => {
  it("finds visible Chinese and normalized English text, not reasoning or raw tool bodies", async () => {
    await saveSession(fixture("visible", { messages: [{ role: "assistant", content: "能量守恒", reasoning: "secret-thought", iterations: [{ content: "ＦＥＥＣ boundary", toolCalls: [{ toolName: "web_fetch", args: {}, result: "secret-tool", durationMs: 1 }] }] }] }));
    expect((await queryHistory({ query: 'feec "boundary"' })).results[0]).toMatchObject({ session_id: "visible", message_index: 0 });
    expect((await queryHistory({ query: "能量" })).results).toHaveLength(1);
    expect((await queryHistory({ query: "secret" })).results).toHaveLength(0);
    const result = await readHistory({ session_id: "visible" }, new Set());
    expect(JSON.stringify(result.records)).not.toContain("secret");
    expect(result.records[0].content).toBe("ＦＥＥＣ boundary\n\n能量守恒");
  });
  it("distinguishes source scope from successful reads and excludes broad search hits and failures", () => {
    const saved = fixture("relations", { sources: [{ id: "1:PDF", key: "PDF", libraryID: 1, parentKey: "PARENT", title: "Paper", cacheKey: "x", status: "ready" }],
      messages: [{ role: "user", content: "Question", sources: [{ key: "NOTE", libraryID: 1, title: "Past note" }] }, { role: "assistant", content: "", iterations: [{ toolCalls: [
        { toolName: "read_pdf_text", args: { key: "1:PDF" }, result: "Original evidence", durationMs: 1 },
        { toolName: "read_image", args: { key: "2:PDF" }, result: "Error executing read_image: missing", durationMs: 1 },
        { toolName: "search_zotero_library", args: { query: "Paper" }, result: "2:PDF", durationMs: 1 },
      ] }] }] });
    expect(projectHistory(saved).relations.map(r => [r.item_id, r.kind])).toEqual([["1:PDF", "current_source"], ["1:NOTE", "turn_source"], ["1:PDF", "read"]]);
  });
  it("matches parents, exact attachments and any/all item filters without crossing libraries", async () => {
    await saveSession(fixture("library-one", { sources: [{ id: "1:PDF", key: "PDF", libraryID: 1, parentKey: "PARENT", title: "One", cacheKey: "x", status: "ready" }] }));
    await saveSession(fixture("library-two", { sources: [{ id: "2:PDF", key: "PDF", libraryID: 2, parentKey: "PARENT", title: "Two", cacheKey: "x", status: "ready" }] }));
    expect((await queryHistory({ item_ids: ["1:PARENT"] })).results.map(r => r.session_id)).toEqual(["library-one"]);
    expect((await queryHistory({ item_ids: ["1:PARENT"], include_children: false })).results).toHaveLength(0);
    expect((await queryHistory({ item_ids: ["1:PDF", "2:PDF"], item_match: "all" })).results).toHaveLength(0);
    expect((await queryHistory({ item_ids: ["1:PDF", "2:PDF"] })).results).toHaveLength(2);
    await expect(queryHistory({ item_ids: ["PDF"] })).rejects.toThrow("Ambiguous");
  });
  it("honors explicit library IDs on tool calls even when another library has the same source key", () => {
    const saved = fixture("explicit-library", { sources: [{ id: "1:NOTE", key: "NOTE", libraryID: 1, title: "One", cacheKey: "x", status: "ready" }],
      messages: [{ role: "assistant", content: "", toolHistory: [{ toolName: "read_zotero_notes", args: { item_key: "NOTE", library_id: 2 }, result: "note", durationMs: 1 }] }] });
    expect(projectHistory(saved).relations.find(r => r.kind === "read")?.item_id).toBe("2:NOTE");
  });
  it("retains removed sources through turn snapshots and marks ambiguous legacy identities", async () => {
    await saveSession(fixture("removed", { messages: [{ role: "user", content: "Old source", sources: [{ key: "PDF", libraryID: 1, title: "Paper" }] }] }));
    await saveSession(fixture("ambiguous", { sourceKeys: ["PDF"], sources: undefined }));
    expect((await queryHistory({ item_ids: ["1:PARENT"], relation: "turn_source" })).results[0].session_id).toBe("removed");
    const result = await queryHistory({ session_ids: ["ambiguous"] });
    expect(result.results[0].relations[0].identity_uncertain).toBe(true);
    expect((await queryHistory({ session_ids: ["ambiguous"], item_ids: ["1:PDF"] })).results).toHaveLength(0);
  });
  it("pages all matches and rejects stale or changed-query cursors", async () => {
    for (const id of ["page-one", "page-two", "page-three"]) await saveSession(fixture(id));
    const first = await queryHistory({ query: "能量", page_size: 1 });
    const second = await queryHistory({ query: "能量", page_size: 1, cursor: first.next_cursor! });
    expect(second.results[0].session_id).not.toBe(first.results[0].session_id);
    await expect(queryHistory({ query: "边界", cursor: first.next_cursor! })).rejects.toThrow("changed");
    await updateSessionTitle("page-one", "Renamed without timestamp update", "user");
    await expect(queryHistory({ query: "能量", cursor: first.next_cursor! })).rejects.toThrow("changed");
  });
  it("reads long messages completely across Unicode-safe pages and preserves terminal states", async () => {
    const content = "abc😀中文".repeat(30);
    await saveSession(fixture("long", { messages: [{ id: "stable-message", role: "assistant", content, status: "cancelled" }] }));
    let page = await readHistory({ session_id: "long", max_chars: 9 }, new Set());
    let actual = String(page.records[0].content);
    expect(page.records[0]).toMatchObject({ message_id: "stable-message", status: "cancelled" });
    while (page.next_cursor) { page = await readHistory({ session_id: "long", max_chars: 9, cursor: page.next_cursor }, new Set()); actual += String(page.records[0].content); }
    expect(actual).toBe(content);
  });
  it("does not leak outside-source tool results and namespaces legacy result IDs by chat", async () => {
    const call = (result: string) => [{ toolName: "read_pdf_text", args: { key: "1:PDF" }, result, durationMs: 1 }];
    await saveSession(fixture("legacy-a", { messages: [{ role: "assistant", content: "Answer", toolHistory: call("original-A") }] }));
    await saveSession(fixture("legacy-b", { messages: [{ role: "assistant", content: "Answer", toolHistory: call("original-B") }] }));
    const options = { session_id: "legacy-a", view: "tool_result" as const, result_id: "legacy-0-0-0" };
    await expect(readHistory(options, new Set())).rejects.toThrow("outside");
    expect((await readHistory(options, new Set(["1:PDF"]))).records[0].content).toBe("original-A");
    expect((await readHistory({ ...options, session_id: "legacy-b" }, new Set(["1:PDF"]))).records[0].content).toBe("original-B");
  });
  it("uses canonical stored result bodies when display records were deduplicated", async () => {
    const value = fixture("canonical", { messages: [{ role: "assistant", content: "Answer", iterations: [{ toolCalls: [{ toolName: "read_pdf_text", args: { key: "1:PDF" }, result: "", resultId: "result-1", durationMs: 1 }] }] }] });
    value.agentContext = { version: 2, fingerprint: "", events: [], active: [], checkpoints: [], historyLength: 1,
      results: [{ id: "result-1", toolName: "read_pdf_text", content: "complete result", sourceIds: ["1:PDF"] }] };
    await saveSession(value);
    expect((await readHistory({ session_id: value.id, view: "tool_result", result_id: "result-1" }, new Set(["1:PDF"]))).records[0].content).toBe("complete result");
  });
  it("invalidates cached text after clear/delete and does not resurrect late saves", async () => {
    const original = fixture("to-delete"); await saveSession(original);
    const found = await queryHistory({});
    await deleteSession(original.id); await saveSession(original);
    expect((await queryHistory({ include_empty: true })).results).toHaveLength(0);
    await expect(assertHistoryRefs(found.history_refs)).rejects.toThrow("deleted");
    expect(storage.files.has("/history-test/history-search/to-delete.json")).toBe(false);
    await saveSession(fixture("clearable")); await queryHistory({});
    await saveSession(fixture("clearable", { messages: [] }));
    expect((await queryHistory({ query: "能量" })).results).toHaveLength(0);
  });
  it("reports unreadable and orphaned files, rebuilds corrupt derived caches and keeps source bytes intact", async () => {
    const orphan = fixture("orphan");
    const original = new TextEncoder().encode(JSON.stringify(orphan)); storage.files.set("/history-test/history/orphan.json", original);
    storage.stamps.set("/history-test/history/orphan.json", ++storage.serial);
    storage.files.set("/history-test/history/broken.json", new TextEncoder().encode("bad"));
    storage.files.set("/history-test/history-search/orphan.json", new TextEncoder().encode("bad"));
    const result = await queryHistory({});
    expect(result.results[0].session_id).toBe("orphan");
    expect(result.coverage).toMatchObject({ complete: false, unreadable: [{ session_id: "broken" }] });
    expect(storage.files.get("/history-test/history/orphan.json")).toBe(original);
  });
  it("avoids rereading unchanged originals during repeated searches", async () => {
    await saveSession(fixture("cached")); await queryHistory({});
    vi.mocked(IOUtils.read).mockClear(); await queryHistory({ query: "能量" });
    expect(vi.mocked(IOUtils.read).mock.calls.filter(([path]) => path === "/history-test/history/cached.json")).toHaveLength(0);
  });
  it("excludes current and empty chats by default and supports date and session filters", async () => {
    await saveSession(fixture("current")); await saveSession(fixture("empty", { messages: [] }));
    expect((await queryHistory({}, "current")).results).toHaveLength(0);
    expect((await queryHistory({ include_current: true, include_empty: true }, "current")).results).toHaveLength(2);
    expect((await queryHistory({ updated_after: "2026-01-01" })).results).toHaveLength(0);
    expect((await queryHistory({ session_ids: ["current"] })).results).toHaveLength(1);
  });
  it("rejects path traversal before I/O and preserves cancellation", async () => {
    await expect(loadSession("../prefs")).rejects.toThrow("Invalid");
    expect(IOUtils.read).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    await expect(queryHistory({}, undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("returns identical native/MCP results, honors switches and revokes stored history after deletion", async () => {
    await saveSession(fixture("shared"));
    const session = new ChatSession(), context = { session, turnScope: new Set<string>(), requestId: "r", windowId: "w" };
    const native = await executeTool("search_chat_history", { query: "能量" }, context);
    const call = (name: string, args: unknown) => callChannelTool({ client_id: "history-client-123456", request_id: "history-request-12345", name, arguments: args });
    const external = await call("search_chat_history", { query: "能量" });
    expect(external.content[0]).toMatchObject({ text: native + "\n[Stored result: result-1]" });
    await deleteSession("shared");
    expect((await call("read_tool_result", { result_id: "result-1" })).isError).toBe(true);
    setToolEnabled("search_chat_history", false);
    expect(await executeTool("search_chat_history", {}, context)).toContain("disabled");
    expect((await call("search_chat_history", {})).isError).toBe(true);
  });
});
