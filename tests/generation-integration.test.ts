import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.unmock("../src/modules/model-capabilities");
vi.mock("../src/modules/llm-client", async original => ({ ...await original<typeof import("../src/modules/llm-client")>(), chatWithTools: vi.fn() }));
vi.mock("../src/modules/tools", () => ({ executeTool: vi.fn(), getToolMetadata: vi.fn(() => ({ readOnly: true })) }));
import { runAgentLoop } from "../src/modules/agent-loop";
import { ChatSession } from "../src/modules/chat-session";
import { AgentContext } from "../src/modules/agent-context";
import { compactAgentContext } from "../src/modules/context-compaction";
import { buildChatCompletionBody, chatWithTools, getLLMSettings } from "../src/modules/llm-client";
import { clearModelCapabilityCache, resolveModelCapabilities } from "../src/modules/model-capabilities";
import { ContextBudget } from "../src/modules/context-budget";
import { TokenCounter, loadTokenizer } from "../src/modules/token-accounting";

const model = vi.mocked(chatWithTools);
let preferences: Record<string, unknown>;
beforeEach(() => {
  clearModelCapabilityCache(); model.mockReset();
  preferences = { llmThinkingMode: "enabled", llmThinkEffort: "max" };
  vi.mocked(Zotero.Prefs.get).mockImplementation(key => preferences[String(key).split(".").at(-1)!] as never);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: "deepseek-flash", context_window: 1048576, max_output_tokens: 393216 }] }) })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.mocked(Zotero.Prefs.get).mockReset(); });

async function budget() {
  const settings = getLLMSettings();
  const capabilities = await resolveModelCapabilities(settings);
  return new ContextBudget(capabilities, new TokenCounter(await loadTokenizer(), settings, capabilities));
}

describe("generation policy through the actual request path", () => {
  it("retains the Go conversation ID across compaction, answer requests and following turns", async () => {
    Object.assign(preferences, { llmProvider: "opencode-go", llmApiKey: "go-test", llmModel: "deepseek-v4.1-flash", tokenizerMode: "deepseek-v4-estimate", contextWindowTokens: 1000000, maxOutputTokens: 384000 });
    const session = new ChatSession();
    const messages = session.buildAgentMessages("Finish the task", undefined, []);
    session.addUserMessage("Finish the task");
    const context = session.ensureAgentContext(messages);
    for (let i = 0; i < 4; i++) context.append({ role: "assistant", content: "x".repeat(220000) });
    model.mockImplementation(async messages => ({ content: String(messages.at(-1)?.content).startsWith("Create a concise continuation checkpoint") ? "Goal and evidence retained." : "Finished", finishReason: "stop" }));
    await runAgentLoop(messages, [], session);
    expect(context.data.checkpoints).toHaveLength(1);
    await runAgentLoop(messages, [], session);
    expect(model.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const args of model.mock.calls) expect(args[6]!.settings).toMatchObject({ provider: "opencode-go", sessionId: session.id, apiBase: "https://opencode.ai/zen/go/v1" });
  });
  it.each([[13731, 10779], [200000, 180000]])("finishes a %i-token response including %i reasoning tokens on its first request", async (completionTokens, reasoningTokens) => {
    model.mockImplementation(async (messages, tools, _stream, _thinking, _signal, _nonStreaming, options) => {
      const body = buildChatCompletionBody(options!.settings!, messages, { tools, stream: true, maxTokens: options!.maxTokens });
      expect(body.max_tokens).toBe(393216);
      expect(body.reasoning_effort).toBe("max");
      return { content: "Complete historical answer", finishReason: Number(body.max_tokens) >= completionTokens ? "stop" : "length",
        usage: { prompt_tokens: 31327, completion_tokens: completionTokens, completion_tokens_details: { reasoning_tokens: reasoningTokens } } };
    });
    const session = new ChatSession();
    const messages = session.buildAgentMessages("Explain the paper", undefined, []);
    session.addUserMessage("Explain the paper");
    const result = await runAgentLoop(messages, [], session);
    expect(result.content).toBe("Complete historical answer");
    expect(model).toHaveBeenCalledTimes(1);
    expect(session.getAgentContext()!.data.requests![0]).toMatchObject({ outputLimit: 393216, modelMaxOutput: 393216, outputPolicy: "model-maximum", thinkEffort: "max" });
  });

  it("keeps the full model allowance across thinking changes and recomputes explicit overrides", async () => {
    expect((await budget()).outputLimit()).toBe(393216);
    preferences.llmThinkEffort = "high";
    expect((await budget()).outputLimit()).toBe(393216);
    preferences.llmThinkingMode = "disabled";
    expect((await budget()).outputLimit()).toBe(393216);
    preferences.requestedOutputTokens = 20000;
    expect((await budget()).outputLimit()).toBe(20000);
    preferences.requestedOutputTokens = 0;
    expect((await budget()).outputLimit()).toBe(393216);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects input pressure without shrinking generation and compacts before the next answer", async () => {
    const b = await budget();
    const session = new ChatSession();
    const messages = session.buildAgentMessages("Finish the task", undefined, []);
    session.addUserMessage("Finish the task");
    const context = session.ensureAgentContext(messages);
    for (let i = 0; i < 4; i++) context.append({ role: "assistant", content: "x".repeat(230000) });
    expect(b.fits(context.messages, [])).toBe(false);
    expect(b.outputLimit()).toBe(393216);
    expect(b.inputLimit()).toBe(634388);
    model.mockImplementation(async messages => ({ content: String(messages.at(-1)?.content).startsWith("Create a concise continuation checkpoint")
      ? "Goal: finish the task. Evidence retained." : "Task finished", finishReason: "stop" }));
    await runAgentLoop(messages, [], session);
    expect(session.getAgentContext()!.data.checkpoints).toHaveLength(1);
    for (const args of model.mock.calls) {
      expect(args[6]!.maxTokens).toBe(393216);
      expect(b.fits(args[0], args[1], args[6]!.maxTokens)).toBe(true);
    }
  });

  it("does not raise a manual limit when reasoning consumes it", async () => {
    preferences.requestedOutputTokens = 8192;
    model.mockResolvedValue({ content: "", finishReason: "length", usage: { completion_tokens: 8192 } });
    const session = new ChatSession();
    const messages = session.buildAgentMessages("Think", undefined, []);
    session.addUserMessage("Think");
    await expect(runAgentLoop(messages, [], session)).rejects.toThrow("output capacity");
    expect(model).toHaveBeenCalledTimes(1);
    expect(model.mock.calls[0][6]!.maxTokens).toBe(8192);
  });

  it("keeps a compact text target separate from its reasoning allowance", async () => {
    const b = await budget();
    const user = { role: "user" as const, content: "Continue" };
    const context = AgentContext.create([{ role: "system", content: "policy" }, user, { role: "assistant", content: "x".repeat(50000) }], "model", 1);
    model.mockResolvedValue({ content: "Short checkpoint", finishReason: "stop", usage: { completion_tokens: 12000, completion_tokens_details: { reasoning_tokens: 11990 } } });
    await compactAgentContext(context, [], user, b, vi.fn(), undefined, false, getLLMSettings());
    expect(model).toHaveBeenCalledTimes(1);
    expect(model.mock.calls[0][6]!.maxTokens).toBe(393216);
    expect(String(model.mock.calls[0][0].at(-1)?.content)).toContain("at most 4096 tokens");
  });
});
