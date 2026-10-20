import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/modules/tools", () => ({ executeTool: vi.fn(), toolResultSourceIds: () => [] }));
vi.mock("../src/modules/library-changes", () => ({ captureLibraryAccess: vi.fn(() => ({ mode: "ask", items: [], collections: [] })) }));
import { executeTool } from "../src/modules/tools";
import { captureLibraryAccess } from "../src/modules/library-changes";
import { callChannelTool, cancelToolCall, closeToolSession, resetToolChannel } from "../src/modules/tool-channel";
const client = "client-1234567890", request = "request-123456789";
const invoke = (client_id = client, request_id = request) => callChannelTool({ client_id, request_id, name: "list_sources", arguments: {} });

beforeEach(() => { vi.clearAllMocks(); resetToolChannel(); });
afterEach(() => resetToolChannel());
describe("MCP session and image adaptation", () => {
  it("keeps session sources and result history separate while reusing a client's session", async () => {
    vi.mocked(executeTool).mockImplementation(async (_name, _args, context) => {
      const before = context.session.getSources().length;
      context.session.addSource("PDF12345", "Paper", undefined, 1);
      return String(before);
    });
    expect((await invoke()).content[0]).toMatchObject({ text: "0\n[Stored result: result-1]" });
    expect((await invoke()).content[0]).toMatchObject({ text: "1\n[Stored result: result-2]" });
    expect((await invoke("other-client-1234")).content[0]).toMatchObject({ text: "0\n[Stored result: result-1]" });
    expect(vi.mocked(executeTool).mock.calls[1][2].turnScope).toEqual(new Set(["1:PDF12345"]));
    closeToolSession(client);
    expect((await invoke()).content[0]).toMatchObject({ text: "0\n[Stored result: result-1]" });
  });
  it("returns full text and native page bytes as MCP image content without base64 in the text result", async () => {
    vi.mocked(executeTool).mockImplementation(async (_name, _args, context) => {
      context.deliverImage!({ sourceId: "1:PDF12345", path: "page-2.jpg", mime: "image/jpeg", byteLength: 4, dataUrl: "data:image/jpeg;base64,/9j/4A==" });
      return "page 2 evidence ".repeat(10000);
    });
    const result = await invoke();
    expect(result.isError).toBe(false);
    expect(result.content[0]).toEqual({ type: "text", text: `${"page 2 evidence ".repeat(10000)}\n[Stored result: result-1]` });
    expect(result.content[1]).toEqual({ type: "image", mimeType: "image/jpeg", data: "/9j/4A==" });
  });
  it("enforces the advertised image budget and releases the session after failure", async () => {
    vi.mocked(executeTool).mockImplementationOnce(async (_name, _args, context) => {
      context.deliverImage!({ sourceId: "1:PDF12345", path: "page.jpg", mime: "image/jpeg", byteLength: 21 * 1024 * 1024, dataUrl: "data:image/jpeg;base64,AA==" });
      return "";
    }).mockResolvedValue("next");
    await expect(invoke()).rejects.toThrow("20 MiB");
    expect((await invoke()).content[0]).toMatchObject({ text: "next\n[Stored result: result-1]" });
  });
  it.each(["cancel", "close", "reset", "unload"])("propagates %s to the active execution", async action => {
    let signal: AbortSignal | undefined;
    vi.mocked(executeTool).mockImplementationOnce(async (_name, _args, context) => {
      signal = context.signal;
      await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      return "";
    }).mockResolvedValue("done");
    const pending = invoke();
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(signal).toBeDefined());
    await expect(invoke()).rejects.toThrow("active call");
    cancelToolCall(client, "other-request-123");
    expect(signal!.aborted).toBe(false);
    if (action === "cancel") cancelToolCall(client, request);
    else if (action === "close") closeToolSession(client);
    else if (action === "reset") resetToolChannel();
    else window.dispatchEvent(new Event("unload"));
    await rejection;
    expect((await invoke()).isError).toBe(false);
  });
  it("cleans up even when authorization setup fails before dispatch", async () => {
    vi.mocked(captureLibraryAccess).mockImplementationOnce(() => { throw new Error("UI unavailable"); });
    await expect(invoke()).rejects.toThrow("UI unavailable");
    vi.mocked(executeTool).mockResolvedValue("ok");
    expect((await invoke()).isError).toBe(false);
  });
});
