import { beforeEach, expect, it, vi } from "vitest";
import { noteText, readZoteroNotes, searchZoteroNotes } from "../src/modules/zotero-notes";
const items = new Map<string, any>();
const parent = { key: "PAPER001", getField: () => "Parent paper", getCollections: () => [10], getTags: () => [{ tag: "review" }] };
function note(key: string, html: string, child = true) {
  const item = { libraryID: 1, key, id: items.size + 1, html, dateModified: "one", deleted: false,
    parentItem: child ? parent : null, parentKey: child ? parent.key : false,
    isNote: () => true, isRegularItem: () => false, isInTrash: () => false,
    loadDataType: vi.fn(async () => {}), getNote() { return this.html; }, getNoteTitle: () => key,
    getCollections: () => child ? [] : [11], getTags: () => [] };
  items.set(key, item); return item;
}
beforeEach(() => {
  items.clear();
  vi.mocked(Zotero.Libraries.getAll).mockReturnValue([{ libraryID: 1 }] as any);
  vi.mocked(Zotero.Items.getByLibraryAndKey).mockImplementation((lib, key) => lib === 1 ? items.get(key) : null);
  Object.assign(Zotero.Items, { getAll: vi.fn(async () => [...items.values()]), get: (id: number) => [...items.values()].find(item => item.id === id) });
  Object.assign(Zotero, { Collections: { getByLibraryAndKey: () => ({ id: 10, getDescendents: () => [{ id: 11 }] }) } });
});
it("preserves citation targets, paragraphs and text while removing active HTML", () => {
  expect(noteText('<p>First <a href="zotero://open-pdf/library/items/PDF00001?page=2">Evidence</a></p><p>Second<br>Third<script>alert(1)</script></p>'))
    .toBe("First [Evidence](zotero://open-pdf/library/items/PDF00001?page=2)\nSecond\nThird");
});
it("reads complete text by default, exact HTML on demand and selected lines with the same full revision", async () => {
  const item = note("NOTE0001", "<p>First</p><p>Second</p><p>Third</p>");
  const complete = (await readZoteroNotes({ library_id: 1, item_key: item.key })).notes[0];
  expect(complete).toMatchObject({ text: "First\nSecond\nThird", total_lines: 3 });
  expect(complete).not.toHaveProperty("html");
  const partial = (await readZoteroNotes({ library_id: 1, item_key: item.key, start_line: 2, end_line: 2 })).notes[0];
  expect(partial).toMatchObject({ text: "Second", revision: complete.revision });
  const html = (await readZoteroNotes({ library_id: 1, item_key: item.key, format: "html" })).notes[0];
  expect(html.html).toBe(item.html); expect(html).not.toHaveProperty("text");
  await expect(readZoteroNotes({ library_id: 2, item_key: item.key })).rejects.toThrow("not found");
  await expect(readZoteroNotes({ library_id: 1, item_key: item.key, start_line: 0 })).rejects.toThrow("range");
});
it("finds child and standalone notes with explicit per-call coverage and continuation", async () => {
  note("NOTE0001", "<p>energy in a child</p>"); note("NOTE0002", "<p>ENERGY standalone</p>", false); note("NOTE0003", "<p>unrelated</p>");
  const first = await searchZoteroNotes({ query: "energy", notes_per_call: 1 });
  expect(first.total_notes).toBe(3); expect(first.coverage).toHaveLength(1); expect(first.hits[0]).toMatchObject({ note_key: "NOTE0001", parent_item_key: "PAPER001" });
  const next = await searchZoteroNotes({ query: "energy", notes_per_call: 2, cursor: first.next_cursor });
  expect(next.hits[0]).toMatchObject({ note_key: "NOTE0002", parent_item_key: null }); expect(next.next_cursor).toBeNull();
  expect(next.coverage).toHaveLength(2);
});
it("uses parent collection/tags for child notes and recursive collections for standalone notes", async () => {
  note("NOTE0001", "<p>energy</p>"); note("NOTE0002", "<p>energy</p>", false);
  const direct = await searchZoteroNotes({ query: "energy", library_id: 1, collection_key: "COL00001" });
  expect(direct.hits.map(hit => hit.note_key)).toEqual(["NOTE0001"]);
  const recursive = await searchZoteroNotes({ query: "energy", library_id: 1, collection_key: "COL00001", recursive: true });
  expect(recursive.hits).toHaveLength(2);
  expect((await searchZoteroNotes({ query: "energy", tag: "review" })).hits).toHaveLength(1);
  await expect(searchZoteroNotes({ query: "energy", item_key: parent.key })).rejects.toThrow("library_id");
});
it("refreshes cached note text and invalidates continuation on edits or changed search criteria", async () => {
  const item = note("NOTE0001", `<p>energy ${"x".repeat(100)} energy</p>`);
  const first = await searchZoteroNotes({ query: "energy", page_size: 1, snippet_chars: 12 });
  expect(first.next_cursor).not.toBeNull();
  await expect(searchZoteroNotes({ query: "other", page_size: 1, snippet_chars: 12, cursor: first.next_cursor })).rejects.toThrow("cursor");
  item.html = "<p>changed energy</p>";
  await expect(searchZoteroNotes({ query: "energy", page_size: 1, snippet_chars: 12, cursor: first.next_cursor })).rejects.toThrow("change");
  expect((await readZoteroNotes({ library_id: 1, item_key: item.key })).notes[0].text).toBe("changed energy");
});
it("excludes trashed notes and aborts without reporting ordinary empty results", async () => {
  note("NOTE0001", "<p>energy</p>").deleted = true;
  note("NOTE0002", "<p>energy</p>").isInTrash = () => true;
  expect((await searchZoteroNotes({ query: "energy" })).total_notes).toBe(0);
  const controller = new AbortController(); controller.abort();
  await expect(searchZoteroNotes({ query: "energy" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});
