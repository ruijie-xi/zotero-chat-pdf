import { describe, expect, it } from "vitest";
import { AgentContext, COMPACT_PROMPT, ContextMessage } from "../src/modules/agent-context";
import { ChatSession } from "../src/modules/chat-session";
import { buildChatCompletionBody } from "../src/modules/llm-client";
import { executeTool } from "../src/modules/tools";

const initial: ContextMessage[] = [{ role: "system", content: "policy" }, { role: "user", content: "finish the task" }];

describe("durable transcript and working context", () => {
  it("compacts only the working view and retrieves original evidence exactly", () => {
    const context = AgentContext.create(initial, "model", 1);
    const stored = context.storeResult("0123456789", "read_document", ["1:A"]);
    context.append({ role: "tool", content: stored.content, resultId: stored.id });
    const before = JSON.stringify(context.data.events);
    context.compact("progress and next steps", initial[1]);
    expect(JSON.stringify(context.data.events.slice(0, 3))).toBe(before);
    expect(context.messages).toHaveLength(3);
    expect(context.readResult(stored.id, 3, 4, new Set(["1:A"]))).toContain("\n3456");
    expect(context.readResult(stored.id, 3, 4, new Set(["1:A"]))).toContain("next_start=7");
    expect(() => context.readResult(stored.id, 0, 4, new Set())).toThrow("scope");
    expect(() => context.readResult(stored.id, -1, 4, new Set(["1:A"]))).toThrow("valid");
  });

  it("deduplicates result bodies on disk and rehydrates exact message bytes", () => {
    const context = AgentContext.create(initial, "model", 1);
    const result = context.storeResult("unique-evidence", "read_document", []);
    context.append({ role: "tool", content: result.content, resultId: result.id, tool_call_id: "call-1" });
    const saved = context.toJSON();
    expect(JSON.stringify(saved).match(/unique-evidence/g)).toHaveLength(1);
    expect(AgentContext.restore(saved)?.messages).toEqual(context.messages);
  });

  it("never persists image bytes and marks active vision context for rebuilding", () => {
    const context = AgentContext.create(initial, "model", 1);
    context.append({ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,SECRET", detail: "auto" } }] });
    const saved = context.toJSON();
    expect(JSON.stringify(saved)).not.toContain("SECRET");
    expect(saved.requiresRebuild).toBe(true);
  });

  it("preserves exact prefixes over follow-ups and session restore", () => {
    const session = new ChatSession();
    const first = session.buildAgentMessages("first");
    session.addUserMessage("first");
    const context = session.getAgentContext()!;
    context.append({ role: "assistant", content: "looking", tool_calls: [{ id: "unique-id", type: "function", function: { name: "read_document", arguments: '{ "key" : "A" }' } }] });
    const result = context.storeResult("raw evidence", "read_document", []);
    context.append({ role: "tool", content: result.content, tool_call_id: "unique-id", resultId: result.id });
    context.append({ role: "assistant", content: "done" });
    session.addAssistantMessage("done", undefined, undefined, undefined, [{ toolCalls: [{ toolName: "read_document", args: { key: "A" }, result: result.content, resultId: result.id, durationMs: 1 }] }]);
    const prefix = context.messages;
    expect(prefix.slice(0, first.length)).toEqual(first);
    const saved = session.toSavedSession();
    expect(saved.messages[1].iterations?.[0].toolCalls[0].result).toBe("");
    const restored = ChatSession.fromSavedSession(saved);
    expect(restored.getHistory()[1].iterations?.[0].toolCalls[0].result).toBe("raw evidence");
    expect(restored.getHistory()[1].iterations?.[0].content).toBe("looking");
    expect(ChatSession.fromSavedSession(restored.toSavedSession()).getHistory()[1].iterations?.[0].content).toBe("looking");
    expect(restored.buildAgentMessages("next").slice(0, -1)).toEqual(prefix);
  });

  it("clearing or editing history invalidates the derived context", () => {
    const session = new ChatSession();
    session.buildAgentMessages("one"); session.addUserMessage("one");
    session.truncateHistoryAt(0);
    expect(session.getAgentContext()).toBeUndefined();
    session.buildAgentMessages("two"); session.clearHistory();
    expect(session.toSavedSession().agentContext).toBeUndefined();
  });

  it("does not expose private result references in provider protocol fields", () => {
    const body = buildChatCompletionBody({ model: "test", thinkingMode: "default", thinkEffort: "default" },
      [{ role: "tool", content: "data", resultId: "private", tool_call_id: "call" } as ContextMessage], { stream: true });
    expect(body.messages).toEqual([{ role: "tool", content: "data", tool_call_id: "call" }]);
  });

  it("recovers completed actions as receipts without replaying the action", () => {
    const context = AgentContext.create(initial, "model", 1);
    const result = context.storeResult("changed", "mutate", []);
    context.data.pending = { assistant: { role: "assistant", content: "", tool_calls: [
      { id: "done", type: "function", function: { name: "mutate", arguments: "{}" } },
      { id: "uncertain", type: "function", function: { name: "mutate", arguments: "{}" } },
    ] }, completed: [{ callId: "done", resultId: result.id }] };
    const restored = AgentContext.restore(context.toJSON())!;
    restored.recoverPending();
    expect(restored.messages.at(-2)?.content).toContain("Do not repeat");
    expect(restored.messages.at(-1)?.content).toContain("Outcome is unknown");
    expect(restored.data.pending).toBeUndefined();
  });

  it("enforces current source authorization in the retrieval tool", async () => {
    const session = new ChatSession();
    const source = session.addSource("A", "A", undefined, 1);
    session.buildAgentMessages("read");
    const result = session.getAgentContext()!.storeResult("secret evidence", "read_document", [source.id]);
    const context = { session, requestId: "test", windowId: "window", turnScope: new Set([source.id]), resultPageChars: 6 };
    expect(await executeTool("read_tool_result", { result_id: result.id }, context)).toContain("next_start=6");
    session.removeSource(source.id);
    expect(await executeTool("read_tool_result", { result_id: result.id }, context)).not.toContain("secret evidence");
  });

  it("uses a task-independent prompt and preserves uncertainty and pending work", () => {
    expect(COMPACT_PROMPT).not.toMatch(/paper|PDF|Zotero|theorem|research/i);
    expect(COMPACT_PROMPT).toContain("side effects");
    expect(COMPACT_PROMPT).toContain("has not been inspected");
    expect(COMPACT_PROMPT).toContain("Do not use tools");
  });

  it("keeps unread result IDs outside the generated summary and merges exact coverage", () => {
    const context = AgentContext.create(initial, "model", 1);
    const result = context.storeResult("0123456789", "read_document", []);
    const page = context.storeResult("01234", "read_tool_result", []);
    page.parentRange = { id: result.id, start: 0, end: 5 };
    context.markDelivered(page.id);
    context.compact("Summary that forgot all result IDs", initial[1]);
    expect(context.messages[1].content).toContain(`${result.id}: 10 characters; delivered ranges=[[0,5]]`);
    const end = context.storeResult("456789", "read_tool_result", []);
    end.parentRange = { id: result.id, start: 4, end: 10 };
    context.markDelivered(end.id);
    expect(result.delivered).toBe(true);
    expect(result.ranges).toEqual([[0, 10]]);
  });
});
