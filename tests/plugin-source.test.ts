import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json";

const digest = "a".repeat(64);
const file = { path: "src/modules/example.ts", content: "first\r\nEnergy transfer\r\nenergy balance\r\nlast", bytes: 50, sha256: digest, line_count: 4 };
const snapshot = { schema_version: 1, version: packageJson.version, build_time: "test-build", snapshot_sha256: digest, files: [file] };
let fetchResource: ReturnType<typeof vi.fn>;
let execute: typeof import("../src/modules/plugin-source").executePluginSourceTool;
beforeEach(async () => {
  vi.resetModules();
  fetchResource = vi.fn(async () => ({ ok: true, json: async () => structuredClone(snapshot) }));
  vi.stubGlobal("fetch", fetchResource);
  execute = (await import("../src/modules/plugin-source")).executePluginSourceTool;
});
afterEach(() => vi.unstubAllGlobals());

describe("installed plugin source tools", () => {
  it("loads only one fixed resource, returns build identity and reuses the local snapshot", async () => {
    const result = JSON.parse((await execute("list_plugin_source", {}))!);
    expect(result).toMatchObject({ build: { version: packageJson.version, snapshot_sha256: digest }, files: [{ path: file.path, line_count: 4 }] });
    expect(result.files[0]).not.toHaveProperty("content");
    const read = JSON.parse((await execute("read_plugin_source", { path: file.path }))!);
    expect(read.lines).toHaveLength(4); expect(read.lines[1]).toEqual({ line: 2, text: "Energy transfer" });
    expect(fetchResource).toHaveBeenCalledExactlyOnceWith("chrome://chatpdf/content/source-snapshot.json");
  });
  it("returns exact inclusive lines and paginates every literal matching line", async () => {
    const read = JSON.parse((await execute("read_plugin_source", { path: file.path, start_line: 2, end_line: 3 }))!);
    expect(read.lines).toEqual([{ line: 2, text: "Energy transfer" }, { line: 3, text: "energy balance" }]);
    const first = JSON.parse((await execute("search_plugin_source", { query: "ENERGY", page_size: 1 }))!);
    expect(first).toMatchObject({ total_matches: 2, next_start: 1, matches: [{ line: 2 }] });
    const second = JSON.parse((await execute("search_plugin_source", { query: "energy", start: first.next_start, page_size: 1, path: file.path }))!);
    expect(second).toMatchObject({ next_start: null, matches: [{ line: 3 }] });
    expect(JSON.parse((await execute("search_plugin_source", { query: ".*" }))!).matches).toEqual([]);
  });
  it("rejects paths outside the snapshot and invalid ranges without loading arbitrary resources", async () => {
    for (const path of ["../.env", "src/../secret.ts", "/tmp/key", "C:\\secret", "https://example.com/a.ts", "src/%2e%2e/secret.ts", "src/missing.ts"]) {
      await expect(execute("read_plugin_source", { path })).rejects.toThrow();
      await expect(execute("search_plugin_source", { query: "x", path })).rejects.toThrow();
    }
    for (const range of [{ start_line: 0 }, { start_line: 4, end_line: 2 }, { end_line: 5 }, { start_line: 1.5 }]) {
      await expect(execute("read_plugin_source", { path: file.path, ...range })).rejects.toThrow();
    }
    await expect(execute("search_plugin_source", { query: " " })).rejects.toThrow();
    await expect(execute("search_plugin_source", { query: "x", start: -1 })).rejects.toThrow();
    expect(fetchResource).toHaveBeenCalledTimes(1);
  });
  it("retries failed loads and rejects a snapshot from a different installed version", async () => {
    fetchResource.mockRejectedValueOnce(new Error("unavailable"));
    await expect(execute("list_plugin_source", {})).rejects.toThrow("unavailable");
    fetchResource.mockResolvedValueOnce({ ok: true, json: async () => ({ ...snapshot, version: "wrong" }) });
    await expect(execute("list_plugin_source", {})).rejects.toThrow("mismatched");
    expect(JSON.parse((await execute("list_plugin_source", {}))!).files).toHaveLength(1);
  });
  it("rejects traversal entries in a malformed snapshot", async () => {
    fetchResource.mockResolvedValueOnce({ ok: true, json: async () => ({ ...snapshot, files: [{ ...file, path: "src/../secret.ts" }] }) });
    await expect(execute("list_plugin_source", {})).rejects.toThrow("Invalid plugin source file");
  });
  it("isolates cancellation between concurrent readers and exposes readonly metadata without PDF scope", async () => {
    let finish!: () => void;
    fetchResource.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { ok: true, json: async () => snapshot }; });
    const controller = new AbortController();
    const aborted = expect(execute("list_plugin_source", {}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    const other = execute("read_plugin_source", { path: file.path });
    controller.abort(); finish();
    await aborted; expect(JSON.parse((await other)!).lines).toHaveLength(4);
    const { getToolDefinitions, getToolMetadata, toolResultSourceIds, executeTool } = await import("../src/modules/tools");
    const { ChatSession } = await import("../src/modules/chat-session");
    const context = { session: new ChatSession(), turnScope: new Set<string>(), requestId: "test", windowId: "test" };
    for (const name of ["list_plugin_source", "read_plugin_source", "search_plugin_source"]) {
      expect(getToolDefinitions().some(tool => tool.function.name === name)).toBe(true);
      expect(getToolMetadata(name)).toMatchObject({ readOnly: true, network: false, mutatesSession: false });
      expect(toolResultSourceIds(name, {}, context)).toEqual([]);
    }
    expect(await executeTool("read_plugin_source", { path: file.path }, context)).toContain("Energy transfer");
    const prompt = context.session.buildAgentMessages("Debug plugin")[0].content;
    expect(prompt).toContain("read_plugin_source"); expect(prompt).toContain("reproduced bug");
  });
});
