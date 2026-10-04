import { contextFingerprint } from "./agent-context";
import { sanitizeHtml } from "./markdown-renderer";
import { getItemByKey } from "./zotero-items";
import { textMatches } from "./pdf-text";
import { throwIfConversionAborted } from "./pdf-conversion";

const cache = new Map<string, { revision: string; text: string }>();
export function noteText(html: string): string {
  const doc = new DOMParser().parseFromString(sanitizeHtml(html), "text/html");
  for (const link of doc.querySelectorAll("a[href]")) link.replaceWith(doc.createTextNode(`[${link.textContent}](${link.getAttribute("href")})`));
  for (const br of doc.querySelectorAll("br")) br.replaceWith(doc.createTextNode("\n"));
  for (const block of doc.querySelectorAll("p,div,li,h1,h2,h3,h4,blockquote,tr")) block.append(doc.createTextNode("\n"));
  return (doc.body?.textContent || "").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
async function read(note: Zotero.Item) {
  await (note as any).loadDataType?.("note");
  const html = note.getNote(), revision = contextFingerprint(html), id = `${note.libraryID}:${note.key}`;
  let saved = cache.get(id);
  if (saved?.revision !== revision) { saved = { revision, text: noteText(html) }; cache.set(id, saved); }
  return { library_id: note.libraryID, key: note.key, parent_key: note.parentKey || null,
    title: note.getNoteTitle(), revision, html, text: saved!.text };
}
export async function readZoteroNotes(args: Record<string, unknown>, signal?: AbortSignal) {
  const item = getItemByKey(String(args.item_key || ""), Number(args.library_id));
  if (!item || item.deleted || (item as any).isInTrash?.()) throw new Error("Note or bibliographic item not found.");
  if (item.isRegularItem()) await (item as any).loadDataType?.("childItems");
  const notes = item.isNote() ? [item] : item.isRegularItem() ? item.getNotes().map(id => Zotero.Items.get(id)).filter(note => note && !note.deleted) : [];
  const format = String(args.format || "text");
  if (!["text", "html"].includes(format)) throw new Error("format must be text or html.");
  const result = [];
  for (const note of notes) {
    throwIfConversionAborted(signal);
    const record = await read(note), content = format === "html" ? record.html : record.text;
    const lines = content.split("\n");
    const start = args.start_line === undefined ? 1 : Number(args.start_line), end = args.end_line === undefined ? lines.length : Number(args.end_line);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > lines.length) throw new Error("Use an inclusive line range within the note.");
    const { library_id, key, parent_key, title, revision } = record;
    const metadata = { library_id, key, parent_key, title, revision };
    result.push({ ...metadata, format, total_lines: lines.length, start_line: start, end_line: end, [format]: lines.slice(start - 1, end).join("\n") });
  }
  return { notes: result };
}

export async function searchZoteroNotes(args: Record<string, unknown>, signal?: AbortSignal) {
  const query = String(args.query || "").trim();
  if (!query) throw new Error("query must be nonempty (literal text, case insensitive).");
  const pageSize = Number(args.page_size ?? 20), perCall = Number(args.notes_per_call ?? 100), snippet = Number(args.snippet_chars ?? 240);
  for (const value of [pageSize, perCall, snippet]) if (!Number.isSafeInteger(value) || value < 1) throw new Error("Search limits must be positive integers.");
  const libraryID = args.library_id === undefined ? undefined : Number(args.library_id);
  if (libraryID !== undefined && (!Number.isSafeInteger(libraryID) || libraryID < 1)) throw new Error("library_id must be a positive integer.");
  if (args.item_key && libraryID === undefined) throw new Error("library_id is required with item_key.");
  const collections = new Set<number>();
  if (args.collection_key) {
    if (!libraryID) throw new Error("library_id is required with collection_key.");
    const collection = Zotero.Collections.getByLibraryAndKey(libraryID, String(args.collection_key));
    if (!collection || collection.deleted) throw new Error("Collection not found.");
    collections.add(collection.id);
    if (args.recursive) for (const child of collection.getDescendents(false, "collection")) collections.add(child.id);
  }
  const candidates: Zotero.Item[] = [];
  for (const lib of Zotero.Libraries.getAll()) {
    if (libraryID !== undefined && lib.libraryID !== libraryID) continue;
    throwIfConversionAborted(signal);
    const items = await Zotero.Items.getAll(lib.libraryID, false, false);
    for (const note of items) {
      if (!note.isNote() || note.deleted || (note as any).isInTrash?.()) continue;
      const owner = note.parentItem || note;
      if (args.item_key && String(args.item_key) !== owner.key && String(args.item_key) !== note.key) continue;
      if (collections.size && !owner.getCollections().some(id => collections.has(id))) continue;
      if (args.tag && ![...owner.getTags(), ...note.getTags()].some(tag => tag.tag === String(args.tag))) continue;
      candidates.push(note);
    }
  }
  candidates.sort((a, b) => `${a.libraryID}:${a.key}`.localeCompare(`${b.libraryID}:${b.key}`));
  const fingerprint = contextFingerprint([query, libraryID, args.collection_key, args.recursive, args.item_key, args.tag, snippet,
    candidates.map(note => [note.libraryID, note.key, note.dateModified])]);
  const cursor = args.cursor ? JSON.parse(String(args.cursor)) : { fingerprint, index: 0, match: 0 };
  if (cursor.fingerprint !== fingerprint || !Number.isSafeInteger(cursor.index) || cursor.index < 0 || cursor.index > candidates.length
    || !Number.isSafeInteger(cursor.match) || cursor.match < 0) throw new Error("Search cursor expired or invalid. Restart without cursor.");
  const hits = [], coverage = []; let index = cursor.index, match = cursor.match, revision: string | undefined;
  while (index < candidates.length && coverage.length < perCall && hits.length < pageSize) {
    throwIfConversionAborted(signal);
    const note = candidates[index], record = await read(note); revision = record.revision;
    if (match > 0 && cursor.revision !== revision) throw new Error("Search cursor expired after a note change. Restart without cursor.");
    const matches = textMatches(record.text, query, snippet);
    coverage.push({ library_id: note.libraryID, note_key: note.key, revision, matches: matches.length });
    while (match < matches.length && hits.length < pageSize) hits.push({ library_id: note.libraryID, note_key: note.key,
      parent_item_key: note.parentItem?.key || null, parent_title: String(note.parentItem?.getField("title") || ""), title: record.title, revision, ...matches[match++] });
    if (match < matches.length) break;
    index++; match = 0;
  }
  return { representation: "zotero-note-search", query, total_notes: candidates.length, page_size: pageSize, notes_per_call: perCall,
    snippet_chars: snippet, hits, coverage, next_cursor: index < candidates.length ? JSON.stringify({ fingerprint, index, match, revision: match ? revision : undefined }) : null,
    note: "Only reported notes were inspected. Child notes use their parent's collection membership; standalone notes are also included. Use read_zotero_notes with note_key as item_key and library_id to read complete evidence." };
}
