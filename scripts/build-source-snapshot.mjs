import { createHash } from "node:crypto";
import { lstat, readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const hash = value => createHash("sha256").update(value).digest("hex");
const ownAsset = path => /^addon\/(?:bootstrap\.js|prefs\.js|content\/[\w/-]+\.(?:js|css|html|xhtml)|locale\/[\w-]+\/[\w-]+\.ftl)$/.test(path)
  && !/\/(?:katex|tokenizers)(?:[/.]|$)/.test(path);

/** Only project-owned code and two architecture documents; never follow symlinks. */
export async function createSourceSnapshot(root, version, buildTime) {
  const paths = [];
  async function walk(directory, accepts) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Source snapshot rejects symlink: ${path}`);
      if (entry.isDirectory()) await walk(path, accepts);
      else if (entry.isFile() && accepts(path)) paths.push(path);
    }
  }
  if (!(await lstat(join(root, "docs"))).isDirectory()) throw new Error("Invalid source directory: docs");
  for (const directory of ["src", "addon", "scripts"]) {
    if (!(await lstat(join(root, directory))).isDirectory()) throw new Error(`Invalid source directory: ${directory}`);
    await walk(directory, path => directory === "src" ? path.endsWith(".ts")
      : directory === "scripts" ? path.endsWith(".mjs") : ownAsset(path));
  }
  paths.push("package.json", "zotero-plugin.config.ts", "docs/agent-capabilities.md", "docs/llm-workflow.md");
  const files = [];
  for (const path of paths.sort()) {
    const stat = await lstat(join(root, path));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid source file: ${path}`);
    const bytes = await readFile(join(root, path));
    const content = bytes.toString("utf8");
    files.push({ path, bytes: bytes.length, sha256: hash(bytes), line_count: content.split(/\r?\n/).length, content });
  }
  return { schema_version: 1, version, build_time: buildTime,
    snapshot_sha256: hash(files.map(file => `${file.path}\0${file.sha256}\n`).join("")), files };
}

export async function writeSourceSnapshot(context) {
  const snapshot = await createSourceSnapshot(process.cwd(), context.version, context.templateData.buildTime);
  const directory = join(context.dist, "addon", "content");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "source-snapshot.json"), JSON.stringify(snapshot));
}
