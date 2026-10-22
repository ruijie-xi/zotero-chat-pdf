import { getPref } from "../utils/prefs";
import { uiText } from "../utils/ui-text";
import { runAgentLoop } from "./agent-loop";
import { getToolDefinitions } from "./tools";
import { logLLMRequest, logLLMResponse } from "./debug-log";
import { saveSession } from "./chat-history";
import { getPanelState, createAbortController, resetStreamingUI, setSendButtonToStop, type StreamState } from "./panel-state";
import { appendMessage, clearChatMessages, renderChatHistory, renderLiveStreamState } from "./message-renderer";
import { refreshSourceChips } from "./source-chips";
import { captureLibraryAccess } from "./library-changes";
import { requestLibraryApproval } from "./library-approval";
import { createTurnCallbacks } from "./turn-stream";
import { generateTitle } from "./session-persistence";
import type { MessageEditRequest } from "./message-editor";

export { autoSaveSession } from "./session-persistence";

export function shouldRestoreChatInputFocus(doc: Document, inputElement: HTMLElement, sendButton: HTMLElement | null): boolean {
  const active = doc.activeElement;
  return !active || active === doc.body || active === doc.documentElement || active === sendButton || inputElement.contains(active);
}

/** Persist the terminal turn even when it finishes in a background chat. */
async function saveTurn(stream: StreamState): Promise<void> {
  try { await saveSession(stream.session.toSavedSession()); }
  catch (error) { Zotero.debug(`[ChatPDF] Save turn failed: ${error}`); }
}

/** Own the turn lifecycle; callbacks and message presentation are separate. */
export async function handleSend(root: HTMLElement): Promise<void> {
  const state = getPanelState(root);
  const input = state.chatInput;
  const sendButton = root.querySelector<HTMLButtonElement>("#chatpdf-send");
  if (!input || !sendButton || state.backgroundStreams.has(state.session.id)) return;
  const text = input.getText();
  if (!text.trim()) return;
  const session = state.session;
  const scope = session.resolveTurnScope(input.getMentionKeys());
  const libraryAccess = captureLibraryAccess(state.win);
  const sources = session.snapshotSources(scope).filter(source => session.getSource(source.id)?.status === "ready");
  const model = String(getPref("llmModel") || "deepseek-chat");
  const profile = String(getPref("activeProfile") || "");
  const { controller, signal } = createAbortController(root.ownerDocument!.defaultView || undefined);
  let complete!: () => void;
  const stream: StreamState = {
    session, abortController: controller, fullText: "", fullReasoning: "", thinkingDone: true,
    thinkingElapsed: 0, thinkingStartTime: 0, iterations: [], modelLabel: profile ? `${profile} / ${model}` : model,
    completion: new Promise(resolve => { complete = resolve; }),
  };
  state.backgroundStreams.set(session.id, stream);
  state.isStreaming = true;
  state.currentAbortController = controller;
  input.clear();
  input.setEditable(false);
  setSendButtonToStop(sendButton);
  appendMessage(root, "user", text, session.getHistoryLength(), undefined, Date.now(), sources);
  let userAdded = false;
  let failureMessage: string | undefined;
  let succeeded = false;

  try {
    const tools = getToolDefinitions();
    // Build provider context before adding the current message: never send it twice.
    const messages = session.buildAgentMessages(text, scope, tools, libraryAccess);
    session.addUserMessage(text, sources);
    userAdded = true;
    renderLiveStreamState(root, stream);
    await saveSession(session.toSavedSession());
    void logLLMRequest(messages, model).catch(() => {});
    const result = await runAgentLoop(messages, tools, session, createTurnCallbacks(stream), signal, {
      requestId: crypto.randomUUID?.() ?? Zotero.Utilities.randomString(24),
      windowId: state.windowId, turnScope: scope, libraryAccess,
      approveLibraryChanges: (plan, undo) => state.session === session && root.isConnected
        ? requestLibraryApproval(root, plan, signal, undo) : Promise.resolve(false),
    });
    stream.fullText = result.content;
    stream.fullReasoning = result.iterations.length ? "" : result.reasoning || "";
    stream.iterations = result.iterations;
    stream.usage = result.usage;
    stream.terminalStatus = "complete";
    succeeded = true;
    void logLLMResponse(result.content, result.reasoning).catch(() => {});
  } catch (error) {
    const failure = error as { name?: string; message?: string };
    const cancelled = failure?.name === "AbortError" || signal.aborted;
    failureMessage = failure?.message || String(error);
    stream.terminalStatus = cancelled ? "cancelled" : "error";
    if (cancelled) stream.fullText ||= uiText("Generation stopped before any answer was produced.", "已停止生成，尚未产生回答。");
    else stream.fullText = [stream.fullText, uiText(`Error: ${failureMessage}`, `错误：${failureMessage}`)].filter(Boolean).join("\n\n");
    Zotero.debug(`[ChatPDF] Turn ${stream.terminalStatus}: ${failureMessage}`);
  } finally {
    if (!userAdded) session.addUserMessage(text, sources);
    stream.thinkingDone = true;
    stream.statusText = "";
    stream.timestamp = Date.now();
    // Keep partial reasoning that has not yet become a completed iteration.
    const iterations = stream.fullReasoning && stream.iterations.length
      ? [...stream.iterations, { reasoning: stream.fullReasoning, toolCalls: [] }]
      : stream.iterations;
    session.addAssistantMessage(stream.fullText, stream.fullReasoning || undefined, stream.modelLabel, iterations, stream.usage, stream.terminalStatus, succeeded ? undefined : failureMessage);
    if (state.session === session && root.isConnected) {
      try {
        if (stream.render) stream.render(true);
        else { clearChatMessages(root); renderChatHistory(root); }
        refreshSourceChips(root);
      } catch (error) {
        Zotero.debug(`[ChatPDF] Final turn display failed: ${error}`);
      } finally {
        state.streamViewCleanup?.();
      }
    }
    await saveTurn(stream);
    if (state.backgroundStreams.get(session.id) === stream) state.backgroundStreams.delete(session.id);
    // A background completion must never clear another session's stop button/controller.
    try {
      if (state.session === session && (state.currentAbortController === controller || !state.currentAbortController)) {
        const restoreFocus = shouldRestoreChatInputFocus(root.ownerDocument!, input.element, sendButton);
        resetStreamingUI(root);
        if (restoreFocus && root.isConnected && !state.showingHistory) input.focus();
      }
    } finally {
      complete();
    }
  }
  if (succeeded && session.getHistoryLength() === 2 && session.titleSource !== "user") void generateTitle(session, root);
}

/** Wait for cancellation to finish before truncating and replacing a turn. */
export async function resendEditedMessage(root: HTMLElement, request: MessageEditRequest): Promise<void> {
  const state = getPanelState(root);
  const session = state.session;
  if (request.sessionId !== session.id || session.getHistory()[request.index]?.role !== "user") return;
  const stream = state.backgroundStreams.get(session.id);
  stream?.abortController.abort();
  await stream?.completion;
  if (state.session !== session || !root.isConnected) return;
  if (request.index === 0) { session.title = ""; session.titleSource = "auto"; }
  session.truncateHistoryAt(request.index);
  clearChatMessages(root);
  renderChatHistory(root);
  state.chatInput?.setText(request.text);
  await handleSend(root);
}
