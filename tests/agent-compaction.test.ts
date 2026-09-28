import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/modules/llm-client", async importOriginal => ({
  ...await importOriginal<typeof import("../src/modules/llm-client")>(), chatWithTools: vi.fn(),
}));
vi.mock("../src/modules/tools", () => ({ executeTool: vi.fn(), getToolMetadata: vi.fn(() => ({ readOnly: true })) }));

import { runAgentLoop } from "../src/modules/agent-loop";
import { chatWithTools, ProviderContextError, Tool } from "../src/modules/llm-client";
import { executeTool, getToolMetadata } from "../src/modules/tools";
import { ChatSession } from "../src/modules/chat-session";
import { AgentContext, COMPACT_PROMPT, contextSize } from "../src/modules/agent-context";
import { compactAgentContext } from "../src/modules/context-compaction";

const tools: Tool[] = [{ type: "function", function: { name: "read_document", description: "Read", parameters: {} } }];
const model = vi.mocked(chatWithTools);
const execute = vi.mocked(executeTool);
const call = (id: string, name = "read_document", args = {}) => ({ content: "", tool_calls: [{ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }], usage: { prompt_tokens: 10, total_tokens: 10 } });
function setup(limit = 240_000) {
  vi.mocked(Zotero.Prefs.get).mockImplementation(key => String(key).endsWith("contextMaxChars") ? limit : undefined);
  const session = new ChatSession();
  const messages = session.buildAgentMessages("Complete all work", undefined, tools);
  session.addUserMessage("Complete all work");
  return { session, messages };
}

beforeEach(() => { vi.clearAllMocks(); model.mockReset(); execute.mockReset(); });

