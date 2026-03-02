import { config } from "../../package.json";
import { ChatSession, SourceItem } from "./chat-session";
import * as MDCache from "./md-cache";
import * as ChatHistory from "./chat-history";
import { convertPdf } from "./mineru-client";
import { chat as llmChat, StreamCallback, ThinkingCallback } from "./llm-client";
import { renderMarkdown } from "./markdown-renderer";

let session = new ChatSession();
let showingHistory = false;

// ---- Helpers ----

function getPdfAttachment(item: Zotero.Item): Zotero.Item | null {
  if (item.isPDFAttachment?.()) return item;
  if (item.isRegularItem?.()) {
    for (const id of item.getAttachments()) {
      const att = Zotero.Items.get(id);
      if (att?.isPDFAttachment?.()) return att;
    }
  }
  return null;
}

function getItemTitle(item: Zotero.Item): string {
  if (item.isRegularItem?.()) return (item.getField("title") as string) || "Untitled";
  const parent = item.parentItem;
  if (parent) return (parent.getField("title") as string) || "Untitled";
  return (item.getField("title") as string) || "Untitled";
}

/** Create an element in XHTML namespace (required inside Zotero XUL panels). */
function h(doc: Document, tag: string, attrs?: Record<string, string>, ...children: (Node | string)[]): HTMLElement {
  const el = doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElement;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "className") el.className = v;
      else el.setAttribute(k, v);
    }
  }
  for (const child of children) {
    if (typeof child === "string") el.appendChild(doc.createTextNode(child));
    else el.appendChild(child);
  }
  return el;
}

// ---- Session management ----

export async function addItemToSession(item: Zotero.Item): Promise<void> {
  const pdf = getPdfAttachment(item);
  if (!pdf) return;
  const key = pdf.key;
  const title = getItemTitle(item);
  session.addSource(key, title);
  if (await MDCache.has(key)) {
    const md = await MDCache.read(key);
    session.setSourceReady(key, md);
  }
}

async function convertSource(source: SourceItem, onProgress?: (msg: string) => void): Promise<void> {
  session.setSourceStatus(source.key, "converting");
  onProgress?.("Starting conversion...");
  try {
    let attItem: Zotero.Item | null = null;
    for (const lib of Zotero.Libraries.getAll()) {
      try {
        const found = Zotero.Items.getByLibraryAndKey(lib.libraryID, source.key);
        if (found) { attItem = found; break; }
      } catch { continue; }
    }
    if (!attItem) throw new Error(`Cannot find attachment with key ${source.key}`);
    const pdfPath = await attItem.getFilePathAsync();
    if (!pdfPath) throw new Error("PDF file not found on disk");

    const markdown = await convertPdf(pdfPath, (_status, msg) => onProgress?.(msg));
    await MDCache.write(source.key, markdown);
    session.setSourceReady(source.key, markdown);
    onProgress?.("Ready");
  } catch (err: any) {
    Zotero.debug(`[ChatPDF] convertSource error: ${err.message}\n${err.stack}`);
    session.setSourceStatus(source.key, "error", err.message);
    onProgress?.(err.message);
    throw err;
  }
}

// ---- Auto-save ----

async function autoSaveSession(): Promise<void> {
  if (!session.hasMessages()) return;
  try {
    await ChatHistory.saveSession(session.toSavedSession());
  } catch (err: any) {
    Zotero.debug(`[ChatPDF] autoSaveSession error: ${err.message}`);
  }
}

// ---- Full-height helper (pattern from zotero-pdf-translate) ----

function updatePanelHeight(body: HTMLElement) {
  const details = body.closest("item-details");
  const head = body.closest("item-pane-custom-section")?.querySelector(".head");
  if (!details || !head) return;
  const container = details.querySelector(".zotero-view-item") as HTMLElement | null;
  if (!container) return;
  const height = container.clientHeight - head.clientHeight - 8;
  body.style.setProperty("--chatpdf-panel-height", `${height}px`);
}

