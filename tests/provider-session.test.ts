import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.unmock("../src/modules/model-capabilities");
vi.mock("../src/modules/llm-client", async original => ({ ...await original<typeof import("../src/modules/llm-client")>(), chatWithTools: vi.fn() }));
vi.mock("../src/modules/tools", () => ({ executeTool: vi.fn(), getToolMetadata: vi.fn(() => ({ readOnly: true })) }));
import { runAgentLoop } from "../src/modules/agent-loop";
import { ChatSession } from "../src/modules/chat-session";
import { chatWithTools } from "../src/modules/llm-client";
import { clearModelCapabilityCache } from "../src/modules/model-capabilities";

const model = vi.mocked(chatWithTools);
let preferences: Record<string, unknown>;
beforeEach(() => {
  clearModelCapabilityCache(); model.mockReset();
  preferences = { llmThinkingMode: "enabled", llmThinkEffort: "max" };
  vi.mocked(Zotero.Prefs.get).mockImplementation(key => preferences[String(key).split(".").at(-1)!] as never);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: "deepseek-flash", context_window: 1048576, max_output_tokens: 393216 }] }) })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.mocked(Zotero.Prefs.get).mockReset(); });

describe("Go conversation transport", () => {
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
});
