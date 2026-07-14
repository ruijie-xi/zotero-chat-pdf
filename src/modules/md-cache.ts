import { getCacheDir, ensureDir } from "../utils/cache-dir";
import { atomicWriteJson, atomicWriteText } from "../utils/atomic-storage";

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
  title?: string;
  pageCount: number;
  chunkSize: number;
  chunks: DocumentChunkMeta[];
  updatedAt: number;
}

function getFilePath(key: string): string {
  return PathUtils.join(getCacheDir(), `${key}.md`);
}

export function getDocDir(key: string): string {
  return PathUtils.join(getCacheDir(), "documents", key);
}

function getDocumentPath(key: string): string {
  return PathUtils.join(getDocDir(key), "document.md");
}

function getManifestPath(key: string): string {
  return PathUtils.join(getDocDir(key), "manifest.json");
}

function getChunkPath(key: string, index: number): string {
  return PathUtils.join(getDocDir(key), "chunks", `${String(index).padStart(4, "0")}.md`);
}

export async function has(key: string, legacyKey?: string): Promise<boolean> {
  if ((await IOUtils.exists(getDocumentPath(key))) || await IOUtils.exists(getFilePath(key))) return true;
  return !!legacyKey && ((await IOUtils.exists(getDocumentPath(legacyKey))) || await IOUtils.exists(getFilePath(legacyKey)));
}

async function resolveDocumentPath(key: string, legacyKey?: string): Promise<string> {
  const candidates = [getDocumentPath(key), getFilePath(key)];
  if (legacyKey) candidates.push(getDocumentPath(legacyKey), getFilePath(legacyKey));
  for (const path of candidates) {
    if (await IOUtils.exists(path)) return path;
  }
  return getDocumentPath(key);
}

export async function read(key: string, legacyKey?: string): Promise<string> {
  const path = await resolveDocumentPath(key, legacyKey);
  const bytes = await IOUtils.read(path);
  return new TextDecoder().decode(bytes);
}

export async function write(key: string, content: string): Promise<void> {
  await ensureDir(getDocDir(key));
  await atomicWriteText(getDocumentPath(key), content);
}

export async function readManifest(key: string, legacyKey?: string): Promise<DocumentManifest | null> {
  let path = getManifestPath(key);
  if (!(await IOUtils.exists(path)) && legacyKey) path = getManifestPath(legacyKey);
  if (!(await IOUtils.exists(path))) return null;
  const bytes = await IOUtils.read(path);
  return JSON.parse(new TextDecoder().decode(bytes)) as DocumentManifest;
}

export async function writeManifest(key: string, manifest: DocumentManifest): Promise<void> {
  const dir = getDocDir(key);
  await ensureDir(dir);
  const path = getManifestPath(key);
  await atomicWriteJson(path, manifest);
}

export async function readChunk(key: string, index: number, legacyKey?: string): Promise<string> {
  let path = getChunkPath(key, index);
  if (!(await IOUtils.exists(path)) && legacyKey) path = getChunkPath(legacyKey, index);
  const bytes = await IOUtils.read(path);
  return new TextDecoder().decode(bytes);
}

export async function writeChunk(key: string, index: number, content: string): Promise<void> {
  await ensureDir(PathUtils.join(getDocDir(key), "chunks"));
  await atomicWriteText(getChunkPath(key, index), content);
}

export async function clear(key?: string): Promise<void> {
  if (key) {
    const path = getFilePath(key);
    if (await IOUtils.exists(path)) {
      await IOUtils.remove(path);
    }
    const dir = getDocDir(key);
    if (await IOUtils.exists(dir)) {
      await IOUtils.remove(dir, { recursive: true });
    }
  } else {
    const dir = getCacheDir();
    if (await IOUtils.exists(dir)) {
      await IOUtils.remove(dir, { recursive: true });
    }
  }
}
