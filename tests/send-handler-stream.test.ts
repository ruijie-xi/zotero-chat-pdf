import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/modules/agent-loop", () => ({ runAgentLoop: vi.fn() }));
vi.mock("../src/modules/chat-history", () => ({ saveSession: vi.fn(async () => {}) }));
vi.mock("../src/modules/debug-log", () => ({ logLLMRequest: vi.fn(async () => {}), logLLMResponse: vi.fn(async () => {}), logGenerationResult: vi.fn(async () => {}) }));
vi.mock("../src/modules/source-chips", () => ({ refreshSourceChips: vi.fn(), convertSource: vi.fn() }));
import { handleSend } from "../src/modules/send-handler";
import { runAgentLoop } from "../src/modules/agent-loop";
import { createPanelState, destroyPanelState } from "../src/modules/panel-state";
import { ChatSession } from "../src/modules/chat-session";
import { appendMessage, renderLiveStreamState } from "../src/modules/message-renderer";
import type { IterationRecord } from "../src/modules/llm-client";

const iteration = (content: string): IterationRecord => ({ content, reasoning: "Reason", toolCalls: [{ toolName: "list_sources", args: {}, result: "source", durationMs: 1 }] });
let root: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"><div id="chatpdf-messages"></div><button id="chatpdf-send"></button><div id="input"></div></div>';
  root = document.querySelector("#root")!;
  const state = createPanelState(window);
  state.session = new ChatSession();
  state.session.titleSource = "user";
  state.chatInput = { getText: () => "Continue", getMentionKeys: () => [], clear: vi.fn(), setEditable: vi.fn(), focus: vi.fn(), destroy: vi.fn(), element: root.querySelector("#input") } as any;
});
afterEach(() => { destroyPanelState(window); vi.useRealTimers(); vi.clearAllMocks(); vi.restoreAllMocks(); });

