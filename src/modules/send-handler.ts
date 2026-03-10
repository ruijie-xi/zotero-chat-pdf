import { h, scrollToBottomIfNeeded } from "../utils/dom";
import { formatToolStatus } from "../utils/format";
import { getPref } from "../utils/prefs";
import { chat as llmChat, StreamCallback, ThinkingCallback, ChatMessage, TokenUsage, IterationRecord } from "./llm-client";
import { runAgentLoop, AgentCallbacks } from "./agent-loop";
import { getToolDefinitions } from "./tools";
import { renderMarkdown } from "./markdown-renderer";
import { logLLMRequest, logLLMResponse } from "./debug-log";
import * as ChatHistory from "./chat-history";
import { ToolCallRecord } from "./chat-session";
import {
  session, setSession, chatInput, isStreaming, setIsStreaming,
  currentAbortController, setCurrentAbortController,
  backgroundStreams, StreamState,
  abortCurrentStream, createAbortController,
  setSendButtonToStop, setSendButtonToSend,
  showingHistory,
} from "./panel-state";
import { appendMessage, createToolBlock, updateUsageBar, renderChatHistory } from "./message-renderer";
import { refreshSourceChips, convertSource } from "./source-chips";

/** Auto-save the current session to disk. */
export async function autoSaveSession(): Promise<void> {
  if (!session.hasMessages()) return;
  try {
    await ChatHistory.saveSession(session.toSavedSession());
  } catch (err: any) {
    Zotero.debug(`[ChatPDF] autoSaveSession error: ${err.message}`);
  }
}

/** Extract plain text and mention source keys from the TipTap editor. */
function extractInputContent(_root: HTMLElement): { text: string; sourceKeys: string[] } {
  if (!chatInput) return { text: "", sourceKeys: [] };
  return { text: chatInput.getText(), sourceKeys: chatInput.getMentionKeys() };
}

/** Clear the TipTap editor. */
function clearEditableInput(_root: HTMLElement): void {
  if (chatInput) chatInput.clear();
}

/** Get the current model profile name. */
function getCurrentProfileName(): string {
  return (getPref("activeProfile") as string) || "";
}

/** Generate an LLM-based title for a session. */
async function generateTitle(targetSession: import("./chat-session").ChatSession): Promise<void> {
  if (targetSession.titleSource === "user") return;
  const history = targetSession.getHistory();
  if (history.length < 2) return;

  const firstUser = history.find(m => m.role === "user");
  const firstAssistant = history.find(m => m.role === "assistant");
  if (!firstUser || !firstAssistant) return;

  try {
    const titleMessages: ChatMessage[] = [
      {
        role: "system",
        content: "Generate a concise, specific title for this conversation. Detect the language of the user's message and reply in that same language. Reply with ONLY the title text \u2014 no quotes, no punctuation at the end, maximum 50 characters.",
      },
      {
        role: "user",
        content: `User: ${firstUser.content.slice(0, 300)}\n\nAssistant: ${firstAssistant.content.slice(0, 300)}`,
      },
    ];

    const title = (await llmChat(titleMessages)).trim().slice(0, 50);
    if (!title) return;

    targetSession.title = title;
    targetSession.titleSource = "llm";
    await ChatHistory.saveSession(targetSession.toSavedSession());
    Zotero.debug(`[ChatPDF] Generated title: "${title}"`);

    if (showingHistory) {
      const { loadHistoryList } = await import("./history-view");
      for (const win of Zotero.getMainWindows()) {
        const root = (win as any).document?.querySelector("#chatpdf-root") as HTMLElement | null;
        if (root) loadHistoryList(root);
      }
    }
  } catch (err: any) {
    Zotero.debug(`[ChatPDF] generateTitle failed: ${err.message}`);
  }
}

