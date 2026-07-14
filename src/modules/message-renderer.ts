import { h, scrollToBottomIfNeeded } from "../utils/dom";
import { formatTokens, formatMsgTime } from "../utils/format";
import { renderMarkdown } from "./markdown-renderer";
import { TokenUsage, IterationRecord } from "./llm-client";
import { ToolCallRecord } from "./chat-session";
import { getPanelState, StreamState } from "./panel-state";
import { handleSend } from "./send-handler";
import { openPdfForSourceKey } from "./zotero-items";

// Re-export for use by other modules
export { refreshSourceChips } from "./source-chips";

/** Render small per-message source chips (right-aligned, for user messages). */
function renderMsgSources(doc: Document, sources: { key: string; libraryID?: number; title: string }[]): HTMLElement {
  const container = h(doc, "div", { className: "chatpdf-msg-sources" });
  for (const src of sources) {
    const chip = h(doc, "button", { className: "chatpdf-msg-source-chip", title: `Open PDF: ${src.title}` }, src.title);
    chip.addEventListener("click", (e: Event) => {
      e.stopPropagation();
      openPdfForSourceKey(src.key, src.libraryID).catch((err: any) => {
        Zotero.debug(`[ChatPDF] open message source failed for ${src.key}: ${err.message}`);
      });
    });
    container.appendChild(chip);
  }
  return container;
}

/** Create a copy button for assistant messages. */
function createCopyButton(doc: Document, rawMarkdown: string): HTMLElement {
  const btn = h(doc, "button", { className: "chatpdf-copy-btn", title: "Copy as Markdown" }, "Copy");
  btn.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    const win = doc.defaultView!;
    (win as any).navigator.clipboard.writeText(rawMarkdown).then(() => {
      btn.textContent = "Copied!";
      win.setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    }).catch(() => {
      btn.textContent = "Failed";
      win.setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    });
  });
  return btn;
}

/** Create a collapsible tool call block for display in the assistant bubble. */
export function createToolBlock(doc: Document, toolHistory: ToolCallRecord[], totalMs: number): HTMLElement {
  const block = h(doc, "div", { className: "chatpdf-tool-block" });
  const toggle = h(doc, "button", { className: "chatpdf-tool-toggle" });
  toggle.textContent = `Used ${toolHistory.length} tool${toolHistory.length !== 1 ? "s" : ""} \u00B7 ${(totalMs / 1000).toFixed(1)}s`;
  const content = h(doc, "div", { className: "chatpdf-tool-content" });

  for (let i = 0; i < toolHistory.length; i++) {
    const tr = toolHistory[i];
    const entry = h(doc, "div", { className: "chatpdf-tool-entry" });
    const argsStr = JSON.stringify(tr.args);
    const nameRow = h(doc, "div", { className: "chatpdf-tool-name" }, `${i + 1}. ${tr.toolName}`);
    entry.appendChild(nameRow);
    if (argsStr !== "{}") {
      entry.appendChild(h(doc, "div", { className: "chatpdf-tool-args" }, argsStr));
    }
    entry.appendChild(h(doc, "div", { className: "chatpdf-tool-result" }, tr.result));
    entry.appendChild(h(doc, "div", { className: "chatpdf-tool-duration" }, `${tr.durationMs}ms`));
    content.appendChild(entry);
  }

  toggle.addEventListener("click", () => {
    block.classList.toggle("chatpdf-tool-block-expanded");
  });
  block.appendChild(toggle);
  block.appendChild(content);
  return block;
}

