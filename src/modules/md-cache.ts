import { getPref } from "../utils/prefs";

function getCacheDir(): string {
  const custom = getPref("cacheDir");
  if (custom) {
    return custom;
  }
  // Default: ~/.chatpdf-cache/
  const home =
    Services.dirsvc.get("Home", Components.interfaces.nsIFile).path;
  return PathUtils.join(home, ".chatpdf-cache");
}

function getFilePath(key: string): string {
  return PathUtils.join(getCacheDir(), `${key}.md`);
}

async function ensureCacheDir(): Promise<void> {
  const dir = getCacheDir();
  if (!(await IOUtils.exists(dir))) {
    await IOUtils.makeDirectory(dir, { createAncestors: true });
  }
}

export async function has(key: string): Promise<boolean> {
  return IOUtils.exists(getFilePath(key));
}

export async function read(key: string): Promise<string> {
  const path = getFilePath(key);
  const bytes = await IOUtils.read(path);
  return new TextDecoder().decode(bytes);
}

export async function write(key: string, content: string): Promise<void> {
  await ensureCacheDir();
  const path = getFilePath(key);
  await IOUtils.write(path, new TextEncoder().encode(content));
}

export async function clear(key?: string): Promise<void> {
  if (key) {
    const path = getFilePath(key);
    if (await IOUtils.exists(path)) {
      await IOUtils.remove(path);
    }
  } else {
    const dir = getCacheDir();
    if (await IOUtils.exists(dir)) {
      await IOUtils.remove(dir, { recursive: true });
    }
  }
}
