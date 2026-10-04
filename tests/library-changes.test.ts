import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyLibraryChanges, planLibraryChanges, listLibraryChanges, captureLibraryAccess, describeLibraryAccess, summarizeLibraryChange, LibraryAccess } from "../src/modules/library-changes";
const disk = new Map<string, Uint8Array>(), items = new Map<string, any>(), collections = new Map<string, any>();
let mode: string, edit: boolean, saved: number;
class Item {
  key = "NEW00001"; libraryID = 1; id = 10; parentKey: string | false = false; deleted = false;
  tags = [{ tag: "automatic", type: 1 }]; memberships = [1, 3]; note = "";
  constructor(public type = "journalArticle") {}
  async loadPrimaryData() {} setType() { this.type = "note"; }
  getField() { return "Paper"; } isNote() { return this.type === "note"; } isRegularItem() { return !this.isNote(); }
  getTags() { return structuredClone(this.tags); } setTags(value: any) { this.tags = structuredClone(value); }
  getCollections() { return [...this.memberships]; } setCollections(value: number[]) { this.memberships = value; }
  getNote() { return this.note; } setNote(value: string) { this.note = value; }
  async save() { saved++; items.set(this.key, this); } async erase() { items.delete(this.key); } async reload() {}
}
class Collection {
  key = "NEW00002"; libraryID = 1; id = 5; name = "New"; parentKey: string | false = false;
  getChildItems() { return [...items.values()].filter(item => item.memberships.includes(this.id)); }
  getChildCollections() { return [...collections.values()].filter(collection => collection.parentKey === this.key); }
  async loadPrimaryData() {}
  async loadDataType() {}
  async save() { saved++; collections.set(this.key, this); } async erase() { collections.delete(this.key); } async reload() {}
}
const access: LibraryAccess = { mode: "library", libraryID: 1, items: [], collections: [] };
beforeEach(() => {
  disk.clear(); items.clear(); collections.clear(); saved = 0; mode = "library"; edit = true;
  vi.mocked(Zotero.getMainWindows).mockReturnValue([window] as any);
  for (const [index, key] of ["COL00001", "COL00002", "COL00003"].entries()) {
    const collection = new Collection(); collection.key = key; collection.id = index + 1; collection.name = key; collections.set(key, collection);
  }
  const item = new Item(); item.key = "ITEM0001"; items.set(item.key, item);
  Object.assign(Zotero, { Item, Collection, ItemTypes: { getID: () => 1 }, DB: { executeTransaction: vi.fn(async callback => callback()) } });
  Object.assign(Zotero.Libraries, { get: vi.fn(() => ({ editable: edit })) });
  Object.assign(Zotero, { Collections: { getByLibraryAndKey: (_lib: number, key: string) => collections.get(key), get: (id: number) => [...collections.values()].find(c => c.id === id) } });
  vi.mocked(Zotero.Items.getByLibraryAndKey).mockImplementation((_lib, key) => items.get(key));
  vi.mocked(Zotero.Prefs.get).mockImplementation(key => String(key).endsWith("cacheDir") ? "/cache" as never : mode as never);
  Object.assign(Zotero.Utilities, { generateObjectKey: vi.fn(() => "NEW00001") });
  Object.assign(IOUtils, { exists: vi.fn(async (path: string) => disk.has(path)), read: vi.fn(async (path: string) => disk.get(path)),
    makeDirectory: vi.fn(async () => {}), remove: vi.fn(async () => {}), write: vi.fn(async (path: string, bytes: Uint8Array) => disk.set(path, bytes)) });
});
const planTags = () => planLibraryChanges([{ action: "add_tags", library_id: 1, item_keys: ["ITEM0001"], tags: ["read"] }]);
describe("reversible scoped library changes", () => {
  const deleteEmpty = (key = "COL00002") => ({ action: "delete_empty_collection" as const, library_id: 1, collection_key: key });
  it("deletes an empty leaf and restores its exact key, name and parent with an idempotent receipt", async () => {
    collections.get("COL00002").parentKey = "COL00001";
    const plan = planLibraryChanges([deleteEmpty()]);
    expect(summarizeLibraryChange(plan)).toMatchObject({ changes: [{ key: "COL00002", before: { name: "COL00002", parentKey: "COL00001" }, after: null }] });
    await applyLibraryChanges(plan, access);
    expect(collections.has("COL00002")).toBe(false);
    expect((await listLibraryChanges())[0].changes[0].after).toBeNull();
    await applyLibraryChanges(plan, access);
    expect(Zotero.DB.executeTransaction).toHaveBeenCalledOnce();
    await applyLibraryChanges(plan, access, undefined, undefined, true);
    expect(collections.get("COL00002")).toMatchObject({ key: "COL00002", name: "COL00002", parentKey: "COL00001", libraryID: 1 });
  });
  it("refuses nonempty collections, including empty child containers and trashed items", () => {
    expect(() => planLibraryChanges([deleteEmpty("COL00001")])).toThrow("not empty");
    items.get("ITEM0001").deleted = true;
    expect(() => planLibraryChanges([deleteEmpty("COL00001")])).toThrow("not empty");
    collections.get("COL00003").parentKey = "COL00002";
    expect(() => planLibraryChanges([deleteEmpty()])).toThrow("not empty");
  });
  it("combines moving contents and deleting a shell, and restores the shell before memberships on undo", async () => {
    const plan = planLibraryChanges([deleteEmpty("COL00001"),
      { action: "move_to_collection", library_id: 1, item_keys: ["ITEM0001"], from_collection_key: "COL00001", collection_key: "COL00002" }]);
    await applyLibraryChanges(plan, access);
    expect(collections.has("COL00001")).toBe(false);
    expect(items.get("ITEM0001").memberships).toEqual([2, 3]);
    expect(items.get("ITEM0001").tags).toEqual([{ tag: "automatic", type: 1 }]);
    await applyLibraryChanges(plan, access, undefined, undefined, true);
    expect(items.get("ITEM0001").memberships.map((id: number) => Zotero.Collections.get(id).key).sort()).toEqual(["COL00001", "COL00003"]);
  });
  it("deletes an emptied container after its child, and restores parents before children", async () => {
    collections.get("COL00002").parentKey = "COL00001";
    items.get("ITEM0001").memberships = [3];
    const eraseParent = vi.spyOn(collections.get("COL00001"), "erase");
    const eraseChild = vi.spyOn(collections.get("COL00002"), "erase");
    const plan = planLibraryChanges([deleteEmpty("COL00001"), deleteEmpty()]);
    await applyLibraryChanges(plan, access);
    expect(eraseChild.mock.invocationCallOrder[0]).toBeLessThan(eraseParent.mock.invocationCallOrder[0]);
    await applyLibraryChanges(plan, access, undefined, undefined, true);
    expect(collections.get("COL00002").parentKey).toBe("COL00001");
  });
  it("checks fresh child data immediately before deletion and protects intervening user work", async () => {
    const plan = planLibraryChanges([deleteEmpty()]);
    const load = vi.spyOn(collections.get("COL00002"), "loadDataType").mockImplementation(async () => {
      items.get("ITEM0001").memberships.push(2);
    });
    await expect(applyLibraryChanges(plan, access)).rejects.toThrow("no longer empty");
    expect(load).toHaveBeenCalledWith("childItems", true);
    expect(load).toHaveBeenCalledWith("childCollections", true);
    expect(collections.has("COL00002")).toBe(true);
  });
  it("requires approval and respects selected/collection scopes and read-only revocation for deletion", async () => {
    const plan = planLibraryChanges([deleteEmpty()]);
    mode = "ask";
    await expect(applyLibraryChanges(plan, { mode: "ask", items: [], collections: [] }, async () => false)).rejects.toThrow("approved");
    mode = "selected";
    await expect(applyLibraryChanges(plan, { mode: "selected", libraryID: 1, items: ["ITEM0001"], collections: [] })).rejects.toThrow("scope");
    mode = "collection";
    await expect(applyLibraryChanges(plan, { mode: "collection", libraryID: 1, items: [], collections: ["COL00001"] })).rejects.toThrow("scope");
    mode = "readonly";
    await expect(applyLibraryChanges(plan, access)).rejects.toThrow("disabled");
    mode = "collection";
    await applyLibraryChanges(plan, { mode: "collection", libraryID: 1, items: [], collections: ["COL00002"] });
    expect(collections.has("COL00002")).toBe(false);
  });
  it("rejects a reused key on undo and references to deleted parents or memberships", async () => {
    const plan = planLibraryChanges([deleteEmpty()]);
    await applyLibraryChanges(plan, access);
    const replacement = new Collection(); replacement.key = "COL00002"; replacement.name = "Later work";
    collections.set(replacement.key, replacement);
    await expect(applyLibraryChanges(plan, access, undefined, undefined, true)).rejects.toThrow("Conflict");
    expect(() => planLibraryChanges([deleteEmpty(), { action: "update_collection", library_id: 1, collection_key: "COL00003", parent_collection_key: "COL00002" }])).toThrow("deleted parent");
    expect(() => planLibraryChanges([deleteEmpty(), { action: "add_to_collection", library_id: 1, item_keys: ["ITEM0001"], collection_key: "COL00002" }])).toThrow("deleted collection");
  });
  it("reloads the local tree and preserves selection without writing refresh moves", async () => {
    const view = { selection: { focused: 4, selectEventsSuppressed: false }, getRow: () => ({ id: "C1", ref: { libraryID: 1 } }),
      reload: vi.fn(async () => { view.selection.selectEventsSuppressed = true; }), selectByID: vi.fn(async () => true) };
    vi.mocked(Zotero.getMainWindows).mockReturnValue([{ ZoteroPane: { collectionsView: view } }] as any);
    await applyLibraryChanges(planLibraryChanges([deleteEmpty()]), access);
    expect(view.reload).toHaveBeenCalledOnce(); expect(view.selectByID).toHaveBeenCalledWith("C1", false);
    expect(view.selection.selectEventsSuppressed).toBe(false); expect(saved).toBe(0);
  });
  it("grants the current library independently of selected items and collections", async () => {
    const descendants = vi.fn(() => { throw new Error("irrelevant descendants must not be read"); });
    const pane = { getSelectedLibraryID: () => 1, getSelectedItems: () => [items.get("ITEM0001")],
      getSelectedCollection: () => ({ key: "COL00001", libraryID: 1, getDescendents: descendants }) };
    const captured = captureLibraryAccess({ ZoteroPane: pane } as any);
    expect(captured).toEqual({ mode: "library", libraryID: 1, items: [], collections: [] });
    expect(descendants).not.toHaveBeenCalled();
    const plan = planLibraryChanges([{ action: "update_collection", library_id: 1, collection_key: "COL00002", name: "Outside selected collection" },
      { action: "create_collection", library_id: 1, name: "Library root" }]);
    await applyLibraryChanges(plan, captured);
    expect(collections.get("COL00002").name).toBe("Outside selected collection");
    expect(collections.get("NEW00001").parentKey).toBe(false);
  });
  it("describes only the active mode's authority, even for legacy snapshots", () => {
    const selection = { libraryID: 1, items: ["ITEM0001"], collections: ["COL00001"] };
    const full = describeLibraryAccess({ ...selection, mode: "library" });
    expect(full).toMatchObject({ scope: "all items and collections in this library", review_required: false });
    expect(full).not.toHaveProperty("items"); expect(full).not.toHaveProperty("collections");
    expect(full).not.toHaveProperty("item_keys"); expect(full).not.toHaveProperty("collection_keys");
    expect(describeLibraryAccess({ ...selection, mode: "selected" })).toMatchObject({ item_keys: selection.items });
    expect(describeLibraryAccess({ ...selection, mode: "selected" })).not.toHaveProperty("collection_keys");
    expect(describeLibraryAccess({ ...selection, mode: "collection" })).toMatchObject({ collection_keys: selection.collections });
    expect(describeLibraryAccess({ ...selection, mode: "readonly" })).toMatchObject({ scope: "no library writes" });
    expect(describeLibraryAccess({ ...selection, mode: "ask" })).toMatchObject({ review_required: true });
  });
  it("moves only from the specified collection, preserves other memberships and tag types, then restores exactly", async () => {
    const plan = planLibraryChanges([{ action: "move_to_collection", library_id: 1, item_keys: ["ITEM0001"], from_collection_key: "COL00001", collection_key: "COL00002" },
      { action: "add_tags", library_id: 1, item_keys: ["ITEM0001"], tags: ["read"] }]);
    expect(saved).toBe(0);
    await applyLibraryChanges(plan, access);
    expect(items.get("ITEM0001").getCollections()).toEqual([2, 3]);
    expect(items.get("ITEM0001").getTags()).toContainEqual({ tag: "automatic", type: 1 });
    await applyLibraryChanges(plan, access, undefined, undefined, true);
    expect(items.get("ITEM0001").getCollections()).toEqual([1, 3]);
    expect(items.get("ITEM0001").getTags()).toEqual([{ tag: "automatic", type: 1 }]);
    expect((await listLibraryChanges())[0].status).toBe("undone");
  });
  it("requires real approval in ask mode and never commits a rejected batch", async () => {
    mode = "ask";
    const plan = planTags(), ask: LibraryAccess = { mode: "ask", items: [], collections: [] };
    await expect(applyLibraryChanges(plan, ask, async () => false)).rejects.toThrow("approved");
    expect(saved).toBe(0);
    const approve = vi.fn(async () => true);
    await applyLibraryChanges(plan, ask, approve); await applyLibraryChanges(plan, ask, approve);
    expect(approve).toHaveBeenCalledOnce(); expect(saved).toBe(1);
  });
  it("rejects readonly libraries, revoked permission, and an out-of-scope item", async () => {
    const plan = planTags(); edit = false;
    await expect(applyLibraryChanges(plan, access)).rejects.toThrow("read-only");
    edit = true; mode = "readonly";
    await expect(applyLibraryChanges(plan, access)).rejects.toThrow("disabled");
    mode = "selected";
    await expect(applyLibraryChanges(plan, { mode: "selected", libraryID: 1, items: [], collections: [] })).rejects.toThrow("scope");
    expect(saved).toBe(0);
  });
  it("detects changes while approval is pending, and later user edits block undo", async () => {
    const plan = planTags(); mode = "ask";
    await expect(applyLibraryChanges(plan, { mode: "ask", items: [], collections: [] }, async () => {
      items.get("ITEM0001").tags.push({ tag: "later", type: 0 }); return true;
    })).rejects.toThrow("Conflict");
    mode = "library"; const fresh = planTags(); await applyLibraryChanges(fresh, access);
    items.get("ITEM0001").tags.push({ tag: "new user work", type: 0 });
    await expect(applyLibraryChanges(fresh, access, undefined, undefined, true)).rejects.toThrow("Conflict");
  });
  it("prevents cycles across multiple collection changes", () => {
    expect(() => planLibraryChanges([{ action: "update_collection", library_id: 1, collection_key: "COL00001", parent_collection_key: "COL00002" },
      { action: "update_collection", library_id: 1, collection_key: "COL00002", parent_collection_key: "COL00001" }])).toThrow("cycle");
  });
  it("sanitizes note HTML and undoes note creation", async () => {
    const plan = planLibraryChanges([{ action: "create_note", library_id: 1, parent_item_key: "ITEM0001", markdown: 'Note <script>alert(1)</script> [unsafe](javascript:alert(1))' }]);
    await applyLibraryChanges(plan, access);
    const note = items.get("NEW00001"); expect(note.parentKey).toBe("ITEM0001");
    expect(note.getNote()).not.toMatch(/<script|javascript:/);
    await applyLibraryChanges(plan, access, undefined, undefined, true); expect(items.has("NEW00001")).toBe(false);
  });
  it("does not repeat mutations for a completed receipt", async () => {
    const plan = planTags(); await applyLibraryChanges(plan, access); await applyLibraryChanges(plan, access);
    expect(saved).toBe(1); expect(Zotero.DB.executeTransaction).toHaveBeenCalledOnce();
  });
  it("refuses to delete newly created collections containing later user work during undo", async () => {
    const plan = planLibraryChanges([{ action: "create_collection", library_id: 1, name: "New" }]);
    await applyLibraryChanges(plan, access);
    items.get("ITEM0001").memberships.push(collections.get("NEW00001").id);
    await expect(applyLibraryChanges(plan, access, undefined, undefined, true)).rejects.toThrow("no longer empty");
  });
  it("cancels before opening a transaction and keeps the original state", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(applyLibraryChanges(planTags(), access, undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(saved).toBe(0);
  });
  it("stops an automatically authorized batch if permission changes before transaction execution", async () => {
    vi.mocked(Zotero.DB.executeTransaction).mockImplementation(async callback => {
      mode = "selected";
      return callback();
    });
    await expect(applyLibraryChanges(planTags(), access)).rejects.toThrow("permission changed");
    expect(saved).toBe(0);
  });
  it("marks a model-requested undo as a reversal and honors read-only revocation during review", async () => {
    const plan = planTags(); await applyLibraryChanges(plan, access);
    mode = "ask";
    const review = vi.fn(async () => { mode = "readonly"; return true; });
    await expect(applyLibraryChanges(plan, { mode: "ask", items: [], collections: [] }, review, undefined, true)).rejects.toThrow("revoked");
    expect(review).toHaveBeenCalledWith(plan, true);
    expect(items.get("ITEM0001").getTags()).toContainEqual({ tag: "read", type: 0 });
    expect((await listLibraryChanges())[0].status).toBe("applied");
  });
});
