import { config } from "../../package.json";
import { ChatSession, SourceItem } from "./chat-session";
import * as MDCache from "./md-cache";
import { convertPdf } from "./mineru-client";
import { chat as llmChat, StreamCallback } from "./llm-client";

let session = new ChatSession();

// Get PDF attachment from a Zotero item
function getPdfAttachment(item: Zotero.Item): Zotero.Item | null {
  if (item.isPDFAttachment?.()) {
    return item;
  }
  if (item.isRegularItem?.()) {
    const attachmentIDs = item.getAttachments();
    for (const id of attachmentIDs) {
      const att = Zotero.Items.get(id);
      if (att && att.isPDFAttachment?.()) {
        return att;
      }
    }
  }
  return null;
}

function getItemTitle(item: Zotero.Item): string {
  if (item.isRegularItem?.()) {
    return item.getField("title") as string || "Untitled";
  }
  const parent = item.parentItem;
  if (parent) {
    return parent.getField("title") as string || "Untitled";
  }
  return item.getField("title") as string || "Untitled";
}

export async function addItemToSession(item: Zotero.Item): Promise<void> {
  const pdf = getPdfAttachment(item);
  if (!pdf) return;

  const key = pdf.key;
  const title = getItemTitle(item);
  const source = session.addSource(key, title);

  // Check cache
  if (await MDCache.has(key)) {
    const md = await MDCache.read(key);
    session.setSourceReady(key, md);
  }
}

async function convertSource(
  source: SourceItem,
  onProgress?: (msg: string) => void,
): Promise<void> {
  session.setSourceStatus(source.key, "converting");
  onProgress?.("Starting conversion...");

  try {
    const att = Zotero.Items.getByLibraryAndKey(1, source.key) ||
      (() => {
        // Search all libraries
        const items = Zotero.Items.getAll(1, false, false);
        return null;
      })();

    // Get the attachment item by key
    let attItem: Zotero.Item | null = null;
    // Try finding by key in all libraries
    const libraries = Zotero.Libraries.getAll();
    for (const lib of libraries) {
      try {
        const found = Zotero.Items.getByLibraryAndKey(lib.libraryID, source.key);
        if (found) {
          attItem = found;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!attItem) {
      throw new Error(`Cannot find attachment with key ${source.key}`);
    }

    const pdfPath = await attItem.getFilePathAsync();
    if (!pdfPath) {
      throw new Error("PDF file not found on disk");
    }

    const markdown = await convertPdf(pdfPath, (_status, msg) => {
      onProgress?.(msg);
    });

    await MDCache.write(source.key, markdown);
    session.setSourceReady(source.key, markdown);
    onProgress?.("Ready");
  } catch (err: any) {
    session.setSourceStatus(source.key, "error", err.message);
    onProgress?.(err.message);
    throw err;
  }
}

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
    bodyXHTML: `<html:div id="chatpdf-root" xmlns:html="http://www.w3.org/1999/xhtml" />`,
    onRender: ({
      body,
      item,
    }: {
      body: HTMLElement;
      item: Zotero.Item;
      setSectionSummary: (summary: string) => void;
    }) => {
      const root = body.querySelector("#chatpdf-root") as HTMLElement;
      if (!root) return;
      buildChatUI(root, item);
    },
    onItemChange: ({
      body,
      item,
    }: {
      body: HTMLElement;
      item: Zotero.Item;
      setSectionSummary: (summary: string) => void;
    }) => {
      // Auto-add the selected item as a source
      const root = body.querySelector("#chatpdf-root") as HTMLElement;
      if (!root || !item) return;

      const pdf = getPdfAttachment(item);
      if (pdf && !session.getSource(pdf.key)) {
        addItemToSession(item).then(() => refreshSourceList(root));
      }
    },
  });
}