/** Create a block for a single agent iteration (reasoning + tool calls). */
export function createIterationBlock(doc: Document, record: IterationRecord, iterIndex: number): HTMLElement {
  const block = h(doc, "div", { className: "chatpdf-iteration-block" });

  // Reasoning (collapsed by default)
  if (record.reasoning) {
    const reasoningBlock = h(doc, "div", { className: "chatpdf-reasoning-block" });
    const toggle = h(doc, "button", { className: "chatpdf-reasoning-toggle" });
    const chevron = h(doc, "span", { className: "chatpdf-reasoning-chevron" }, "\u25B6");
    const label = h(doc, "span", { className: "chatpdf-reasoning-label" }, `Thought (step ${iterIndex + 1})`);
    toggle.appendChild(chevron);
    toggle.appendChild(label);
    toggle.addEventListener("click", () => {
      reasoningBlock.classList.toggle("chatpdf-reasoning-expanded");
    });
    const content = h(doc, "div", { className: "chatpdf-reasoning-content" });
    content.textContent = record.reasoning;
    reasoningBlock.appendChild(toggle);
    reasoningBlock.appendChild(content);
    block.appendChild(reasoningBlock);
  }

  // Tool calls
  if (record.toolCalls.length > 0) {
    const totalMs = record.toolCalls.reduce((sum, t) => sum + t.durationMs, 0);
    const toolBlock = createToolBlock(doc, record.toolCalls, totalMs);
    block.appendChild(toolBlock);
  }

  return block;
}

/** Render token usage bar. */
export function updateUsageBar(root: HTMLElement, usage?: TokenUsage): void {
  const bar = root.querySelector("#chatpdf-usage-bar") as HTMLElement | null;
  if (!bar) return;
  const text = formatUsageText(usage);
  if (!text) {
    bar.style.display = "none";
    return;
  }
  bar.style.display = "";
  bar.textContent = text;
}

export function formatUsageText(usage?: TokenUsage): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (usage.prompt_tokens) parts.push(`In: ${formatTokens(usage.prompt_tokens)}`);
  if (usage.completion_tokens) parts.push(`Out: ${formatTokens(usage.completion_tokens)}`);
  if (usage.completion_tokens_details?.reasoning_tokens) {
    parts.push(`Reasoning: ${formatTokens(usage.completion_tokens_details.reasoning_tokens)}`);
  }
  if (usage.total_tokens) parts.push(`Total: ${formatTokens(usage.total_tokens)}`);
  if (usage.prompt_cache_hit_tokens || usage.prompt_cache_miss_tokens) {
    const hit = usage.prompt_cache_hit_tokens || 0;
    const miss = usage.prompt_cache_miss_tokens || 0;
    parts.push(`Cache: ${formatTokens(hit)}/${formatTokens(miss)}`);
  }
  return parts.join(" \u00B7 ");
}

export function appendUsageMeta(container: HTMLElement, usage?: TokenUsage): void {
  const text = formatUsageText(usage);
  const existing = container.querySelector(".chatpdf-msg-usage");
  if (existing) existing.remove();
  if (!text) return;
  const doc = container.ownerDocument!;
  container.appendChild(h(doc, "div", { className: "chatpdf-msg-usage" }, text));
}

