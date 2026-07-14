import { getCacheDir, ensureDir } from "../utils/cache-dir";
import { error as logError } from "../utils/log";
import { atomicWriteJson, withStorageLock } from "../utils/atomic-storage";

export interface SavedSource {
  id: string;
  key: string;
  libraryID?: number;
  cacheKey: string;
  title: string;
  parentKey?: string;
  status: "pending" | "converting" | "ready" | "error";
  errorMessage?: string;
}

export interface SavedSession {
  schemaVersion?: number;
  id: string;
  title: string;
  titleSource?: "auto" | "llm" | "user";
  sourceKeys: string[];
  sourceTitles: string[];
  sourceParentKeys?: string[];
  referencedParentKeys?: string[];
  sources?: SavedSource[];
  messages: { role: string; content: string; reasoning?: string; timestamp?: number; sources?: { id?: string; key: string; libraryID?: number; title: string; parentKey?: string }[]; modelLabel?: string; toolHistory?: any[]; iterations?: any[]; usage?: any; status?: "complete" | "cancelled" | "error"; errorMessage?: string }[];
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

/** Prevent a late background save from resurrecting a session deleted in this runtime. */
const deletedSessionIds = new Set<string>();

function getHistoryDir(): string {
  return PathUtils.join(getCacheDir(), "history");
}

function getSessionPath(id: string): string {
  return PathUtils.join(getHistoryDir(), `${id}.json`);
}

function getIndexPath(): string {
  return PathUtils.join(getHistoryDir(), "_index.json");
}

function toMeta(session: SavedSession): SessionMeta {
  return {
    id: session.id,
    title: session.title,
    titleSource: session.titleSource,
    sourceTitles: session.sourceTitles || session.sources?.map((source) => source.title) || [],
    referencedParentKeys: session.referencedParentKeys,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

async function ensureHistoryDir(): Promise<void> {
  await ensureDir(getHistoryDir());
}

export async function saveSession(session: SavedSession): Promise<void> {
  await withStorageLock("chat-history", async () => {
    if (deletedSessionIds.has(session.id)) return;
    await ensureHistoryDir();
    await atomicWriteJson(getSessionPath(session.id), session);

    const index = await loadIndex();
    const existing = index.findIndex((m) => m.id === session.id);
    const meta = toMeta(session);
    if (existing >= 0) index[existing] = meta;
    else index.push(meta);
    await saveIndex(index);
  });
}

export async function loadSession(id: string): Promise<SavedSession | null> {
  if (deletedSessionIds.has(id)) return null;
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
  deletedSessionIds.add(id);
  await withStorageLock("chat-history", async () => {
    const path = getSessionPath(id);
    if (await IOUtils.exists(path)) await IOUtils.remove(path);
    const index = await loadIndex();
    await saveIndex(index.filter((m) => m.id !== id));
  });
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
  await atomicWriteJson(getIndexPath(), sessions);
}

async function loadIndex(): Promise<SessionMeta[]> {
  const path = getIndexPath();
  if (!(await IOUtils.exists(path))) return rebuildIndex();
  try {
    const bytes = await IOUtils.read(path);
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json) as SessionMeta[];
  } catch (err: any) {
    logError("history", "loadIndex failed", err);
    return rebuildIndex();
  }
}

async function rebuildIndex(): Promise<SessionMeta[]> {
  await ensureHistoryDir();
  const children = await (IOUtils as any).getChildren?.(getHistoryDir()) || [];
  const metas: SessionMeta[] = [];
  for (const path of children as string[]) {
    if (!/\.json$/i.test(path) || path.endsWith("_index.json") || path.includes(".tmp-")) continue;
    try {
      const bytes = await IOUtils.read(path);
      const session = JSON.parse(new TextDecoder().decode(bytes)) as SavedSession;
      if (session?.id && !deletedSessionIds.has(session.id)) metas.push(toMeta(session));
    } catch (error: any) {
      logError("history", `Skipping unreadable session file ${path}`, error);
    }
  }
  await saveIndex(metas);
  return metas;
}
