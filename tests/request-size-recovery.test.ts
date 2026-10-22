import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentContext, COMPACT_PROMPT, ContextMessage } from "../src/modules/agent-context";
import { compactAgentContext, exchangeGroups } from "../src/modules/context-compaction";
import { ContextBudget } from "../src/modules/context-budget";
import { TokenCounter } from "../src/modules/token-accounting";
import { getLLMSettings, ProviderMessage } from "../src/modules/llm-client";
import { runAgentLoop } from "../src/modules/agent-loop";
import { ChatSession } from "../src/modules/chat-session";
import { getToolDefinitions } from "../src/modules/tool-registry";
import * as toolsModule from "../src/modules/tools";
import { OFFLOADED_IMAGE_TEXT } from "../src/modules/image-window";

const caps = { inputLimit: 240000, maxOutput: 32768, generation: { outputTokens: 32768, retryCeiling: 32768, source: "model-maximum" as const,
  thinkingMode: "default", thinkEffort: "default" }, tokenizer: "deepseek-v4" as const, imageTokens: 1024, source: "manual" as const, fetchedAt: 1 };
const user: ContextMessage = { role: "user", content: "Compare all figures and preserve the completed library edit." };
const urls = [1, 2, 3, 4, 5].map(page => `data:image/jpeg;base64,${String(page).repeat(4096)}`);
const visuals = (count: number): ContextMessage => ({ role: "user", content: urls.slice(0, count).flatMap((url, i) => [
  { type: "text" as const, text: `source=1:ABC12345 page=${i + 1}` }, { type: "image_url" as const, image_url: { url, detail: "high" as const } },
]) });
const images = (messages: ProviderMessage[]) => messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(p => p.type === "image_url") : []);
const call = (name: string) => ({ id: "call-" + name, type: "function" as const, function: { name, arguments: "{}" } });
function response(content: string, calls?: ReturnType<typeof call>[]) {
  return new Response("data: " + JSON.stringify({ choices: [{ delta: { content, ...(calls ? { tool_calls: calls.map((c, index) => ({ ...c, index })) } : {}) },
    finish_reason: calls ? "tool_calls" : "stop" }] }) + "\n\ndata: [DONE]\n\n");
}
function fixture(count = 4) {
  const context = AgentContext.create([{ role: "system", content: "Follow the user. Read original pages." }, user,
    { role: "assistant", content: "", tool_calls: [call("change_zotero_library")] },
    { role: "tool", tool_call_id: "call-change_zotero_library", content: "Edit completed once", resultId: "result-1" }, visuals(count)], "model", 1);
  context.storeResult("Edit completed once", "change_zotero_library", []).mutating = true;
  const budget = new ContextBudget(caps, new TokenCounter({ encode: (text: string) => ({ ids: { length: text.length } }) } as any, getLLMSettings(), caps));
  return { context, budget };
}
const rejected = () => new Response("<h1>413 Request Entity Too Large</h1>openresty", { status: 413 });
const requests: any[] = [];
const accepted: string[] = [];
function notes(body: any) {
  const current = images(body.messages);
  exchangeGroups(body.messages);
  current.forEach(image => { expect(image.image_url.detail).toBe("high"); accepted.push(image.image_url.url); });
  const previous = body.messages.findLast((m: any) => m.role === "assistant" && typeof m.content === "string" && m.content.startsWith("Notes:"))?.content || "Notes: Edit completed once; pending figure comparison.";
  const labels = body.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((p: any) => p.type === "text").map((p: any) => p.text) : []);
  return response(previous + " " + labels.join(" "));
}
beforeEach(() => {
  requests.length = 0; accepted.length = 0;
  vi.mocked(Zotero.Prefs.get).mockImplementation(key => ({ llmApiKey: "dummy-key", llmModel: "same-model" })[String(key).split(".").at(-1)!] as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(Zotero.Prefs.get).mockReset(); });

describe("HTTP 413 checkpoint recovery", () => {
  it("splits complete exchanges and image batches adaptively, preserving all original pixels, labels and receipts", async () => {
    const { context, budget } = fixture();
    const original = structuredClone(context.data.events);
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const body = JSON.parse(init!.body as string); requests.push(body);
      return images(body.messages).length > 1 ? rejected() : notes(body);
    }));
    expect(await compactAgentContext(context, getToolDefinitions(), user, budget, vi.fn())).toBe(true);
    expect(accepted).toEqual(urls.slice(0, 4));
    expect(requests.length).toBeLessThan(16);
    expect(requests.every(body => body.model === "same-model" && body.tools.length === 24)).toBe(true);
    expect(context.data.events.slice(0, original.length)).toEqual(original);
    expect(context.data.results[0]).toMatchObject({ content: "Edit completed once", mutating: true });
    expect(images(context.messages)).toEqual([]);
    for (let page = 1; page <= 4; page++) expect(context.data.checkpoints[0].summary).toContain(`page=${page}`);
    expect(context.messages.filter(m => m.content === user.content)).toHaveLength(1);
  });

  it("continues the native loop after a real HTTP 413 without replaying tools or disabling later image reads", async () => {
    const session = new ChatSession(); session.addSource("ABC12345", "Paper", undefined, 1);
    let readCount = 0, writeCount = 0, stage = 0;
    const executor = vi.spyOn(toolsModule, "executeTool").mockImplementation(async (name, _args, context) => {
      if (name === "change_zotero_library") { writeCount++; return "Edit completed once"; }
      readCount++;
      const pages = readCount === 1 ? urls.slice(0, 4) : urls.slice(4);
      for (const url of pages) context.deliverImage!({ sourceId: "1:ABC12345", path: "page-" + (urls.indexOf(url) + 1),
        label: "page=" + (urls.indexOf(url) + 1), dataUrl: url, mime: "image/jpeg", byteLength: 3072 });
      return "Original page receipts";
    });
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const body = JSON.parse(init!.body as string); requests.push(body);
      expect(body.tools).toHaveLength(24);
      if (images(body.messages).length > 1) return rejected();
      if (String(body.messages.at(-1).content).startsWith(COMPACT_PROMPT)) return notes(body);
      if (stage++ === 0) return response("", [call("inspect_pdf_page"), call("change_zotero_library")]);
      if (stage === 2) {
        for (let page = 1; page <= 4; page++) expect(JSON.stringify(body.messages)).toContain(`page=${page}`);
        return response("", [call("inspect_pdf_page")]);
      }
      expect(images(body.messages).map(i => i.image_url.url)).toEqual(urls.slice(4));
      return response("All figures compared");
    }));
    const tools = getToolDefinitions(), messages = session.buildAgentMessages(user.content as string, undefined, tools);
    session.addUserMessage(user.content as string);
    const result = await runAgentLoop(messages, tools, session);
    expect(result.content).toBe("All figures compared");
    expect(readCount).toBe(2); expect(writeCount).toBe(1); expect(executor).toHaveBeenCalledTimes(3);
    expect(accepted).toEqual(urls.slice(0, 4));
    expect(result.iterations.some(record => record.content?.includes("oversized request"))).toBe(true);
    expect(session.getAgentContext()!.data.checkpoints).toHaveLength(1);
    expect(session.getAgentContext()!.data.results.some(r => r.mutating && r.content === "Edit completed once")).toBe(true);
  });

  it("keeps original context on cancellation between image groups", async () => {
    const { context, budget } = fixture();
    const before = structuredClone({ events: context.data.events, active: context.data.active });
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const body = JSON.parse(init!.body as string); requests.push(body);
      const count = images(body.messages).length;
      if (count > 1) return rejected();
      if (count) controller.abort();
      return notes(body);
    }));
    await expect(compactAgentContext(context, [], user, budget, vi.fn(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(context.data.events).toEqual(before.events); expect(context.data.active).toEqual(before.active);
    expect(context.data.checkpoints).toHaveLength(0); expect(accepted).toHaveLength(1);
  });

  it("offloads only previously delivered images on 413 and keeps text, receipts and rereads exact", async () => {
    const session = new ChatSession(); session.addSource("ABC12345", "Paper", undefined, 1);
    let reads = 0, writes = 0, stage = 0;
    vi.spyOn(toolsModule, "executeTool").mockImplementation(async (name, _args, context) => {
      if (name === "change_zotero_library") { writes++; return "Edit completed once"; }
      const pages = [[0, 1], [2, 3], [0]][reads++];
      for (const index of pages) context.deliverImage!({ sourceId: "1:ABC12345", path: "page-" + (index + 1),
        label: "page=" + (index + 1), dataUrl: urls[index], mime: "image/jpeg", byteLength: 3072 });
      return "Read receipt " + reads;
    });
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const body = JSON.parse(init!.body as string); requests.push(body);
      expect(body.tools).toHaveLength(24);
      expect(String(body.messages.at(-1).content)).not.toContain(COMPACT_PROMPT);
      if (images(body.messages).length > 2) return rejected();
      if (stage++ === 0) return response("", [call("inspect_pdf_page"), call("change_zotero_library")]);
      if (stage === 2) {
        expect(images(body.messages).map(i => i.image_url.url)).toEqual(urls.slice(0, 2));
        return response("Exact analysis of pages 1 and 2", [call("inspect_pdf_page")]);
      }
      expect(JSON.stringify(body.messages)).toContain("Exact analysis of pages 1 and 2");
      expect(JSON.stringify(body.messages)).toContain("Edit completed once");
      if (stage === 3) {
        expect(images(body.messages).map(i => i.image_url.url)).toEqual(urls.slice(2, 4));
        const rejectedBody = requests.at(-2)!;
        const expected = structuredClone(rejectedBody.messages);
        for (const message of expected) if (Array.isArray(message.content)) message.content = message.content.map((part: any) =>
          part.type === "image_url" && urls.slice(0, 2).includes(part.image_url.url) ? { type: "text", text: OFFLOADED_IMAGE_TEXT } : part);
        expect(body.messages).toEqual(expected);
        return response("Reread page 1 for exact notation", [call("inspect_pdf_page")]);
      }
      expect(images(body.messages).map(i => i.image_url.url)).toEqual(urls.slice(0, 1));
      const firstOffload = requests[3].messages;
      const firstImageIndex = firstOffload.findIndex((m: any) => Array.isArray(m.content));
      expect(body.messages.slice(0, firstImageIndex + 1)).toEqual(firstOffload.slice(0, firstImageIndex + 1));
      return response("Equation checked against reread image");
    }));
    const tools = getToolDefinitions(), messages = session.buildAgentMessages(user.content as string, undefined, tools);
    session.addUserMessage(user.content as string);
    const result = await runAgentLoop(messages, tools, session);
    expect(result.content).toBe("Equation checked against reread image");
    expect(reads).toBe(3); expect(writes).toBe(1); expect(requests).toHaveLength(6);
    const context = session.getAgentContext()!;
    expect(context.data.checkpoints).toHaveLength(0);
    expect(context.data.imageOffloads?.map(record => record.imageCount)).toEqual([2, 2]);
    expect(result.iterations.filter(record => record.content?.includes("rereadable references"))).toHaveLength(2);
    expect(images(context.data.events).map(i => i.image_url.url)).toEqual([...urls.slice(0, 4), urls[0]]);
    expect(context.data.results.find(r => r.mutating)?.content).toBe("Edit completed once");
  });

  it("stops when a single original image still cannot fit, without silently dropping or resizing it", async () => {
    const { context, budget } = fixture(1);
    const before = structuredClone(context.messages);
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const body = JSON.parse(init!.body as string); requests.push(body);
      return images(body.messages).length ? rejected() : notes(body);
    }));
    await expect(compactAgentContext(context, [], user, budget, vi.fn())).rejects.toThrow("one complete exchange or image");
    expect(context.messages).toEqual(before); expect(context.data.checkpoints).toHaveLength(0);
    expect(requests.length).toBeLessThan(8);
    expect(requests.flatMap(body => images(body.messages)).every(i => i.image_url.url === urls[0])).toBe(true);
  });

  it.each([401, 422])("does not split unrelated HTTP %i failures", async status => {
    const { context, budget } = fixture();
    const before = structuredClone(context.messages);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Invalid request", { status })));
    await expect(compactAgentContext(context, [], user, budget, vi.fn())).rejects.toThrow(`LLM API error (${status})`);
    expect(fetch).toHaveBeenCalledOnce(); expect(context.messages).toEqual(before);
  });
});
