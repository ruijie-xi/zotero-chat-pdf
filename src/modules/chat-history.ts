import { getCacheDir, ensureDir } from "../utils/cache-dir";
import { error as logError } from "../utils/log";
import { atomicWrite, atomicWriteJson, withStorageLock } from "../utils/atomic-storage";
import type { AgentContextData } from "./agent-context";

export interface SavedSource {
  kind?: "image";
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
  /** Provider usage from session-owned LLM calls outside assistant turns, such as title generation. */
  auxiliaryUsage?: any;
  agentContext?: AgentContextData;
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
  messageCount?: number;
  /** UI pinning belongs to the index, so background session saves cannot reset it. */
  pinned?: boolean;
}

/** Prevent a late background save from resurrecting a session deleted in this runtime. */
const deletedSessionIds = new Set<string>();
const canonicalSessionIds = new Set<string>();

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
    sourceTitles: [...new Set([...(session.sourceTitles || session.sources?.map(source => source.title) || []),
      ...(session.messages || []).flatMap(message => message.sources?.map(source => source.title) || [])])].filter(Boolean),
    referencedParentKeys: session.referencedParentKeys,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages?.filter(message => message.role === "user" || message.role === "assistant").length || 0,
  };
}

async function ensureHistoryDir(): Promise<void> {
  await ensureDir(getHistoryDir());
}

export async function saveSession(session: SavedSession): Promise<void> {
  await withStorageLock("chat-history", async () => {
    if (deletedSessionIds.has(session.id)) return;
    await ensureHistoryDir();
    const path = getSessionPath(session.id);
    if (!canonicalSessionIds.has(session.id) && (session.schemaVersion || 0) >= 4 && await IOUtils.exists(path)) {
      const bytes = await IOUtils.read(path);
      const previous = JSON.parse(new TextDecoder().decode(bytes)) as SavedSession;
      if ((previous.schemaVersion || 0) < 4) {
        const backup = PathUtils.join(getHistoryDir(), "migration-backups", `${session.id}.pre-v4.json`);
        if (!(await IOUtils.exists(backup))) await atomicWrite(backup, bytes);
      }
    }
    await atomicWriteJson(getSessionPath(session.id), session);
    if ((session.schemaVersion || 0) >= 4) canonicalSessionIds.add(session.id);

    const index = await loadIndex();
    const existing = index.findIndex((m) => m.id === session.id);
    const meta = toMeta(session);
    if (existing >= 0) index[existing] = { ...meta, pinned: index[existing].pinned };
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
  const session = JSON.parse(json) as SavedSession;
  if ((session.schemaVersion || 0) < 4) canonicalSessionIds.delete(id);
  return session;
}

export async function listSessions(): Promise<SessionMeta[]> {
  return withStorageLock("chat-history", async () => {
    const index = await loadIndex();
    let enriched = false;
    // Older indexes lack message counts. Read each old file once, without touching its content.
    for (const meta of index) {
      if (meta.messageCount !== undefined || deletedSessionIds.has(meta.id)) continue;
      try {
        const saved = await loadSession(meta.id);
        if (saved) { const recovered = toMeta(saved); meta.messageCount = recovered.messageCount; meta.sourceTitles = recovered.sourceTitles; enriched = true; }
      } catch (error: any) { logError("history", "Could not enrich history metadata", error); }
    }
    if (enriched) await saveIndex(index);
    return index.filter(meta => !deletedSessionIds.has(meta.id)).sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

export async function setSessionPinned(id: string, pinned: boolean): Promise<void> {
  await withStorageLock("chat-history", async () => {
    if (deletedSessionIds.has(id)) return;
    const index = await loadIndex();
    const meta = index.find(meta => meta.id === id);
    if (!meta) return;
    meta.pinned = pinned;
    await saveIndex(index);
  });
}

export async function deleteSession(id: string): Promise<void> {
  deletedSessionIds.add(id);
  await withStorageLock("chat-history", async () => {
    const path = getSessionPath(id);
    if (await IOUtils.exists(path)) await IOUtils.remove(path);
    const backup = PathUtils.join(getHistoryDir(), "migration-backups", `${id}.pre-v4.json`);
    if (await IOUtils.exists(backup)) await IOUtils.remove(backup);
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