function buildChatUI(root: HTMLElement, item: Zotero.Item) {
  const doc = root.ownerDocument;

  // Load CSS
  const linkEl = doc.querySelector(`link[href*="${config.addonRef}"]`);
  if (!linkEl) {
    const link = doc.createElementNS("http://www.w3.org/1999/xhtml", "link") as HTMLLinkElement;
    link.rel = "stylesheet";
    link.href = `chrome://${config.addonRef}/content/chatpdf.css`;
    doc.head?.appendChild(link) || doc.documentElement.appendChild(link);
  }

  root.innerHTML = "";

  // Source list area
  const sourceArea = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  sourceArea.className = "chatpdf-sources";
  sourceArea.id = "chatpdf-sources";

  const sourceHeader = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  sourceHeader.className = "chatpdf-sources-header";
  sourceHeader.textContent = "Sources";

  const convertAllBtn = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
  convertAllBtn.className = "chatpdf-btn chatpdf-btn-sm";
  convertAllBtn.textContent = "Convert All";
  convertAllBtn.addEventListener("click", () => {
    const sources = session.getSources().filter((s) => s.status === "pending");
    for (const s of sources) {
      convertSource(s, () => refreshSourceList(root)).catch(() => {});
    }
  });
  sourceHeader.appendChild(convertAllBtn);
  sourceArea.appendChild(sourceHeader);

  const sourceList = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  sourceList.className = "chatpdf-source-list";
  sourceList.id = "chatpdf-source-list";
  sourceArea.appendChild(sourceList);

  // Drop zone for drag-and-drop
  sourceArea.addEventListener("dragover", (e: Event) => {
    (e as DragEvent).preventDefault();
    sourceArea.classList.add("chatpdf-drop-active");
  });
  sourceArea.addEventListener("dragleave", () => {
    sourceArea.classList.remove("chatpdf-drop-active");
  });
  sourceArea.addEventListener("drop", async (e: Event) => {
    const de = e as DragEvent;
    de.preventDefault();
    sourceArea.classList.remove("chatpdf-drop-active");

    // Get Zotero item IDs from the drag data
    const data = de.dataTransfer?.getData("zotero/item");
    if (data) {
      const ids = data.split(",").map((id: string) => parseInt(id, 10));
      for (const id of ids) {
        const droppedItem = Zotero.Items.get(id);
        if (droppedItem) {
          await addItemToSession(droppedItem);
        }
      }
      refreshSourceList(root);
    }
  });

  root.appendChild(sourceArea);

  // Status bar
  const statusBar = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  statusBar.className = "chatpdf-status";
  statusBar.id = "chatpdf-status";
  root.appendChild(statusBar);

  // Chat messages area
  const messagesArea = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  messagesArea.className = "chatpdf-messages";
  messagesArea.id = "chatpdf-messages";
  root.appendChild(messagesArea);

  // Input area
  const inputArea = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  inputArea.className = "chatpdf-input-area";

  const textarea = doc.createElementNS("http://www.w3.org/1999/xhtml", "textarea") as HTMLTextAreaElement;
  textarea.className = "chatpdf-textarea";
  textarea.id = "chatpdf-textarea";
  textarea.placeholder = "Ask a question about your documents...";
  textarea.rows = 2;

  const btnRow = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  btnRow.className = "chatpdf-btn-row";

  const sendBtn = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
  sendBtn.className = "chatpdf-btn chatpdf-btn-primary";
  sendBtn.textContent = "Send";
  sendBtn.id = "chatpdf-send";

  const clearBtn = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
  clearBtn.className = "chatpdf-btn";
  clearBtn.textContent = "Clear Chat";

  btnRow.appendChild(sendBtn);
  btnRow.appendChild(clearBtn);
  inputArea.appendChild(textarea);
  inputArea.appendChild(btnRow);
  root.appendChild(inputArea);

  // Event handlers
  sendBtn.addEventListener("click", () => handleSend(root));
  textarea.addEventListener("keydown", (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" && !ke.shiftKey) {
      ke.preventDefault();
      handleSend(root);
    }
  });
  clearBtn.addEventListener("click", () => {
    session.clearHistory();
    const msgs = root.querySelector("#chatpdf-messages");
    if (msgs) msgs.innerHTML = "";
  });

  // Auto-add current item
  if (item) {
    addItemToSession(item).then(() => refreshSourceList(root));
  }

  // Render existing history
  renderHistory(root);
}

