import { getItemCollections } from "./zotero-items";
import { throwIfConversionAborted } from "./pdf-conversion";

async function metadata(item: Zotero.Item) {
  await item.loadAllData();
  const data = JSON.parse(JSON.stringify(item.toJSON({ skipStorageProperties: true })));
  // Linked file paths are not needed to inspect an item; note bodies have a
  // dedicated complete reader rather than repeating them for every child.
  delete data.path;
  if (typeof data.note === "string") { data.note_content_available = !!data.note; delete data.note; }
  return { library_id: item.libraryID, ...data };
}

function collectionPath(libraryID: number, key: string) {
  const path: { key: string; name: string }[] = [], seen = new Set<string>();
  let current: string | false = key;
  while (current && !seen.has(current)) {
    seen.add(current);
    const collection = Zotero.Collections.getByLibraryAndKey(libraryID, current);
    if (!collection || collection.deleted) return { path: path.reverse(), path_complete: false };
    path.push({ key: collection.key, name: collection.name }); current = collection.parentKey;
  }
  return { path: path.reverse(), path_complete: !current };
}

/** Full public item metadata is fetched on demand, independent of PDF TurnScope. */
export async function inspectZoteroItem(item: Zotero.Item, signal?: AbortSignal) {
  throwIfConversionAborted(signal);
  const requested = await metadata(item);
  const parent = item.isRegularItem() ? null : item.parentItem;
  const parentData = parent ? await metadata(parent) : null;
  const paper = item.isRegularItem() ? item : parent?.isRegularItem() ? parent : null;
  const owner = paper || item;
  const notes = [], attachments = [];
  if (paper) {
    for (const id of paper.getNotes()) {
      throwIfConversionAborted(signal);
      const child = Zotero.Items.get(id);
      if (child && !child.deleted) notes.push({ ...await metadata(child), title: child.getNoteTitle() });
    }
    for (const id of paper.getAttachments()) {
      throwIfConversionAborted(signal);
      const child = Zotero.Items.get(id);
      if (child && !child.deleted) attachments.push({ ...await metadata(child), is_pdf: child.isPDFAttachment(),
        local_file_available: child.isFileAttachment() ? await child.fileExists() : null });
    }
  }
  throwIfConversionAborted(signal);
  notes.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  attachments.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return { representation: "zotero-item-details", item: requested, parent_item: parentData,
    collection_memberships: getItemCollections(owner).sort((a, b) => a.key.localeCompare(b.key)).map(collection => ({
      library_id: owner.libraryID, key: collection.key, name: collection.name, parent_key: collection.parentKey || null,
      ...collectionPath(owner.libraryID, collection.key),
    })), child_notes: notes, attachments,
    note: "Stored metadata, including full bibliographic fields, creator roles, tag types, relations and dates. Child note bodies are read with read_zotero_notes; attachments are read with document tools. Metadata does not grant edit authority." };
}