/** Append a message bubble to the messages area. */
export function appendMessage(root: HTMLElement, role: "user" | "assistant", content: string, msgIndex?: number, reasoning?: string, timestamp?: number, sources?: { key: string; libraryID?: number; title: string }[], modelLabel?: string, toolHistory?: ToolCallRecord[], iterations?: IterationRecord[], usage?: TokenUsage): HTMLElement {
  const messagesEl = root.querySelector("#chatpdf-messages");
  if (!messagesEl) return root;
  const doc = root.ownerDocument!;

  // Remove welcome message on first real message
  const welcome = messagesEl.querySelector(".chatpdf-welcome");
  if (welcome) welcome.remove();

  const row = h(doc, "div", { className: `chatpdf-msg-row chatpdf-msg-row-${role}` });
  if (msgIndex !== undefined) {
    row.dataset.msgIndex = String(msgIndex);
  }

  if (role === "assistant") {
    const avatar = h(doc, "div", { className: "chatpdf-avatar chatpdf-avatar-assistant" }, "\u2728");
    row.appendChild(avatar);
  }

  const bubble = h(doc, "div", { className: `chatpdf-message chatpdf-message-${role}` });

  if (role === "assistant") {
    // Render stacked iteration blocks (new format)
    if (iterations?.length) {
      for (let i = 0; i < iterations.length; i++) {
        const iterBlock = createIterationBlock(doc, iterations[i], i);
        bubble.appendChild(iterBlock);
      }
    } else {
      // Legacy: render reasoning/thinking block if available
      if (reasoning) {
        const reasoningBlock = h(doc, "div", { className: "chatpdf-reasoning-block" });
        const toggle = h(doc, "button", { className: "chatpdf-reasoning-toggle" });
        const chevron = h(doc, "span", { className: "chatpdf-reasoning-chevron" }, "\u25B6");
        const label = h(doc, "span", { className: "chatpdf-reasoning-label" }, "Thought");
        toggle.appendChild(chevron);
        toggle.appendChild(label);
        toggle.addEventListener("click", () => {
          reasoningBlock.classList.toggle("chatpdf-reasoning-expanded");
        });
        const reasoningContentEl = h(doc, "div", { className: "chatpdf-reasoning-content" });
        reasoningContentEl.textContent = reasoning;
        reasoningBlock.appendChild(toggle);
        reasoningBlock.appendChild(reasoningContentEl);
        bubble.appendChild(reasoningBlock);
      }

      // Legacy: render tool call block if tool history is available
      if (toolHistory?.length) {
        const totalMs = toolHistory.reduce((sum, t) => sum + t.durationMs, 0);
        const toolBlock = createToolBlock(doc, toolHistory, totalMs);
        bubble.appendChild(toolBlock);
      }
    }

    try {
      const contentWrap = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
      contentWrap.innerHTML = renderMarkdown(content);
      bubble.appendChild(contentWrap);
    } catch {
      bubble.appendChild(doc.createTextNode(content));
    }
    // Timestamp inside assistant bubble
    if (timestamp) {
      bubble.appendChild(h(doc, "div", { className: "chatpdf-msg-time chatpdf-msg-time-assistant" }, formatMsgTime(timestamp)));
    }
    // Model label under assistant bubble
    if (modelLabel) {
      bubble.appendChild(h(doc, "div", { className: "chatpdf-msg-model-label" }, modelLabel));
    }
    appendUsageMeta(bubble, usage);
    // Copy button for assistant messages
    row.appendChild(createCopyButton(doc, content));
    row.appendChild(bubble);
  } else {
    bubble.textContent = content;
    // Edit button for user messages
    const editBtn = h(doc, "button", { className: "chatpdf-edit-btn", title: "Edit" }, "\u270E");
    editBtn.addEventListener("click", (e: Event) => {
      e.stopPropagation();
      enterEditMode(root, row, bubble, content);
    });
    row.appendChild(editBtn);

    // Wrap bubble + timestamp + source chips in a column container
    const wrap = h(doc, "div", { className: "chatpdf-msg-user-wrap" });
    wrap.appendChild(bubble);
    if (timestamp) {
      wrap.appendChild(h(doc, "div", { className: "chatpdf-msg-time chatpdf-msg-time-user" }, formatMsgTime(timestamp)));
    }
    if (sources?.length) {
      wrap.appendChild(renderMsgSources(doc, sources));
    }
    row.appendChild(wrap);
  }

  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

/** Enter inline edit mode for a user message bubble. */
function enterEditMode(root: HTMLElement, row: HTMLElement, bubble: HTMLElement, originalText: string): void {
  const state = getPanelState(root);
  const { session } = state;
  const doc = root.ownerDocument!;

  bubble.style.display = "none";
  const editBtn = row.querySelector(".chatpdf-edit-btn") as HTMLElement;
  if (editBtn) editBtn.style.display = "none";

  const editArea = h(doc, "div", { className: "chatpdf-edit-area" });
  const editTextarea = h(doc, "textarea", { className: "chatpdf-edit-textarea" }) as HTMLTextAreaElement;
  editTextarea.value = originalText;
  editArea.appendChild(editTextarea);

  const actions = h(doc, "div", { className: "chatpdf-edit-actions" });
  const cancelBtn = h(doc, "button", { className: "chatpdf-edit-cancel-btn" }, "Cancel");
  const saveBtn = h(doc, "button", { className: "chatpdf-edit-save-btn" }, "Send");
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  editArea.appendChild(actions);

  row.appendChild(editArea);

  editTextarea.style.height = "auto";
  editTextarea.style.height = Math.min(editTextarea.scrollHeight, 120) + "px";
  editTextarea.focus();
  editTextarea.addEventListener("input", () => {
    editTextarea.style.height = "auto";
    editTextarea.style.height = Math.min(editTextarea.scrollHeight, 120) + "px";
  });

  function exitEdit() {
    editArea.remove();
    bubble.style.display = "";
    if (editBtn) editBtn.style.display = "";
  }

  cancelBtn.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    exitEdit();
  });

  saveBtn.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    const newText = editTextarea.value.trim();
    if (!newText) { exitEdit(); return; }

    const msgIndex = parseInt(row.dataset.msgIndex || "-1", 10);

    if (msgIndex === 0) {
      session.title = "";
      session.titleSource = "auto";
    }

    if (msgIndex >= 0) {
      session.truncateHistoryAt(msgIndex);
      // Import dynamically to avoid circular dep
      import("./send-handler").then(m => m.autoSaveSession(root));
    }

    // Clear all messages from DOM and re-render the remaining history
    const messagesEl = root.querySelector("#chatpdf-messages");
    if (messagesEl) {
      messagesEl.innerHTML = "";
      const remaining = session.getHistory();
      if (remaining.length > 0) {
        let idx = 0;
        for (const msg of remaining) {
          if (msg.role === "system") continue;
          appendMessage(root, msg.role as "user" | "assistant", msg.content, idx, msg.reasoning, msg.timestamp, msg.sources, msg.modelLabel, msg.toolHistory, msg.iterations, msg.usage);
          idx++;
        }
      }
    }

    state.chatInput?.setText(newText);
    handleSend(root);
  });

  editTextarea.addEventListener("keydown", (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" && !ke.shiftKey) {
      ke.preventDefault();
      saveBtn.click();
    }
    if (ke.key === "Escape") {
      ke.preventDefault();
      exitEdit();
    }
  });
}

