import { h } from "../utils/dom";
import { formatMsgTime } from "../utils/format";
import { uiLabel, uiText } from "../utils/ui-text";
import { renderMarkdownInto } from "./markdown-renderer";
import { visibleAssistantText, type ChatMessage, type IterationRecord } from "./llm-client";
import { createToolBlock } from "./tool-message-view";
import { appendUsageMeta } from "./usage-view";

export interface PendingMessage {
  thinkingDone: boolean;
  thinkingStartTime: number;
  thinkingElapsed: number;
  status?: string;
}

export interface AssistantMessageSnapshot {
  content: string;
  reasoning?: string;
  iterations?: IterationRecord[];
  timestamp?: number;
  modelLabel?: string;
  usage?: ChatMessage["usage"];
  status?: ChatMessage["status"];
  pending?: PendingMessage;
}

export function createCopyButton(doc: Document, markdown: string | (() => string)): HTMLElement {
  const button = h(doc, "button", { className: "chatpdf-copy-btn", type: "button", title: uiLabel("copyMarkdown") }, uiLabel("copy"));
  button.addEventListener("click", async event => {
    event.stopPropagation();
    try {
      await doc.defaultView!.navigator.clipboard.writeText(typeof markdown === "string" ? markdown : markdown());
      button.textContent = uiLabel("copied");
    } catch {
      button.textContent = uiLabel("copyFailed");
    }
    doc.defaultView!.setTimeout(() => { button.textContent = uiLabel("copy"); }, 1500);
  });
  return button;
}

/** One renderer for saved iterations and the current streaming iteration. */
class IterationView {
  readonly element: HTMLElement;
  private reasoning?: { block: HTMLElement; toggle: HTMLElement; label: HTMLElement; timer: HTMLElement; content: HTMLElement; spinner: HTMLElement };
  private content?: HTMLElement;
  private text = "";
  private tools?: HTMLElement;
  private toolCalls?: IterationRecord["toolCalls"];
  private wasThinking = false;

  constructor(private doc: Document, private index: number) {
    this.element = h(doc, "div", { className: "chatpdf-iteration-block" });
  }

  update(record: IterationRecord, pending?: PendingMessage, finalContent = false): void {
    const thinking = !!pending && !pending.thinkingDone;
    if (record.reasoning || thinking) {
      if (!this.reasoning) {
        const block = h(this.doc, "div", { className: "chatpdf-reasoning-block" });
        const toggle = h(this.doc, "button", { className: "chatpdf-reasoning-toggle", type: "button", "aria-expanded": String(thinking) });
        const label = h(this.doc, "span", { className: "chatpdf-reasoning-label" });
        const timer = h(this.doc, "span", { className: "chatpdf-reasoning-timer" });
        const spinner = h(this.doc, "span", { className: "chatpdf-reasoning-spinner" });
        const content = h(this.doc, "div", { className: "chatpdf-reasoning-content" });
        toggle.append(h(this.doc, "span", { className: "chatpdf-reasoning-chevron", "aria-hidden": "true" }, "▶"), spinner, label, timer);
        toggle.addEventListener("click", () => toggle.setAttribute("aria-expanded", String(block.classList.toggle("chatpdf-reasoning-expanded"))));
        block.classList.toggle("chatpdf-reasoning-expanded", thinking);
        block.append(toggle, content);
        this.element.prepend(block);
        this.reasoning = { block, toggle, label, timer, content, spinner };
      }
      const view = this.reasoning;
      if (view.content.textContent !== (record.reasoning || "")) view.content.textContent = record.reasoning || "";
      view.label.textContent = thinking ? uiLabel("thinking") : uiText(`Thought (step ${this.index + 1})`, `思考过程（第 ${this.index + 1} 步）`);
      view.spinner.hidden = !thinking;
      const elapsed = thinking && pending.thinkingStartTime ? Math.floor((Date.now() - pending.thinkingStartTime) / 1000) : pending?.thinkingElapsed || 0;
      view.timer.textContent = elapsed > 0 ? uiText(`${elapsed}s`, `${elapsed} 秒`) : "";
      if (this.wasThinking && !thinking) {
        view.block.classList.remove("chatpdf-reasoning-expanded");
        view.toggle.setAttribute("aria-expanded", "false");
      }
    } else {
      this.reasoning?.block.remove();
      this.reasoning = undefined;
    }
    this.wasThinking = thinking;

    const text = record.content || "";
    if (text) {
      if (!this.content) {
        this.content = h(this.doc, "div");
        this.element.append(this.content);
      }
      this.content.className = pending || finalContent ? "chatpdf-live-content" : "chatpdf-iteration-content";
      if (text !== this.text) {
        try { renderMarkdownInto(this.content, text); }
        catch { this.content.textContent = text; }
      }
    } else {
      this.content?.remove();
      this.content = undefined;
    }
    this.text = text;
    if (record.toolCalls !== this.toolCalls) {
      this.tools?.remove();
      this.tools = record.toolCalls.length ? createToolBlock(this.doc, record.toolCalls, record.toolCalls.reduce((sum, tool) => sum + tool.durationMs, 0)) : undefined;
      if (this.tools) this.element.append(this.tools);
      this.toolCalls = record.toolCalls;
    }
    this.element.hidden = !this.element.childElementCount;
  }
}