describe("automatic context compaction", () => {
  it("retries a reasoning-exhausted summary with a larger output budget and identical cache prefix", async () => {
    const context = AgentContext.create([{ role: "system", content: "policy" }, { role: "user", content: "x".repeat(50_000) }], "model", 1);
    const usage = vi.fn();
    model.mockResolvedValueOnce({ content: "unfinished", finishReason: "length", usage: {
      prompt_tokens: 63_899, completion_tokens: 8_192, completion_tokens_details: { reasoning_tokens: 6_821 },
    } }).mockResolvedValueOnce({ content: "Goal and pending work preserved.", finishReason: "stop", usage: { completion_tokens: 9_000 } });
    await compactAgentContext(context, tools, { role: "user", content: "continue" }, 100_000, usage);
    expect(model).toHaveBeenCalledTimes(2);
    expect(model.mock.calls[0].slice(0, 6)).toEqual(model.mock.calls[1].slice(0, 6));
    expect(model.mock.calls.map(args => args[6]?.maxTokens)).toEqual([8_192, 16_384]);
    expect(usage).toHaveBeenCalledTimes(2);
    expect(context.data.checkpoints[0].usage?.completion_tokens).toBe(17_192);
    expect(context.data.checkpoints[0].summary).not.toContain("unfinished");
    expect(context.data.requests?.map(request => request.finishReason)).toEqual(["length", "stop"]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("bounds exhausted-summary retries and keeps the original context intact", async () => {
    const context = AgentContext.create([{ role: "system", content: "policy" }, { role: "user", content: "x".repeat(50_000) }], "model", 1);
    const before = context.toJSON();
    model.mockResolvedValue({ content: "partial", finishReason: "length" });
    await expect(compactAgentContext(context, tools, { role: "user", content: "continue" }, 100_000, vi.fn())).rejects.toThrow("three attempts");
    expect(model).toHaveBeenCalledTimes(3);
    expect(context.data.events).toEqual(before.events);
    expect(context.data.active).toEqual(before.active);
    expect(context.data.checkpoints).toEqual([]);
  });

  it("stops cancelled compaction before attempting a larger output budget", async () => {
    const context = AgentContext.create([{ role: "system", content: "policy" }, { role: "user", content: "x".repeat(50_000) }], "model", 1);
    const controller = new AbortController();
    model.mockImplementation(async () => { controller.abort(); return { content: "", finishReason: "length" }; });
    await expect(compactAgentContext(context, tools, { role: "user", content: "continue" }, 100_000, vi.fn(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("continues past the old allowance and keeps the summarizer prefix/tools intact", async () => {
    const { session, messages } = setup();
    const requests: Parameters<typeof chatWithTools>[] = [];
    let mainCalls = 0;
    model.mockImplementation(async (...args) => {
      requests.push(args);
      if (String(args[0].at(-1)?.content).startsWith(COMPACT_PROMPT)) return { content: "Completed previous reads; continue remaining work.", usage: { prompt_tokens: 30, total_tokens: 30 } };
      mainCalls++;
      return mainCalls <= 7 ? call(String(mainCalls), "read_document", { part: mainCalls }) : { content: "All three sources completed", usage: { prompt_tokens: 10, total_tokens: 10 } };
    });
    execute.mockImplementation(async (_name, args) => String(args.part).repeat(68_000));
    const result = await runAgentLoop(messages, tools, session);
    expect(execute).toHaveBeenCalledTimes(7);
    expect(result.content).toBe("All three sources completed");
    expect(session.getAgentContext()!.data.checkpoints.length).toBeGreaterThanOrEqual(2);
    const summaryRequests = requests.filter(args => String(args[0].at(-1)?.content).startsWith(COMPACT_PROMPT));
    for (const args of summaryRequests) {
      expect(args[1]).toBe(tools);
      expect(args[0][0]).toEqual(messages[0]);
      expect(contextSize(args[0], tools)).toBeLessThan(240_000);
    }
    expect(result.usage?.prompt_tokens).toBe(80 + summaryRequests.length * 30);
    expect(session.getAgentContext()!.data.results.reduce((n, r) => n + r.content.length, 0)).toBe(7 * 68_000);
  });

  it("delivers an 80472-character result whole when it fits", async () => {
    const { session, messages } = setup();
    model.mockResolvedValueOnce({ ...call("read"), content: "Read this evidence first." }).mockResolvedValueOnce({ content: "done" });
    execute.mockResolvedValue("x".repeat(80_472));
    const result = await runAgentLoop(messages, tools, session);
    expect(result.iterations[0].toolCalls[0].contextDelivery).toBe("complete");
    expect(result.iterations[0].content).toBe("Read this evidence first.");
    expect(model.mock.calls[1][0].find(message => message.role === "tool")?.content).toBe("x".repeat(80_472));
  });

  it("pages a result larger than a fresh context without blocking the next read", async () => {
    const { session, messages } = setup();
    model.mockResolvedValueOnce(call("huge")).mockResolvedValueOnce(call("page", "read_tool_result", { result_id: "result-1" })).mockResolvedValueOnce({ content: "done" });
    execute.mockResolvedValueOnce("x".repeat(500_000)).mockResolvedValueOnce("first exact page");
    const result = await runAgentLoop(messages, tools, session);
    expect(result.iterations[0].toolCalls[0].contextDelivery).toBe("paged");
    expect(model.mock.calls[1][0].at(-1)?.content).toContain("result_id=result-1");
    expect(result.iterations[1].toolCalls[0].contextDelivery).toBe("complete");
    expect(session.getAgentContext()!.data.results[0].content).toHaveLength(500_000);
  });

  it("never dispatches tools returned by the summarizer and retains the old context", async () => {
    const context = AgentContext.create([{ role: "system", content: "policy" }, { role: "user", content: "x".repeat(50_000) }], "model", 1);
    const before = context.toJSON();
    model.mockResolvedValue(call("unexpected", "mutate"));
    await expect(compactAgentContext(context, tools, { role: "user", content: "continue" }, 100_000, vi.fn())).rejects.toThrow("checkpoint");
    expect(execute).not.toHaveBeenCalled();
    expect(context.toJSON().events).toEqual(before.events);
    expect(context.toJSON().active).toEqual(before.active);
    expect(context.toJSON().checkpoints).toEqual(before.checkpoints);
    expect(context.data.requests?.[0].kind).toBe("compact");
  });

  it("cancellation during compaction never replaces working state", async () => {
    const context = AgentContext.create([{ role: "system", content: "policy" }, { role: "user", content: "x".repeat(50_000) }], "model", 1);
    const controller = new AbortController();
    model.mockImplementation(async () => { controller.abort(); return { content: "summary" }; });
    await expect(compactAgentContext(context, tools, { role: "user", content: "continue" }, 100_000, vi.fn(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(context.data.checkpoints).toHaveLength(0);
  });

  it("does not execute a completed mutation again after a provider context rejection", async () => {
    const { session, messages } = setup();
    vi.mocked(getToolMetadata).mockReturnValue({ readOnly: false, mutatesSession: true, network: false, costly: false });
    model.mockResolvedValueOnce(call("write", "mutate"))
      .mockRejectedValueOnce(new ProviderContextError("context window"))
      .mockResolvedValueOnce({ content: "The mutation completed. Continue with the final answer." })
      .mockResolvedValueOnce({ content: "done" });
    execute.mockResolvedValue("mutation receipt " + "x".repeat(20_000));
    await runAgentLoop(messages, tools, session);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps completed mutation receipts when a later serial operation fails", async () => {
    const { session, messages } = setup();
    vi.mocked(getToolMetadata).mockReturnValue({ readOnly: false, mutatesSession: true, network: false, costly: false });
    const first = call("one", "mutate");
    first.tool_calls.push(call("two", "mutate").tool_calls[0]);
    model.mockResolvedValue(first);
    execute.mockResolvedValueOnce("operation one completed").mockRejectedValueOnce(new Error("lost connection"));
    await expect(runAgentLoop(messages, tools, session)).rejects.toThrow("lost connection");
    const restored = AgentContext.restore(session.getAgentContext()!.toJSON())!;
    restored.recoverPending();
    expect(restored.messages.at(-2)?.content).toContain("Do not repeat");
    expect(restored.messages.at(-1)?.content).toContain("Outcome is unknown");
  });

  it("keeps tools available in automatic mode beyond the old iteration limit", async () => {
    const { session, messages } = setup();
    vi.mocked(Zotero.Prefs.get).mockImplementation(key => String(key).endsWith("agentMaxIterations") ? 1 : undefined);
    model.mockResolvedValueOnce(call("one")).mockResolvedValueOnce(call("two")).mockResolvedValueOnce({ content: "done" });
    execute.mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    await runAgentLoop(messages, tools, session);
    expect(model.mock.calls.every(args => args[1] === tools)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
