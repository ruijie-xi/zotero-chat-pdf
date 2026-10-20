import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerChatPdfBridge, unregisterChatPdfBridge } from "../src/modules/chatpdf-bridge";
import { ChatSession } from "../src/modules/chat-session";
import { executeTool, getToolDefinitions } from "../src/modules/tools";
import { setToolEnabled } from "../src/modules/tool-settings";

async function call(op: string, params: unknown = {}, protocol_version = 2, headers = {}) {
  const Endpoint = (Zotero as any).Server.Endpoints["/chatpdf/v2"];
  const [status, , text] = await new Endpoint().init({ data: { protocol_version, op, params }, headers });
  return { status, body: JSON.parse(text) };
}
const toolCall = (name: string, args: unknown = {}) => call("tools.call", {
  client_id: "client-1234567890", request_id: "request-123456789", name, arguments: args,
});
describe("shared Zotero tool channel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const prefs: Record<string, unknown> = {};
    vi.mocked(Zotero.Prefs.get).mockImplementation(key => prefs[String(key)] as never);
    vi.mocked(Zotero.Prefs.set).mockImplementation((key, value) => { prefs[String(key)] = value; });
    Object.assign(Zotero, { Server: { Endpoints: {} }, version: "10.0.6" });
    registerChatPdfBridge();
  });
  afterEach(() => { unregisterChatPdfBridge(); vi.mocked(Zotero.Prefs.get).mockReset(); });

  it("publishes all 23 native names, descriptions and schemas by default", async () => {
    const tools = (await call("tools.list")).body.result.tools;
    expect(tools).toHaveLength(23);
    expect(tools.map(({ metadata: _metadata, ...tool }: any) => tool)).toEqual(
      getToolDefinitions().map(tool => tool.function));
    expect(tools.find((tool: any) => tool.name === "web_search")).toBeDefined();
    expect(tools.find((tool: any) => tool.name === "change_zotero_library").metadata.readOnly).toBe(false);
    const status = await call("status");
    expect(status.body).toMatchObject({ protocol_version: 2, ok: true, result: {
      capabilities: { shared_tools: true, pdf_conversion: false, pdf_page_reading: true },
      enabled_tools: tools.map((tool: any) => tool.name),
    } });
    expect(JSON.stringify(status.body)).not.toMatch(/apiKey|cache_dir|manifest_version/);
  });
  it("executes the same native tool and stores its complete result for subsequent reads", async () => {
    const session = new ChatSession();
    const native = await executeTool("list_sources", {}, { session, turnScope: new Set(), requestId: "r", windowId: "w" });
    const result = (await toolCall("list_sources")).body.result;
    expect(result).toEqual({ content: [{ type: "text", text: `${native}\n[Stored result: result-1]` }], isError: false });
    const reread = (await toolCall("read_tool_result", { result_id: "result-1" })).body.result;
    expect(reread.isError).toBe(false);
    expect(reread.content[0].text).toContain(native);
  });
  it("removes a disabled tool from both catalogs and rejects a stale call before any network access", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    setToolEnabled("web_fetch", false);
    expect(getToolDefinitions().some(tool => tool.function.name === "web_fetch")).toBe(false);
    expect((await call("tools.list")).body.result.tools.some((tool: any) => tool.name === "web_fetch")).toBe(false);
    expect((await toolCall("web_fetch", { url: "https://example.org" })).body.result).toMatchObject({
      isError: true, content: [{ text: expect.stringContaining("disabled") }],
    });
    expect(network).not.toHaveBeenCalled();
    network.mockRestore();
    setToolEnabled("web_fetch", true);
    expect(getToolDefinitions()).toHaveLength(23);
  });
  it.each([
    ["read_pdf_page", { key: "1:PDF12345", page: "2" }, "type integer"],
    ["read_pdf_page", { key: "1:PDF12345", page: 1, dpi: 999 }, "allowed range"],
    ["list_sources", { unrestricted: true }, "not a supported parameter"],
    ["list_sources", null, "type object"],
  ])("validates %s arguments in the shared executor", async (name, args, error) => {
    expect((await toolCall(name, args)).body.result).toMatchObject({
      isError: true, content: [{ text: expect.stringContaining(error) }],
    });
  });
  it("rejects incompatible protocols and browser-origin calls", async () => {
    expect((await call("status", {}, 1)).status).toBe(400);
    expect((await call("status", [])).body.ok).toBe(false);
    expect((await call("tools.list", {}, 2, { Origin: "https://example.org" })).status).toBe(403);
    expect((Zotero as any).Server.Endpoints["/chatpdf/v1"]).toBeUndefined();
  });
  it.each(["selection.get", "conversion.start", "conversion.get", "conversion.list", "conversion.cancel"])(
    "rejects retired operation %s", async op => {
      expect((await call(op)).body).toMatchObject({ ok: false, error: { message: "unsupported operation", retryable: false } });
    });
  it("closes external state on shutdown", async () => {
    await toolCall("list_sources");
    unregisterChatPdfBridge();
    expect(Object.keys((Zotero as any).Server.Endpoints)).toEqual([]);
    registerChatPdfBridge();
    expect((await toolCall("read_tool_result", { result_id: "result-1" })).body.result.isError).toBe(true);
  });
});
