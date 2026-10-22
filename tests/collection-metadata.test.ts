import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSession } from "../src/modules/chat-session";
import { executeTool } from "../src/modules/tools";

const abstract = "Complete abstract line.\n".repeat(4000) + "EXACT ABSTRACT END";
let items: any[], children: ReturnType<typeof vi.fn>;
const context = () => ({ session: new ChatSession(), turnScope: new Set<string>(), requestId: "r", windowId: "w" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(Zotero.Prefs.get).mockReturnValue(undefined);
  items = Array.from({ length: 44 }, (_, i) => ({
    id: i + 1, key: `ITEM${String(i + 1).padStart(4, "0")}`, libraryID: 1, parentItem: null,
    isRegularItem: () => true, isPDFAttachment: () => false,
    getField: (field: string) => ({ title: `Paper ${i + 1}`, date: "2026", itemType: "journalArticle", abstractNote: i === 0 ? abstract : "" })[field] || "",
    getAttachments: () => [], getCreators: () => [{ firstName: "A", lastName: "Researcher" }],
    getCollections: () => [10], getTags: () => [{ tag: "IGA" }],
  }));
  children = vi.fn(() => items);
  const collection = { id: 10, key: "COL00001", libraryID: 1, name: "Inbox", getChildItems: children };
  vi.mocked(Zotero.Libraries.getAll).mockReturnValue([{ libraryID: 1 }] as any);
  vi.mocked(Zotero.Items.getByLibraryAndKey).mockImplementation((libraryID, key) => libraryID === 1 ? items.find(item => item.key === key) : null);
  Object.assign(Zotero, { Collections: {
    get: () => collection,
    getByLibraryAndKey: (libraryID: number, key: string) => libraryID === 1 && key === collection.key ? collection : null,
  } });
});

describe("explicit collection metadata detail", () => {
  it("returns every item in brief mode and makes omitted abstracts discoverable", async () => {
    const output = await executeTool("list_collection_items", { collection_key: "COL00001", library_id: 1 }, context());
    expect(output).toContain("44 total");
    for (const item of items) expect(output).toContain(`key: ${item.key}`);
    expect(output).toContain("Metadata detail: brief (abstract bodies omitted)");
    expect(output).toContain("detail=full");
    expect(output).toContain("abstract_available: yes");
    expect(output).toContain("abstract_available: no");
    expect(output).not.toContain("Complete abstract line");
    expect(output).toContain("tags: IGA");
    expect(output).toContain("creators: A Researcher");
  });

  it("returns complete multiline abstracts on request and preserves individual item retrieval", async () => {
    const full = await executeTool("list_collection_items", { collection_key: "COL00001", library_id: 1, detail: "full" }, context());
    expect(full).toContain("44 total");
    expect(full).toContain(`abstract: ${abstract}`);
    expect(full).toContain("Metadata detail: full");
    const selected = await executeTool("get_zotero_item", { key: items[0].key, library_id: 1, detail: "summary" }, context());
    expect(selected).toContain(`abstract: ${abstract}`);
  });

  it("limits items only when requested and rejects an unknown detail before reading the collection", async () => {
    const invalid = await executeTool("list_collection_items", { collection_key: "COL00001", detail: "summary" }, context());
    expect(invalid).toContain("unsupported value");
    expect(children).not.toHaveBeenCalled();
    const limited = await executeTool("list_collection_items", { collection_key: "COL00001", detail: "full", max_results: 1 }, context());
    expect(limited).toContain("1 of 44 returned");
    expect(limited).toContain(abstract);
    expect(limited).not.toContain("key: ITEM0002");
  });
});
