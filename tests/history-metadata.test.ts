import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ files: new Map<string, Uint8Array>() }));
vi.mock("../src/utils/cache-dir", () => ({ getCacheDir: () => "/cache", ensureDir: vi.fn() }));
vi.mock("../src/utils/atomic-storage", () => ({ withStorageLock: async (_key: string, task: () => Promise<unknown>) => task(),
  atomicWriteJson: async (path: string, value: unknown) => mocks.files.set(path, new TextEncoder().encode(JSON.stringify(value))), atomicWrite: vi.fn() }));
import { deleteSession, listSessions, saveSession, setSessionPinned, type SavedSession } from "../src/modules/chat-history";
const session = (id: string, messages: SavedSession["messages"] = []): SavedSession => ({ id, title: "Paper questions", sourceKeys: [], sourceTitles: ["Hamiltonian systems"], messages, createdAt: 1, updatedAt: 2 });
const store = (path: string, value: unknown) => mocks.files.set(path, new TextEncoder().encode(JSON.stringify(value)));
beforeEach(() => {
  mocks.files.clear(); store("/cache/history/_index.json", []);
  Object.assign(IOUtils, { exists: vi.fn(async (path: string) => mocks.files.has(path)), read: vi.fn(async (path: string) => mocks.files.get(path)!), remove: vi.fn(async (path: string) => mocks.files.delete(path)) });
});
describe("durable history metadata", () => {
  it("preserves a pin through background saves and a fresh index read", async () => {
    const value = session("pin-survives", [{ role: "user", content: "question" }]);
    await saveSession(value); await setSessionPinned(value.id, true);
    await saveSession({ ...value, title: "Updated title", updatedAt: 3 });
    expect((await listSessions())[0]).toMatchObject({ pinned: true, messageCount: 1, title: "Updated title" });
    await setSessionPinned(value.id, false); expect((await listSessions())[0].pinned).toBe(false);
  });
  it("enriches an older index only once and leaves session bytes unchanged", async () => {
    const value = session("old-index", [{ role: "assistant", content: "result", status: "cancelled", sources: [{ key: "OLD", title: "Previously removed paper" }] }]);
    store("/cache/history/old-index.json", value);
    const original = mocks.files.get("/cache/history/old-index.json");
    store("/cache/history/_index.json", [{ id: value.id, title: value.title, sourceTitles: value.sourceTitles, createdAt: 1, updatedAt: 2 }]);
    expect((await listSessions())[0]).toMatchObject({ messageCount: 1, sourceTitles: ["Hamiltonian systems", "Previously removed paper"] });
    await listSessions();
    expect(vi.mocked(IOUtils.read).mock.calls.filter(([path]) => path === "/cache/history/old-index.json")).toHaveLength(1);
    expect(mocks.files.get("/cache/history/old-index.json")).toBe(original);
  });
  it("does not resurrect deleted chats through a late pin or session save", async () => {
    const value = session("deleted-pin"); await saveSession(value); await deleteSession(value.id);
    await setSessionPinned(value.id, true); await saveSession(value);
    expect(await listSessions()).toEqual([]);
  });
});