export function createIterationBlock(doc: Document, record: IterationRecord, index: number): HTMLElement {
  const view = new IterationView(doc, index);
  view.update(record);
  return view.element;
}

/** Retain completed DOM nodes and disclosure state across stream updates. */
export class AssistantMessageView {
  readonly row: HTMLElement;
  readonly bubble: HTMLElement;
  private iterations: IterationView[] = [];
  private current?: IterationView;
  private dots: HTMLElement;
  private progress: HTMLElement;
  private footer: HTMLElement;
  private copy?: HTMLElement;
  private snapshot: AssistantMessageSnapshot = { content: "" };

  constructor(private doc: Document) {
    this.row = h(doc, "div", { className: "chatpdf-msg-row chatpdf-msg-row-assistant" });
    this.bubble = h(doc, "div", { className: "chatpdf-message chatpdf-message-assistant" });
    this.dots = h(doc, "div", { className: "chatpdf-thinking", "aria-label": uiLabel("thinking") }, h(doc, "span"), h(doc, "span"), h(doc, "span"));
    this.progress = h(doc, "div", { className: "chatpdf-tool-status", role: "status" });
    this.footer = h(doc, "div", { className: "chatpdf-msg-footer" });
    this.bubble.append(this.dots, this.progress, this.footer);
    this.row.append(h(doc, "div", { className: "chatpdf-avatar chatpdf-avatar-assistant", "aria-hidden": "true" }, "✦"), this.bubble);
  }

  update(snapshot: AssistantMessageSnapshot): void {
    this.snapshot = snapshot;
    const records = snapshot.iterations || [];
    for (let index = this.iterations.length; index < records.length; index++) {
      const view = this.current || new IterationView(this.doc, index);
      this.current = undefined;
      view.update(records[index]);
      this.bubble.insertBefore(view.element, this.dots.parentNode ? this.dots : this.footer);
      this.iterations.push(view);
    }
    if (!this.current) {
      this.current = new IterationView(this.doc, records.length);
      this.bubble.insertBefore(this.current.element, this.dots.parentNode ? this.dots : this.footer);
    }
    this.current.update({ content: snapshot.content, reasoning: snapshot.reasoning, toolCalls: [] }, snapshot.pending, true);
    const waiting = !!snapshot.pending && !snapshot.content && !snapshot.reasoning && !snapshot.pending.status;
    this.dots.hidden = !waiting;
    this.progress.hidden = !snapshot.pending?.status;
    this.progress.textContent = snapshot.pending?.status || "";
    this.row.setAttribute("aria-busy", String(!!snapshot.pending));
    if (snapshot.pending) return;

    this.dots.remove();
    this.progress.remove();
    this.row.dataset.status = snapshot.status || "complete";
    this.footer.replaceChildren();
    if (snapshot.status === "cancelled") this.footer.append(h(this.doc, "div", { className: "chatpdf-stopped-marker" }, uiText("Generation stopped", "已停止生成")));
    const meta = h(this.doc, "div", { className: "chatpdf-msg-meta" });
    if (snapshot.timestamp) meta.append(h(this.doc, "span", { className: "chatpdf-msg-time chatpdf-msg-time-assistant" }, formatMsgTime(snapshot.timestamp)));
    if (snapshot.modelLabel) meta.append(h(this.doc, "span", { className: "chatpdf-msg-model-label" }, snapshot.modelLabel));
    if (meta.childElementCount) this.footer.append(meta);
    appendUsageMeta(this.footer, snapshot.usage);
    this.footer.hidden = !this.footer.childElementCount;
    if (!this.copy) {
      this.copy = createCopyButton(this.doc, () => visibleAssistantText(this.snapshot.content, this.snapshot.iterations));
      this.row.append(this.copy);
    }
  }
}
