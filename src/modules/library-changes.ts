import { atomicWriteJson, withStorageLock } from "../utils/atomic-storage";
import { getCacheDir } from "../utils/cache-dir";
import { getPref } from "../utils/prefs";
import { renderMarkdown } from "./markdown-renderer";
import { throwIfConversionAborted } from "./pdf-conversion";
import { contextFingerprint } from "./agent-context";

export type LibraryEditMode = "ask" | "readonly" | "selected" | "collection" | "library";
export interface LibraryAccess { mode: LibraryEditMode; libraryID?: number; items: string[]; collections: string[]; }
export interface LibraryAction {
  action: "add_to_collection" | "remove_from_collection" | "move_to_collection" | "add_tags" | "remove_tags" | "rename_tag" | "create_collection" | "update_collection" | "delete_empty_collection" | "create_note" | "update_note";
  library_id: number; item_keys?: string[]; collection_key?: string; from_collection_key?: string;
  parent_collection_key?: string | null; name?: string; tags?: string[]; tag?: string; new_tag?: string;
  note_key?: string; parent_item_key?: string; markdown?: string;
}
interface Snapshot { kind: "item" | "collection"; libraryID: number; key: string; title: string; data: Record<string, any>; }
interface Change { before: Snapshot | null; after: Snapshot | null; }
export interface LibraryChangeSet { id: string; actionHash?: string; status: "preview" | "prepared" | "applied" | "undone" | "failed"; changes: Change[]; }
const journalPath = () => PathUtils.join(getCacheDir(), "library-changes.json");
const identity = (obj: { libraryID: number; key: string }) => `${obj.libraryID}:${obj.key}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const keyPattern = /^[A-Z0-9]{8}$/;
const targetOf = (change: Change): Snapshot => (change.after || change.before)!;

function object(kind: Snapshot["kind"], libraryID: number, key: string): any {
  if (!Number.isSafeInteger(libraryID) || libraryID < 1 || !keyPattern.test(key)) throw new Error("Use a library_id and an eight-character Zotero key.");
  return (kind === "item" ? Zotero.Items : Zotero.Collections).getByLibraryAndKey(libraryID, key);
}
function editable(libraryID: number): void {
  if (!(Zotero.Libraries as any).get(libraryID)?.editable) throw new Error(`Library ${libraryID} is read-only or unavailable.`);
}
function snapshot(kind: Snapshot["kind"], obj: any): Snapshot {
  const data = kind === "collection" ? { name: obj.name, parentKey: obj.parentKey || null }
    : obj.isNote() ? { note: obj.getNote(), parentKey: obj.parentKey || null }
      : { tags: obj.getTags().map((tag: any) => ({ tag: tag.tag, type: tag.type || 0 })).sort((a: any, b: any) => a.tag.localeCompare(b.tag) || a.type - b.type),
        collections: obj.getCollections().map((id: number) => Zotero.Collections.get(id).key).sort() };
  return { kind, libraryID: obj.libraryID, key: obj.key,
    title: kind === "collection" ? obj.name : String(obj.getField("title") || obj.getNoteTitle?.() || obj.key), data };
}
function current(change: Change): Snapshot | null {
  const target = targetOf(change);
  const obj = object(target.kind, target.libraryID, target.key);
  return obj && !obj.deleted ? snapshot(target.kind, obj) : null;
}
function sameState(a: Snapshot | null, b: Snapshot | null): boolean {
  return a === null || b === null ? a === b : same(a.data, b.data);
}
function inScope(change: Change, access: LibraryAccess): boolean {
  const target = targetOf(change);
  if (access.mode === "ask") return true; // Actual approval is required by the executor, not supplied by the model.
  if (access.mode === "readonly" || access.libraryID !== target.libraryID) return false;
  if (access.mode === "library") return true;
  if (target.kind === "collection") {
    return access.mode === "collection" && (access.collections.includes(target.key) || (!change.before && access.collections.includes(target.data.parentKey)))
      && (change.before?.data.parentKey === target.data.parentKey || !target.data.parentKey || access.collections.includes(target.data.parentKey));
  }
  const itemKey = target.data.parentKey || target.key;
  if (access.mode === "selected") return access.items.includes(itemKey);
  const item = object("item", target.libraryID, itemKey);
  if (!item || !item.getCollections().some((id: number) => access.collections.includes(Zotero.Collections.get(id).key))) return false;
  if (target.data.collections) {
    const before = change.before?.data.collections || [], after = target.data.collections;
    const changed = [...before.filter((key: string) => !after.includes(key)), ...after.filter((key: string) => !before.includes(key))];
    if (changed.some(key => !access.collections.includes(key))) return false;
  }
  return true;
}
export function captureLibraryAccess(win: Window): LibraryAccess {
  const mode = (getPref("agentLibraryEditMode") || "ask") as LibraryEditMode;
  const pane = (win as any).ZoteroPane;
  const collection = pane?.getSelectedCollection?.();
  const libraryID = pane?.getSelectedLibraryID?.() || collection?.libraryID;
  const selected = (pane?.getSelectedItems?.() || []).map((item: any) => item.parentItem || item);
  const collections = mode === "collection" && collection ? [collection.key, ...collection.getDescendents(false, "collection").map((child: any) => child.key)] : [];
  return { mode: ["ask", "readonly", "selected", "collection", "library"].includes(mode) ? mode : "ask", libraryID,
    items: mode === "selected" ? [...new Set<string>(selected.filter((item: any) => item.libraryID === libraryID).map((item: any) => item.key))] : [], collections };
}

/** UI selection is not an allowlist when the whole current library is authorized. */
export function describeLibraryAccess(access: LibraryAccess): Record<string, unknown> {
  const base = { mode: access.mode, libraryID: access.libraryID };
  if (access.mode === "library") return { ...base, scope: access.libraryID ? "all items and collections in this library" : "unavailable: no current library", review_required: false };
  if (access.mode === "selected") return { ...base, scope: "only these selected items and their notes", item_keys: access.items, review_required: false };
  if (access.mode === "collection") return { ...base, scope: "these collections, their descendants and contained items", collection_keys: access.collections, review_required: false };
  if (access.mode === "readonly") return { mode: access.mode, scope: "no library writes", review_required: false };
  return { mode: "ask", scope: "each concrete batch only after a trusted user review", review_required: true };
}

export function planLibraryChanges(actions: LibraryAction[]): LibraryChangeSet {
  if (!Array.isArray(actions) || !actions.length) throw new Error("actions must be a nonempty array.");
  const changes = new Map<string, Change>();
  const edit = (kind: Snapshot["kind"], libraryID: number, key: string): Change & { after: Snapshot } => {
    editable(libraryID);
    const id = `${kind}:${libraryID}:${key}`;
    let change = changes.get(id);
    if (!change) {
      const obj = object(kind, libraryID, key);
      if (!obj || obj.deleted) throw new Error(`Target ${libraryID}:${key} not found.`);
      const before = snapshot(kind, obj);
      change = { before, after: JSON.parse(JSON.stringify(before)) };
      changes.set(id, change);
    }
    if (!change.after) throw new Error("A deleted collection cannot be edited again in the same batch.");
    return change as Change & { after: Snapshot };
  };
  const requireCollection = (lib: number, key: string) => {
    const collection = object("collection", lib, key);
    if (!collection || collection.deleted) throw new Error(`Collection ${lib}:${key} not found.`);
    return collection;
  };
  const name = (value: unknown) => { if (typeof value !== "string" || !value.trim()) throw new Error("A nonempty name or tag is required."); return value.trim(); };
  for (const action of actions) {
    editable(action.library_id);
    if (action.action === "create_collection" || action.action === "create_note") {
      const key = Zotero.Utilities.generateObjectKey();
      const after: Snapshot = { kind: action.action === "create_collection" ? "collection" : "item", libraryID: action.library_id, key, title: "", data: {} };
      if (after.kind === "collection") {
        if (action.parent_collection_key) requireCollection(action.library_id, action.parent_collection_key);
        after.data = { name: name(action.name), parentKey: action.parent_collection_key || null }; after.title = after.data.name;
      } else {
        const parent = object("item", action.library_id, String(action.parent_item_key || ""));
        if (!parent?.isRegularItem()) throw new Error("A note requires a bibliographic parent_item_key.");
        if (typeof action.markdown !== "string") throw new Error("markdown is required.");
        after.data = { note: renderMarkdown(action.markdown), parentKey: parent.key }; after.title = `Note on ${parent.getField("title")}`;
      }
      changes.set(`${after.kind}:${identity(after)}`, { before: null, after });
    } else if (action.action === "delete_empty_collection") {
      const change = edit("collection", action.library_id, String(action.collection_key || ""));
      if (!change.before) throw new Error("Do not create and delete the same collection in one batch.");
      changes.set(`collection:${action.library_id}:${change.after.key}`, { before: change.before, after: null });
    } else if (action.action === "update_collection") {
      const change = edit("collection", action.library_id, String(action.collection_key || ""));
      if (action.name !== undefined) change.after.data.name = name(action.name);
      if (action.parent_collection_key !== undefined) {
        if (action.parent_collection_key) requireCollection(action.library_id, action.parent_collection_key);
        change.after.data.parentKey = action.parent_collection_key || null;
      }
    } else if (action.action === "update_note") {
      const change = edit("item", action.library_id, String(action.note_key || ""));
      if (typeof change.after.data.note !== "string" || typeof action.markdown !== "string") throw new Error("Target must be a note and markdown is required.");
      change.after.data.note = renderMarkdown(action.markdown);
    } else {
      if (!Array.isArray(action.item_keys) || !action.item_keys.length) throw new Error("item_keys is required.");
      for (const key of action.item_keys) {
        const obj = object("item", action.library_id, key);
        if (!obj || obj.isNote() || obj.parentItem) throw new Error("Organize top-level items. Use their parent item keys for child attachments.");
        const change = edit("item", action.library_id, key), data = change.after.data;
        if (["add_to_collection", "remove_from_collection", "move_to_collection"].includes(action.action)) {
          const target = name(action.collection_key); requireCollection(action.library_id, target);
          const memberships = new Set<string>(data.collections);
          if (action.action === "move_to_collection") {
            const from = name(action.from_collection_key); requireCollection(action.library_id, from);
            if (from === target) throw new Error("Move source and target collections must differ.");
            if (!memberships.has(from)) throw new Error(`Item ${key} is not in the specified source collection.`);
            memberships.delete(from);
          }
          if (action.action === "remove_from_collection") memberships.delete(target); else memberships.add(target);
          data.collections = [...memberships].sort();
        } else if (action.action === "add_tags" || action.action === "remove_tags") {
          if (!Array.isArray(action.tags) || !action.tags.length) throw new Error("tags is required.");
          for (const tag of action.tags.map(name)) {
            if (action.action === "remove_tags") data.tags = data.tags.filter((entry: any) => entry.tag !== tag);
            else if (!data.tags.some((entry: any) => entry.tag === tag)) data.tags.push({ tag, type: 0 });
          }
        } else if (action.action === "rename_tag") {
          const old = name(action.tag), next = name(action.new_tag);
          const found = data.tags.find((entry: any) => entry.tag === old);
          data.tags = data.tags.filter((entry: any) => entry.tag !== old);
          if (found && !data.tags.some((entry: any) => entry.tag === next)) data.tags.push({ tag: next, type: found.type });
        } else throw new Error(`Unsupported library action: ${action.action}`);
        data.tags.sort((a: any, b: any) => a.tag.localeCompare(b.tag) || a.type - b.type);
      }
    }
  }
  // Validate the final graph, including multiple reparentings in one batch.
  for (const change of changes.values()) if (change.after?.kind === "collection") {
    const seen = new Set([change.after.key]);
    let parent = change.after.data.parentKey;
    while (parent) {
      if (seen.has(parent)) throw new Error("Collection parent changes would create a cycle.");
      seen.add(parent);
      const planned = changes.get(`collection:${change.after.libraryID}:${parent}`);
      if (planned && !planned.after) throw new Error("A collection cannot remain under a deleted parent.");
      parent = planned ? planned.after!.data.parentKey : requireCollection(change.after.libraryID, parent).parentKey;
    }
  }
  // Check the final batch state, so moving out all contents and deleting the
  // resulting empty shell needs just one reviewed, reversible transaction.
  for (const change of changes.values()) {
    if (change.after?.data.collections) for (const key of change.after.data.collections) {
      const collection = changes.get(`collection:${change.after.libraryID}:${key}`);
      if (collection && !collection.after) throw new Error("An item cannot remain in a deleted collection.");
    }
    if (change.after) continue;
    const target = targetOf(change), collection = requireCollection(target.libraryID, target.key);
    const remainingItems = collection.getChildItems(false, true).some((item: any) => {
      const planned = changes.get(`item:${target.libraryID}:${item.key}`);
      return !planned || planned.after?.data.collections?.includes(target.key);
    });
    const remainingChildren = collection.getChildCollections(false, true).some((child: any) => {
      const planned = changes.get(`collection:${target.libraryID}:${child.key}`);
      return !planned || planned.after?.data.parentKey === target.key;
    });
    if (remainingItems || remainingChildren) throw new Error(`Collection ${identity(target)} is not empty after the planned changes (including trashed contents).`);
  }
  return { id: `change-${Date.now()}-${Math.random().toString(36).slice(2)}`, status: "preview",
    changes: [...changes.values()].filter(change => !sameState(change.before, change.after)) };
}

async function journal(): Promise<LibraryChangeSet[]> {
  return await IOUtils.exists(journalPath()) ? JSON.parse(new TextDecoder().decode(await IOUtils.read(journalPath()))) : [];
}
export async function listLibraryChanges(): Promise<LibraryChangeSet[]> { return journal(); }
export function summarizeLibraryChange(plan: LibraryChangeSet): Record<string, unknown> {
  const fields = (data: Record<string, any> | undefined) => !data ? null : typeof data.note === "string"
    ? { parentKey: data.parentKey, note_chars: data.note.length, revision: contextFingerprint(data.note) } : data;
  return { change_id: plan.id, status: plan.status, changes: plan.changes.map(change => {
    const target = targetOf(change);
    return { kind: target.kind, library_id: target.libraryID, key: target.key, title: target.title,
      before: fields(change.before?.data), after: fields(change.after?.data) };
  }) };
}

async function writeSnapshot(target: Snapshot | null, original: Snapshot): Promise<void> {
  let obj = object(original.kind, original.libraryID, original.key);
  if (!target) {
    if (original.kind === "collection") {
      // Membership/parent caches can be updated only on commit. Reload through
      // Zotero's public API to inspect the current transactional database state.
      await obj.loadDataType("childItems", true);
      await obj.loadDataType("childCollections", true);
      if (obj.getChildItems(false, true).length || obj.getChildCollections(false, true).length) throw new Error("Collection is no longer empty; deletion would remove later work (including trashed contents).");
    }
    await obj.erase(); return;
  }
  if (obj?.deleted) throw new Error("Target is in the trash; restore it explicitly before editing.");
  if (!obj) {
    obj = target.kind === "collection" ? new Zotero.Collection() : new Zotero.Item();
    obj.libraryID = target.libraryID; obj.key = target.key;
    // A preallocated key identifies the object. Public loading marks a missing
    // object's data initialized before setters/save; no private flags are altered.
    await obj.loadPrimaryData(false, false);
    if (target.kind === "item") obj.setType(Zotero.ItemTypes.getID("note"));
  }
  if (target.kind === "collection") { obj.name = target.data.name; obj.parentKey = target.data.parentKey || false; }
  else if (typeof target.data.note === "string") { obj.parentKey = target.data.parentKey || false; obj.setNote(target.data.note); }
  else { obj.setTags(target.data.tags); obj.setCollections(target.data.collections.map((key: string) => object("collection", target.libraryID, key).id)); }
  await obj.save();
}

function orderedChanges(changes: Change[]): Change[] {
  const updates = changes.filter(change => change.after), deletions = changes.filter(change => !change.after);
  const depth = (change: Change): number => {
    let parent = change.before?.data.parentKey, count = 0;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const ancestor = deletions.find(candidate => candidate.before?.libraryID === change.before?.libraryID && candidate.before?.key === parent);
      if (!ancestor) break;
      count++; parent = ancestor.before?.data.parentKey;
    }
    return count;
  };
  // Delete children first; undo reverses this order to restore parents first.
  return [...updates, ...deletions.sort((a, b) => depth(b) - depth(a))];
}

async function refreshCollectionTrees(): Promise<void> {
  for (const win of Zotero.getMainWindows()) {
    const view = (win as any).ZoteroPane?.collectionsView;
    if (!view?.reload) continue;
    const row = view.getRow?.(view.selection?.focused);
    const selectedID = row?.id, libraryID = row?.ref?.libraryID;
    const suppressed = view.selection?.selectEventsSuppressed;
    try {
      await view.reload();
      if (view.selectByID) {
        const restored = selectedID && await view.selectByID(selectedID, false);
        if (!restored && libraryID) await view.selectByID(`L${libraryID}`, false);
      }
    }
    catch (error) { Zotero.debug(`[ChatPDF] Collection tree refresh failed: ${String(error)}`); }
    finally { if (view.selection) view.selection.selectEventsSuppressed = suppressed ?? false; }
  }
}

/** All authorization comes from the UI/captured access; tool arguments cannot grant permission. */
export async function applyLibraryChanges(plan: LibraryChangeSet, access: LibraryAccess,
  approve?: (plan: LibraryChangeSet, undo?: boolean) => Promise<boolean>, signal?: AbortSignal, undo = false): Promise<LibraryChangeSet> {
  throwIfConversionAborted(signal);
  if (!plan.changes.length) return { ...plan, status: undo ? "undone" : "applied" };
  const previous = (await journal()).find(record => record.id === plan.id);
  if (!undo && previous?.status === "applied" || undo && previous?.status === "undone") return previous!;
  if (getPref("agentLibraryEditMode") === "readonly" || access.mode === "readonly") throw new Error("Library edits are disabled by the chat window's read-only permission.");
  if (!plan.changes.every(change => inScope(change, access))) throw new Error("Change is outside the library edit scope selected for this turn.");
  let approved = false;
  if (access.mode === "ask" || (getPref("agentLibraryEditMode") || "ask") !== access.mode) {
    if (!approve || !await approve(plan, undo)) throw new Error("Library changes were not approved.");
    approved = true;
  }
  const checkPermission = () => {
    const mode = getPref("agentLibraryEditMode") || "ask";
    if (mode === "readonly" || !approved && mode !== access.mode) throw new Error("Library edit permission changed or was revoked. Review a new request.");
  };
  throwIfConversionAborted(signal);
  return withStorageLock(journalPath(), async () => {
    const records = await journal();
    const existing = records.find(record => record.id === plan.id);
    if (!undo && existing?.status === "applied" || undo && existing?.status === "undone") return existing!;
    checkPermission();
    if (!undo && existing?.status === "undone") throw new Error("This change was already undone. Use a new operation_id for a new operation.");
    if (!undo && existing?.status === "prepared" && existing.changes.every(change => sameState(current(change), change.after))) {
      existing.status = "applied"; await atomicWriteJson(journalPath(), records); return existing;
    }
    if (undo && existing?.status !== "applied") throw new Error("Only a completed change can be undone.");
    const expected = (change: Change) => undo ? change.after : change.before;
    for (const change of plan.changes) {
      editable(targetOf(change).libraryID);
      if (!sameState(current(change), expected(change))) throw new Error(`Conflict at ${identity(targetOf(change))}. Read current state and prepare a new change.`);
    }
    const receipt: LibraryChangeSet = existing || { ...plan, status: "prepared" };
    if (!existing) records.push(receipt);
    if (!undo) receipt.status = "prepared";
    await atomicWriteJson(journalPath(), records); // Durable receipt before any side effects.
    let committed = false;
    try {
      await Zotero.DB.executeTransaction(async () => {
        throwIfConversionAborted(signal);
        checkPermission();
        for (const change of plan.changes) {
          editable(targetOf(change).libraryID);
          if (!sameState(current(change), expected(change))) throw new Error(`Conflict at ${identity(targetOf(change))}.`);
        }
        const ordered = orderedChanges(plan.changes);
        for (const change of undo ? ordered.reverse() : ordered) {
          throwIfConversionAborted(signal);
          await writeSnapshot(undo ? change.before : change.after, targetOf(change));
        }
      });
      committed = true;
      // Zotero normalizes note HTML; record actual committed state for conflict-safe undo.
      if (!undo) for (const change of receipt.changes) change.after = current(change);
      receipt.status = undo ? "undone" : "applied";
      await atomicWriteJson(journalPath(), records);
      if (plan.changes.some(change => targetOf(change).kind === "collection")) await refreshCollectionTrees();
      return receipt;
    } catch (error) {
      // Keep a prepared receipt when persistence fails after the DB commit; never blindly replay it.
      for (const change of plan.changes) {
        const target = targetOf(change);
        const obj = object(target.kind, target.libraryID, target.key);
        await obj?.reload?.().catch(() => {});
      }
      if (committed) throw new Error(`Library changes committed, but receipt update failed. Do not repeat the actions. Inspect change_id=${plan.id} and current targets before recovery.`, { cause: error });
      throw error;
    }
  });
}
