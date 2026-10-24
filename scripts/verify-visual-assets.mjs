import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Fail the build if offline compiler/font assets are incomplete or changed. */
export async function verifyVisualAssets(root = process.cwd()) {
  const directory = join(root, "addon/content/visual/vendor/tikzjax");
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  for (const entry of manifest.files) {
    if (!/^[\w./-]+$/.test(entry.file) || entry.file.split("/").includes("..")) throw new Error("Invalid visual vendor manifest path");
    const bytes = await readFile(join(directory, entry.file));
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error(`Visual vendor integrity mismatch: ${entry.file}`);
  }
}
