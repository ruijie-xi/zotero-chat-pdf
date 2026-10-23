import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../src/modules/agent-loop";
import { ChatSession } from "../src/modules/chat-session";
import { resolveModelCapabilities } from "../src/modules/model-capabilities";
import { getToolDefinitions } from "../src/modules/tool-registry";
import * as toolsModule from "../src/modules/tools";
import type { ToolExecutionContext } from "../src/modules/tools";
import type { ProviderMessage } from "../src/modules/llm-client";

const caps = { inputLimit: 240000, maxOutput: 32768, generation: { outputTokens: 32768, retryCeiling: 32768, source: "model-maximum" as const, thinkingMode: "default", thinkEffort: "default" }, tokenizer: "deepseek-v4" as const, imageTokens: 1024, source: "manual" as const, fetchedAt: 1 };
const image = { sourceId: "1:ABC12345", path: "pdf-page-1", dataUrl: "data:image/jpeg;base64,/9j/2Q==", mime: "image/jpeg" as const, byteLength: 4 };
const hasImages = (messages: ProviderMessage[]) => messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === "image_url"));
const call = (name: string, args = {}) => ({ id: "call-" + name, type: "function", function: { name, arguments: JSON.stringify(args) } });
function response(content: string, calls?: ReturnType<typeof call>[]) {
  return new Response("data: " + JSON.stringify({ choices: [{ delta: { content, ...(calls ? { tool_calls: calls.map((c, index) => ({ ...c, index })) } : {}) }, finish_reason: calls ? "tool_calls" : "stop" }] }) + "\n\ndata: [DONE]\n\n");
}
let preferences: Record<string, unknown>;
let rendered: number, writes: number;
let execute: ReturnType<typeof vi.spyOn>;
const originalExecute = toolsModule.executeTool;
beforeEach(() => {
  preferences = { llmApiKey: "dummy-test-key", llmModel: "test-model", visionSupport: "disabled" };
  rendered = 0; writes = 0;
  vi.mocked(Zotero.Prefs.get).mockImplementation(key => preferences[String(key).split(".").at(-1)!] as never);
  vi.mocked(resolveModelCapabilities).mockResolvedValue({ ...caps, supportsVision: undefined });
  execute = vi.spyOn(toolsModule, "executeTool").mockImplementation(async (name: string, args: Record<string, unknown>, context: ToolExecutionContext) => {
    if (context.imageInputRejected) return originalExecute(name, args, context);
    if (name === "inspect_pdf_page") { rendered++; context.deliverImage!(image); return "Rendered page receipt"; }
    if (name === "change_zotero_library") { writes++; return "Saved write receipt"; }
    return originalExecute(name, args, context);
  });
});
afterEach(() => {
  execute.mockRestore(); vi.unstubAllGlobals();
  vi.mocked(Zotero.Prefs.get).mockReset();
  vi.mocked(resolveModelCapabilities).mockResolvedValue({ ...caps, supportsVision: true });
});
function sessionWithSource() {
  const session = new ChatSession(); session.addSource("ABC12345", "Paper", undefined, 1); return session;
}
async function turn(session: ChatSession, text = "Read the paper", callbacks = {}, signal?: AbortSignal) {
  const tools = getToolDefinitions();
  const messages = session.buildAgentMessages(text, undefined, tools);
  session.addUserMessage(text);
  const result = await runAgentLoop(messages, tools, session, callbacks, signal);
  session.addAssistantMessage(result.content, result.reasoning, undefined, result.iterations);
  return result;
}

