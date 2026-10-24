import { describe, expect, it, vi } from "vitest";
import { VisualLibrary, validateVisualInput, type VisualInput } from "../src/modules/visual-model";
import { sanitizeVisualSvg } from "../src/modules/visual-sanitize";
import { ChatSession } from "../src/modules/chat-session";
import { executeVisualTool } from "../src/modules/visual-tools";
import { renderVisual } from "../src/modules/visual-renderer";
import { getAllToolDefinitions, getToolMetadata } from "../src/modules/tool-registry";
vi.mock("../src/modules/visual-renderer", () => ({ renderVisual: vi.fn(async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"/>', width: 100, height: 100, diagnostics: [] })) }));
const input: VisualInput = { title: "A diagram", kind: "svg", source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="20"/></svg>', description: "Illustrative example", dataMode: "illustrative", citations: [] };
const output = { svg: input.source, width: 100, height: 100, diagnostics: [] };
const args = { title: input.title, kind: input.kind, source: input.source, description: input.description, data_mode: input.dataMode, citations: [] };
describe("Versioned learning visuals", () => {
  it("pins historical versions, detects races and makes retries idempotent", () => {
    const library = new VisualLibrary();
    const a = library.commit(input, output, "vis-test", 0, "call-a", 0);
    library.commit({ ...input, title: "Revised" }, output, a.id, 1, "call-b", 0);
    expect(library.get(a)?.title).toBe("A diagram");
    expect(library.latest(a.id)?.version).toBe(2);
    expect(() => library.commit(input, output, a.id, 1, "racing-call", 0)).toThrow("conflict");
    expect(library.commit(input, output, a.id, 0, "call-a", 0).version).toBe(1);
    const copy = library.latest(a.id)!; copy.title = "tampered";
    expect(library.latest(a.id)?.title).toBe("Revised");
  });
  it("restores earlier interactive visuals as snapshots without reader state", () => {
    const library = new VisualLibrary();
    const a = library.commit(input, output, "vis-test", 0, "a", 0);
    const old = { ...library.toJSON(), states: { "vis-test@1": { values: { t: 1.5 } } }, layout: "visual" };
    for (const kind of ["interactive", "html"]) {
      const legacy = { ...old, versions: [{ ...a, kind, source: '{"script":"throw Error(123)"}', png: "data:image/png;base64,aGVsbG8=" }] };
      const restored = VisualLibrary.restore(legacy as any);
      expect(restored.get(a)).toMatchObject({ kind: "snapshot", source: legacy.versions[0].source, png: legacy.versions[0].png });
      expect(restored.toJSON()).not.toHaveProperty("states");
      expect(restored.toJSON()).not.toHaveProperty("layout");
      expect(VisualLibrary.restore(restored.toJSON()).get(a)?.kind).toBe("snapshot");
    }
  });
  it("revokes in-flight commits on clear without restoring removed sources", () => {
    const session = new ChatSession();
    session.visuals.commit(input, output, "vis-test", 0, "a", 0);
    const saved = session.toSavedSession();
    expect(ChatSession.fromSavedSession(saved).visuals.list()).toHaveLength(1);
    expect(ChatSession.fromSavedSession({ ...saved, visuals: undefined }).visuals.list()).toHaveLength(0);
    session.clearHistory();
    expect(session.toSavedSession().visuals?.versions).toEqual([]);
    expect(() => session.visuals.commit(input, output, "vis-late", 0, "late", 0)).toThrow("revoked");
  });
  it("requires provenance for measured data and rejects oversized sources explicitly", () => {
    expect(() => validateVisualInput({ ...input, dataMode: "paper-data" })).toThrow("citations");
    expect(() => validateVisualInput({ ...input, source: "x".repeat(256001) })).toThrow("never truncated");
  });
  it.each(["interactive", "html", "snapshot"])("rejects new %s visuals", kind => {
    expect(() => validateVisualInput({ ...input, kind } as any)).toThrow("static images");
  });
});
describe("Static SVG boundary", () => {
  it.each(['<script>alert(1)</script>', '<foreignObject><p>bad</p></foreignObject>', '<image href="https://evil/track"/>', '<use href="chrome://zotero/content"/>', '<circle onload="bad()"/>', '<circle fill="url(https://evil/a)"/>', '<style>@import "https://evil";</style>', '<animate attributeName="href"/>'])('rejects active SVG: %s', payload => {
    expect(() => sanitizeVisualSvg(`<svg xmlns="http://www.w3.org/2000/svg">${payload}</svg>`, document)).toThrow();
  });
  it("supports internal markers, math text and safe presentation styles", () => {
    const result = sanitizeVisualSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><defs><marker id="tip" markerWidth="4" markerHeight="4"><path d="M0 0 L4 2 L0 4"/></marker></defs><path d="M10 10 L100 100" style="stroke:blue;fill:none" marker-end="url(#tip)"/><text x="20" y="30">∇ · B = 0</text></svg>', document);
    expect(result).toContain('stroke="blue"');
    expect(result).toContain('url(#tip)');
    expect(result).not.toContain('style=');
  });
});
describe("Shared visual tool lifecycle", () => {
  const context = () => ({ session: new ChatSession(), requestId: "turn-1", callId: "call-1", windowId: "test", turnScope: new Set<string>(), deliverVisual: vi.fn() });
  it("uses one catalog with mutating create/update and read-only reads", () => {
    const names = getAllToolDefinitions().map(t => t.function.name);
    for (const name of ["create_visual", "read_visual", "update_visual", "inspect_visual"]) expect(names.filter(n => n === name)).toHaveLength(1);
    expect(getToolMetadata("create_visual").readOnly).toBe(false);
    expect(getToolMetadata("update_visual").mutatesSession).toBe(true);
    expect(getToolMetadata("read_visual").readOnly).toBe(true);
    const schema = getAllToolDefinitions().find(t => t.function.name === "create_visual")!.function.parameters as any;
    expect(schema.properties.kind.enum).toEqual(["svg", "mermaid", "tikz"]);
  });
  it("preserves the last working revision when a new renderer fails", async () => {
    const ctx = context();
    const created = JSON.parse(await executeVisualTool("create_visual", args, ctx));
    vi.mocked(renderVisual).mockRejectedValueOnce(new Error("Invalid TikZ"));
    await expect(executeVisualTool("update_visual", { ...args, id: created.id, expected_version: 1 }, { ...ctx, callId: "call-2" })).rejects.toThrow("Invalid TikZ");
    expect(ctx.session.visuals.latest(created.id)?.version).toBe(1);
    expect(ctx.deliverVisual).toHaveBeenCalledOnce();
    const read = JSON.parse(await executeVisualTool("read_visual", { id: created.id, include_source: true }, ctx));
    expect(read.source).toBe(input.source);
    expect(read).not.toHaveProperty("state");
  });
  it("checks source scope before and after asynchronous rendering", async () => {
    const ctx = context(), source = ctx.session.addSource("PAPER123", "Paper", undefined, 1);
    const scoped = { ...args, citations: [{ source_id: source.id, page: 1 }] };
    await expect(executeVisualTool("create_visual", scoped, ctx)).rejects.toThrow("outside");
    ctx.turnScope.add(source.id);
    vi.mocked(renderVisual).mockImplementationOnce(async () => { ctx.session.removeSource(source.id); return output; });
    await expect(executeVisualTool("create_visual", scoped, ctx)).rejects.toThrow();
    expect(ctx.session.visuals.list()).toEqual([]);
  });
  it("does not commit after clear or cancellation during rendering", async () => {
    const ctx = context(), abort = new AbortController();
    vi.mocked(renderVisual).mockImplementationOnce(async () => { abort.abort(); return output; });
    await expect(executeVisualTool("create_visual", args, { ...ctx, signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(ctx.session.visuals.list()).toEqual([]);
    vi.mocked(renderVisual).mockImplementationOnce(async () => { ctx.session.clearHistory(); return output; });
    await expect(executeVisualTool("create_visual", args, ctx)).rejects.toMatchObject({ name: "AbortError" });
  });
});
