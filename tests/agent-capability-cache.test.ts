import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSession } from "../src/modules/chat-session";
import { getToolDefinitions, getToolMetadata, toolResultSourceIds } from "../src/modules/tools";
import { getItemByKey } from "../src/modules/zotero-items";

afterEach(() => vi.mocked(Zotero.Prefs.get).mockReset());
describe("capability context and prefix reuse", () => {
  it("keeps tool definitions identical through permission/source/status changes", () => {
    const before = JSON.stringify(getToolDefinitions());
    vi.mocked(Zotero.Prefs.get).mockImplementation(key => String(key).endsWith("agentLibraryEditMode") ? "readonly" as never : undefined);
    expect(JSON.stringify(getToolDefinitions())).toBe(before);
    expect(getToolMetadata("change_zotero_library").readOnly).toBe(false);
    expect(getToolMetadata("search_pdf_text")).toMatchObject({ readOnly: true, network: false, costly: false });
  });
  it("appends scope and authorization only at the end without rewriting previous provider blocks", () => {
    const session = new ChatSession(), tools = getToolDefinitions();
    const first = session.buildAgentMessages("Find papers", undefined, tools, { mode: "ask", items: [], collections: [] });
    session.addUserMessage("Find papers");
    const context = session.getAgentContext()!;
    context.append({ role: "assistant", content: "Found candidates", tool_calls: [{ id: "search", type: "function", function: { name: "search_pdf_text", arguments: '{ "query": "energy" }' } }] });
    context.append({ role: "tool", tool_call_id: "search", content: "Exact unchanged evidence" });
    session.addAssistantMessage("Found candidates");
    const prefix = JSON.stringify(context.messages);
    const src = session.addSource("ABC12345", "Paper", undefined, 1);
    const next = session.buildAgentMessages("Read it", new Set([src.id]), tools, { mode: "selected", libraryID: 1, items: ["ITEM1234"], collections: [] });
    expect(JSON.stringify(next.slice(0, -1))).toBe(prefix);
    expect(next[0]).toEqual(first[0]);
    expect(String(next.at(-1)!.content)).toContain('"mode":"selected"');
    expect(String(next[0].content)).not.toContain("ABC12345");
    expect(String(next[0].content)).toContain("no mandatory search/conversion workflow");
  });
  it("keeps library evidence readable after unrelated session sources are removed", () => {
    const session = new ChatSession(), src = session.addSource("ABC12345", "Paper", undefined, 1);
    const context = { session, turnScope: new Set([src.id]), requestId: "r", windowId: "w" };
    expect(toolResultSourceIds("search_pdf_text", { query: "energy" }, context)).toEqual([]);
    expect(toolResultSourceIds("read_pdf_text", { key: src.id }, context)).toEqual([src.id]);
  });
  it("appends unambiguous whole-library access after old narrow assistant claims without rewriting them", () => {
    const session = new ChatSession(), tools = getToolDefinitions();
    session.buildAgentMessages("Plan", undefined, tools, { mode: "collection", libraryID: 1, items: [], collections: ["OLD00001"] });
    session.addUserMessage("Plan");
    const context = session.getAgentContext()!;
    context.append({ role: "assistant", content: "Only OLD00001 is authorized" }); session.addAssistantMessage("Only OLD00001 is authorized");
    const previous = JSON.stringify(context.messages);
    const next = session.buildAgentMessages("Proceed", undefined, tools, { mode: "library", libraryID: 1, items: ["ITEM0001"], collections: ["OLD00001"] });
    expect(JSON.stringify(next.slice(0, -1))).toBe(previous);
    expect(next.at(-1)!.content).toContain("supersedes older turn access and assistant claims");
    expect(next.at(-1)!.content).toContain("all items and collections in this library");
    expect(next.at(-1)!.content).not.toContain("OLD00001"); expect(next.at(-1)!.content).not.toContain("ITEM0001");
  });
  it("never falls through to another library or selects an ambiguous bare key", () => {
    vi.mocked(Zotero.Libraries.getAll).mockReturnValue([{ libraryID: 1 }, { libraryID: 2 }] as any);
    vi.mocked(Zotero.Items.getByLibraryAndKey).mockImplementation(id => id === 1 ? { key: "ABC12345", libraryID: 1 } as any : null);
    expect(getItemByKey("ABC12345", 2)).toBeNull();
    expect(getItemByKey("ABC12345")?.libraryID).toBe(1);
    vi.mocked(Zotero.Items.getByLibraryAndKey).mockImplementation(id => ({ key: "ABC12345", libraryID: id }) as any);
    expect(getItemByKey("ABC12345")).toBeNull();
  });
});
