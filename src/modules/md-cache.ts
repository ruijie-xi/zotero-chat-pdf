import { getCacheDir, ensureDir } from "../utils/cache-dir";

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

export async function has(key: string): Promise<boolean> {
  return (await IOUtils.exists(getDocumentPath(key))) || IOUtils.exists(getFilePath(key));
}

export async function read(key: string): Promise<string> {
  const documentPath = getDocumentPath(key);
  const path = await IOUtils.exists(documentPath) ? documentPath : getFilePath(key);
  const bytes = await IOUtils.read(path);
  return new TextDecoder().decode(bytes);
}

export async function write(key: string, content: string): Promise<void> {
  await ensureDir(getDocDir(key));
  const path = getDocumentPath(key);
  await IOUtils.write(path, new TextEncoder().encode(content));
}

export async function hasManifest(key: string): Promise<boolean> {
  return IOUtils.exists(getManifestPath(key));
}

export async function readManifest(key: string): Promise<DocumentManifest | null> {
  const path = getManifestPath(key);
  if (!(await IOUtils.exists(path))) return null;
  const bytes = await IOUtils.read(path);
  return JSON.parse(new TextDecoder().decode(bytes)) as DocumentManifest;
}

export async function writeManifest(key: string, manifest: DocumentManifest): Promise<void> {
  const dir = getDocDir(key);
  await ensureDir(dir);
  const path = getManifestPath(key);
  await IOUtils.write(path, new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
}

export async function readChunk(key: string, index: number): Promise<string> {
  const bytes = await IOUtils.read(getChunkPath(key, index));
  return new TextDecoder().decode(bytes);
}

export async function writeChunk(key: string, index: number, content: string): Promise<void> {
  await ensureDir(PathUtils.join(getDocDir(key), "chunks"));
  await IOUtils.write(getChunkPath(key, index), new TextEncoder().encode(content));
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