/** Render all chat history messages in the current session. */
export function renderChatHistory(root: HTMLElement): void {
  const messagesEl = root.querySelector("#chatpdf-messages");
  if (!messagesEl) return;
  const history = getPanelState(root).session.getHistory();
  if (history.length > 0) {
    const welcome = messagesEl.querySelector(".chatpdf-welcome");
    if (welcome) welcome.remove();
    let msgIndex = 0;
    let lastUsage: TokenUsage | undefined;
    for (const msg of history) {
      if (msg.role === "system") continue;
      appendMessage(root, msg.role as "user" | "assistant", msg.content, msgIndex, msg.reasoning, msg.timestamp, msg.sources, msg.modelLabel, msg.toolHistory, msg.iterations, msg.usage);
      if (msg.usage) lastUsage = msg.usage;
      msgIndex++;
    }
    if (lastUsage) updateUsageBar(root, lastUsage);
  }
}

/**
 * Render the current state of a live background stream as an assistant bubble
 * and set up a polling interval to live-update as the stream progresses.
 */
export function renderLiveStreamState(root: HTMLElement, stream: StreamState): void {
  const panelState = getPanelState(root);
  const messagesEl = root.querySelector("#chatpdf-messages");
  if (!messagesEl) return;
  const doc = root.ownerDocument!;
  const win = doc.defaultView!;

  const row = h(doc, "div", { className: "chatpdf-msg-row chatpdf-msg-row-assistant" });
  row.id = "chatpdf-bg-stream-indicator";

  const avatar = h(doc, "div", { className: "chatpdf-avatar chatpdf-avatar-assistant" });
  avatar.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`;
  row.appendChild(avatar);

  const bubble = h(doc, "div", { className: "chatpdf-message chatpdf-message-assistant" });

  let reasoningBlock: HTMLElement | null = null;
  let reasoningContentEl: HTMLElement | null = null;
  let reasoningLabel: HTMLElement | null = null;
  let reasoningSpinner: HTMLElement | null = null;
  let reasoningTimerEl: HTMLElement | null = null;
  let contentWrap: HTMLElement | null = null;
  let dots: HTMLElement | null = null;

  let lastReasoningLen = 0;
  let lastTextLen = 0;
  let wasThinkingDone = false;

  function ensureReasoningBlock() {
    if (reasoningBlock) return;
    reasoningBlock = h(doc, "div", { className: "chatpdf-reasoning-block chatpdf-reasoning-expanded" });
    const toggle = h(doc, "button", { className: "chatpdf-reasoning-toggle" });
    const chevron = h(doc, "span", { className: "chatpdf-reasoning-chevron" }, "\u25B6");
    reasoningLabel = h(doc, "span", { className: "chatpdf-reasoning-label" }, "Thinking");
    reasoningSpinner = h(doc, "span", { className: "chatpdf-reasoning-spinner" });
    reasoningTimerEl = h(doc, "span", { className: "chatpdf-reasoning-timer" }, "0s");
    toggle.appendChild(chevron);
    toggle.appendChild(reasoningSpinner);
    toggle.appendChild(reasoningLabel);
    toggle.appendChild(reasoningTimerEl);
    toggle.addEventListener("click", () => {
      reasoningBlock!.classList.toggle("chatpdf-reasoning-expanded");
    });
    reasoningContentEl = h(doc, "div", { className: "chatpdf-reasoning-content" });
    reasoningBlock.appendChild(toggle);
    reasoningBlock.appendChild(reasoningContentEl);
    bubble.insertBefore(reasoningBlock, bubble.firstChild);
  }

  function updateReasoning() {
    if (!stream.fullReasoning) return;
    if (dots && dots.parentNode) dots.remove();
    ensureReasoningBlock();

    if (stream.fullReasoning.length !== lastReasoningLen) {
      reasoningContentEl!.textContent = stream.fullReasoning;
      lastReasoningLen = stream.fullReasoning.length;
      scrollToBottomIfNeeded(messagesEl!);
    }

    if (!stream.thinkingDone && stream.thinkingStartTime > 0 && reasoningTimerEl) {
      const elapsed = Math.floor((Date.now() - stream.thinkingStartTime) / 1000);
      reasoningTimerEl.textContent = `${elapsed}s`;
    }

    if (stream.thinkingDone && !wasThinkingDone) {
      wasThinkingDone = true;
      if (reasoningSpinner) reasoningSpinner.remove();
      if (reasoningLabel) reasoningLabel.textContent = "Thought";
      if (reasoningTimerEl) {
        reasoningTimerEl.textContent = stream.thinkingElapsed > 0 ? `${stream.thinkingElapsed}s` : "";
      }
      if (reasoningBlock) reasoningBlock.classList.remove("chatpdf-reasoning-expanded");
    }
  }

  function updateContent() {
    if (stream.fullText.length === lastTextLen) return;
    lastTextLen = stream.fullText.length;
    if (dots && dots.parentNode) dots.remove();
    if (!contentWrap) {
      contentWrap = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
      bubble.appendChild(contentWrap);
    }
    try {
      contentWrap.innerHTML = renderMarkdown(stream.fullText);
    } catch {
      contentWrap.textContent = stream.fullText;
    }
    scrollToBottomIfNeeded(messagesEl!);
  }

  updateReasoning();
  if (stream.thinkingDone) wasThinkingDone = true;
  updateContent();

  if (!stream.fullText) {
    dots = h(doc, "div", { className: "chatpdf-thinking" });
    for (let i = 0; i < 3; i++) {
      dots.appendChild(doc.createElementNS("http://www.w3.org/1999/xhtml", "span"));
    }
    bubble.appendChild(dots);
  }

  row.appendChild(bubble);
  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  const pollInterval = win.setInterval(() => {
    if (!panelState.backgroundStreams.has(stream.session.id) || !row.isConnected) {
      win.clearInterval(pollInterval);
      panelState.activePollIntervals.delete(pollInterval);
      return;
    }
    updateReasoning();
    updateContent();
  }, 100) as unknown as number;
  panelState.activePollIntervals.add(pollInterval);
}
