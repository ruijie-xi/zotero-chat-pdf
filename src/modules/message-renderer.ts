import { h, preserveBottomScroll } from "../utils/dom";
import { formatMsgTime } from "../utils/format";
import { uiLabel, uiText } from "../utils/ui-text";
import { sumTokenUsage, type ChatMessage, type IterationRecord, type TokenUsage } from "./llm-client";
import { getPanelState, type StreamState } from "./panel-state";
import { openPdfForSourceKey } from "./zotero-items";
import { AssistantMessageView } from "./assistant-message-view";
import { enterEditMode } from "./message-editor";
import { updateUsageBar } from "./usage-view";

export { refreshSourceChips } from "./source-chips";
export { createCopyButton, createIterationBlock } from "./assistant-message-view";
export { createToolBlock } from "./tool-message-view";
export { updateUsageBar, formatUsageText, appendUsageMeta } from "./usage-view";

type DisplaySource = { key: string; libraryID?: number; title: string };

function renderMessageSources(doc: Document, sources: DisplaySource[]): HTMLElement {
  const container = h(doc, "div", { className: "chatpdf-msg-sources" });
  for (const source of sources) {
    const chip = h(doc, "button", { type: "button", className: "chatpdf-msg-source-chip", title: uiText(`Open PDF: ${source.title}`, `打开 PDF：${source.title}`) }, source.title);
    chip.addEventListener("click", event => {
      event.stopPropagation();
      void openPdfForSourceKey(source.key, source.libraryID).catch(error => Zotero.debug(`[ChatPDF] Open message source failed: ${error}`));
    });
    container.append(chip);
  }
  return container;
}

export function appendMessage(root: HTMLElement, role: "user" | "assistant", content: string, msgIndex?: number, reasoning?: string, timestamp?: number, sources?: DisplaySource[], modelLabel?: string, iterations?: IterationRecord[], usage?: TokenUsage, status?: ChatMessage["status"]): HTMLElement {
  const messages = root.querySelector("#chatpdf-messages");
  if (!messages) return root;
  const doc = root.ownerDocument!;
  messages.querySelector(".chatpdf-welcome")?.remove();
  let row: HTMLElement;
  let bubble: HTMLElement;
  if (role === "assistant") {
    const view = new AssistantMessageView(doc);
    view.update({ content, reasoning: iterations?.length ? undefined : reasoning, timestamp, modelLabel, iterations, usage, status });
    ({ row, bubble } = view);
  } else {
    row = h(doc, "div", { className: "chatpdf-msg-row chatpdf-msg-row-user" });
    bubble = h(doc, "div", { className: "chatpdf-message chatpdf-message-user" }, content);
    const edit = h(doc, "button", { className: "chatpdf-edit-btn", type: "button", title: uiLabel("edit"), "aria-label": uiLabel("edit") }, "✎");
    edit.addEventListener("click", event => { event.stopPropagation(); enterEditMode(root, row, bubble, content); });
    const wrap = h(doc, "div", { className: "chatpdf-msg-user-wrap" }, bubble);
    if (timestamp) wrap.append(h(doc, "div", { className: "chatpdf-msg-time chatpdf-msg-time-user" }, formatMsgTime(timestamp)));
    if (sources?.length) wrap.append(renderMessageSources(doc, sources));
    row.append(edit, wrap);
  }
  if (msgIndex !== undefined) row.dataset.msgIndex = String(msgIndex);
  messages.append(row);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

export function clearChatMessages(root: HTMLElement): void {
  getPanelState(root).streamViewCleanup?.();
  root.querySelector("#chatpdf-messages")?.replaceChildren();
}

export function renderChatHistory(root: HTMLElement): void {
  const session = getPanelState(root).session;
  for (const [index, message] of session.getHistory().entries()) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    appendMessage(root, message.role, message.content, index, message.reasoning, message.timestamp, message.sources, message.modelLabel, message.iterations, message.usage, message.status);
  }
  updateUsageBar(root, session.getTokenUsage());
}

/** Both a newly sent turn and a restored background turn attach this same view. */
export function renderLiveStreamState(root: HTMLElement, stream: StreamState): void {
  const state = getPanelState(root);
  const messages = root.querySelector("#chatpdf-messages");
  if (!messages) return;
  state.streamViewCleanup?.();
  const win = root.ownerDocument!.defaultView!;
  const view = new AssistantMessageView(root.ownerDocument!);
  view.row.dataset.msgIndex = String(stream.session.getHistoryLength());
  messages.append(view.row);
  let timer: number | undefined;
  let disposed = false;
  const update = () => {
    timer = undefined;
    if (!view.row.isConnected || state.session !== stream.session) { dispose(); return; }
    preserveBottomScroll(messages, () => {
      view.update({ content: stream.fullText, reasoning: stream.fullReasoning, iterations: stream.iterations,
        modelLabel: stream.modelLabel, timestamp: stream.timestamp, usage: stream.usage, status: stream.terminalStatus,
        pending: stream.terminalStatus ? undefined : { thinkingDone: stream.thinkingDone, thinkingElapsed: stream.thinkingElapsed, thinkingStartTime: stream.thinkingStartTime, status: stream.statusText } });
      updateUsageBar(root, sumTokenUsage([stream.session.getTokenUsage(), stream.terminalStatus ? undefined : stream.usage]));
    });
    if (stream.terminalStatus) dispose();
  };
  const render = (immediate = false) => {
    if (disposed) return;
    if (immediate) {
      if (timer !== undefined) win.clearTimeout(timer);
      update();
    } else if (timer === undefined) timer = win.setTimeout(update, 80);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) win.clearTimeout(timer);
    if (elapsedTimer !== undefined) { win.clearInterval(elapsedTimer); state.activePollIntervals.delete(elapsedTimer); }
    if (stream.render === render) stream.render = undefined;
    if (state.streamViewCleanup === dispose) state.streamViewCleanup = null;
  };
  stream.render = render;
  state.streamViewCleanup = dispose;
  const elapsedTimer = win.setInterval(() => { if (!stream.thinkingDone) render(); }, 1000);
  state.activePollIntervals.add(elapsedTimer);
  render(true);
  messages.scrollTop = messages.scrollHeight;
}
