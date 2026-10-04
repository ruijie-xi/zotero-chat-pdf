import { beforeEach, expect, it, vi } from "vitest";
import { inspectZoteroItem } from "../src/modules/zotero-item-details";
import { executeTool, getToolDefinitions } from "../src/modules/tools";
import { ChatSession } from "../src/modules/chat-session";
const inventory = new Map<number, any>();
function item(id: number, key: string, type: string, data: any) {
  const record: any = { id, key, libraryID: 1, parentItem: null, deleted: false,
    loadAllData: vi.fn(async () => {}), toJSON: vi.fn(() => data),
    isRegularItem: () => type === "journalArticle", isPDFAttachment: () => type === "attachment", isFileAttachment: () => type === "attachment",
    getField: (field: string) => data[field] || "", getNoteTitle: () => "Child note", getNotes: () => [2], getAttachments: () => [3],
    getCollections: () => [10], getTags: () => data.tags || [], getCreators: () => data.creators || [], fileExists: vi.fn(async () => false) };
  inventory.set(id, record); return record;
}
let paper: any, note: any, pdf: any, raw: any;
beforeEach(() => {
  inventory.clear();
  raw = { key: "PAPER001", itemType: "journalArticle", title: "Paper", DOI: "10.1234/example", url: "https://example.org/paper", publicationTitle: "Journal",
    volume: "7", issue: "2", pages: "31–50", abstractNote: "Complete abstract", extra: "Complete Extra\nSecond line", dateAdded: "2026-01-01", dateModified: "2026-10-04",
    creators: [{ creatorType: "editor", firstName: "A", lastName: "Editor" }], tags: [{ tag: "automatic", type: 1 }], collections: ["COL00001"], relations: { "dc:relation": ["https://www.zotero.org/users/local/example/items/RELATED1"] } };
  paper = item(1, "PAPER001", "journalArticle", raw);
  note = item(2, "NOTE0001", "note", { key: "NOTE0001", itemType: "note", note: "<p>Complete note body</p>", parentItem: paper.key }); note.parentItem = paper;
  pdf = item(3, "PDF00001", "attachment", { key: "PDF00001", itemType: "attachment", parentItem: paper.key, path: "C:/private/file.pdf", contentType: "application/pdf", filename: "file.pdf" }); pdf.parentItem = paper;
  Object.assign(Zotero.Items, { get: (id: number) => inventory.get(id) });
  vi.mocked(Zotero.Items.getByLibraryAndKey).mockImplementation((lib, key) => lib === 1 ? [...inventory.values()].find(value => value.key === key) : null);
  Object.assign(Zotero, { Collections: { get: () => ({ libraryID: 1, key: "COL00001", name: "Child", parentKey: "ROOT0001" }),
    getByLibraryAndKey: (_lib: number, key: string) => key === "COL00001" ? { key, name: "Child", parentKey: "ROOT0001" } : { key, name: "Root", parentKey: false } } });
});
it("returns full fields, creator roles, tag types, relations, exact collection ancestry and child references on demand", async () => {
  const details = await inspectZoteroItem(paper);
  expect(details.item).toMatchObject(raw); expect(details.parent_item).toBeNull();
  expect(details.collection_memberships[0]).toMatchObject({ key: "COL00001", path: [{ key: "ROOT0001", name: "Root" }, { key: "COL00001", name: "Child" }], path_complete: true });
  expect(details.child_notes[0]).toMatchObject({ key: "NOTE0001", title: "Child note", note_content_available: true });
  expect(details.child_notes[0]).not.toHaveProperty("note");
  expect(details.attachments[0]).toMatchObject({ key: "PDF00001", is_pdf: true, local_file_available: false });
  expect(JSON.stringify(details)).not.toContain("C:/private");
  expect(pdf.toJSON()).toHaveProperty("path"); expect(note.toJSON()).toHaveProperty("note");
});
it("keeps the requested child identity and returns its bibliographic parent", async () => {
  const details = await inspectZoteroItem(pdf);
  expect(details.item.key).toBe(pdf.key); expect(details.parent_item?.key).toBe(paper.key); expect(details.item).not.toHaveProperty("path");
});
it("defaults get_zotero_item to full details while supporting a compact summary without expanding session scope", async () => {
  const session = new ChatSession(), context = { session, turnScope: new Set<string>(), requestId: "r", windowId: "w" };
  const full = JSON.parse((await executeTool("get_zotero_item", { key: paper.key, library_id: 1 }, context)).split("\n\n[Tool result metadata:")[0]);
  expect(full.item.DOI).toBe(raw.DOI); expect(session.getSources()).toHaveLength(0);
  expect(await executeTool("get_zotero_item", { key: paper.key, library_id: 1, detail: "summary" }, context)).toContain("has_pdf: yes");
  expect(await executeTool("get_zotero_item", { key: paper.key, library_id: 2 }, context)).toContain("not found");
  expect(getToolDefinitions().find(tool => tool.function.name === "get_zotero_item")!.function.description).toContain("Extra");
});
it("aborts before metadata reads and reports broken ancestry without fabricating a path", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(inspectZoteroItem(paper, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(paper.loadAllData).not.toHaveBeenCalled();
  (Zotero.Collections as any).getByLibraryAndKey = () => null;
  expect((await inspectZoteroItem(paper)).collection_memberships[0].path_complete).toBe(false);
});