// ---- Section registration ----

export function registerChatSection() {
  Zotero.ItemPaneManager.registerSection({
    paneID: "chatpdf-section",
    pluginID: config.addonID,
    header: {
      l10nID: `${config.addonRef}-item-section-chatpdf-head-text`,
      icon: `chrome://${config.addonRef}/content/icons/chat.svg`,
    },
    sidenav: {
      l10nID: `${config.addonRef}-item-section-chatpdf-sidenav-tooltip`,
      icon: `chrome://${config.addonRef}/content/icons/chat.svg`,
    },
    bodyXHTML: `
      <linkset>
        <html:link rel="stylesheet" href="chrome://${config.addonRef}/content/katex.css" />
        <html:link rel="stylesheet" href="chrome://${config.addonRef}/content/chatpdf.css" />
      </linkset>
      <html:div id="chatpdf-root" xmlns:html="http://www.w3.org/1999/xhtml" />
    `,
    sectionButtons: [
      {
        type: "fullHeight",
        icon: "chrome://zotero/skin/16/universal/maximize.svg",
        l10nID: `${config.addonRef}-item-section-chatpdf-fullheight`,
        onClick: ({ body }: { body: HTMLElement }) => {
          updatePanelHeight(body);
          const details = body.closest("item-details") as any;
          if (details?.scrollToPane) {
            details.scrollToPane(`${config.addonID}-chatpdf-section`);
          }
        },
      },
    ],
    onInit: ({ body, refresh }: { body: HTMLElement; refresh: () => Promise<void> }) => {
      const uid = Zotero.Utilities.randomString(8);
      body.dataset.paneUid = uid;
      // Store refresh function for external updates
      (body as any)._chatpdfRefresh = refresh;
    },
    onDestroy: ({ body }: { body: HTMLElement }) => {
      delete (body as any)._chatpdfRefresh;
    },
    onRender: ({ body, item }: { body: HTMLElement; item: Zotero.Item; setSectionSummary: (s: string) => void }) => {
      const root = body.querySelector("#chatpdf-root") as HTMLElement;
      if (!root) return;
      buildChatUI(root, item);
      updatePanelHeight(body);
    },
    onItemChange: ({ body, item, setEnabled }: { body: HTMLElement; item: Zotero.Item; setEnabled: (e: boolean) => void; setSectionSummary: (s: string) => void }) => {
      const pdf = item ? getPdfAttachment(item) : null;
      setEnabled(!!pdf);
      const root = body?.querySelector("#chatpdf-root") as HTMLElement;
      if (!root || !item || !pdf) return true;
      return true;
    },
  });
}

// ---- Date formatting ----

