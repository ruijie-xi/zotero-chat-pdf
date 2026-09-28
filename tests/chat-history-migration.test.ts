import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/utils/cache-dir", () => ({ getCacheDir: () => "/private-cache", ensureDir: vi.fn(async () => {}) }));
vi.mock("../src/utils/atomic-storage", () => ({
  withStorageLock: async (_: string, fn: () => Promise<void>) => fn(),
  atomicWrite: vi.fn(async () => {}), atomicWriteJson: vi.fn(async () => {}),
}));
import { atomicWrite, atomicWriteJson } from "../src/utils/atomic-storage";
import { saveSession } from "../src/modules/chat-history";
import { ChatSession } from "../src/modules/chat-session";
import { migrateDefaultPrompt, DEFAULT_SYSTEM_PROMPT_EN } from "../src/modules/prompts";

beforeEach(() => vi.clearAllMocks());
describe("one-way session migration", () => {
  it("backs up original bytes before the first canonical save and normalizes legacy tool history", async () => {
    const legacy = { id: "migration-test", title: "task", sourceKeys: [], sourceTitles: [], createdAt: 1, updatedAt: 2, schemaVersion: 3,
      messages: [{ role: "assistant", content: "partial", reasoning: "reason", status: "error" as const, toolHistory: [{ toolName: "read", args: {}, result: "whole evidence", durationMs: 1, contextDelivery: "omitted" }] }] };
    const bytes = new TextEncoder().encode(JSON.stringify(legacy, null, 3));
    Object.assign(IOUtils, { exists: vi.fn(async (path: string) => path.endsWith("migration-test.json") || path.endsWith("_index.json")),
      read: vi.fn(async (path: string) => path.endsWith("_index.json") ? new TextEncoder().encode("[]") : bytes) });
    const session = ChatSession.fromSavedSession(legacy);
    const canonical = session.toSavedSession();
    expect(canonical.messages[0].toolHistory).toBeUndefined();
    expect(canonical.messages[0].iterations?.[0]).toMatchObject({ reasoning: "reason", toolCalls: [{ result: "whole evidence", contextDelivery: "omitted" }] });
    expect(canonical.messages[0].status).toBe("error");
    await saveSession(canonical);
    expect(atomicWrite).toHaveBeenCalledWith("/private-cache/history/migration-backups/migration-test.pre-v4.json", bytes);
    expect(vi.mocked(atomicWrite).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(atomicWriteJson).mock.invocationCallOrder[0]);
  });
  it("does not overwrite a session when its migration backup fails", async () => {
    Object.assign(IOUtils, { exists: vi.fn(async (path: string) => path.endsWith("backup-failure.json")), read: vi.fn(async () => new TextEncoder().encode('{"schemaVersion":3}')) });
    vi.mocked(atomicWrite).mockRejectedValueOnce(new Error("disk full"));
    const session = new ChatSession(); session.id = "backup-failure";
    await expect(saveSession(session.toSavedSession())).rejects.toThrow("disk full");
    expect(atomicWriteJson).not.toHaveBeenCalled();
  });
  it("migrates exact old defaults but preserves user modifications", () => {
    const old = DEFAULT_SYSTEM_PROMPT_EN.replace("Use tools to inspect relevant documents and evidence.", "Answer questions based on the following document(s).");
    expect(migrateDefaultPrompt(old)).toBe(DEFAULT_SYSTEM_PROMPT_EN);
    expect(migrateDefaultPrompt(old + " Custom requirement.")).toBe(old + " Custom requirement.");
  });
});