function refreshSourceList(root: HTMLElement) {
  const list = root.querySelector("#chatpdf-source-list");
  if (!list) return;
  const doc = root.ownerDocument;

  list.innerHTML = "";
  const sources = session.getSources();

  if (sources.length === 0) {
    const empty = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    empty.className = "chatpdf-source-empty";
    empty.textContent = "Drag items here or right-click \u2192 Add to ChatPDF";
    list.appendChild(empty);
    return;
  }

  for (const source of sources) {
    const row = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    row.className = "chatpdf-source-row";

    const title = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    title.className = "chatpdf-source-title";
    title.textContent = source.title;
    title.title = source.title;
    row.appendChild(title);

    const statusBadge = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    statusBadge.className = `chatpdf-source-status chatpdf-status-${source.status}`;

    if (source.status === "ready") {
      statusBadge.textContent = "Ready";
    } else if (source.status === "converting") {
      statusBadge.textContent = "Converting...";
    } else if (source.status === "error") {
      statusBadge.textContent = "Error";
      statusBadge.title = source.errorMessage || "";
    } else {
      // pending - show convert button
      const convertBtn = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
      convertBtn.className = "chatpdf-btn chatpdf-btn-sm";
      convertBtn.textContent = "Convert";
      convertBtn.addEventListener("click", () => {
        convertSource(source, (msg) => {
          statusBadge.textContent = msg;
          refreshSourceList(root);
        }).catch(() => refreshSourceList(root));
        refreshSourceList(root);
      });
      row.appendChild(convertBtn);
    }

    if (source.status !== "pending") {
      row.appendChild(statusBadge);
    }

    const removeBtn = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
    removeBtn.className = "chatpdf-btn chatpdf-btn-sm chatpdf-btn-remove";
    removeBtn.textContent = "\u00D7";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", () => {
      session.removeSource(source.key);
      refreshSourceList(root);
    });
    row.appendChild(removeBtn);

    list.appendChild(row);
  }
}

function renderHistory(root: HTMLElement) {
  const messagesEl = root.querySelector("#chatpdf-messages");
  if (!messagesEl) return;
  const doc = root.ownerDocument;

  messagesEl.innerHTML = "";
  for (const msg of session.getHistory()) {
    if (msg.role === "system") continue;
    appendMessage(root, msg.role as "user" | "assistant", msg.content);
  }
}

function appendMessage(
  root: HTMLElement,
  role: "user" | "assistant",
  content: string,
): HTMLElement {
  const messagesEl = root.querySelector("#chatpdf-messages");
  if (!messagesEl) return root;
  const doc = root.ownerDocument;

  const bubble = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  bubble.className = `chatpdf-message chatpdf-message-${role}`;
  bubble.textContent = content;
  messagesEl.appendChild(bubble);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

async function handleSend(root: HTMLElement) {
  const textarea = root.querySelector("#chatpdf-textarea") as HTMLTextAreaElement;
  const sendBtn = root.querySelector("#chatpdf-send") as HTMLButtonElement;
  if (!textarea || !sendBtn) return;

  const userText = textarea.value.trim();
  if (!userText) return;

  // Add user message
  textarea.value = "";
  session.addUserMessage(userText);
  appendMessage(root, "user", userText);

  // Disable input while processing
  textarea.disabled = true;
  sendBtn.disabled = true;

  const statusEl = root.querySelector("#chatpdf-status");

  try {
    const messages = session.buildMessages(userText);

    // Create assistant bubble for streaming
    const bubble = appendMessage(root, "assistant", "");
    bubble.textContent = "";

    if (statusEl) statusEl.textContent = "Thinking...";

    const fullResponse = await llmChat(messages, (chunk: string, done: boolean) => {
      if (!done) {
        bubble.textContent += chunk;
        const messagesEl = root.querySelector("#chatpdf-messages");
        if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    });

    session.addAssistantMessage(fullResponse);
    if (statusEl) statusEl.textContent = "";
  } catch (err: any) {
    appendMessage(root, "assistant", `Error: ${err.message}`);
    if (statusEl) statusEl.textContent = `Error: ${err.message}`;
  } finally {
    textarea.disabled = false;
    sendBtn.disabled = false;
    textarea.focus();
  }
}

export function registerContextMenu() {
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    label: "Add to ChatPDF",
    commandListener: async (ev: Event) => {
      const items = Zotero.getActiveZoteroPane()?.getSelectedItems();
      if (!items) return;
      for (const item of items) {
        await addItemToSession(item);
      }
      // Trigger a UI refresh if the panel is visible
      const doc = (ev.target as Element)?.ownerDocument;
      if (doc) {
        const root = doc.querySelector("#chatpdf-root") as HTMLElement;
        if (root) refreshSourceList(root);
      }
    },
  });
}

export function getSession(): ChatSession {
  return session;
}

export function resetSession(): void {
  session = new ChatSession();
}
