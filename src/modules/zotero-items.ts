import { ChatSession } from "./chat-session";
import * as MDCache from "./md-cache";

export interface ZoteroItemSummary {
  key: string;
  libraryID?: number;
  title: string;
  creators: string[];
  year?: string;
  itemType?: string;
  abstractNote?: string;
  tags: string[];
  collections: string[];
  hasPdf: boolean;
  pdfKey?: string;
  parentKey?: string;
}

export interface ZoteroCollectionSummary {
  key: string;
  libraryID?: number;
  name: string;
  parentKey?: string;
  itemCount?: number;
}

export interface ZoteroAnnotationSummary {
  key: string;
  libraryID: number;
  type: string;
  text?: string;
  comment?: string;
  color?: string;
  pageLabel?: string;
  dateModified?: string;
  tags: string[];
  attachmentKey?: string;
  itemKey?: string;
  title: string;
  creators: string[];
  year?: string;
}

function uniqueByKey<T>(items: T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = getKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function getPdfAttachment(item: Zotero.Item): Zotero.Item | null {
  if (item.isPDFAttachment?.()) return item;
  if (item.isRegularItem?.()) {
    for (const id of item.getAttachments()) {
      const att = Zotero.Items.get(id);
      if (att?.isPDFAttachment?.()) return att;
    }
  }
  return null;
}

export function getItemTitle(item: Zotero.Item): string {
  if (item.isRegularItem?.()) return (item.getField("title") as string) || "Untitled";
  const parent = item.parentItem;
  if (parent) return (parent.getField("title") as string) || "Untitled";
  return (item.getField("title") as string) || "Untitled";
}

export function getItemByKey(key: string, libraryID?: number): Zotero.Item | null {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return null;

  if (libraryID !== undefined) {
    try {
      const item = Zotero.Items.getByLibraryAndKey(libraryID, normalizedKey);
      if (item) return item;
    } catch (e: any) {
      Zotero.debug(`[ChatPDF] getItemByKey: lookup failed for lib ${libraryID}: ${e.message}`);
    }
  }
  for (const lib of Zotero.Libraries.getAll()) {
    try {
      const item = Zotero.Items.getByLibraryAndKey(lib.libraryID, normalizedKey);
      if (item) return item;
    } catch {
      continue;
    }
  }
  return null;
}

export async function getItemFromZoteroUri(uri: string): Promise<Zotero.Item | null> {
  Zotero.debug(`[ChatPDF] getItemFromZoteroUri: trying "${uri}"`);

  const selectMatch = uri.match(/zotero:\/\/select\/(?:library|groups\/\d+)\/items\/([A-Z0-9]+)/i);
  if (selectMatch) return getItemByKey(selectMatch[1]);

  const openPdfMatch = uri.match(/zotero:\/\/open-pdf\/(?:library|groups\/\d+)\/items\/([A-Z0-9]+)/i);
  if (openPdfMatch) return getItemByKey(openPdfMatch[1]);

  const attachLibMatch = uri.match(/zotero:\/\/attachment\/(\d+)\/([A-Z0-9]+)/i);
  if (attachLibMatch) {
    const item = getItemByKey(attachLibMatch[2], parseInt(attachLibMatch[1], 10));
    if (item) return item;
  }

  const attachNumMatch = uri.match(/zotero:\/\/attachment\/(\d+)(?:[/?#]|$)/);
  if (attachNumMatch) {
    try {
      const item = Zotero.Items.get(parseInt(attachNumMatch[1], 10));
      if (item) return item;
    } catch (e: any) {
      Zotero.debug(`[ChatPDF] getItemFromZoteroUri: numeric attachment lookup failed: ${e.message}`);
    }
  }

  try {
    const item = (Zotero.URI as any).getURIItem(uri);
    if (item) return item;
  } catch (e: any) {
    Zotero.debug(`[ChatPDF] getItemFromZoteroUri: getURIItem failed: ${e.message}`);
  }

  return null;
}

function creatorName(creator: any): string {
  return creator.name || [creator.firstName, creator.lastName].filter(Boolean).join(" ") || creator.lastName || "";
}

export function getItemCreators(item: Zotero.Item): string[] {
  try {
    return ((item as any).getCreators?.() || [])
      .map(creatorName)
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function getItemYear(item: Zotero.Item): string | undefined {
  const raw = String(item.getField("date") || "");
  const match = raw.match(/\b(17|18|19|20)\d{2}\b/);
  return match?.[0];
}

export function getItemType(item: Zotero.Item): string | undefined {
  const anyItem = item as any;
  return anyItem.itemType || anyItem.getItemType?.() || undefined;
}

function getItemTags(item: Zotero.Item): string[] {
  try {
    return ((item as any).getTags?.() || [])
      .map((tag: any) => typeof tag === "string" ? tag : tag.tag)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function annotationSourceItems(annotation: Zotero.Item): {
  attachment?: Zotero.Item;
  bibliographic?: Zotero.Item;
} {
  const attachment = annotation.parentItem;
  const bibliographic = attachment?.parentItem;
  return { attachment, bibliographic };
}

export function summarizeZoteroAnnotation(annotation: Zotero.Item): ZoteroAnnotationSummary {
  const { attachment, bibliographic } = annotationSourceItems(annotation);
  const source = bibliographic || attachment || annotation.topLevelItem || annotation;
  const title = String(source.getField("title") || getItemTitle(source) || "Untitled");

  return {
    key: annotation.key,
    libraryID: annotation.libraryID,
    type: String(annotation.annotationType || "unknown"),
    text: annotation.annotationText || undefined,
    comment: annotation.annotationComment || undefined,
    color: annotation.annotationColor || undefined,
    pageLabel: annotation.annotationPageLabel || undefined,
    dateModified: annotation.dateModified || undefined,
    tags: getItemTags(annotation),
    attachmentKey: attachment?.key,
    itemKey: bibliographic?.key,
    title,
    creators: getItemCreators(source),
    year: getItemYear(source),
  };
}

function getItemCollectionNames(item: Zotero.Item): string[] {
  return getItemCollections(item).map((collection) => collection.name);
}

function summarizeCollection(collection: any): ZoteroCollectionSummary {
  const maybeChildren = typeof collection.getChildItems === "function" ? collection.getChildItems() : undefined;
  const itemCount = Array.isArray(maybeChildren) ? maybeChildren.length : undefined;
  return {
    key: collection.key,
    libraryID: collection.libraryID,
    name: collection.name || "Untitled Collection",
    parentKey: collection.parentKey,
    itemCount,
  };
}

export function getItemCollections(item: Zotero.Item): ZoteroCollectionSummary[] {
  try {
    return ((item as any).getCollections?.() || [])
      .map((id: number) => (Zotero.Collections as any).get(id))
      .filter(Boolean)
      .map(summarizeCollection);
  } catch {
    return [];
  }
}

export function summarizeZoteroItem(item: Zotero.Item): ZoteroItemSummary {
  const parent = item.isRegularItem?.() ? item : item.parentItem;
  const source = parent || item;
  const pdf = getPdfAttachment(item) || (parent ? getPdfAttachment(parent) : null);
  const abstractNote = String(source.getField("abstractNote") || "");

  return {
    key: source.key || item.key,
    libraryID: (source as any).libraryID || (item as any).libraryID,
    title: getItemTitle(item),
    creators: getItemCreators(source),
    year: getItemYear(source),
    itemType: getItemType(source),
    abstractNote: abstractNote || undefined,
    tags: getItemTags(source),
    collections: getItemCollectionNames(source),
    hasPdf: !!pdf,
    pdfKey: pdf?.key,
    parentKey: parent?.key,
  };
}

export async function addZoteroItemToSession(item: Zotero.Item, session: ChatSession): Promise<{ sourceKey?: string; message: string }> {
  const pdf = getPdfAttachment(item);
  if (!pdf) {
    return { message: `Error: "${getItemTitle(item)}" has no PDF attachment available.` };
  }

  const key = pdf.key;
  const libraryID = Number((pdf as any).libraryID || (item as any).libraryID) || undefined;
  const title = getItemTitle(item);
  const parentKey: string | undefined = item.isRegularItem?.()
    ? item.key
    : (item.parentItem?.key || pdf.parentItem?.key || undefined);
  const existing = session.getSource(key, libraryID);
  const source = session.addSource(key, title, parentKey, libraryID);

  if (await MDCache.has(source.cacheKey, key)) {
    const md = await MDCache.read(source.cacheKey, key);
    session.setSourceReady(source.id, md);
  }

  return {
    sourceKey: source.id,
    message: existing
      ? `Already in this chat session: "${source.title}" (source key: ${key}, status: ${source.status}).`
      : `Added to this chat session: "${source.title}" (source key: ${key}, status: ${source.status}).`,
  };
}

export async function getAllLibraryItems(): Promise<Zotero.Item[]> {
  const all: Zotero.Item[] = [];
  for (const lib of Zotero.Libraries.getAll()) {
    try {
      const maybeItems = (Zotero.Items as any).getAll?.(lib.libraryID, true, false);
      const items = typeof maybeItems?.then === "function" ? await maybeItems : maybeItems;
      if (Array.isArray(items)) all.push(...items);
    } catch (e: any) {
      Zotero.debug(`[ChatPDF] getAllLibraryItems failed for lib ${lib.libraryID}: ${e.message}`);
    }
  }

  return uniqueByKey(
    all.filter((item) => {
      if (!item || (item as any).deleted) return false;
      if (item.isRegularItem?.()) return true;
      return item.isPDFAttachment?.() && !item.parentItem;
    }),
    (item) => `${(item as any).libraryID || ""}:${item.key}`,
  );
}

function annotationsForItem(item: Zotero.Item): Zotero.Item[] {
  if (item.isAnnotation?.()) return [item];

  if (item.isRegularItem?.()) {
    const annotations: Zotero.Item[] = [];
    for (const attachmentID of item.getAttachments()) {
      const attachment = Zotero.Items.get(attachmentID);
      if (attachment) annotations.push(...(attachment.getAnnotations?.(false) || []));
    }
    return annotations;
  }

  return item.getAnnotations?.(false) || [];
}

export async function getAllAnnotations(itemKey?: string, libraryID?: number): Promise<Zotero.Item[]> {
  const normalizedKey = String(itemKey || "").trim();
  if (normalizedKey) {
    const item = getItemByKey(normalizedKey, libraryID);
    if (!item) return [];
    return uniqueByKey(
      annotationsForItem(item).filter((annotation) => !annotation.deleted),
      (annotation) => `${annotation.libraryID}:${annotation.key}`,
    );
  }

  const annotations: Zotero.Item[] = [];
  for (const lib of Zotero.Libraries.getAll()) {
    if (libraryID !== undefined && lib.libraryID !== libraryID) continue;
    try {
      const maybeItems = Zotero.Items.getAll(lib.libraryID, false, false);
      const items = typeof (maybeItems as any)?.then === "function" ? await maybeItems : maybeItems;
      if (Array.isArray(items)) {
        annotations.push(...items.filter((item) => item?.isAnnotation?.() && !item.deleted));
      }
    } catch (e: any) {
      Zotero.debug(`[ChatPDF] getAllAnnotations failed for lib ${lib.libraryID}: ${e.message}`);
    }
  }

  return uniqueByKey(annotations, (annotation) => `${annotation.libraryID}:${annotation.key}`);
}

export async function getAllCollections(): Promise<ZoteroCollectionSummary[]> {
  const collections: any[] = [];
  for (const lib of Zotero.Libraries.getAll()) {
    try {
      const maybeCollections = (Zotero.Collections as any).getAll?.(lib.libraryID);
      const items = typeof maybeCollections?.then === "function" ? await maybeCollections : maybeCollections;
      if (Array.isArray(items)) collections.push(...items);
    } catch (e: any) {
      Zotero.debug(`[ChatPDF] getAllCollections failed for lib ${lib.libraryID}: ${e.message}`);
    }
  }

  const direct = uniqueByKey(collections, (collection) => `${collection.libraryID || ""}:${collection.key}`)
    .map(summarizeCollection);
  if (direct.length > 0) return direct;

  const discovered: ZoteroCollectionSummary[] = [];
  for (const item of await getAllLibraryItems()) {
    discovered.push(...getItemCollections(item));
  }
  return uniqueByKey(discovered, (collection) => `${collection.libraryID || ""}:${collection.key}`);
}

export async function openPdfForSourceKey(key: string, libraryID?: number): Promise<boolean> {
  const item = getItemByKey(key, libraryID);
  if (!item) return false;
  const pdf = getPdfAttachment(item);
  if (!pdf) return false;

  try {
    const pane = (Zotero as any).getActiveZoteroPane?.() || (Zotero.getMainWindows()[0] as any)?.ZoteroPane;
    if (pane?.viewPDF) {
      await pane.viewPDF((pdf as any).id, {});
      return true;
    }
  } catch (e: any) {
    Zotero.debug(`[ChatPDF] openPdfForSourceKey: viewPDF failed for ${key}: ${e.message}`);
  }

  try {
    const pane = (Zotero as any).getActiveZoteroPane?.() || (Zotero.getMainWindows()[0] as any)?.ZoteroPane;
    if (pane?.selectItem) {
      pane.selectItem((pdf as any).id);
      return true;
    }
  } catch (e: any) {
    Zotero.debug(`[ChatPDF] openPdfForSourceKey: selectItem failed for ${key}: ${e.message}`);
  }

  return false;
}