describe("actual image requests and text-only recovery", () => {
  it.each([false, undefined])("allows text requests regardless of metadata (%s) or legacy settings", async supportsVision => {
    vi.mocked(resolveModelCapabilities).mockResolvedValue({ ...caps, supportsVision });
    vi.stubGlobal("fetch", vi.fn(async () => response("Text answer")));
    expect((await turn(new ChatSession())).content).toBe("Text answer");
    expect(fetch).toHaveBeenCalledOnce();
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.tools).toHaveLength(25);
  });

  it("sends real image content even when vision metadata is missing", async () => {
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const body = JSON.parse(init!.body as string); requests.push(body);
      return response(requests.length === 1 ? "" : "Image read", requests.length === 1 ? [call("inspect_pdf_page")] : undefined);
    }));
    expect((await turn(sessionWithSource())).content).toBe("Image read");
    expect(rendered).toBe(1); expect(requests).toHaveLength(2);
    expect(hasImages(requests[1].messages)).toBe(true);
    expect(requests[1].tools).toHaveLength(25);
  });

  it("continues native image reading beyond 20 MiB across multiple iterations", async () => {
    vi.mocked(toolsModule.executeTool).mockImplementation(async (_name, _args, context) => {
      context.deliverImage!({ ...image, byteLength: 9 * 1024 * 1024 });
      return "Full page delivered";
    });
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init!.body as string));
      return requests.length <= 3 ? response("", [call("inspect_pdf_page")]) : response("Three images read");
    }));
    expect((await turn(sessionWithSource())).content).toBe("Three images read");
    expect(requests.at(-1).messages.flatMap((message: any) => Array.isArray(message.content)
      ? message.content.filter((part: any) => part.type === "image_url") : [])).toHaveLength(3);
  });

  it("recovers once, prevents stale image calls, preserves receipts and remembers only this session/model", async () => {
    const session = sessionWithSource(), requests: any[] = [], notices = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const body = JSON.parse(init!.body as string); requests.push(body);
      if (requests.length === 1) return response("", [call("inspect_pdf_page"), call("change_zotero_library")]);
      if (hasImages(body.messages)) return new Response(JSON.stringify({ error: { message: "This model does not support image inputs." } }), { status: 400 });
      if (requests.length === 3) return response("", [call("inspect_pdf_page")]);
      return response("Summary based on extracted text");
    }));
    const result = await turn(session, "Read", { onIterationComplete: notices });
    expect(result.content).toBe("Summary based on extracted text");
    expect(requests).toHaveLength(4);
    expect(rendered).toBe(1); expect(writes).toBe(1);
    expect(requests[2].tools).toHaveLength(23);
    expect(requests[3].messages.at(-1).content).toContain("rejected image inputs");
    expect(result.iterations.some(it => it.content?.includes("rejected image inputs"))).toBe(true);
    const context = session.getAgentContext()!;
    expect(hasImages(context.messages)).toBe(false);
    expect(hasImages(context.data.events)).toBe(true);
    expect(context.data.results.some(r => r.content.includes("Saved write receipt"))).toBe(true);
    expect(JSON.stringify(session.toSavedSession())).not.toContain("dummy-test-key");
    await turn(session, "Continue");
    expect(requests.at(-1).tools).toHaveLength(23);
    expect(hasImages(requests.at(-1).messages)).toBe(false);
    preferences.llmModel = "another-model";
    await turn(session, "Use the new model");
    expect(requests.at(-1).tools).toHaveLength(25);
    preferences.llmModel = "test-model";
    await turn(new ChatSession(), "New session");
    expect(requests.at(-1).tools).toHaveLength(25);
    session.clearHistory();
    await turn(session, "Retry after clearing");
    expect(requests.at(-1).tools).toHaveLength(25);
  });

  it.each([400, 401, 429, 503])("does not turn unrelated HTTP %i errors into text fallback", async status => {
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const body = JSON.parse(init!.body as string); requests.push(body);
      return requests.length === 1 ? response("", [call("inspect_pdf_page")]) : new Response(status === 400 ? "Unsupported image format" : "This model does not support images.", { status });
    }));
    const session = sessionWithSource();
    await expect(turn(session)).rejects.toThrow("LLM API error");
    expect(requests).toHaveLength([429, 503].includes(status) ? 4 : 2);
    expect(hasImages(session.getAgentContext()!.messages)).toBe(true);
  });

  it("does not retry a text request just because an error mentions images", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("This model does not support images.", { status: 400 })));
    await expect(turn(new ChatSession())).rejects.toThrow("LLM API error");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("also recovers an image rejection during context compaction without replaying old images", async () => {
    const session = sessionWithSource(), tools = getToolDefinitions();
    const messages = session.buildAgentMessages("Continue", undefined, tools);
    session.addUserMessage("Continue");
    const context = session.getAgentContext()!;
    context.append({ role: "assistant", content: "x".repeat(195000) });
    context.append({ role: "user", content: [{ type: "image_url", image_url: { url: image.dataUrl, detail: "high" } }] });
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const body = JSON.parse(init!.body as string); requests.push(body);
      if (hasImages(body.messages)) return new Response("This model does not support images.", { status: 400 });
      return response(String(body.messages.at(-1).content).startsWith("Create a concise continuation checkpoint")
        ? "Goal and evidence retained; rejected images were not read." : "Continued with text");
    }));
    expect((await runAgentLoop(messages, tools, session)).content).toBe("Continued with text");
    expect(requests).toHaveLength(3);
    expect(hasImages(requests[0].messages)).toBe(true);
    expect(requests.slice(1).every(request => !hasImages(request.messages) && request.tools.length === 23)).toBe(true);
    expect(context.data.checkpoints).toHaveLength(1);
    expect(hasImages(context.data.events)).toBe(true);
  });

  it("honors cancellation before an image rejection can trigger another request", async () => {
    const controller = new AbortController(); let count = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (++count === 1) return response("", [call("inspect_pdf_page")]);
      controller.abort();
      return new Response("This model does not support image inputs.", { status: 400 });
    }));
    await expect(turn(sessionWithSource(), "Read", {}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
