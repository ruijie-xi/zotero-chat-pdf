import { getPref } from "./prefs";

/** Get the root cache directory, reading from the cacheDir pref or falling back to ~/.chatpdf-cache/. */
export function getCacheDir(): string {
  const custom = getPref("cacheDir");
  if (custom) return custom;
  const home =
    Services.dirsvc.get("Home", Components.interfaces.nsIFile).path;
  return PathUtils.join(home, ".chatpdf-cache");
}

/** Ensure a directory exists, creating it (and parents) if necessary. */
export async function ensureDir(path: string): Promise<void> {
  if (!(await IOUtils.exists(path))) {
    await IOUtils.makeDirectory(path, { createAncestors: true });
  }
}
