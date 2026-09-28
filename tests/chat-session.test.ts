import { describe, expect, it } from "vitest";
import { ChatSession } from "../src/modules/chat-session";
import type { SavedSession } from "../src/modules/chat-history";

describe("ChatSession source and persistence semantics", () => {
  it("keeps same attachment keys from different libraries separate", () => {
    const session = new ChatSession();
    const personal = session.addSource("PDF", "Personal", "P1", 1);
    const group = session.addSource("PDF", "Group", "P2", 2);
    expect(personal.id).toBe("1:PDF");
    expect(group.id).toBe("2:PDF");
    expect(session.getSources()).toHaveLength(2);
    expect(session.getSource("PDF")).toBeUndefined();
  });

  it("uses mentions as a turn scope and all sources when no mention exists", () => {
    const session = new ChatSession();
    const first = session.addSource("A", "A", undefined, 1);
    const second = session.addSource("B", "B", undefined, 1);
    expect([...session.resolveTurnScope([first.id])]).toEqual([first.id]);
    expect([...session.resolveTurnScope([])]).toEqual([first.id, second.id]);
  });

  it("persists stable source metadata", () => {
    const session = new ChatSession();
    const source = session.addSource("A", "Paper", "PARENT", 4);
    session.setSourceReady(source.id, "markdown");
    const saved = session.toSavedSession();
    expect(saved.schemaVersion).toBe(4);
    expect(saved.sources?.[0]).toMatchObject({ id: "4:A", key: "A", libraryID: 4, status: "ready" });
  });

  it("restores session sources rather than the last message snapshot", () => {
    const saved: SavedSession = {
      schemaVersion: 2,
      id: "session",
      title: "Test",
      sourceKeys: ["CURRENT"],
      sourceTitles: ["Current"],
      sources: [{ id: "1:CURRENT", key: "CURRENT", libraryID: 1, cacheKey: "1-CURRENT", title: "Current", status: "ready" }],
      messages: [{ role: "user", content: "old", sources: [{ id: "1:OLD", key: "OLD", libraryID: 1, title: "Old" }] }],
      createdAt: 1,
      updatedAt: 2,
    };
    const session = ChatSession.fromSavedSession(saved);
    expect(session.getSource("1:CURRENT")?.title).toBe("Current");
    expect(session.getSource("1:OLD")).toBeUndefined();
  });

  it("persists cancelled and error terminal messages", () => {
    const session = new ChatSession();
    session.addAssistantMessage("partial", undefined, undefined, undefined, undefined, "cancelled");
    session.addAssistantMessage("failed", undefined, undefined, undefined, undefined, "error", "network");
    expect(session.toSavedSession().messages).toMatchObject([
      { status: "cancelled" },
      { status: "error", errorMessage: "network" },
    ]);
  });

  it("does not replay full historical tool results into a later request", () => {
    const session = new ChatSession();
    const huge = "x".repeat(50_000);
    session.addAssistantMessage("answer", undefined, undefined, [{ toolCalls: [{ toolName: "read_document", args: { key: "A" }, result: huge, durationMs: 1 }] }]);
    const messages = session.buildAgentMessages("next");
    const combined = messages.map((message) => message.content).join("\n");
    expect(combined).toContain("50000 characters returned");
    expect(combined).not.toContain(huge);
  });

  it("keeps the system prefix stable and stores turn scope with the user message", () => {
    const session = new ChatSession();
    const source = session.addSource("A", "Paper A", undefined, 1);
    session.setSourceReady(source.id, "markdown");
    const scope = new Set([source.id]);

    const first = session.buildAgentMessages("first question", scope);
    expect(first[0].content).not.toContain("Paper A");
    expect(first.at(-1)?.content).toContain('"Paper A" [1:A]');

    session.addUserMessage("first question", session.snapshotSources(scope));
    session.addAssistantMessage("first answer");
    const second = session.buildAgentMessages("follow up", scope);

    expect(second[0].content).toBe(first[0].content);
    expect(second[1].content).toBe(first.at(-1)?.content);
  });

  it("sums all provider-reported turn usage for the session", () => {
    const session = new ChatSession();
    session.addAssistantMessage("one", undefined, undefined, undefined, {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_cache_hit_tokens: 70,
      prompt_cache_miss_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 5 },
    });
    session.addAssistantMessage("two", undefined, undefined, undefined, {
      prompt_tokens: 200,
      completion_tokens: 50,
      prompt_cache_hit_tokens: 160,
      prompt_cache_miss_tokens: 40,
      completion_tokens_details: { reasoning_tokens: 15 },
    });
    session.addAuxiliaryUsage({
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      prompt_cache_hit_tokens: 8,
      prompt_cache_miss_tokens: 2,
    });

    expect(session.getTokenUsage()).toEqual({
      prompt_tokens: 310,
      completion_tokens: 72,
      total_tokens: 382,
      prompt_cache_hit_tokens: 238,
      prompt_cache_miss_tokens: 72,
      completion_tokens_details: { reasoning_tokens: 20 },
    });
    const saved = session.toSavedSession();
    expect(saved.auxiliaryUsage).toMatchObject({ total_tokens: 12 });
    expect(ChatSession.fromSavedSession(saved).getTokenUsage()).toEqual(session.getTokenUsage());
  });
});
