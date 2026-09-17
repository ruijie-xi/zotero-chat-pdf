import type { ChatSession, SourceItem } from "./chat-session";
import { getDocDir } from "./md-cache";
import { atomicWrite } from "../utils/atomic-storage";
import { sourceCacheKey } from "./source-identity";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TURN_IMAGE_BYTES = 20 * 1024 * 1024;
export const IMAGE_INPUT_HELP = "PNG, JPEG or WebP; up to 10 MiB per image and 20 MiB per turn. Requires a vision-capable model. Images are sent to your configured LLM provider when read.";

export interface ImageInput {
  sourceId: string;
  path: string;
  mime: string;
  byteLength: number;
  dataUrl: string;
}

export function checkImageSize(size: number): void {
  if (!Number.isFinite(size) || size <= 0 || size > MAX_IMAGE_BYTES) {
    throw new Error("Images must be non-empty and at most 10 MiB. Resize the image before adding or reading it.");
  }
}

export function imageMime(bytes: Uint8Array): string {
  checkImageSize(bytes.length);
  if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 16 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  throw new Error("Unsupported image content. Use PNG, JPEG or WebP (SVG and GIF are not supported).");
}

export function safeImagePath(path: string): string[] {
  const parts = path.split("/");
  if (!path || parts.some((part) => !part || part === "." || part === ".." || /[\\:\x00-\x1f]/.test(part) || /[. ]$/.test(part))) {
    throw new Error("Image path must be a relative path inside this source's cache.");
  }
  return parts;
}

function imageRoot(source: Pick<SourceItem, "cacheKey">): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(source.cacheKey) || source.cacheKey.includes("..")) {
    throw new Error("Invalid image source cache key.");
  }
  return getDocDir(source.cacheKey);
}

/** Never follow links out of a source cache, including intermediate directories. */
async function checkedPath(source: SourceItem, relative: string): Promise<string> {
  const root = imageRoot(source);
  let path = PathUtils.parent(root)!;
  for (const part of [PathUtils.filename(root), ...safeImagePath(relative)]) {
    path = PathUtils.join(path, part);
    if (Zotero.File.pathToFile(path).isSymlink()) throw new Error("Linked image cache paths are not allowed.");
  }
  return path;
}

export async function importImage(
  session: ChatSession, bytes: Uint8Array, title: string,
  identity?: { key: string; libraryID?: number; parentKey?: string },
  isCurrent: () => boolean = () => true,
): Promise<SourceItem> {
  imageMime(bytes);
  const key = identity?.key || `image-${crypto.randomUUID()}`;
  // Publish the source only after the atomic file write has completed.
  const cacheKey = sourceCacheKey({ key, libraryID: identity?.libraryID });
  await atomicWrite(PathUtils.join(imageRoot({ cacheKey }), "image.bin"), bytes);
  if (!isCurrent()) {
    const error = new Error("The destination chat changed while the image was being added.");
    error.name = "AbortError";
    throw error;
  }
  const source = session.addSource(key, title, identity?.parentKey, identity?.libraryID);
  source.kind = "image";
  source.status = "ready";
  source.errorMessage = undefined;
  return source;
}

export async function readImageFile(path: string): Promise<Uint8Array> {
  checkImageSize((await IOUtils.stat(path)).size ?? 0);
  const bytes = await IOUtils.read(path, { maxBytes: MAX_IMAGE_BYTES + 1 });
  imageMime(bytes);
  return bytes;
}

export async function listSourceImages(source: SourceItem, signal?: AbortSignal): Promise<string[]> {
  if (source.kind === "image") return ["image.bin"];
  const result: string[] = [];
  const root = imageRoot(source);
  if (!await IOUtils.exists(root)) return result;
  const visit = async (relative: string) => {
    signal?.throwIfAborted();
    const path = relative ? await checkedPath(source, relative) : root;
    if (Zotero.File.pathToFile(path).isSymlink()) return;
    for (const child of await IOUtils.getChildren(path)) {
      signal?.throwIfAborted();
      if (Zotero.File.pathToFile(child).isSymlink()) continue;
      const name = PathUtils.filename(child);
      const entry = relative ? `${relative}/${name}` : name;
      const stat = await IOUtils.stat(child);
      if (stat.type === "directory") await visit(entry);
      else if (stat.type === "regular" && /\.(png|jpe?g|webp)$/i.test(name)) result.push(entry);
    }
  };
  await visit("");
  return result.sort();
}

export async function readSourceImage(source: SourceItem, relative?: string, signal?: AbortSignal): Promise<ImageInput> {
  signal?.throwIfAborted();
  const path = relative || (source.kind === "image" ? "image.bin" : "");
  if (source.kind === "image" && path !== "image.bin") throw new Error("This source contains only image.bin.");
  if (source.kind !== "image" && !/\.(png|jpe?g|webp)$/i.test(path)) throw new Error("Use an image path returned by list_images.");
  const bytes = await readImageFile(await checkedPath(source, path));
  signal?.throwIfAborted();
  const mime = imageMime(bytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { sourceId: source.id, path, mime, byteLength: bytes.length, dataUrl: `data:${mime};base64,${(Zotero.getMainWindow() as any).btoa(binary)}` };
}