function formatRelativeDate(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    // Check if actually same calendar day
    if (now.toDateString() === date.toDateString()) return "Today";
    return "Yesterday";
  }
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getMonth()]} ${date.getDate()}`;
}

// ---- UI Building ----

function buildChatUI(root: HTMLElement, item: Zotero.Item) {
  const doc = root.ownerDocument!;
  root.innerHTML = "";
  showingHistory = false;

  // 1. Messages area (top, scrollable)
  const messagesArea = h(doc, "div", { className: "chatpdf-messages", id: "chatpdf-messages" });

  // Welcome message
  const welcome = h(doc, "div", { className: "chatpdf-welcome" });
  const welcomeIcon = h(doc, "div", { className: "chatpdf-welcome-icon" }, "\uD83D\uDCAC");
  const welcomeText = h(doc, "div", { className: "chatpdf-welcome-text" }, "Ask questions about your documents");
  const welcomeHint = h(doc, "div", { className: "chatpdf-welcome-hint" }, "Drop PDFs into the sources area or use the right-click menu to add papers");
  welcome.appendChild(welcomeIcon);
  welcome.appendChild(welcomeText);
  welcome.appendChild(welcomeHint);
  messagesArea.appendChild(welcome);
  root.appendChild(messagesArea);

  // History view (hidden by default)
  const historyHeader = h(doc, "div", { className: "chatpdf-header-bar", id: "chatpdf-history-header", style: "display:none" });
  const historyTitle = h(doc, "span", { className: "chatpdf-header-title" }, "Chat History");
  const newChatBtnHeader = h(doc, "button", { className: "chatpdf-header-btn" }, "+ New Chat");
  historyHeader.appendChild(historyTitle);
  historyHeader.appendChild(newChatBtnHeader);
  root.appendChild(historyHeader);

  const historyList = h(doc, "div", { className: "chatpdf-history-list", id: "chatpdf-history-list", style: "display:none" });
  root.appendChild(historyList);

  // 2. Resize handle + Source chips area (above input)
  const resizeHandle = h(doc, "div", { className: "chatpdf-resize-handle" });
  root.appendChild(resizeHandle);

  const sourceArea = h(doc, "div", { className: "chatpdf-sources", id: "chatpdf-sources" });
  const chipContainer = h(doc, "div", { className: "chatpdf-source-chips", id: "chatpdf-source-chips" });
  sourceArea.appendChild(chipContainer);

  // Resize handle drag logic
  resizeHandle.addEventListener("mousedown", (e: Event) => {
    const me = e as MouseEvent;
    me.preventDefault();
    const startY = me.clientY;
    const startHeight = sourceArea.getBoundingClientRect().height;
    const win = doc.defaultView!;

    function onMouseMove(ev: Event) {
      const delta = startY - (ev as MouseEvent).clientY;
      const newHeight = Math.min(300, Math.max(32, startHeight + delta));
      sourceArea.style.height = newHeight + "px";
    }
    function onMouseUp() {
      win.removeEventListener("mousemove", onMouseMove, true);
      win.removeEventListener("mouseup", onMouseUp, true);
    }
    win.addEventListener("mousemove", onMouseMove, true);
    win.addEventListener("mouseup", onMouseUp, true);
  });

  // Drag-and-drop on source area
  sourceArea.addEventListener("dragover", (e: Event) => {
    (e as DragEvent).preventDefault();
    sourceArea.classList.add("chatpdf-drop-active");
  });
  sourceArea.addEventListener("dragleave", () => sourceArea.classList.remove("chatpdf-drop-active"));
  sourceArea.addEventListener("drop", async (e: Event) => {
    const de = e as DragEvent;
    de.preventDefault();
    sourceArea.classList.remove("chatpdf-drop-active");
    const data = de.dataTransfer?.getData("zotero/item");
    if (data) {
      for (const id of data.split(",").map((s: string) => parseInt(s, 10))) {
        const droppedItem = Zotero.Items.get(id);
        if (droppedItem) await addItemToSession(droppedItem);
      }
      refreshSourceChips(root);
    }
  });
  root.appendChild(sourceArea);

  // 3. Input area (bottom)
  const inputArea = h(doc, "div", { className: "chatpdf-input-area", id: "chatpdf-input-area" });

  // Toolbar row (above input)
  const toolbar = h(doc, "div", { className: "chatpdf-toolbar" });
  const historyBtn = h(doc, "button", { className: "chatpdf-toolbar-btn" }, "\u{1F4CB} History");
  const newChatBtn = h(doc, "button", { className: "chatpdf-toolbar-btn" }, "\u{2795} New Chat");
  const clearLink = h(doc, "button", { className: "chatpdf-toolbar-btn" }, "Clear chat");
  const convertAllLink = h(doc, "button", { className: "chatpdf-toolbar-btn" }, "Convert all");
  toolbar.appendChild(historyBtn);
  toolbar.appendChild(newChatBtn);
  toolbar.appendChild(clearLink);
  toolbar.appendChild(convertAllLink);
  inputArea.appendChild(toolbar);

  const inputWrapper = h(doc, "div", { className: "chatpdf-input-wrapper" });

  const textarea = h(doc, "textarea", {
    className: "chatpdf-textarea",
    id: "chatpdf-textarea",
    placeholder: "Ask about your documents...",
    rows: "1",
  }) as HTMLTextAreaElement;

  const sendBtn = h(doc, "button", { className: "chatpdf-send-btn", id: "chatpdf-send", title: "Send" }, "\u2191");

  inputWrapper.appendChild(textarea);
  inputWrapper.appendChild(sendBtn);
  inputArea.appendChild(inputWrapper);

  root.appendChild(inputArea);

  // ---- Event handlers ----

  sendBtn.addEventListener("click", () => handleSend(root));
  textarea.addEventListener("keydown", (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" && !ke.shiftKey) {
      ke.preventDefault();
      handleSend(root);
    }
  });
  // Auto-resize textarea
  textarea.addEventListener("input", () => {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
  });

  clearLink.addEventListener("click", () => {
    session.clearHistory();
    const msgs = root.querySelector("#chatpdf-messages");
    if (msgs) {
      msgs.innerHTML = "";
      // Re-add welcome
      msgs.appendChild(welcome);
    }
  });

  convertAllLink.addEventListener("click", () => {
    for (const s of session.getSources().filter((s) => s.status === "pending")) {
      convertSource(s, () => refreshSourceChips(root)).catch(() => {});
    }
  });

  // History button: toggle history view
  historyBtn.addEventListener("click", () => {
    if (showingHistory) {
      hideHistoryView(root);
    } else {
      showHistoryView(root);
    }
  });

  // New Chat buttons (toolbar + header)
  const handleNewChat = async () => {
    await autoSaveSession();
    session = new ChatSession();
    if (item) {
      await addItemToSession(item);
    }
    hideHistoryView(root);
    // Rebuild chat area
    const msgs = root.querySelector("#chatpdf-messages");
    if (msgs) {
      msgs.innerHTML = "";
      msgs.appendChild(welcome);
    }
    refreshSourceChips(root);
  };
  newChatBtn.addEventListener("click", handleNewChat);
  newChatBtnHeader.addEventListener("click", handleNewChat);

  renderChatHistory(root);
  refreshSourceChips(root);
}

// ---- History View ----

function showHistoryView(root: HTMLElement) {
  showingHistory = true;
  const messagesEl = root.querySelector("#chatpdf-messages") as HTMLElement;
  const resizeEl = root.querySelector(".chatpdf-resize-handle") as HTMLElement;
  const sourcesEl = root.querySelector("#chatpdf-sources") as HTMLElement;
  const inputEl = root.querySelector("#chatpdf-input-area") as HTMLElement;
  const headerEl = root.querySelector("#chatpdf-history-header") as HTMLElement;
  const listEl = root.querySelector("#chatpdf-history-list") as HTMLElement;

  if (messagesEl) messagesEl.style.display = "none";
  if (resizeEl) resizeEl.style.display = "none";
  if (sourcesEl) sourcesEl.style.display = "none";
  if (inputEl) inputEl.style.display = "none";
  if (headerEl) headerEl.style.display = "";
  if (listEl) listEl.style.display = "";

  // Load history items
  loadHistoryList(root);
}

function hideHistoryView(root: HTMLElement) {
  showingHistory = false;
  const messagesEl = root.querySelector("#chatpdf-messages") as HTMLElement;
  const resizeEl = root.querySelector(".chatpdf-resize-handle") as HTMLElement;
  const sourcesEl = root.querySelector("#chatpdf-sources") as HTMLElement;
  const inputEl = root.querySelector("#chatpdf-input-area") as HTMLElement;
  const headerEl = root.querySelector("#chatpdf-history-header") as HTMLElement;
  const listEl = root.querySelector("#chatpdf-history-list") as HTMLElement;

  if (messagesEl) messagesEl.style.display = "";
  if (resizeEl) resizeEl.style.display = "";
  if (sourcesEl) sourcesEl.style.display = "";
  if (inputEl) inputEl.style.display = "";
  if (headerEl) headerEl.style.display = "none";
  if (listEl) listEl.style.display = "none";
}

async function loadHistoryList(root: HTMLElement) {
  const listEl = root.querySelector("#chatpdf-history-list");
  if (!listEl) return;
  const doc = root.ownerDocument!;
  listEl.innerHTML = "";

  try {
    const sessions = await ChatHistory.listSessions();
    if (sessions.length === 0) {
      const empty = h(doc, "div", { className: "chatpdf-history-empty" }, "No chat history yet");
      listEl.appendChild(empty);
      return;
    }

    for (const meta of sessions) {
      const item = h(doc, "div", { className: "chatpdf-history-item" });

      const info = h(doc, "div", { className: "chatpdf-history-item-info" });
      const titleEl = h(doc, "div", { className: "chatpdf-history-item-title" }, meta.title || "Untitled chat");
      const details = h(doc, "div", { className: "chatpdf-history-item-details" });
      const dateEl = h(doc, "span", {}, formatRelativeDate(meta.updatedAt));
      const sourceCount = h(doc, "span", {}, `${meta.sourceTitles.length} source${meta.sourceTitles.length !== 1 ? "s" : ""}`);
      details.appendChild(dateEl);
      details.appendChild(doc.createTextNode(" \u00B7 "));
      details.appendChild(sourceCount);
      info.appendChild(titleEl);
      info.appendChild(details);

      const deleteBtn = h(doc, "button", { className: "chatpdf-history-delete-btn", title: "Delete" }, "\u00D7");

      item.appendChild(info);
      item.appendChild(deleteBtn);

      // Click to load session
      info.addEventListener("click", async () => {
        await autoSaveSession();
        const saved = await ChatHistory.loadSession(meta.id);
        if (saved) {
          session = ChatSession.fromSavedSession(saved);
          // Reload markdown for sources from cache
          for (const source of session.getSources()) {
            if (await MDCache.has(source.key)) {
              const md = await MDCache.read(source.key);
              session.setSourceReady(source.key, md);
            }
          }
          hideHistoryView(root);
          // Re-render messages
          const msgs = root.querySelector("#chatpdf-messages");
          if (msgs) msgs.innerHTML = "";
          renderChatHistory(root);
          refreshSourceChips(root);
        }
      });

      // Delete button
      deleteBtn.addEventListener("click", async (e: Event) => {
        e.stopPropagation();
        await ChatHistory.deleteSession(meta.id);
        loadHistoryList(root);
      });

      listEl.appendChild(item);
    }
  } catch (err: any) {
    Zotero.debug(`[ChatPDF] loadHistoryList error: ${err.message}`);
    const errEl = h(doc, "div", { className: "chatpdf-history-empty" }, "Failed to load history");
    listEl.appendChild(errEl);
  }
}

// ---- Source Chips ----

function refreshSourceChips(root: HTMLElement) {
  const container = root.querySelector("#chatpdf-source-chips");
  if (!container) return;
  const doc = root.ownerDocument!;
  container.innerHTML = "";

  const sources = session.getSources();
  if (sources.length === 0) {
    container.appendChild(h(doc, "span", { className: "chatpdf-source-drop-hint" }, "Drop items here to add sources"));
    return;
  }

  for (const source of sources) {
    const chip = h(doc, "div", { className: `chatpdf-source-chip chatpdf-source-chip-${source.status}`, title: source.errorMessage || "" });

    // Status indicator
    const statusIndicator = h(doc, "span", { className: `chatpdf-chip-indicator chatpdf-chip-indicator-${source.status}` });
    chip.appendChild(statusIndicator);

    // Title
    const titleEl = h(doc, "span", { className: "chatpdf-chip-title" }, source.title);
    chip.appendChild(titleEl);

    // Status badge
    if (source.status !== "pending") {
      const statusLabels: Record<string, string> = {
        converting: "Converting...",
        ready: "Ready",
        error: "Error",
      };
      const badge = h(doc, "span", { className: `chatpdf-chip-badge chatpdf-chip-badge-${source.status}` }, statusLabels[source.status] || "");
      chip.appendChild(badge);
    }

    // Actions
    const actions = h(doc, "span", { className: "chatpdf-chip-actions" });

    if (source.status === "pending") {
      const convertBtn = h(doc, "button", { className: "chatpdf-chip-text-btn", title: "Convert" }, "Convert");
      convertBtn.addEventListener("click", (e: Event) => {
        e.stopPropagation();
        convertSource(source, () => refreshSourceChips(root)).catch(() => refreshSourceChips(root));
        refreshSourceChips(root);
      });
      actions.appendChild(convertBtn);
    }

    const removeBtn = h(doc, "button", { className: "chatpdf-chip-text-btn chatpdf-chip-remove-btn", title: "Remove" }, "Remove");
    removeBtn.addEventListener("click", (e: Event) => {
      e.stopPropagation();
      session.removeSource(source.key);
      refreshSourceChips(root);
    });
    actions.appendChild(removeBtn);

    chip.appendChild(actions);
    container.appendChild(chip);
  }
}

// ---- Messages ----

function renderChatHistory(root: HTMLElement) {
  const messagesEl = root.querySelector("#chatpdf-messages");
  if (!messagesEl) return;
  const history = session.getHistory();
  if (history.length > 0) {
    // Remove welcome message when there's history
    const welcome = messagesEl.querySelector(".chatpdf-welcome");
    if (welcome) welcome.remove();
    let msgIndex = 0;
    for (const msg of history) {
      if (msg.role === "system") continue;
      appendMessage(root, msg.role as "user" | "assistant", msg.content, msgIndex);
      msgIndex++;
    }
  }
}

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

function appendMessage(root: HTMLElement, role: "user" | "assistant", content: string, msgIndex?: number): HTMLElement {
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
    // Avatar
    const avatar = h(doc, "div", { className: "chatpdf-avatar chatpdf-avatar-assistant" }, "\u2728");
    row.appendChild(avatar);
  }

  const bubble = h(doc, "div", { className: `chatpdf-message chatpdf-message-${role}` });

  if (role === "assistant") {
    try {
      bubble.innerHTML = renderMarkdown(content);
    } catch {
      bubble.textContent = content;
    }
    // Copy button for assistant messages
    row.appendChild(createCopyButton(doc, content));
  } else {
    bubble.textContent = content;
    // Edit button for user messages
    const editBtn = h(doc, "button", { className: "chatpdf-edit-btn", title: "Edit" }, "\u270E");
    editBtn.addEventListener("click", (e: Event) => {
      e.stopPropagation();
      enterEditMode(root, row, bubble, content);
    });
    row.appendChild(editBtn);
  }

  row.appendChild(bubble);
  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

/** Enter inline edit mode for a user message bubble. */
function enterEditMode(root: HTMLElement, row: HTMLElement, bubble: HTMLElement, originalText: string) {
  const doc = root.ownerDocument!;

  // Hide the original bubble and edit button
  bubble.style.display = "none";
  const editBtn = row.querySelector(".chatpdf-edit-btn") as HTMLElement;
  if (editBtn) editBtn.style.display = "none";

  // Create edit area
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

  // Auto-resize
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

    // Truncate session history from this message index onwards
    if (msgIndex >= 0) {
      session.truncateHistoryAt(msgIndex);
    }

    // Remove this row and all subsequent message rows from DOM
    const messagesEl = root.querySelector("#chatpdf-messages");
    if (messagesEl) {
      const allRows = Array.from(messagesEl.querySelectorAll(".chatpdf-msg-row"));
      const rowIdx = allRows.indexOf(row);
      if (rowIdx >= 0) {
        for (let i = allRows.length - 1; i >= rowIdx; i--) {
          allRows[i].remove();
        }
      }
    }

    // Re-send with edited text by putting it in the textarea and calling handleSend
    const textarea = root.querySelector("#chatpdf-textarea") as HTMLTextAreaElement;
    if (textarea) {
      textarea.value = newText;
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
    }
    handleSend(root);
  });

  // Allow Enter to send, Shift+Enter for newline
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

// ---- Chat handling ----

async function handleSend(root: HTMLElement) {
  const textarea = root.querySelector("#chatpdf-textarea") as HTMLTextAreaElement;
  const sendBtn = root.querySelector("#chatpdf-send") as HTMLButtonElement;
  if (!textarea || !sendBtn) return;

  const userText = textarea.value.trim();
  if (!userText) return;

  // Block sending when any source is pending or converting
  const notReady = session.getSources().filter((s) => s.status === "pending" || s.status === "converting");
  if (notReady.length > 0) {
    // Show ephemeral warning without clearing the textarea
    const existing = root.querySelector(".chatpdf-send-warning");
    if (existing) existing.remove();
    const doc = root.ownerDocument!;
    const warning = h(doc, "div", { className: "chatpdf-send-warning" },
      `Cannot send: ${notReady.length} source${notReady.length > 1 ? "s" : ""} still pending or converting. Please convert or remove them first.`);
    const inputArea = root.querySelector("#chatpdf-input-area");
    if (inputArea) inputArea.insertBefore(warning, inputArea.firstChild);
    // Auto-dismiss after 4 seconds
    const win = doc.defaultView!;
    win.setTimeout(() => warning.remove(), 4000);
    return;
  }

  textarea.value = "";
  textarea.style.height = "auto";

  // Track message index: current history length is the index for this new user message
  const userMsgIndex = session.getHistoryLength();
  appendMessage(root, "user", userText, userMsgIndex);

  textarea.disabled = true;
  sendBtn.disabled = true;

  try {
    // Build messages BEFORE adding to history to avoid duplication
    const messages = session.buildMessages(userText);
    session.addUserMessage(userText);

    const assistantMsgIndex = session.getHistoryLength(); // index for the upcoming assistant message
    const doc = root.ownerDocument!;
    const row = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
    row.className = "chatpdf-msg-row chatpdf-msg-row-assistant";
    row.dataset.msgIndex = String(assistantMsgIndex);

    const avatar = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
    avatar.className = "chatpdf-avatar chatpdf-avatar-assistant";
    avatar.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`;
    row.appendChild(avatar);

    const bubble = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
    bubble.className = "chatpdf-message chatpdf-message-assistant";

    // Initial thinking indicator (bouncing dots — shown before any tokens arrive)
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

    // ---- Reasoning/Thinking block ----
    let reasoningBlock: HTMLElement | null = null;
    let reasoningContent: HTMLElement | null = null;
    let reasoningLabel: HTMLElement | null = null;
    let reasoningTimer: HTMLElement | null = null;
    let reasoningSpinner: HTMLElement | null = null;
    let fullReasoning = "";
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

      // Insert at the top of the bubble (before any content)
      bubble.insertBefore(reasoningBlock, bubble.firstChild);

      // Start timer
      thinkingStartTime = Date.now();
      thinkingTimerInterval = win.setInterval(() => {
        const elapsed = Math.floor((Date.now() - thinkingStartTime) / 1000);
        if (reasoningTimer) reasoningTimer.textContent = `${elapsed}s`;
      }, 1000) as unknown as number;
    }

    // Thinking callback
    const onThinking: ThinkingCallback = (chunk: string, done: boolean) => {
      if (!done) {
        // Remove initial dots on first thinking token
        if (thinkingDots.parentNode) thinkingDots.remove();

        if (!reasoningBlock) createReasoningBlock();

        fullReasoning += chunk;
        // Throttle rendering at 80ms
        if (!reasoningRenderTimer) {
          reasoningRenderTimer = win.setTimeout(() => {
            reasoningRenderTimer = null;
            if (reasoningContent) reasoningContent.textContent = fullReasoning;
            if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
          }, 80) as unknown as number;
        }
      } else {
        // Thinking done
        if (thinkingTimerInterval) {
          win.clearInterval(thinkingTimerInterval);
          thinkingTimerInterval = null;
        }
        if (reasoningRenderTimer) {
          win.clearTimeout(reasoningRenderTimer);
          reasoningRenderTimer = null;
        }
        if (reasoningContent) reasoningContent.textContent = fullReasoning;
        if (reasoningSpinner) reasoningSpinner.remove();

        // Update label with final time
        const elapsed = thinkingStartTime ? Math.floor((Date.now() - thinkingStartTime) / 1000) : 0;
        if (reasoningLabel && elapsed > 0) {
          reasoningLabel.textContent = "Thought";
        }
        if (reasoningTimer && elapsed > 0) {
          reasoningTimer.textContent = `${elapsed}s`;
        }

        // Collapse the block when thinking finishes
        if (reasoningBlock) {
          reasoningBlock.classList.remove("chatpdf-reasoning-expanded");
        }
      }
    };

    // ---- Content streaming ----
    let fullText = "";
    let renderTimer: number | null = null;

    /** Safely set bubble content; fall back to plain text on XHTML parse errors. */
    function setBubbleHtml(text: string) {
      try {
        // Build HTML: keep reasoning block, replace rest
        const rendered = renderMarkdown(text);
        // Remove dots if still present
        if (thinkingDots.parentNode) thinkingDots.remove();
        // Replace only content after reasoning block
        const existingBlock = bubble.querySelector(".chatpdf-reasoning-block");
        if (existingBlock) {
          // Remove all content after the reasoning block
          while (existingBlock.nextSibling) existingBlock.nextSibling.remove();
          // Add new content wrapper
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

    const fullResponse = await llmChat(messages, (chunk: string, done: boolean) => {
      if (!done) {
        // Remove dots on first content token (for non-thinking models)
        if (thinkingDots.parentNode) thinkingDots.remove();

        fullText += chunk;
        if (!renderTimer) {
          renderTimer = win.setTimeout(() => {
            renderTimer = null;
            setBubbleHtml(fullText);
            if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
          }, 80);
        }
      } else {
        if (renderTimer) {
          win.clearTimeout(renderTimer);
          renderTimer = null;
        }
        setBubbleHtml(fullText);
        if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }, onThinking);

    // Clean up any lingering timers
    if (thinkingTimerInterval) win.clearInterval(thinkingTimerInterval);

    // Add copy button after streaming completes
    row.appendChild(createCopyButton(doc, fullResponse));

    session.addAssistantMessage(fullResponse);
    // Auto-save after assistant message
    await autoSaveSession();
  } catch (err: any) {
    appendMessage(root, "assistant", `Error: ${err.message}`);
  } finally {
    textarea.disabled = false;
    sendBtn.disabled = false;
    textarea.focus();
  }
}

// ---- Context menu ----

export function registerContextMenu() {
  Zotero.MenuManager.registerMenu({
    menuID: "chatpdf-item-menu",
    pluginID: config.addonID,
    target: "main/library/item",
    menus: [{
      menuType: "menuitem",
      l10nID: "chatpdf-menuitem-addtochatpdf",
      onCommand: async (_event: Event, context: _ZoteroTypes.MenuManager.LibraryMenuContext) => {
        for (const item of context.items ?? []) {
          await addItemToSession(item);
        }
        for (const win of Zotero.getMainWindows()) {
          const root = (win as any).document?.querySelector("#chatpdf-root") as HTMLElement | null;
          if (root) refreshSourceChips(root);
        }
      },
    }],
  });
}

// ---- Exports ----

export function getSession(): ChatSession { return session; }
export function resetSession(): void { session = new ChatSession(); }
