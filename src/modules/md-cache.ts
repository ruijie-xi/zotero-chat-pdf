import { getCacheDir, ensureDir } from "../utils/cache-dir";
import { atomicWriteJson, atomicWriteText, withStorageLock } from "../utils/atomic-storage";

export interface DocumentChunkMeta {
  index: number;
  startPage: number;
  endPage: number;
  status: "pending" | "ready" | "error";
  lineStart?: number;
  lineEnd?: number;
  charCount?: number;
  assetCount?: number;
  errorMessage?: string;
}

export interface DocumentManifest {
  version: number;
  key: string;
  documentId?: string;
  libraryID?: number;
  libraryType?: "user" | "group";
  libraryId?: number;
  attachmentKey?: string;
  parentItemKey?: string;
  converter?: "mineru";
  title?: string;
  pageCount: number;
  chunkSize: number;
  chunks: DocumentChunkMeta[];
  updatedAt: number;
}

const documentsDir = () => PathUtils.join(getCacheDir(), "documents");
const legacyPath = (key: string) => PathUtils.join(getCacheDir(), `${key}.md`);
export const getDocDir = (key: string) => PathUtils.join(documentsDir(), key);
const documentPath = (key: string) => PathUtils.join(getDocDir(key), "document.md");
const manifestPath = (key: string) => PathUtils.join(getDocDir(key), "manifest.json");
const chunkPath = (key: string, index: number) => PathUtils.join(
  getDocDir(key), "chunks", `${String(index).padStart(4, "0")}.md`,
);

function safeJobId(jobId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId) || jobId.includes("..")) {
    throw new Error("Invalid conversion job ID");
  }
  return jobId;
}

const conversionRoot = () => PathUtils.join(getCacheDir(), "conversions");
export const getConversionRegistryPath = () => PathUtils.join(conversionRoot(), "jobs.json");
export const getConversionStagingDir = (jobId: string) => PathUtils.join(
  conversionRoot(), "staging", safeJobId(jobId),
);
const stagedChunkPath = (jobId: string, index: number) => PathUtils.join(
  getConversionStagingDir(jobId), "chunks", `${String(index).padStart(4, "0")}.md`,
);

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const path of paths) if (await IOUtils.exists(path)) return path;
  return null;
}

export async function has(key: string, legacyKey?: string): Promise<boolean> {
  return !!(await firstExisting([
    documentPath(key),
    legacyPath(key),
    ...(legacyKey ? [documentPath(legacyKey), legacyPath(legacyKey)] : []),
  ]));
}

export async function read(key: string, legacyKey?: string): Promise<string> {
  const path = await firstExisting([
    documentPath(key),
    legacyPath(key),
    ...(legacyKey ? [documentPath(legacyKey), legacyPath(legacyKey)] : []),
  ]) || documentPath(key);
  return new TextDecoder().decode(await IOUtils.read(path));
}

export async function write(key: string, content: string): Promise<void> {
  await atomicWriteText(documentPath(key), content);
}

export async function readManifest(key: string, legacyKey?: string): Promise<DocumentManifest | null> {
  const path = await firstExisting([
    manifestPath(key),
    ...(legacyKey ? [manifestPath(legacyKey)] : []),
  ]);
  if (!path) return null;
  return JSON.parse(new TextDecoder().decode(await IOUtils.read(path))) as DocumentManifest;
}

export async function writeManifest(key: string, manifest: DocumentManifest): Promise<void> {
  await atomicWriteJson(manifestPath(key), manifest);
}

export async function writeManifestForExistingDocument(
  key: string,
  legacyKey: string,
  manifest: DocumentManifest,
): Promise<void> {
  const target = !(await IOUtils.exists(documentPath(key))) && await IOUtils.exists(documentPath(legacyKey))
    ? legacyKey
    : key;
  await writeManifest(target, manifest);
}

export async function readChunk(key: string, index: number, legacyKey?: string): Promise<string> {
  const path = await firstExisting([
    chunkPath(key, index),
    ...(legacyKey ? [chunkPath(legacyKey, index)] : []),
  ]) || chunkPath(key, index);
  return new TextDecoder().decode(await IOUtils.read(path));
}

export async function writeChunk(key: string, index: number, content: string): Promise<void> {
  await atomicWriteText(chunkPath(key, index), content);
}

