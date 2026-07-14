/** Stable identity for a Zotero item or attachment across personal/group libraries. */
export interface SourceIdentity {
  key: string;
  libraryID?: number;
}

const QUALIFIED_ID = /^(\d+):(.+)$/;

export function makeSourceId(key: string, libraryID?: number): string {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) throw new Error("Source key is required");
  return libraryID === undefined ? normalizedKey : `${libraryID}:${normalizedKey}`;
}

export function parseSourceId(value: string, fallbackLibraryID?: number): SourceIdentity {
  const normalized = String(value || "").trim();
  const match = QUALIFIED_ID.exec(normalized);
  if (match) {
    return { libraryID: Number(match[1]), key: match[2] };
  }
  return { key: normalized, libraryID: fallbackLibraryID };
}

/** Windows-safe cache directory name. Legacy sources keep their original key. */
export function sourceCacheKey(identity: SourceIdentity): string {
  const key = String(identity.key || "").replace(/[^A-Za-z0-9._-]/g, "_");
  return identity.libraryID === undefined ? key : `${identity.libraryID}-${key}`;
}