describe("assistant narration chronology", () => {
  it("freezes partial answers before automatic continuation and restores them exactly once", async () => {
    const partial: IterationRecord = { content: "Partial answer", toolCalls: [] };
    vi.mocked(runAgentLoop).mockImplementation(async (_messages, _tools, _session, callbacks) => {
      callbacks!.onStream!(partial.content!, false);
      await vi.advanceTimersByTimeAsync(100);
      const first = root.querySelector(".chatpdf-live-content");
      callbacks!.onIterationComplete!(1, 0, partial);
      callbacks!.onOutputContinuation!(16384);
      expect(root.textContent).toContain("Continuing automatically");
      callbacks!.onStream!("Remaining answer", false);
      callbacks!.onStream!("", true);
      expect(root.querySelector(".chatpdf-iteration-content")).toBe(first);
      return { content: "Remaining answer", iterations: [partial], totalIterations: 2 };
    });
    await handleSend(root);
    expect(root.querySelector(".chatpdf-tool-status")).toBeNull();
    expect(root.textContent!.match(/Partial answer/g)).toHaveLength(1);
    expect(root.textContent!.match(/Remaining answer/g)).toHaveLength(1);
    const saved = ChatSession.fromSavedSession(createPanelState(window).session.toSavedSession()).getHistory()[1];
    const history = appendMessage(root, "assistant", saved.content, undefined, saved.reasoning, undefined, undefined, undefined, saved.iterations);
    expect(history.textContent!.match(/Partial answer/g)).toHaveLength(1);
    expect(history.textContent!.match(/Remaining answer/g)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    const copy = vi.fn(async (_text: string) => {});
    const previousClipboard = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    try {
      for (const button of root.querySelectorAll<HTMLButtonElement>(".chatpdf-copy-btn")) button.click();
      expect(copy).toHaveBeenCalledTimes(2);
      expect(copy.mock.calls).toEqual([["Partial answer\n\nRemaining answer"], ["Partial answer\n\nRemaining answer"]]);
      await vi.runAllTimersAsync();
    } finally {
      if (previousClipboard) Object.defineProperty(window.navigator, "clipboard", previousClipboard);
      else Reflect.deleteProperty(window.navigator, "clipboard");
    }
  });

  it("flushes fast streams before tools and keeps prior nodes in place through the final answer", async () => {
    const records = [iteration("First narration"), iteration("Second narration")];
    vi.mocked(runAgentLoop).mockImplementation(async (_messages, _tools, _session, callbacks) => {
      callbacks!.onStream!(records[0].content!, false);
      callbacks!.onToolCallStart!("list_sources", {});
      const first = root.querySelector(".chatpdf-live-content")!;
      expect(first.textContent).toContain("First narration");
      callbacks!.onIterationComplete!(1, 0, records[0]);
      const firstTool = root.querySelector(".chatpdf-tool-block")!;
      callbacks!.onStream!(records[1].content!, false);
      await vi.advanceTimersByTimeAsync(100);
      callbacks!.onToolCallStart!("list_sources", {});
      callbacks!.onIterationComplete!(2, 0, records[1]);
      callbacks!.onStream!("Final answer", false);
      callbacks!.onStream!("", true);
      expect(root.querySelector(".chatpdf-iteration-content")).toBe(first);
      expect(first.nextElementSibling).toBe(firstTool);
      return { content: "Final answer", iterations: records, totalIterations: 3 };
    });
    await handleSend(root);
    const bubble = root.querySelector(".chatpdf-message-assistant")!;
    expect([...bubble.children].map(el => el.className)).toEqual([
      "chatpdf-iteration-content", "chatpdf-tool-block", "chatpdf-iteration-content", "chatpdf-tool-block", "chatpdf-live-content",
    ]);
    const saved = ChatSession.fromSavedSession(createPanelState(window).session.toSavedSession()).getHistory()[1];
    const historyBubble = appendMessage(root, "assistant", saved.content, undefined, saved.reasoning, undefined, undefined, undefined, saved.iterations);
    expect(historyBubble.textContent!.indexOf("First narration")).toBeLessThan(historyBubble.textContent!.indexOf("Used 1 tool"));
    expect(historyBubble.querySelectorAll(".chatpdf-iteration-content")).toHaveLength(2);
    expect(historyBubble.textContent!.match(/Final answer/g)).toHaveLength(1);
  });

  it("cleans up pending stream timers and compaction status on failure", async () => {
    vi.mocked(runAgentLoop).mockImplementation(async (_messages, _tools, _session, callbacks) => {
      callbacks!.onThinking!("Thinking", false, true);
      callbacks!.onStream!("Partial answer", false);
      callbacks!.onCompaction!(true);
      callbacks!.onCompaction!(false);
      throw new Error("Compaction failed");
    });
    await handleSend(root);
    expect(root.querySelector(".chatpdf-tool-status")).toBeNull();
    expect(root.querySelector(".chatpdf-reasoning-spinner")).toBeNull();
    expect(root.textContent).toContain("Partial answer");
    expect(root.textContent).toContain("Error: Compaction failed");
    expect(vi.getTimerCount()).toBe(0);
    expect(createPanelState(window).session.getHistory()[1].content).toBe("Partial answer\n\nError: Compaction failed");
  });

  it("restores chronological blocks when returning to a background stream", async () => {
    const state = createPanelState(window);
    const stream = { session: state.session, abortController: new AbortController(), fullText: "Second narration", fullReasoning: "Current reasoning", thinkingDone: true, thinkingElapsed: 0, thinkingStartTime: 0, iterations: [iteration("First narration")] };
    state.backgroundStreams.set(state.session.id, stream);
    renderLiveStreamState(root, stream);
    const first = root.querySelector(".chatpdf-iteration-content")!;
    stream.iterations.push(iteration("Second narration"));
    stream.fullReasoning = "";
    stream.fullText = "Final answer";
    await vi.advanceTimersByTimeAsync(100);
    expect(root.querySelector(".chatpdf-iteration-content")).toBe(first);
    expect(root.querySelectorAll(".chatpdf-iteration-content")).toHaveLength(2);
    expect(root.textContent!.match(/Second narration/g)).toHaveLength(1);
    expect(root.textContent!.indexOf("First narration")).toBeLessThan(root.textContent!.indexOf("Second narration"));
  });
});