/** Seed one private job directory with any partial/ready cache, including its assets. */
export async function prepareConversionStaging(
  jobId: string,
  cacheKey?: string,
  legacyKey?: string,
): Promise<string> {
  const staging = getConversionStagingDir(jobId);
  if (await IOUtils.exists(staging)) return staging;
  const reusable = cacheKey
    ? await firstExisting([getDocDir(cacheKey), ...(legacyKey ? [getDocDir(legacyKey)] : [])])
    : null;
  await ensureDir(PathUtils.parent(staging)!);
  if (reusable) await (IOUtils.copy as any)(reusable, staging, { recursive: true });
  else await ensureDir(staging);
  return staging;
}

export async function readStagedChunks(jobId: string, indexes: number[]): Promise<Map<number, string>> {
  const chunks = new Map<number, string>();
  for (const index of indexes) {
    const path = stagedChunkPath(jobId, index);
    if (!await IOUtils.exists(path)) continue;
    try {
      chunks.set(index, new TextDecoder().decode(await IOUtils.read(path)));
    } catch (error: any) {
      Zotero.debug(`[ChatPDF] Failed to read staged chunk ${index}: ${error?.message || error}`);
    }
  }
  return chunks;
}

export async function writeStagedChunk(jobId: string, index: number, content: string): Promise<void> {
  await atomicWriteText(stagedChunkPath(jobId, index), content);
}

export async function finalizeStagedDocument(
  jobId: string,
  markdown: string,
  manifest: DocumentManifest,
): Promise<void> {
  const staging = getConversionStagingDir(jobId);
  await atomicWriteText(PathUtils.join(staging, "document.md"), markdown);
  await atomicWriteJson(PathUtils.join(staging, "manifest.json"), manifest);
  if (!await IOUtils.exists(PathUtils.join(staging, "document.md"))) {
    throw new Error("Staged document validation failed");
  }
}

/** Atomically install a complete staged directory, restoring the previous ready document on failure. */
export async function commitStagedDocument(jobId: string, cacheKey: string): Promise<void> {
  const staging = getConversionStagingDir(jobId);
  const canonical = getDocDir(cacheKey);
  const backup = `${canonical}.backup-${safeJobId(jobId)}`;
  if (!await IOUtils.exists(staging)) throw new Error("Conversion staging directory is missing");
  await ensureDir(documentsDir());
  await withStorageLock(`document:${cacheKey}`, async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (!await IOUtils.exists(canonical) && await IOUtils.exists(backup)) await IOUtils.move(backup, canonical);
      if (await IOUtils.exists(backup)) await IOUtils.remove(backup, { recursive: true });
      const hadCanonical = await IOUtils.exists(canonical);
      try {
        if (hadCanonical) await IOUtils.move(canonical, backup);
        await IOUtils.move(staging, canonical);
        if (hadCanonical && await IOUtils.exists(backup)) {
          await IOUtils.remove(backup, { recursive: true }).catch((error: any) => {
            Zotero.debug(`[ChatPDF] Could not remove document backup: ${error?.message || error}`);
          });
        }
        return;
      } catch (error) {
        lastError = error;
        if (!await IOUtils.exists(canonical) && await IOUtils.exists(backup)) await IOUtils.move(backup, canonical);
        if (attempt < 5) {
          await new Promise((resolve) => Zotero.getMainWindow().setTimeout(resolve, attempt * 150));
        }
      }
    }
    throw lastError;
  });
}

/** Repair only swap artifacts; normal reads never scan backup directories. */
export async function repairDocumentSwaps(): Promise<void> {
  if (!await IOUtils.exists(documentsDir())) return;
  for (const path of await IOUtils.getChildren(documentsDir())) {
    const name = PathUtils.filename(path);
    const marker = name.indexOf(".backup-");
    if (marker <= 0) continue;
    const canonical = PathUtils.join(documentsDir(), name.slice(0, marker));
    if (await IOUtils.exists(canonical)) await IOUtils.remove(path, { recursive: true }).catch(() => {});
    else await IOUtils.move(path, canonical).catch((error: any) => {
      Zotero.debug(`[ChatPDF] Failed to restore document backup: ${error?.message || error}`);
    });
  }
}

export async function removeConversionStaging(jobId: string): Promise<void> {
  const path = getConversionStagingDir(jobId);
  if (await IOUtils.exists(path)) await IOUtils.remove(path, { recursive: true }).catch(() => {});
}

export async function clear(key?: string): Promise<void> {
  if (key) {
    const old = legacyPath(key);
    if (await IOUtils.exists(old)) await IOUtils.remove(old);
    const dir = getDocDir(key);
    if (await IOUtils.exists(dir)) await IOUtils.remove(dir, { recursive: true });
  } else if (await IOUtils.exists(getCacheDir())) {
    await IOUtils.remove(getCacheDir(), { recursive: true });
  }
}
