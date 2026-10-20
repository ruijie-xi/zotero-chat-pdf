import packageJson from "../../package.json";
import { throwIfAborted } from "../utils/abort";

interface SourceFile { path: string; bytes: number; sha256: string; line_count: number; content: string }
interface SourceSnapshot {
  schema_version: number; version: string; build_time: string; snapshot_sha256: string; files: SourceFile[];
}

import { PLUGIN_SOURCE_TOOLS } from "./tool-registry";
export { PLUGIN_SOURCE_TOOLS } from "./tool-registry";

let snapshotPromise: Promise<SourceSnapshot> | undefined;
function sourcePath(value: unknown): value is string {
  return typeof value === "string" && /^(?:src\/[\w/-]+\.ts|scripts\/[\w/-]+\.mjs|addon\/[\w/-]+\.(?:js|css|html|xhtml|ftl)|package\.json|zotero-plugin\.config\.ts|docs\/(?:agent-capabilities|llm-workflow)\.md)$/.test(value);
}

async function loadSnapshot(): Promise<SourceSnapshot> {
  return snapshotPromise ||= (async () => {
    // A fixed chrome resource only: caller-supplied paths never enter a URL or file API.
    const response = await fetch(`chrome://${packageJson.config.addonRef}/content/source-snapshot.json`);
    if (!response.ok) throw new Error("Bundled plugin source snapshot is unavailable. Install a build that includes it.");
    const snapshot = await response.json() as unknown as SourceSnapshot;
    if (snapshot.schema_version !== 1 || snapshot.version !== packageJson.version
      || typeof snapshot.build_time !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.snapshot_sha256)
      || !Array.isArray(snapshot.files)) throw new Error("Invalid or mismatched plugin source snapshot.");
    const paths = new Set<string>();
    for (const file of snapshot.files) {
      if (!sourcePath(file.path) || paths.has(file.path) || typeof file.content !== "string"
        || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
        || file.line_count !== file.content.split(/\r?\n/).length) throw new Error("Invalid plugin source file entry.");
      paths.add(file.path);
    }
    return snapshot;
  })().catch(error => { snapshotPromise = undefined; throw error; });
}

function integer(value: unknown, fallback: number, minimum: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}.`);
  return value;
}

function findFile(snapshot: SourceSnapshot, path: unknown): SourceFile {
  if (!sourcePath(path)) throw new Error("path must be an exact bundled file path from list_plugin_source.");
  const file = snapshot.files.find(file => file.path === path);
  if (!file) throw new Error("File is not in the installed plugin source snapshot.");
  return file;
}

export async function executePluginSourceTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string | null> {
  if (!PLUGIN_SOURCE_TOOLS.some(tool => tool.function.name === name)) return null;
  throwIfAborted(signal);
  const snapshot = await loadSnapshot();
  throwIfAborted(signal);
  const build = { version: snapshot.version, build_time: snapshot.build_time, snapshot_sha256: snapshot.snapshot_sha256 };
  if (name === "list_plugin_source") {
    if (args.path_prefix !== undefined && typeof args.path_prefix !== "string") throw new Error("path_prefix must be a string.");
    return JSON.stringify({ build, files: snapshot.files.filter(file => !args.path_prefix || file.path.startsWith(args.path_prefix as string))
      .map(({ content: _content, ...metadata }) => metadata) });
  }
  if (name === "read_plugin_source") {
    const file = findFile(snapshot, args.path);
    const start = integer(args.start_line, 1, 1, "start_line"), end = integer(args.end_line, file.line_count, 1, "end_line");
    if (start > end || end > file.line_count) throw new Error(`Line range must be within 1-${file.line_count}, with start_line <= end_line.`);
    return JSON.stringify({ build, path: file.path, sha256: file.sha256, total_lines: file.line_count,
      start_line: start, end_line: end, lines: file.content.split(/\r?\n/).slice(start - 1, end).map((text, i) => ({ line: start + i, text })) });
  }
  if (typeof args.query !== "string" || !args.query.trim()) throw new Error("query must be a non-empty string.");
  const files = args.path === undefined ? snapshot.files : [findFile(snapshot, args.path)];
  const query = args.query.toLowerCase(), start = integer(args.start, 0, 0, "start"), size = integer(args.page_size, 20, 1, "page_size");
  const matches: { path: string; line: number; text: string }[] = [];
  for (const file of files) {
    throwIfAborted(signal);
    file.content.split(/\r?\n/).forEach((text, i) => { if (text.toLowerCase().includes(query)) matches.push({ path: file.path, line: i + 1, text }); });
  }
  const end = Math.min(matches.length, start + size);
  return JSON.stringify({ build, query: args.query, total_matches: matches.length, start,
    matches: matches.slice(start, end), next_start: end < matches.length ? end : null });
}