/** Convert all pending sources then send -- triggered by Ctrl+Enter. */
export async function handleConvertAndSend(root: HTMLElement): Promise<void> {
  const pendingSources = session.getSources().filter(s => s.status === "pending");
  if (pendingSources.length === 0) {
    handleSend(root);
    return;
  }

  const sendBtn = root.querySelector("#chatpdf-send") as HTMLButtonElement;
  if (chatInput) chatInput.setEditable(false);
  if (sendBtn) sendBtn.disabled = true;

  try {
    await Promise.all(
      pendingSources.map(s => convertSource(s, () => refreshSourceChips(root)).catch(() => {}))
    );
  } finally {
    if (chatInput) chatInput.setEditable(true);
    if (sendBtn) sendBtn.disabled = false;
  }

  handleSend(root);
}

/** Main send handler -- builds messages, calls LLM, renders streaming response. */
export async function handleSend(root: HTMLElement): Promise<void> {
  const sendBtn = root.querySelector("#chatpdf-send") as HTMLButtonElement;
  if (!chatInput || !sendBtn) return;

  const { text: userText } = extractInputContent(root);
  if (!userText) return;

  Zotero.debug(`[ChatPDF] handleSend: userText="${userText.slice(0, 80)}"`);

  // Block sending when any source is pending or converting
  const notReady = session.getSources().filter((s) => s.status === "pending" || s.status === "converting");
  if (notReady.length > 0) {
    const existing = root.querySelector(".chatpdf-send-warning");
    if (existing) existing.remove();
    const doc = root.ownerDocument!;
    const warning = h(doc, "div", { className: "chatpdf-send-warning" },
      `Cannot send: ${notReady.length} source${notReady.length > 1 ? "s" : ""} still pending or converting. Please convert or remove them first.`);
    const inputArea = root.querySelector("#chatpdf-input-area");
    if (inputArea) inputArea.insertBefore(warning, inputArea.firstChild);
    const win = doc.defaultView!;
    win.setTimeout(() => warning.remove(), 4000);
    return;
  }

  abortCurrentStream();

  const streamSession = session;
  const streamSessionId = streamSession.id;

  clearEditableInput(root);

  // Snapshot ready sources at send time
  const msgSources = streamSession.getSources()
    .filter(s => s.status === "ready")
    .map(s => ({ key: s.key, title: s.title, ...(s.parentKey ? { parentKey: s.parentKey } : {}) }));

  const userMsgIndex = streamSession.getHistoryLength();
  const userMsgTimestamp = Date.now();
  appendMessage(root, "user", userText, userMsgIndex, undefined, userMsgTimestamp, msgSources);

  chatInput.setEditable(false);
  setIsStreaming(true);
  const { controller, signal } = createAbortController();
  setCurrentAbortController(controller);
  setSendButtonToStop(sendBtn);

  const streamState: StreamState = {
    session: streamSession,
    abortController: controller,
    fullText: "",
    fullReasoning: "",
    thinkingDone: false,
    thinkingElapsed: 0,
    thinkingStartTime: 0,
    iterations: [],
  };
  backgroundStreams.set(streamSessionId, streamState);

  const doc = root.ownerDocument!;

  let fullText = "";
  let fullReasoning = "";
  let agentToolHistory: ToolCallRecord[] | undefined;
  let agentIterations: IterationRecord[] | undefined;
  let agentUsage: TokenUsage | undefined;

  try {
    Zotero.debug("[ChatPDF] handleSend: building messages...");
    const model = (getPref("llmModel") as string) || "deepseek-chat";
    const profileName = getCurrentProfileName();
    const modelLabel = profileName ? `${profileName} / ${model}` : model;

    const assistantMsgIndex = streamSession.getHistoryLength();
    Zotero.debug(`[ChatPDF] handleSend: creating assistant row (index=${assistantMsgIndex})`);
    const row = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
    row.className = "chatpdf-msg-row chatpdf-msg-row-assistant";
    row.dataset.msgIndex = String(assistantMsgIndex);

    const avatar = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
    avatar.className = "chatpdf-avatar chatpdf-avatar-assistant";
    avatar.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`;
    row.appendChild(avatar);

    const bubble = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
    bubble.className = "chatpdf-message chatpdf-message-assistant";

    const thinkingDots = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
    thinkingDots.className = "chatpdf-thinking";
    for (let i = 0; i < 3; i++) {
      thinkingDots.appendChild(doc.createElementNS("http://www.w3.org/1999/xhtml", "span"));
    }
    bubble.appendChild(thinkingDots);

    row.appendChild(bubble);
    const messagesEl = root.querySelector("#chatpdf-messages");
    messagesEl?.appendChild(row);
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;

    const win = doc.defaultView!;

    const isActiveSession = () => session === streamSession && row.isConnected;

    function setBubbleHtml(text: string) {
      try {
        const rendered = renderMarkdown(text);
        if (thinkingDots.parentNode) thinkingDots.remove();
        const blocks = bubble.querySelectorAll(".chatpdf-iteration-block, .chatpdf-reasoning-block, .chatpdf-tool-block, .chatpdf-tool-status");
        if (blocks.length > 0) {
          const lastBlock = blocks[blocks.length - 1];
          while (lastBlock.nextSibling) lastBlock.nextSibling.remove();
          const contentWrap = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
          contentWrap.innerHTML = rendered;
          bubble.appendChild(contentWrap);
        } else {
          bubble.innerHTML = rendered;
        }
      } catch {
        bubble.textContent = text;
      }
    }

    const enableAgentMode = (getPref("enableAgentMode") as boolean | undefined) ?? true;
    Zotero.debug(`[ChatPDF] handleSend: enableAgentMode=${enableAgentMode}`);

    if (enableAgentMode) {
      // ---- Agent mode ----
      const messages = streamSession.buildAgentMessages(userText);
      streamSession.addUserMessage(userText, msgSources);

      ChatHistory.saveSession(streamSession.toSavedSession()).catch((e: any) => {
        Zotero.debug(`[ChatPDF] early save error: ${e.message}`);
      });

      const tools = getToolDefinitions(streamSession);
      Zotero.debug(`[ChatPDF] handleSend: agent mode, ${tools.length} tools available`);

      logLLMRequest(messages, model).catch(() => {});
      row.dataset.msgIndex = String(assistantMsgIndex);

      const statusDiv = h(doc, "div", { className: "chatpdf-tool-status" });
      statusDiv.style.display = "none";
      bubble.appendChild(statusDiv);

      // Per-iteration streaming thinking blocks
      let curThinkBlock: HTMLElement | null = null;
      let curThinkContent: HTMLElement | null = null;
      let curThinkLabel: HTMLElement | null = null;
      let curThinkTimer: HTMLElement | null = null;
      let curThinkSpinner: HTMLElement | null = null;
      let curThinkStartTime = 0;
      let curThinkInterval: number | null = null;
      let curThinkRenderTimer: number | null = null;
      let curIterReasoning = "";
      let agentRenderTimer: number | null = null;

      function finalizeThinkingBlock() {
        if (!curThinkBlock) return;
        const elapsed = curThinkStartTime ? Math.floor((Date.now() - curThinkStartTime) / 1000) : 0;
        if (curThinkInterval) { win.clearInterval(curThinkInterval); curThinkInterval = null; }
        if (curThinkRenderTimer) { win.clearTimeout(curThinkRenderTimer); curThinkRenderTimer = null; }
        if (isActiveSession()) {
          if (curThinkContent) curThinkContent.textContent = curIterReasoning;
          if (curThinkSpinner) curThinkSpinner.remove();
          if (curThinkLabel && elapsed > 0) curThinkLabel.textContent = "Thought";
          if (curThinkTimer && elapsed > 0) curThinkTimer.textContent = `${elapsed}s`;
          if (curThinkBlock) curThinkBlock.classList.remove("chatpdf-reasoning-expanded");
        }
        curThinkBlock = null;
        curThinkContent = null;
        curThinkLabel = null;
        curThinkTimer = null;
        curThinkSpinner = null;
      }

      function createThinkingBlock() {
        finalizeThinkingBlock();
        curIterReasoning = "";

        curThinkBlock = h(doc, "div", { className: "chatpdf-reasoning-block chatpdf-reasoning-expanded" });
        const toggle = h(doc, "button", { className: "chatpdf-reasoning-toggle" });
        const chevron = h(doc, "span", { className: "chatpdf-reasoning-chevron" }, "\u25B6");
        curThinkLabel = h(doc, "span", { className: "chatpdf-reasoning-label" }, "Thinking");
        curThinkSpinner = h(doc, "span", { className: "chatpdf-reasoning-spinner" });
        curThinkTimer = h(doc, "span", { className: "chatpdf-reasoning-timer" }, "0s");
        toggle.appendChild(chevron);
        toggle.appendChild(curThinkSpinner);
        toggle.appendChild(curThinkLabel);
        toggle.appendChild(curThinkTimer);
        const block = curThinkBlock;
        toggle.addEventListener("click", () => {
          block.classList.toggle("chatpdf-reasoning-expanded");
        });
        curThinkContent = h(doc, "div", { className: "chatpdf-reasoning-content" });
        curThinkBlock.appendChild(toggle);
        curThinkBlock.appendChild(curThinkContent);

        if (thinkingDots.parentNode) thinkingDots.remove();
        if (statusDiv.parentNode) statusDiv.remove();
        bubble.appendChild(curThinkBlock);

        curThinkStartTime = Date.now();
        streamState.thinkingStartTime = curThinkStartTime;
        curThinkInterval = win.setInterval(() => {
          const elapsed = Math.floor((Date.now() - curThinkStartTime) / 1000);
          if (curThinkTimer) curThinkTimer.textContent = `${elapsed}s`;
        }, 1000) as unknown as number;
      }

      const agentCallbacks: AgentCallbacks = {
        onIterationComplete: (iter: number, max: number, record: IterationRecord) => {
          Zotero.debug(`[ChatPDF] handleSend: iteration ${iter}/${max} complete, tools=${record.toolCalls.length}`);
          streamState.iterations.push(record);
          if (!isActiveSession()) return;

          if (record.toolCalls.length > 0) {
            if (statusDiv.parentNode) statusDiv.remove();
            const totalMs = record.toolCalls.reduce((sum, t) => sum + t.durationMs, 0);
            const toolBlock = createToolBlock(doc, record.toolCalls, totalMs);
            bubble.appendChild(toolBlock);
          }

          statusDiv.style.display = "";
          statusDiv.textContent = `Step ${iter}/${max}`;
          bubble.appendChild(statusDiv);
          if (messagesEl) scrollToBottomIfNeeded(messagesEl);
        },
        onToolCallStart: (name: string, args: Record<string, unknown>) => {
          const label = formatToolStatus(name, args, streamSession);
          Zotero.debug(`[ChatPDF] handleSend: tool start: ${label}`);
          if (!isActiveSession()) return;
          statusDiv.style.display = "";
          statusDiv.textContent = label;
          if (messagesEl) scrollToBottomIfNeeded(messagesEl);
        },
        onToolCallEnd: (name: string, _result: string, durationMs: number) => {
          Zotero.debug(`[ChatPDF] handleSend: tool end: ${name} (${durationMs}ms)`);
        },
        onThinking: (chunk: string, done: boolean, isNewBlock: boolean) => {
          try {
            if (isNewBlock) {
              if (!isActiveSession()) return;
              createThinkingBlock();
            }
            if (!done) {
              curIterReasoning += chunk;
              fullReasoning += chunk;
              streamState.fullReasoning = fullReasoning;
              if (!isActiveSession()) return;
              if (!curThinkRenderTimer) {
                curThinkRenderTimer = win.setTimeout(() => {
                  curThinkRenderTimer = null;
                  if (!isActiveSession()) return;
                  if (curThinkContent) curThinkContent.textContent = curIterReasoning;
                  if (messagesEl) scrollToBottomIfNeeded(messagesEl);
                }, 80) as unknown as number;
              }
            } else {
              streamState.thinkingDone = true;
              finalizeThinkingBlock();
            }
          } catch (cbErr) {
            Zotero.debug(`[ChatPDF] agent thinking callback error: ${cbErr}`);
          }
        },
        onStream: (chunk: string, done: boolean) => {
          try {
            if (!done) {
              fullText += chunk;
              streamState.fullText = fullText;
              if (!isActiveSession()) return;
              if (thinkingDots.parentNode) thinkingDots.remove();
              if (statusDiv.parentNode) statusDiv.remove();
              if (!agentRenderTimer) {
                agentRenderTimer = win.setTimeout(() => {
                  agentRenderTimer = null;
                  if (!isActiveSession()) return;
                  setBubbleHtml(fullText);
                  if (messagesEl) scrollToBottomIfNeeded(messagesEl);
                }, 80) as unknown as number;
              }
            } else {
              if (agentRenderTimer) { win.clearTimeout(agentRenderTimer); agentRenderTimer = null; }
              if (isActiveSession()) {
                setBubbleHtml(fullText);
                if (messagesEl) scrollToBottomIfNeeded(messagesEl);
              }
            }
          } catch (cbErr) {
            Zotero.debug(`[ChatPDF] agent stream callback error: ${cbErr}`);
          }
        },
      };

      const agentResult = await runAgentLoop(messages, tools, streamSession, agentCallbacks, signal);
      fullText = agentResult.content;
      fullReasoning = agentResult.reasoning || "";
      agentToolHistory = undefined;
      agentIterations = agentResult.iterations;
      agentUsage = agentResult.usage;
      streamState.fullText = fullText;

      finalizeThinkingBlock();
      if (agentRenderTimer) win.clearTimeout(agentRenderTimer);

      Zotero.debug(`[ChatPDF] handleSend: agent result: ${fullText.length} chars, ${agentResult.iterations.length} iterations, totalIter=${agentResult.totalIterations}`);

      if (isActiveSession()) {
        if (statusDiv.parentNode) statusDiv.remove();
        setBubbleHtml(fullText);
        if (messagesEl) scrollToBottomIfNeeded(messagesEl);

        const copyBtn = doc.createElementNS("http://www.w3.org/1999/xhtml", "button") as HTMLElement;
        copyBtn.className = "chatpdf-copy-btn";
        copyBtn.title = "Copy as Markdown";
        copyBtn.textContent = "Copy";
        copyBtn.addEventListener("click", (e: Event) => {
          e.stopPropagation();
          (win as any).navigator.clipboard.writeText(fullText).then(() => {
            copyBtn.textContent = "Copied!";
            win.setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
          }).catch(() => {
            copyBtn.textContent = "Failed";
            win.setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
          });
        });
        row.appendChild(copyBtn);
        if (agentResult.usage) updateUsageBar(root, agentResult.usage);
      }

      logLLMResponse(fullText, fullReasoning || undefined).catch(() => {});

    } else {
      // ---- Non-agent mode (classic full-context path) ----
      const messages = streamSession.buildMessages(userText);
      streamSession.addUserMessage(userText, msgSources);

      ChatHistory.saveSession(streamSession.toSavedSession()).catch((e: any) => {
        Zotero.debug(`[ChatPDF] early save error: ${e.message}`);
      });

      logLLMRequest(messages, model).catch(() => {});

      row.dataset.msgIndex = String(assistantMsgIndex);
      Zotero.debug(`[ChatPDF] handleSend: classic mode, calling LLM...`);

      // ---- Reasoning/Thinking block ----
      let reasoningBlock: HTMLElement | null = null;
      let reasoningContent: HTMLElement | null = null;
      let reasoningLabel: HTMLElement | null = null;
      let reasoningTimer: HTMLElement | null = null;
      let reasoningSpinner: HTMLElement | null = null;
      let thinkingStartTime = 0;
      let thinkingTimerInterval: number | null = null;
      let reasoningRenderTimer: number | null = null;

      function createReasoningBlock() {
        reasoningBlock = h(doc, "div", { className: "chatpdf-reasoning-block" });
        const toggle = h(doc, "button", { className: "chatpdf-reasoning-toggle" });
        const chevron = h(doc, "span", { className: "chatpdf-reasoning-chevron" }, "\u25B6");
        reasoningLabel = h(doc, "span", { className: "chatpdf-reasoning-label" }, "Thinking");
        reasoningSpinner = h(doc, "span", { className: "chatpdf-reasoning-spinner" });
        reasoningTimer = h(doc, "span", { className: "chatpdf-reasoning-timer" }, "0s");
        toggle.appendChild(chevron);
        toggle.appendChild(reasoningSpinner);
        toggle.appendChild(reasoningLabel);
        toggle.appendChild(reasoningTimer);
        toggle.addEventListener("click", () => {
          reasoningBlock!.classList.toggle("chatpdf-reasoning-expanded");
        });
        reasoningContent = h(doc, "div", { className: "chatpdf-reasoning-content" });
        reasoningBlock.appendChild(toggle);
        reasoningBlock.appendChild(reasoningContent);
        bubble.insertBefore(reasoningBlock, bubble.firstChild);
        thinkingStartTime = Date.now();
        streamState.thinkingStartTime = thinkingStartTime;
        thinkingTimerInterval = win.setInterval(() => {
          const elapsed = Math.floor((Date.now() - thinkingStartTime) / 1000);
          if (reasoningTimer) reasoningTimer.textContent = `${elapsed}s`;
        }, 1000) as unknown as number;
      }

      const onThinking: ThinkingCallback = (chunk: string, done: boolean) => {
        try {
          if (!done) {
            fullReasoning += chunk;
            streamState.fullReasoning = fullReasoning;
            if (!isActiveSession()) return;
            if (thinkingDots.parentNode) thinkingDots.remove();
            if (!reasoningBlock) createReasoningBlock();
            if (!reasoningRenderTimer) {
              reasoningRenderTimer = win.setTimeout(() => {
                reasoningRenderTimer = null;
                if (!isActiveSession()) return;
                if (reasoningContent) reasoningContent.textContent = fullReasoning;
                if (messagesEl) scrollToBottomIfNeeded(messagesEl);
              }, 80) as unknown as number;
            }
          } else {
            const elapsed = thinkingStartTime ? Math.floor((Date.now() - thinkingStartTime) / 1000) : 0;
            streamState.thinkingDone = true;
            streamState.thinkingElapsed = elapsed;
            if (thinkingTimerInterval) {
              win.clearInterval(thinkingTimerInterval);
              thinkingTimerInterval = null;
            }
            if (reasoningRenderTimer) {
              win.clearTimeout(reasoningRenderTimer);
              reasoningRenderTimer = null;
            }
            if (isActiveSession()) {
              if (reasoningContent) reasoningContent.textContent = fullReasoning;
              if (reasoningSpinner) reasoningSpinner.remove();
              if (reasoningLabel && elapsed > 0) reasoningLabel.textContent = "Thought";
              if (reasoningTimer && elapsed > 0) reasoningTimer.textContent = `${elapsed}s`;
              if (reasoningBlock) reasoningBlock.classList.remove("chatpdf-reasoning-expanded");
            }
          }
        } catch (cbErr) {
          Zotero.debug(`[ChatPDF] thinking callback error: ${cbErr}`);
        }
      };

      let renderTimer: number | null = null;

      const fullResponse = await llmChat(messages, (chunk: string, done: boolean) => {
        try {
          if (!done) {
            fullText += chunk;
            streamState.fullText = fullText;
            if (!isActiveSession()) return;
            if (thinkingDots.parentNode) thinkingDots.remove();
            if (!renderTimer) {
              renderTimer = win.setTimeout(() => {
                renderTimer = null;
                if (!isActiveSession()) return;
                setBubbleHtml(fullText);
                if (messagesEl) scrollToBottomIfNeeded(messagesEl);
              }, 80) as unknown as number;
            }
          } else {
            if (renderTimer) {
              win.clearTimeout(renderTimer);
              renderTimer = null;
            }
            if (isActiveSession()) {
              setBubbleHtml(fullText);
              if (messagesEl) scrollToBottomIfNeeded(messagesEl);
            }
          }
        } catch (cbErr) {
          Zotero.debug(`[ChatPDF] stream content callback error: ${cbErr}`);
        }
      }, onThinking, signal, (u: TokenUsage) => {
        agentUsage = u;
        if (isActiveSession()) updateUsageBar(root, u);
      });

      if (thinkingTimerInterval) win.clearInterval(thinkingTimerInterval);

      fullText = fullResponse;
      Zotero.debug(`[ChatPDF] handleSend: LLM response received, ${fullResponse.length} chars`);

      if (isActiveSession()) {
        const copyBtn = doc.createElementNS("http://www.w3.org/1999/xhtml", "button") as HTMLElement;
        copyBtn.className = "chatpdf-copy-btn";
        copyBtn.title = "Copy as Markdown";
        copyBtn.textContent = "Copy";
        copyBtn.addEventListener("click", (e: Event) => {
          e.stopPropagation();
          (win as any).navigator.clipboard.writeText(fullResponse).then(() => {
            copyBtn.textContent = "Copied!";
            win.setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
          }).catch(() => {
            copyBtn.textContent = "Failed";
            win.setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
          });
        });
        row.appendChild(copyBtn);
      }

      logLLMResponse(fullResponse, fullReasoning || undefined).catch(() => {});
    }

    streamSession.addAssistantMessage(fullText, fullReasoning || undefined, modelLabel, agentToolHistory, agentIterations, agentUsage);
    if (isActiveSession()) {
      refreshSourceChips(root);
    }
    try {
      await ChatHistory.saveSession(streamSession.toSavedSession());
    } catch (saveErr: any) {
      Zotero.debug(`[ChatPDF] autoSaveSession error: ${saveErr.message}`);
    }

    if (streamSession.getHistoryLength() === 2 && streamSession.titleSource !== "user") {
      generateTitle(streamSession).catch(err => Zotero.debug(`[ChatPDF] generateTitle error: ${err.message}`));
    }

    Zotero.debug(`[ChatPDF] Background stream completed for session ${streamSessionId}, isActive=${isActiveSession()}`);

    if (!isActiveSession() && session.id === streamSessionId) {
      Zotero.debug(`[ChatPDF] User returned to streaming session — refreshing display`);
      setSession(streamSession);
      const msgs = root.querySelector("#chatpdf-messages");
      if (msgs) msgs.innerHTML = "";
      renderChatHistory(root);
      refreshSourceChips(root);
    }
  } catch (err: any) {
    Zotero.debug(`[ChatPDF] handleSend error: ${err?.name}: ${err?.message}\n${err?.stack}`);
    if (err.name === "AbortError") {
      if (session === streamSession) {
        const messagesEl = root.querySelector("#chatpdf-messages");
        const lastBubble = messagesEl?.querySelector(".chatpdf-msg-row-assistant:last-child .chatpdf-message-assistant") as HTMLElement;
        if (lastBubble) {
          const stoppedMarker = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
          stoppedMarker.className = "chatpdf-stopped-marker";
          stoppedMarker.textContent = "[Generation stopped]";
          lastBubble.appendChild(stoppedMarker);
        }
      }
      if (fullText) {
        streamSession.addAssistantMessage(fullText, fullReasoning || undefined);
      }
      try {
        await ChatHistory.saveSession(streamSession.toSavedSession());
      } catch (saveErr: any) {
        Zotero.debug(`[ChatPDF] autoSaveSession error: ${saveErr.message}`);
      }
    } else {
      if (session === streamSession) {
        appendMessage(root, "assistant", `Error: ${err.message}`);
      }
    }
  } finally {
    backgroundStreams.delete(streamSessionId);
    setIsStreaming(false);
    setCurrentAbortController(null);
    if (session === streamSession) {
      if (chatInput) { chatInput.setEditable(true); chatInput.focus(); }
      setSendButtonToSend(sendBtn);
    }
  }
}
