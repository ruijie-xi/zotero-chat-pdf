import { config } from "../../package.json";
import { ChatSession, SourceItem } from "./chat-session";
import * as MDCache from "./md-cache";
import { convertPdf } from "./mineru-client";
import { chat as llmChat, StreamCallback } from "./llm-client";
import { renderMarkdown } from "./markdown-renderer";

let session = new ChatSession();

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
      icon: `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
    },
    sidenav: {
      l10nID: `${config.addonRef}-item-section-chatpdf-sidenav-tooltip`,
      icon: `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
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
      if (!session.getSource(pdf.key)) {
        addItemToSession(item).then(() => refreshSourceChips(root));
      }
      return true;
    },
  });
}

// ---- UI Building ----

function buildChatUI(root: HTMLElement, item: Zotero.Item) {
  const doc = root.ownerDocument!;
  root.innerHTML = "";

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

  // 2. Source chips area (above input)
  const sourceArea = h(doc, "div", { className: "chatpdf-sources", id: "chatpdf-sources" });
  const chipContainer = h(doc, "div", { className: "chatpdf-source-chips", id: "chatpdf-source-chips" });
  sourceArea.appendChild(chipContainer);

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
  const inputArea = h(doc, "div", { className: "chatpdf-input-area" });

  // Toolbar row (above input)
  const toolbar = h(doc, "div", { className: "chatpdf-toolbar" });
  const clearLink = h(doc, "button", { className: "chatpdf-toolbar-btn" }, "Clear chat");
  const convertAllLink = h(doc, "button", { className: "chatpdf-toolbar-btn" }, "Convert all");
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

  // Auto-add current item
  if (item) {
    addItemToSession(item).then(() => refreshSourceChips(root));
  }

  renderHistory(root);
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

function renderHistory(root: HTMLElement) {
  const messagesEl = root.querySelector("#chatpdf-messages");
  if (!messagesEl) return;
  const history = session.getHistory();
  if (history.length > 0) {
    // Remove welcome message when there's history
    const welcome = messagesEl.querySelector(".chatpdf-welcome");
    if (welcome) welcome.remove();
    for (const msg of history) {
      if (msg.role === "system") continue;
      appendMessage(root, msg.role as "user" | "assistant", msg.content);
    }
  }
}

function appendMessage(root: HTMLElement, role: "user" | "assistant", content: string): HTMLElement {
  const messagesEl = root.querySelector("#chatpdf-messages");
  if (!messagesEl) return root;
  const doc = root.ownerDocument!;

  // Remove welcome message on first real message
  const welcome = messagesEl.querySelector(".chatpdf-welcome");
  if (welcome) welcome.remove();

  const row = h(doc, "div", { className: `chatpdf-msg-row chatpdf-msg-row-${role}` });

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
  } else {
    bubble.textContent = content;
  }

  row.appendChild(bubble);
  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

// ---- Chat handling ----

async function handleSend(root: HTMLElement) {
  const textarea = root.querySelector("#chatpdf-textarea") as HTMLTextAreaElement;
  const sendBtn = root.querySelector("#chatpdf-send") as HTMLButtonElement;
  if (!textarea || !sendBtn) return;

  const userText = textarea.value.trim();
  if (!userText) return;

  textarea.value = "";
  textarea.style.height = "auto";
  appendMessage(root, "user", userText);

  textarea.disabled = true;
  sendBtn.disabled = true;

  try {
    // Build messages BEFORE adding to history to avoid duplication
    const messages = session.buildMessages(userText);
    session.addUserMessage(userText);

    const doc = root.ownerDocument!;
    const row = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
    row.className = "chatpdf-msg-row chatpdf-msg-row-assistant";

    const avatar = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
    avatar.className = "chatpdf-avatar chatpdf-avatar-assistant";
    avatar.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`;
    row.appendChild(avatar);

    const bubble = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
    bubble.className = "chatpdf-message chatpdf-message-assistant";

    // Thinking indicator
    const thinking = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
    thinking.className = "chatpdf-thinking";
    for (let i = 0; i < 3; i++) {
      thinking.appendChild(doc.createElementNS("http://www.w3.org/1999/xhtml", "span"));
    }
    bubble.appendChild(thinking);

    row.appendChild(bubble);
    const messagesEl = root.querySelector("#chatpdf-messages");
    messagesEl?.appendChild(row);
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;

    let fullText = "";
    const win = doc.defaultView!;
    let renderTimer: number | null = null;

    /** Safely set bubble content; fall back to plain text on XHTML parse errors. */
    function setBubbleHtml(text: string) {
      try {
        bubble.innerHTML = renderMarkdown(text);
      } catch {
        bubble.textContent = text;
      }
    }

    const fullResponse = await llmChat(messages, (chunk: string, done: boolean) => {
      if (!done) {
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
    });

    session.addAssistantMessage(fullResponse);
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
