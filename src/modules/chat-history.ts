import { getPref } from "../utils/prefs";

export interface SavedSession {
  id: string;
  title: string;
  titleSource?: "auto" | "llm" | "user";
  sourceKeys: string[];
  sourceTitles: string[];
  sourceParentKeys?: string[];
  referencedParentKeys?: string[];
  messages: { role: string; content: string; reasoning?: string; timestamp?: number; sources?: { key: string; title: string; parentKey?: string }[]; modelLabel?: string }[];
  createdAt: number;
  updatedAt: number;
}

export interface SessionMeta {
  id: string;
  title: string;
  titleSource?: "auto" | "llm" | "user";
  sourceTitles: string[];
  referencedParentKeys?: string[];
  createdAt: number;
  updatedAt: number;
}

function getCacheDir(): string {
  const custom = getPref("cacheDir");
  if (custom) return custom;
  const home =
    Services.dirsvc.get("Home", Components.interfaces.nsIFile).path;
  return PathUtils.join(home, ".chatpdf-cache");
}

function getHistoryDir(): string {
  return PathUtils.join(getCacheDir(), "history");
}

function getSessionPath(id: string): string {
  return PathUtils.join(getHistoryDir(), `${id}.json`);
}

function getIndexPath(): string {
  return PathUtils.join(getHistoryDir(), "_index.json");
}

async function ensureHistoryDir(): Promise<void> {
  const dir = getHistoryDir();
  if (!(await IOUtils.exists(dir))) {
    await IOUtils.makeDirectory(dir, { createAncestors: true });
  }
}

export async function saveSession(session: SavedSession): Promise<void> {
  await ensureHistoryDir();
  const path = getSessionPath(session.id);
  const json = JSON.stringify(session, null, 2);
  await IOUtils.write(path, new TextEncoder().encode(json));

  // Update index
  const index = await loadIndex();
  const existing = index.findIndex((m) => m.id === session.id);
  const meta: SessionMeta = {
    id: session.id,
    title: session.title,
    titleSource: session.titleSource,
    sourceTitles: session.sourceTitles,
    referencedParentKeys: session.referencedParentKeys,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
  if (existing >= 0) {
    index[existing] = meta;
  } else {
    index.push(meta);
  }
  await saveIndex(index);
}

export async function loadSession(id: string): Promise<SavedSession | null> {
  const path = getSessionPath(id);
  if (!(await IOUtils.exists(path))) return null;
  const bytes = await IOUtils.read(path);
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as SavedSession;
}

export async function listSessions(): Promise<SessionMeta[]> {
  const index = await loadIndex();
  // Sort by updatedAt descending
  return index.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteSession(id: string): Promise<void> {
  const path = getSessionPath(id);
  if (await IOUtils.exists(path)) {
    await IOUtils.remove(path);
  }
  // Update index
  const index = await loadIndex();
  const filtered = index.filter((m) => m.id !== id);
  await saveIndex(filtered);
}

export async function updateSessionTitle(id: string, title: string, titleSource: "auto" | "llm" | "user"): Promise<void> {
  const saved = await loadSession(id);
  if (!saved) return;
  saved.title = title;
  saved.titleSource = titleSource;
  await saveSession(saved);
}

async function saveIndex(sessions: SessionMeta[]): Promise<void> {
  await ensureHistoryDir();
  const path = getIndexPath();
  const json = JSON.stringify(sessions, null, 2);
  await IOUtils.write(path, new TextEncoder().encode(json));
}

async function loadIndex(): Promise<SessionMeta[]> {
  const path = getIndexPath();
  if (!(await IOUtils.exists(path))) return [];
  try {
    const bytes = await IOUtils.read(path);
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json) as SessionMeta[];
  } catch {
    return [];
  }
}
