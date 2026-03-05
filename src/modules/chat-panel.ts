import { config } from "../../package.json";
import { ChatSession, SourceItem } from "./chat-session";
import * as MDCache from "./md-cache";
import * as ChatHistory from "./chat-history";
import { convertPdf } from "./mineru-client";
import { chat as llmChat, StreamCallback, ThinkingCallback, ChatMessage } from "./llm-client";
import { renderMarkdown } from "./markdown-renderer";
import { logLLMRequest, logLLMResponse } from "./debug-log";
import { getPref, setPref } from "../utils/prefs";

let session = new ChatSession();
let showingHistory = false;

// ---- History filter state ----
let historyFilterParentKey: string | null = null;
let historyFilterTitle: string | null = null;

// ---- Model profiles ----
interface ModelProfile {
  name: string;
  apiBase: string;
  apiKey: string;
  model: string;
}

/** AbortControllers for in-progress MinerU conversions, keyed by source key. */
const conversionAbortControllers = new Map<string, { abort(): void; signal: AbortSignal }>();

// ---- Streaming state ----

let isStreaming = false;
let currentAbortController: { abort(): void; signal: AbortSignal } | null = null;

/** Live state of an active stream (foreground or background). */
interface StreamState {
  session: ChatSession;
  abortController: { abort(): void; signal: AbortSignal };
  /** Accumulated content text so far. */
  fullText: string;
  /** Accumulated reasoning/thinking text so far. */
  fullReasoning: string;
  /** Whether the thinking phase is done. */
  thinkingDone: boolean;
  /** Total thinking time in seconds (set when thinking completes). */
  thinkingElapsed: number;
  /** Timestamp when thinking started (for live timer display). */
  thinkingStartTime: number;
}

/**
 * Track active streams keyed by session ID.
 * When a stream is running for a session that the user navigated away from,
 * this map keeps the live state so we can resume the UI if the user comes back.
 */
const backgroundStreams = new Map<string, StreamState>();

/** Create an AbortController — works in both chrome and content contexts. */
function createAbortController(): { controller: { abort(): void; signal: AbortSignal }; signal: AbortSignal } {
  // In Zotero's chrome context, AbortController may not be globally available.
  // Access it from a window object instead.
  const Ctor = (typeof AbortController !== "undefined")
    ? AbortController
    : (Zotero.getMainWindow() as any).AbortController;
  const controller = new Ctor();
  return { controller, signal: controller.signal };
}

/** Abort the current LLM stream if one is active. */
export function abortCurrentStream(): void {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  isStreaming = false;
}

// ---- Scroll helpers ----

/** Check if the user is near the bottom of a scrollable element. */
function isNearBottom(el: Element, threshold = 60): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

/** Scroll to bottom only if the user hasn't scrolled up. */
function scrollToBottomIfNeeded(el: Element): void {
  if (isNearBottom(el)) {
    el.scrollTop = el.scrollHeight;
  }
}

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

/** Reset the input UI to the non-streaming state.
 *  Call this whenever switching to a different session so the textarea
 *  and send button aren't stuck in the old stream's "stop" mode.
 *  IMPORTANT: This detaches the currentAbortController so that background
 *  streams continue running even though the UI has moved on. */
function resetStreamingUI(root: HTMLElement): void {
  // Detach the foreground abort controller — the background stream keeps its own
  // reference via the backgroundStreams map and will continue running.
  currentAbortController = null;
  isStreaming = false;
  const ta = root.querySelector("#chatpdf-textarea") as HTMLTextAreaElement;
  const sb = root.querySelector("#chatpdf-send") as HTMLButtonElement;
  if (ta) ta.disabled = false;
  if (sb) setSendButtonToSend(sb);
}

// ---- Model profile helpers ----

function loadModelProfiles(): ModelProfile[] {
  try {
    const raw = getPref("modelProfiles") as string;
    if (!raw) return [];
    return JSON.parse(raw) as ModelProfile[];
  } catch {
    return [];
  }
}

function getCurrentProfileName(): string {
  return (getPref("activeProfile") as string) || "";
}

function refreshProfileSelect(root: HTMLElement): void {
  const select = root.querySelector("#chatpdf-profile-select") as HTMLSelectElement | null;
  if (!select) return;
  const doc = root.ownerDocument!;
  select.innerHTML = "";
  const profiles = loadModelProfiles();
  const currentProfile = getCurrentProfileName();
  if (profiles.length === 0) {
    select.style.display = "none";
    return;
  }
  select.style.display = "";
  for (const p of profiles) {
    const opt = doc.createElementNS("http://www.w3.org/1999/xhtml", "option") as HTMLOptionElement;
    opt.value = p.name;
    opt.textContent = p.name;
    if (p.name === currentProfile) opt.selected = true;
    select.appendChild(opt);
  }
}

// ---- Session management ----

export async function addItemToSession(item: Zotero.Item): Promise<void> {
  const pdf = getPdfAttachment(item);
  if (!pdf) return;
  const key = pdf.key;
  const title = getItemTitle(item);
  // Resolve the parent bibliographic item key (not the attachment key).
  // Try item itself (if regular item), then item.parentItem, then pdf.parentItem.
  const parentKey: string | undefined = item.isRegularItem?.()
    ? item.key
    : (item.parentItem?.key || pdf.parentItem?.key || undefined);
  session.addSource(key, title, parentKey);
  if (await MDCache.has(key)) {
    const md = await MDCache.read(key);
    session.setSourceReady(key, md);
  }
}

async function convertSource(source: SourceItem, onProgress?: (msg: string) => void): Promise<void> {
  session.setSourceStatus(source.key, "converting");
  const { controller: convController, signal: convSignal } = createAbortController();
  conversionAbortControllers.set(source.key, convController);
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

    const markdown = await convertPdf(pdfPath, (_status, msg) => onProgress?.(msg), convSignal);
    await MDCache.write(source.key, markdown);
    session.setSourceReady(source.key, markdown);
    onProgress?.("Ready");
  } catch (err: any) {
    if (err.name === "AbortError") {
      Zotero.debug(`[ChatPDF] convertSource aborted for ${source.key}`);
      session.setSourceStatus(source.key, "pending");
      onProgress?.("Conversion stopped");
    } else {
      Zotero.debug(`[ChatPDF] convertSource error: ${err.message}\n${err.stack}`);
      session.setSourceStatus(source.key, "error", err.message);
      onProgress?.(err.message);
      throw err;
    }
  } finally {
    conversionAbortControllers.delete(source.key);
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

// ---- Side panel injection ----

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

export function injectChatPanel(win: Window): void {
  const doc = win.document;

  // Avoid double injection
  if (doc.getElementById("chatpdf-panel-container")) return;

  // Find the main horizontal layout. In Zotero 7 the main browser area is
  // inside a hbox that also holds the item pane.  We look for the element
  // that contains the item-pane (usually a <hbox id="zotero-layout">
  // or the <hbox> that wraps the center + right panes).
  const itemPane = doc.getElementById("zotero-context-pane-inner")
    || doc.getElementById("zotero-item-pane")
    || doc.getElementById("zotero-context-pane");

  // We want to insert after the item pane's parent hbox.  Walk up to find
  // a suitable container.
  const layoutBox = doc.getElementById("zotero-layout")
    || itemPane?.closest("hbox")
    || doc.querySelector("#main-window hbox");

  if (!layoutBox) {
    Zotero.debug("[ChatPDF] Could not find layout container to inject panel");
    return;
  }

  // --- Inject CSS ---
  const katexLink = doc.createElementNS("http://www.w3.org/1999/xhtml", "link") as HTMLLinkElement;
  katexLink.rel = "stylesheet";
  katexLink.href = `chrome://${config.addonRef}/content/katex.css`;
  katexLink.id = "chatpdf-katex-css";
  doc.documentElement.appendChild(katexLink);

  const cssLink = doc.createElementNS("http://www.w3.org/1999/xhtml", "link") as HTMLLinkElement;
  cssLink.rel = "stylesheet";
  cssLink.href = `chrome://${config.addonRef}/content/chatpdf.css`;
  cssLink.id = "chatpdf-main-css";
  doc.documentElement.appendChild(cssLink);

  // --- Create XUL splitter ---
  const splitter = doc.createElementNS(XUL_NS, "splitter");
  splitter.id = "chatpdf-splitter";
  splitter.setAttribute("resizebefore", "closest");
  splitter.setAttribute("resizeafter", "closest");

  // --- Create XUL vbox container ---
  const vbox = doc.createElementNS(XUL_NS, "vbox");
  vbox.id = "chatpdf-panel-container";
  vbox.setAttribute("width", "350");
  vbox.setAttribute("flex", "0");
  vbox.setAttribute("persist", "width");

  // --- Create XHTML root div inside vbox ---
  const root = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
  root.id = "chatpdf-root";
  vbox.appendChild(root);

  // Insert splitter + panel at the end of the layout box
  layoutBox.appendChild(splitter);
  layoutBox.appendChild(vbox);

  // Build the chat UI once — it persists for the window lifetime
  buildChatUI(root);
}

/** Remove injected panel elements from a window. */
export function removeChatPanel(win: Window): void {
  const doc = win.document;
  doc.getElementById("chatpdf-panel-container")?.remove();
  doc.getElementById("chatpdf-splitter")?.remove();
  doc.getElementById("chatpdf-katex-css")?.remove();
  doc.getElementById("chatpdf-main-css")?.remove();
}

// ---- Date formatting ----

function formatRelativeDate(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (now.toDateString() === date.toDateString()) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  if (diffDays < 7) return `${diffDays} days ago ${time}`;

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getMonth()]} ${date.getDate()} ${time}`;
}

/** Format a message timestamp as hh:mm. */
function formatMsgTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Render small per-message source chips (right-aligned, for user messages). */
function renderMsgSources(doc: Document, sources: { key: string; title: string }[]): HTMLElement {
  const container = h(doc, "div", { className: "chatpdf-msg-sources" });
  for (const src of sources) {
    const chip = h(doc, "span", { className: "chatpdf-msg-source-chip", title: src.title }, src.title);
    container.appendChild(chip);
  }
  return container;
}

/** Look up a Zotero item by attachment key, searching all libraries. */
function getItemByKey(key: string, libraryID?: number): Zotero.Item | null {
  if (libraryID !== undefined) {
    try {
      const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
      if (item) return item;
    } catch {}
  }
  for (const lib of Zotero.Libraries.getAll()) {
    try {
      const item = Zotero.Items.getByLibraryAndKey(lib.libraryID, key);
      if (item) return item;
    } catch { continue; }
  }
  return null;
}

/** Look up a Zotero item from any Zotero URI format. */
async function getItemFromZoteroUri(uri: string): Promise<Zotero.Item | null> {
  Zotero.debug(`[ChatPDF] getItemFromZoteroUri: trying "${uri}"`);

  // zotero://select/library/items/KEY  or  zotero://select/groups/ID/items/KEY
  const selectMatch = uri.match(/zotero:\/\/select\/(?:library|groups\/\d+)\/items\/([A-Z0-9]+)/i);
  if (selectMatch) return getItemByKey(selectMatch[1]);

  // zotero://open-pdf/library/items/KEY  or  zotero://open-pdf/groups/ID/items/KEY
  const openPdfMatch = uri.match(/zotero:\/\/open-pdf\/(?:library|groups\/\d+)\/items\/([A-Z0-9]+)/i);
  if (openPdfMatch) return getItemByKey(openPdfMatch[1]);

  // zotero://attachment/LIBRARYID/KEY
  const attachLibMatch = uri.match(/zotero:\/\/attachment\/(\d+)\/([A-Z0-9]+)/i);
  if (attachLibMatch) {
    const item = getItemByKey(attachLibMatch[2], parseInt(attachLibMatch[1], 10));
    if (item) return item;
  }

  // zotero://attachment/NUMERICID  (just numeric item ID)
  const attachNumMatch = uri.match(/zotero:\/\/attachment\/(\d+)(?:[/?#]|$)/);
  if (attachNumMatch) {
    try {
      const item = Zotero.Items.get(parseInt(attachNumMatch[1], 10));
      if (item) return item;
    } catch {}
  }

  // Try Zotero.URI.getURIItem as a catch-all
  try {
    const item = (Zotero.URI as any).getURIItem(uri);
    if (item) return item;
  } catch {}

  return null;
}

// ---- UI Building ----

function buildChatUI(root: HTMLElement) {
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

  // Fix text copy in Zotero's privileged context.
  // The copy event fires on the FOCUSED element and bubbles upward.
  // Because messagesArea is not focusable, focus is usually on the textarea
  // (a sibling, not an ancestor of messagesArea), so a listener on messagesArea
  // only catches the first copy while focus happens to be there.
  // Listening at the document level catches every copy regardless of focus,
  // then we filter to only act when the selection is within our messages area.
  doc.addEventListener("copy", (e: Event) => {
    const win = doc.defaultView;
    const sel = win?.getSelection?.();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString();
    if (!text) return;
    // Only intercept when the selection originates inside the messages area
    const anchor = sel.anchorNode;
    if (!anchor || !messagesArea.contains(anchor)) return;
    e.preventDefault();
    try {
      const helper = (Components.classes as any)["@mozilla.org/widget/clipboardhelper;1"]
        .getService((Components.interfaces as any).nsIClipboardHelper);
      helper.copyString(text);
      Zotero.debug(`[ChatPDF] copy: ${text.length} chars`);
    } catch {
      (e as ClipboardEvent).clipboardData?.setData("text/plain", text);
    }
  });

  root.appendChild(messagesArea);

  // History view (hidden by default)
  const historyHeader = h(doc, "div", { className: "chatpdf-header-bar", id: "chatpdf-history-header", style: "display:none" });
  const historyTitle = h(doc, "span", { className: "chatpdf-header-title" }, "Chat History");
  const newChatBtnHeader = h(doc, "button", { className: "chatpdf-header-btn" }, "+ New Chat");
  historyHeader.appendChild(historyTitle);
  historyHeader.appendChild(newChatBtnHeader);
  root.appendChild(historyHeader);

  // Dedicated filter bar: sits between the header and the list, hidden by default
  const historyFilterBarEl = h(doc, "div", { className: "chatpdf-history-filter-bar", id: "chatpdf-history-filter-bar", style: "display:none" });
  root.appendChild(historyFilterBarEl);

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
    const dt = de.dataTransfer;

    // Debug: log all available data transfer types
    if (dt) {
      const types = Array.from(dt.types);
      Zotero.debug(`[ChatPDF] drop: dataTransfer.types = ${JSON.stringify(types)}`);
      for (const type of types) {
        try { Zotero.debug(`[ChatPDF] drop: ${type} = "${dt.getData(type)}"`); } catch {}
      }
    }

    // 1. zotero/item — library item drag (item IDs, most reliable)
    const zoteroItemData = dt?.getData("zotero/item");
    if (zoteroItemData) {
      Zotero.debug(`[ChatPDF] drop: zotero/item = ${zoteroItemData}`);
      for (const id of zoteroItemData.split(",").map((s: string) => parseInt(s, 10))) {
        const droppedItem = Zotero.Items.get(id);
        if (droppedItem) await addItemToSession(droppedItem);
      }
      refreshSourceChips(root);
      return;
    }

    // 2. zotero/tab — Zotero tab bar drag (PDF reader tab)
    const tabID = dt?.getData("zotero/tab");
    if (tabID) {
      Zotero.debug(`[ChatPDF] drop: zotero/tab = ${tabID}`);
      try {
        const mainWin = Zotero.getMainWindow() as any;
        // Try Zotero.Reader API first
        const reader = (Zotero as any).Reader?.getByTabID?.(tabID);
        if (reader?.itemID) {
          const item = Zotero.Items.get(reader.itemID);
          if (item) { await addItemToSession(item); refreshSourceChips(root); return; }
        }
        // Fallback: look in Zotero_Tabs._tabs array
        const tab = mainWin.Zotero_Tabs?._tabs?.find((t: any) => t.id === tabID);
        Zotero.debug(`[ChatPDF] drop: tab obj = ${JSON.stringify(tab)}`);
        const itemID = tab?.data?.itemID;
        if (itemID) {
          const item = Zotero.Items.get(itemID);
          if (item) { await addItemToSession(item); refreshSourceChips(root); return; }
        }
      } catch (err) {
        Zotero.debug(`[ChatPDF] drop: zotero/tab lookup error: ${err}`);
      }
    }

    // 3. URI-based fallbacks: collect all candidate URIs from multiple data types
    const uriCandidates: string[] = [];
    const mozUrl = dt?.getData("text/x-moz-url");
    if (mozUrl) {
      // text/x-moz-url format: URL\nTitle
      uriCandidates.push(mozUrl.split("\n")[0].trim());
    }
    const plainText = dt?.getData("text/plain");
    if (plainText) uriCandidates.push(plainText.trim());
    const uriList = dt?.getData("text/uri-list");
    if (uriList) {
      for (const line of uriList.split(/\r?\n/)) {
        const u = line.trim();
        if (u && !u.startsWith("#")) uriCandidates.push(u);
      }
    }

    for (const uri of uriCandidates) {
      const item = await getItemFromZoteroUri(uri);
      if (item) { await addItemToSession(item); refreshSourceChips(root); return; }
    }

    // 4. Last resort: if nothing worked and a reader tab is currently open, use it.
    //    This covers the common case where the user drags the currently-active PDF tab.
    if (dt && Array.from(dt.types).length > 0) {
      try {
        const mainWin = Zotero.getMainWindow() as any;
        const selectedTabID = mainWin.Zotero_Tabs?.selectedID;
        Zotero.debug(`[ChatPDF] drop: last-resort — trying selectedTabID = ${selectedTabID}`);
        if (selectedTabID && selectedTabID !== "zotero-pane") {
          const reader = (Zotero as any).Reader?.getByTabID?.(selectedTabID);
          if (reader?.itemID) {
            const item = Zotero.Items.get(reader.itemID);
            if (item) {
              Zotero.debug(`[ChatPDF] drop: last-resort success — item ${item.key}`);
              await addItemToSession(item);
              refreshSourceChips(root);
              return;
            }
          }
          // Also check _tabs
          const tab = mainWin.Zotero_Tabs?._tabs?.find((t: any) => t.id === selectedTabID);
          const itemID = tab?.data?.itemID;
          if (itemID) {
            const item = Zotero.Items.get(itemID);
            if (item) {
              Zotero.debug(`[ChatPDF] drop: last-resort via _tabs — item ${item.key}`);
              await addItemToSession(item);
              refreshSourceChips(root);
              return;
            }
          }
        }
      } catch (err) {
        Zotero.debug(`[ChatPDF] drop: last-resort error: ${err}`);
      }
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
  const profileSelect = h(doc, "select", { className: "chatpdf-profile-select", id: "chatpdf-profile-select", style: "display:none" }) as HTMLSelectElement;
  toolbar.appendChild(historyBtn);
  toolbar.appendChild(newChatBtn);
  toolbar.appendChild(clearLink);
  toolbar.appendChild(convertAllLink);
  toolbar.appendChild(profileSelect);
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

  const inputHint = h(doc, "div", { className: "chatpdf-input-hint" }, "Enter to send \u00B7 Ctrl+Enter: convert & send \u00B7 Shift+Enter: new line");
  inputArea.appendChild(inputHint);

  root.appendChild(inputArea);

  // ---- Event handlers ----

  sendBtn.addEventListener("click", () => {
    if (isStreaming) {
      abortCurrentStream();
    } else {
      handleSend(root);
    }
  });
  textarea.addEventListener("keydown", (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" && ke.ctrlKey && !ke.shiftKey) {
      ke.preventDefault();
      if (!isStreaming) handleConvertAndSend(root);
    } else if (ke.key === "Enter" && !ke.shiftKey && !ke.ctrlKey) {
      ke.preventDefault();
      if (!isStreaming) handleSend(root);
    }
  });
  // Auto-resize textarea
  textarea.addEventListener("input", () => {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
  });

  clearLink.addEventListener("click", () => {
    abortCurrentStream();
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
    abortCurrentStream();
    await autoSaveSession();
    session = new ChatSession();
    resetStreamingUI(root);
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

  profileSelect.addEventListener("change", () => {
    const profiles = loadModelProfiles();
    const selected = profiles.find(p => p.name === (profileSelect as HTMLSelectElement).value);
    if (selected) {
      setPref("llmApiBase", selected.apiBase);
      setPref("llmApiKey", selected.apiKey);
      setPref("llmModel", selected.model);
      setPref("activeProfile", selected.name);
      Zotero.debug(`[ChatPDF] Switched to profile: ${selected.name}`);
    }
  });

  renderChatHistory(root);
  refreshSourceChips(root);
  refreshProfileSelect(root);
}

// ---- History View ----

export function showFilteredHistory(parentKey: string, title: string): void {
  historyFilterParentKey = parentKey;
  historyFilterTitle = title;
  for (const win of Zotero.getMainWindows()) {
    const root = (win as any).document?.querySelector("#chatpdf-root") as HTMLElement | null;
    if (root) showHistoryView(root);
  }
}

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

  // Load history items (also updates the filter bar)
  loadHistoryList(root);
}

function hideHistoryView(root: HTMLElement) {
  showingHistory = false;
  // Clear filter when closing history
  historyFilterParentKey = null;
  historyFilterTitle = null;
  const messagesEl = root.querySelector("#chatpdf-messages") as HTMLElement;
  const resizeEl = root.querySelector(".chatpdf-resize-handle") as HTMLElement;
  const sourcesEl = root.querySelector("#chatpdf-sources") as HTMLElement;
  const inputEl = root.querySelector("#chatpdf-input-area") as HTMLElement;
  const headerEl = root.querySelector("#chatpdf-history-header") as HTMLElement;
  const filterBarEl = root.querySelector("#chatpdf-history-filter-bar") as HTMLElement;
  const listEl = root.querySelector("#chatpdf-history-list") as HTMLElement;

  if (messagesEl) messagesEl.style.display = "";
  if (resizeEl) resizeEl.style.display = "";
  if (sourcesEl) sourcesEl.style.display = "";
  if (inputEl) inputEl.style.display = "";
  if (headerEl) headerEl.style.display = "none";
  if (filterBarEl) filterBarEl.style.display = "none";
  if (listEl) listEl.style.display = "none";
}

async function loadHistoryList(root: HTMLElement) {
  const listEl = root.querySelector("#chatpdf-history-list");
  if (!listEl) return;
  const doc = root.ownerDocument!;
  listEl.innerHTML = "";

  // Show/update the dedicated filter bar element (below header, above list)
  const filterBarEl = root.querySelector("#chatpdf-history-filter-bar") as HTMLElement | null;
  if (filterBarEl) {
    filterBarEl.innerHTML = "";
    if (historyFilterParentKey) {
      filterBarEl.style.display = "";
      filterBarEl.appendChild(h(doc, "span", { className: "chatpdf-history-filter-label" },
        `Sessions for: ${historyFilterTitle || historyFilterParentKey}`));
      const clearBtn = h(doc, "button", { className: "chatpdf-history-filter-clear" }, "\u00D7 Clear filter");
      clearBtn.addEventListener("click", () => {
        historyFilterParentKey = null;
        historyFilterTitle = null;
        loadHistoryList(root);
      });
      filterBarEl.appendChild(clearBtn);
    } else {
      filterBarEl.style.display = "none";
    }
  }

  try {
    let sessions = await ChatHistory.listSessions();
    if (historyFilterParentKey) {
      const filterKey = historyFilterParentKey;
      sessions = sessions.filter(s => s.referencedParentKeys?.includes(filterKey));
    }
    if (sessions.length === 0) {
      const msg = historyFilterParentKey
        ? `No sessions found for "${historyFilterTitle || historyFilterParentKey}"`
        : "No chat history yet";
      const empty = h(doc, "div", { className: "chatpdf-history-empty" }, msg);
      listEl.appendChild(empty);
      return;
    }

    for (const meta of sessions) {
      const item = h(doc, "div", { className: "chatpdf-history-item" });

      const info = h(doc, "div", { className: "chatpdf-history-item-info" });
      const titleRow = h(doc, "div", { className: "chatpdf-history-item-title-row" });
      const titleEl = h(doc, "span", { className: "chatpdf-history-item-title" }, meta.title || "Untitled chat");
      const editTitleBtn = h(doc, "button", { className: "chatpdf-history-edit-title-btn", title: "Edit title" }, "\u270E");
      titleRow.appendChild(titleEl);
      titleRow.appendChild(editTitleBtn);
      info.appendChild(titleRow);
      const details = h(doc, "div", { className: "chatpdf-history-item-details" });
      const dateEl = h(doc, "span", {}, formatRelativeDate(meta.updatedAt));
      const sourceCount = h(doc, "span", {}, `${meta.sourceTitles.length} source${meta.sourceTitles.length !== 1 ? "s" : ""}`);
      details.appendChild(dateEl);
      details.appendChild(doc.createTextNode(" \u00B7 "));
      details.appendChild(sourceCount);
      info.appendChild(details);

      // Inline title edit on pencil click
      editTitleBtn.addEventListener("click", (e: Event) => {
        e.stopPropagation();
        const input = h(doc, "input", { className: "chatpdf-history-title-input" }) as HTMLInputElement;
        input.value = meta.title || "";
        titleRow.replaceChild(input, titleEl);
        editTitleBtn.style.display = "none";
        input.focus();
        input.select();

        const saveTitle = async () => {
          input.removeEventListener("blur", saveTitle);
          const newTitle = input.value.trim() || meta.title || "Untitled chat";
          if (newTitle !== meta.title) {
            meta.title = newTitle;
            await ChatHistory.updateSessionTitle(meta.id, newTitle, "user");
            if (session.id === meta.id) {
              session.title = newTitle;
              session.titleSource = "user";
            }
          }
          titleEl.textContent = newTitle;
          titleRow.replaceChild(titleEl, input);
          editTitleBtn.style.display = "";
        };

        const cancelTitle = () => {
          input.removeEventListener("blur", saveTitle);
          titleRow.replaceChild(titleEl, input);
          editTitleBtn.style.display = "";
        };

        input.addEventListener("keydown", (ke: Event) => {
          const k = ke as KeyboardEvent;
          if (k.key === "Enter") { k.preventDefault(); saveTitle(); }
          if (k.key === "Escape") { k.preventDefault(); cancelTitle(); }
        });
        input.addEventListener("blur", saveTitle);
      });

      const deleteBtn = h(doc, "button", { className: "chatpdf-history-delete-btn", title: "Delete" }, "\u00D7");

      item.appendChild(info);
      item.appendChild(deleteBtn);

      // Click to load session
      info.addEventListener("click", async () => {
        await autoSaveSession();

        // Check if there's a background stream for this session — use its live data
        const bgStream = backgroundStreams.get(meta.id);
        if (bgStream) {
          Zotero.debug(`[ChatPDF] Loading session ${meta.id} which has an active background stream — using live session`);
          session = bgStream.session;
        } else {
          const saved = await ChatHistory.loadSession(meta.id);
          if (!saved) return;
          session = ChatSession.fromSavedSession(saved);
        }

        // Reset UI so it's not stuck in the old stream's stop/disabled state
        resetStreamingUI(root);

        // If this session has an active background stream, restore streaming state
        // so the Stop button works and the user can see it's still generating
        if (bgStream) {
          currentAbortController = bgStream.abortController;
          isStreaming = true;
          const sb = root.querySelector("#chatpdf-send") as HTMLButtonElement;
          if (sb) setSendButtonToStop(sb);
          const ta = root.querySelector("#chatpdf-textarea") as HTMLTextAreaElement;
          if (ta) ta.disabled = true;
        }
        // Reload markdown for sources from cache
        for (const source of session.getSources()) {
          if (source.status !== "ready") {
            if (await MDCache.has(source.key)) {
              const md = await MDCache.read(source.key);
              session.setSourceReady(source.key, md);
            }
          }
        }
        hideHistoryView(root);
        // Re-render messages
        const msgs = root.querySelector("#chatpdf-messages");
        if (msgs) msgs.innerHTML = "";
        renderChatHistory(root);
        refreshSourceChips(root);

        // If there's an active background stream, render its current state
        if (bgStream && msgs) {
          renderLiveStreamState(root, bgStream);
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

function formatChars(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(0) + "K";
  return String(n);
}

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

    // Size badge for ready sources (always shown)
    if (source.status === "ready" && source.markdown) {
      const charLen = source.markdown.length;
      const sizeText = formatChars(charLen);
      const isTruncated = source.contextRatio !== undefined && source.contextRatio < 1.0;
      const badgeClass = isTruncated ? "chatpdf-chip-badge-truncated" : "chatpdf-chip-badge-ready";
      const label = isTruncated
        ? `${sizeText} (${Math.round(source.contextRatio! * 100)}%)`
        : sizeText;
      const badge = h(doc, "span", { className: `chatpdf-chip-badge ${badgeClass}` }, label);
      chip.appendChild(badge);
    } else if (source.status !== "pending" && source.status !== "ready") {
      // Converting / error badges
      const statusLabels: Record<string, string> = {
        converting: "Converting...",
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

    if (source.status === "converting") {
      const stopBtn = h(doc, "button", { className: "chatpdf-chip-text-btn chatpdf-chip-stop-btn", title: "Stop conversion" }, "Stop");
      stopBtn.addEventListener("click", (e: Event) => {
        e.stopPropagation();
        const controller = conversionAbortControllers.get(source.key);
        if (controller) {
          Zotero.debug(`[ChatPDF] User stopped conversion for ${source.key}`);
          controller.abort();
        }
        refreshSourceChips(root);
      });
      actions.appendChild(stopBtn);
    }

    const removeBtn = h(doc, "button", { className: "chatpdf-chip-text-btn chatpdf-chip-remove-btn", title: "Remove" }, "Remove");
    removeBtn.addEventListener("click", (e: Event) => {
      e.stopPropagation();
      // Abort any in-progress conversion before removing
      const controller = conversionAbortControllers.get(source.key);
      if (controller) {
        Zotero.debug(`[ChatPDF] Aborting conversion for removed source ${source.key}`);
        controller.abort();
      }
      session.removeSource(source.key);
      refreshSourceChips(root);
    });
    actions.appendChild(removeBtn);

    chip.appendChild(actions);
    container.appendChild(chip);
  }

  // Total usage summary bar
  const readySources = sources.filter((s) => s.status === "ready" && s.markdown);
  if (readySources.length > 0) {
    const totalChars = readySources.reduce((sum, s) => sum + (s.markdown?.length ?? 0), 0);
    const maxDocChars = (getPref("maxDocumentChars") as number) || 300000;
    const exceeds = totalChars > maxDocChars;
    const summaryClass = exceeds ? "chatpdf-source-summary chatpdf-source-summary-over" : "chatpdf-source-summary";
    const summary = h(doc, "div", { className: summaryClass },
      `${formatChars(totalChars)} / ${formatChars(maxDocChars)} chars`);
    container.appendChild(summary);
  }
}

// ---- Messages ----

/**
 * Render the current state of a live background stream as an assistant bubble
 * and set up a polling interval to live-update as the stream progresses.
 * The poll reads from `state` (updated by the stream callbacks) and
 * incrementally updates the DOM — so the user sees characters appearing
 * just like when they never left.
 */
function renderLiveStreamState(root: HTMLElement, state: StreamState) {
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

  // Mutable DOM references for incremental updates
  let reasoningBlock: HTMLElement | null = null;
  let reasoningContentEl: HTMLElement | null = null;
  let reasoningLabel: HTMLElement | null = null;
  let reasoningSpinner: HTMLElement | null = null;
  let reasoningTimerEl: HTMLElement | null = null;
  let contentWrap: HTMLElement | null = null;
  let dots: HTMLElement | null = null;

  // Track what we've rendered so we only update on changes
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
    if (!state.fullReasoning) return;
    // Remove dots on first reasoning token
    if (dots && dots.parentNode) dots.remove();
    ensureReasoningBlock();

    if (state.fullReasoning.length !== lastReasoningLen) {
      reasoningContentEl!.textContent = state.fullReasoning;
      lastReasoningLen = state.fullReasoning.length;
      scrollToBottomIfNeeded(messagesEl!);
    }

    // Update timer while thinking is in progress
    if (!state.thinkingDone && state.thinkingStartTime > 0 && reasoningTimerEl) {
      const elapsed = Math.floor((Date.now() - state.thinkingStartTime) / 1000);
      reasoningTimerEl.textContent = `${elapsed}s`;
    }

    // Transition from "Thinking" to "Thought" when done
    if (state.thinkingDone && !wasThinkingDone) {
      wasThinkingDone = true;
      if (reasoningSpinner) reasoningSpinner.remove();
      if (reasoningLabel) reasoningLabel.textContent = "Thought";
      if (reasoningTimerEl) {
        reasoningTimerEl.textContent = state.thinkingElapsed > 0 ? `${state.thinkingElapsed}s` : "";
      }
      if (reasoningBlock) reasoningBlock.classList.remove("chatpdf-reasoning-expanded");
    }
  }

  function updateContent() {
    if (state.fullText.length === lastTextLen) return;
    lastTextLen = state.fullText.length;
    // Remove dots on first content token
    if (dots && dots.parentNode) dots.remove();
    if (!contentWrap) {
      contentWrap = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
      bubble.appendChild(contentWrap);
    }
    try {
      contentWrap.innerHTML = renderMarkdown(state.fullText);
    } catch {
      contentWrap.textContent = state.fullText;
    }
    scrollToBottomIfNeeded(messagesEl!);
  }

  // ---- Initial render ----
  updateReasoning();
  // If thinking is already done at the point we render, mark it
  if (state.thinkingDone) wasThinkingDone = true;
  updateContent();

  // Show bouncing dots if no content yet
  if (!state.fullText) {
    dots = h(doc, "div", { className: "chatpdf-thinking" });
    for (let i = 0; i < 3; i++) {
      dots.appendChild(doc.createElementNS("http://www.w3.org/1999/xhtml", "span"));
    }
    bubble.appendChild(dots);
  }

  row.appendChild(bubble);
  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  // ---- Polling: update the DOM as the stream progresses ----
  // The original stream callbacks keep updating state.fullText/fullReasoning.
  // We poll at 100ms to read those values and render them.
  const pollInterval = win.setInterval(() => {
    // Stop polling if the stream completed or our row was detached from the DOM
    if (!backgroundStreams.has(state.session.id) || !row.isConnected) {
      win.clearInterval(pollInterval);
      return;
    }
    updateReasoning();
    updateContent();
  }, 100) as unknown as number;
}

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
      appendMessage(root, msg.role as "user" | "assistant", msg.content, msgIndex, msg.reasoning, msg.timestamp, msg.sources, msg.modelLabel);
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

function appendMessage(root: HTMLElement, role: "user" | "assistant", content: string, msgIndex?: number, reasoning?: string, timestamp?: number, sources?: { key: string; title: string }[], modelLabel?: string): HTMLElement {
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
    // Render reasoning/thinking block if available
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
    // Copy button for assistant messages
    row.appendChild(createCopyButton(doc, content));
    row.appendChild(bubble);
  } else {
    bubble.textContent = content;
    // Edit button for user messages (absolute positioned)
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

    // If editing the first message, reset the title so it gets regenerated
    if (msgIndex === 0) {
      session.title = "";
      session.titleSource = "auto";
    }

    // Truncate session history from this message index onwards
    if (msgIndex >= 0) {
      session.truncateHistoryAt(msgIndex);
      // Save truncated state immediately so stale messages don't persist on disk
      autoSaveSession();
    }

    // Clear all messages from DOM and re-render the remaining history
    const messagesEl = root.querySelector("#chatpdf-messages");
    if (messagesEl) {
      messagesEl.innerHTML = "";
      // Re-render the truncated history (messages before the edited one)
      const remaining = session.getHistory();
      if (remaining.length > 0) {
        let idx = 0;
        for (const msg of remaining) {
          if (msg.role === "system") continue;
          appendMessage(root, msg.role as "user" | "assistant", msg.content, idx, msg.reasoning, msg.timestamp, msg.sources, msg.modelLabel);
          idx++;
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

// ---- Send button appearance ----

function setSendButtonToStop(sendBtn: HTMLButtonElement) {
  sendBtn.textContent = "\u25A0"; // square stop icon
  sendBtn.title = "Stop";
  sendBtn.classList.add("chatpdf-send-btn-stop");
  sendBtn.disabled = false;
}

function setSendButtonToSend(sendBtn: HTMLButtonElement) {
  sendBtn.textContent = "\u2191"; // up arrow
  sendBtn.title = "Send";
  sendBtn.classList.remove("chatpdf-send-btn-stop");
}

// ---- LLM title generation ----

async function generateTitle(targetSession: ChatSession): Promise<void> {
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
        content: "Generate a concise, specific title for this conversation. Detect the language of the user's message and reply in that same language. Reply with ONLY the title text — no quotes, no punctuation at the end, maximum 50 characters.",
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

    // Refresh history list if it's currently visible
    if (showingHistory) {
      for (const win of Zotero.getMainWindows()) {
        const root = (win as any).document?.querySelector("#chatpdf-root") as HTMLElement | null;
        if (root) loadHistoryList(root);
      }
    }
  } catch (err: any) {
    Zotero.debug(`[ChatPDF] generateTitle failed: ${err.message}`);
    // Keep the auto-generated title (first 50 chars of first message)
  }
}

// ---- Chat handling ----

/** Convert all pending sources then send — triggered by Ctrl+Enter. */
async function handleConvertAndSend(root: HTMLElement): Promise<void> {
  const pendingSources = session.getSources().filter(s => s.status === "pending");
  if (pendingSources.length === 0) {
    handleSend(root);
    return;
  }

  const textarea = root.querySelector("#chatpdf-textarea") as HTMLTextAreaElement;
  const sendBtn = root.querySelector("#chatpdf-send") as HTMLButtonElement;
  if (textarea) textarea.disabled = true;
  if (sendBtn) { sendBtn.disabled = true; }

  try {
    // Convert all pending sources in parallel (same as "Convert all" button)
    await Promise.all(
      pendingSources.map(s => convertSource(s, () => refreshSourceChips(root)).catch(() => {}))
    );
  } finally {
    if (textarea) textarea.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
  }

  handleSend(root);
}

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

  // Abort any previous stream for the CURRENT session only.
  // Background streams for other sessions are left running.
  abortCurrentStream();

  // Capture session reference so background streaming saves to the correct session
  // even if the user navigates away and the module-level `session` changes.
  const streamSession = session;
  const streamSessionId = streamSession.id;

  textarea.value = "";
  textarea.style.height = "auto";

  // Snapshot ready sources at send time (for per-message source display)
  const msgSources = streamSession.getSources()
    .filter(s => s.status === "ready")
    .map(s => ({ key: s.key, title: s.title, ...(s.parentKey ? { parentKey: s.parentKey } : {}) }));

  // Track message index: current history length is the index for this new user message
  const userMsgIndex = streamSession.getHistoryLength();
  const userMsgTimestamp = Date.now();
  appendMessage(root, "user", userText, userMsgIndex, undefined, userMsgTimestamp, msgSources);

  textarea.disabled = true;
  isStreaming = true;
  const { controller, signal } = createAbortController();
  currentAbortController = controller;
  setSendButtonToStop(sendBtn);

  // Register this stream so it can be tracked as a background stream.
  // fullText/fullReasoning are updated via closure below.
  const streamState: StreamState = {
    session: streamSession,
    abortController: controller,
    fullText: "",
    fullReasoning: "",
    thinkingDone: false,
    thinkingElapsed: 0,
    thinkingStartTime: 0,
  };
  backgroundStreams.set(streamSessionId, streamState);

  const doc = root.ownerDocument!;

  // Hoisted so catch block can access partial response on abort
  let fullText = "";
  let fullReasoning = "";

  try {
    Zotero.debug("[ChatPDF] handleSend: building messages...");
    // Build messages BEFORE adding to history to avoid duplication
    const messages = streamSession.buildMessages(userText);
    streamSession.addUserMessage(userText, msgSources);

    // Save immediately so the session appears in history right away
    ChatHistory.saveSession(streamSession.toSavedSession()).catch((e: any) => {
      Zotero.debug(`[ChatPDF] early save error: ${e.message}`);
    });

    // Debug: log full request
    const model = (getPref("llmModel") as string) || "deepseek-chat";
    const profileName = getCurrentProfileName();
    const modelLabel = profileName ? `${profileName} / ${model}` : model;
    logLLMRequest(messages, model).catch(() => {});

    const assistantMsgIndex = streamSession.getHistoryLength(); // index for the upcoming assistant message
    Zotero.debug(`[ChatPDF] handleSend: creating assistant row (index=${assistantMsgIndex}), calling LLM...`);
    const row = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
    row.className = "chatpdf-msg-row chatpdf-msg-row-assistant";
    row.dataset.msgIndex = String(assistantMsgIndex);

    const avatar = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
    avatar.className = "chatpdf-avatar chatpdf-avatar-assistant";
    avatar.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`;
    row.appendChild(avatar);

    const bubble = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
    bubble.className = "chatpdf-message chatpdf-message-assistant";

    // Initial thinking indicator (bouncing dots -- shown before any tokens arrive)
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

    // Helper: check if the UI is still showing the session that initiated this stream
    // AND the DOM nodes created by this stream are still in the document.
    // When the user navigates away and back, the DOM is rebuilt and our old
    // bubble/row references become detached — we must not update them.
    const isActiveSession = () => session === streamSession && row.isConnected;

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

      // Insert at the top of the bubble (before any content)
      bubble.insertBefore(reasoningBlock, bubble.firstChild);

      // Start timer
      thinkingStartTime = Date.now();
      streamState.thinkingStartTime = thinkingStartTime;
      thinkingTimerInterval = win.setInterval(() => {
        const elapsed = Math.floor((Date.now() - thinkingStartTime) / 1000);
        if (reasoningTimer) reasoningTimer.textContent = `${elapsed}s`;
      }, 1000) as unknown as number;
    }

    // Thinking callback
    const onThinking: ThinkingCallback = (chunk: string, done: boolean) => {
      try {
        if (!done) {
          fullReasoning += chunk;
          streamState.fullReasoning = fullReasoning;
          // Skip DOM updates if user navigated away
          if (!isActiveSession()) return;

          // Remove initial dots on first thinking token
          if (thinkingDots.parentNode) thinkingDots.remove();

          if (!reasoningBlock) createReasoningBlock();

          // Throttle rendering at 80ms
          if (!reasoningRenderTimer) {
            reasoningRenderTimer = win.setTimeout(() => {
              reasoningRenderTimer = null;
              if (!isActiveSession()) return;
              if (reasoningContent) reasoningContent.textContent = fullReasoning;
              if (messagesEl) scrollToBottomIfNeeded(messagesEl);
            }, 80) as unknown as number;
          }
        } else {
          // Thinking done — record elapsed time
          const elapsed = thinkingStartTime ? Math.floor((Date.now() - thinkingStartTime) / 1000) : 0;
          streamState.thinkingDone = true;
          streamState.thinkingElapsed = elapsed;

          // Clean up timers regardless of active session
          if (thinkingTimerInterval) {
            win.clearInterval(thinkingTimerInterval);
            thinkingTimerInterval = null;
          }
          if (reasoningRenderTimer) {
            win.clearTimeout(reasoningRenderTimer);
            reasoningRenderTimer = null;
          }
          // Only update DOM if still on the same session
          if (isActiveSession()) {
            if (reasoningContent) reasoningContent.textContent = fullReasoning;
            if (reasoningSpinner) reasoningSpinner.remove();

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
        }
      } catch (cbErr) {
        Zotero.debug(`[ChatPDF] thinking callback error: ${cbErr}`);
      }
    };

    // ---- Content streaming ----
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
      try {
        if (!done) {
          fullText += chunk;
          streamState.fullText = fullText;
          // Skip DOM updates if user navigated away
          if (!isActiveSession()) return;

          // Remove dots on first content token (for non-thinking models)
          if (thinkingDots.parentNode) thinkingDots.remove();

          if (!renderTimer) {
            renderTimer = win.setTimeout(() => {
              renderTimer = null;
              if (!isActiveSession()) return;
              setBubbleHtml(fullText);
              if (messagesEl) scrollToBottomIfNeeded(messagesEl);
            }, 80);
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
    }, onThinking, signal);

    // Clean up any lingering timers
    if (thinkingTimerInterval) win.clearInterval(thinkingTimerInterval);

    Zotero.debug(`[ChatPDF] handleSend: LLM response received, ${fullResponse.length} chars`);

    // Add copy button after streaming completes (only if still viewing this session)
    if (isActiveSession()) {
      row.appendChild(createCopyButton(doc, fullResponse));
    }

    // Debug: log full response
    logLLMResponse(fullResponse, fullReasoning || undefined).catch(() => {});

    streamSession.addAssistantMessage(fullResponse, fullReasoning || undefined, modelLabel);
    // Refresh source chips only if still viewing this session
    if (isActiveSession()) {
      refreshSourceChips(root);
    }
    // Save to the stream's session (not the module-level one)
    try {
      await ChatHistory.saveSession(streamSession.toSavedSession());
    } catch (saveErr: any) {
      Zotero.debug(`[ChatPDF] autoSaveSession error: ${saveErr.message}`);
    }

    // Generate LLM title after first exchange (history = user + assistant = 2 messages)
    if (streamSession.getHistoryLength() === 2 && streamSession.titleSource !== "user") {
      generateTitle(streamSession).catch(err => Zotero.debug(`[ChatPDF] generateTitle error: ${err.message}`));
    }

    Zotero.debug(`[ChatPDF] Background stream completed for session ${streamSessionId}, isActive=${isActiveSession()}`);

    // If user navigated away but has since come back to this session, refresh the display
    if (!isActiveSession() && session.id === streamSessionId) {
      Zotero.debug(`[ChatPDF] User returned to streaming session — refreshing display`);
      // The in-memory `session` was loaded from disk and may not have the assistant message.
      // Replace it with the completed streamSession which has the full response.
      session = streamSession;
      const msgs = root.querySelector("#chatpdf-messages");
      if (msgs) msgs.innerHTML = "";
      renderChatHistory(root);
      refreshSourceChips(root);
    }
  } catch (err: any) {
    Zotero.debug(`[ChatPDF] handleSend error: ${err?.name}: ${err?.message}\n${err?.stack}`);
    if (err.name === "AbortError") {
      // Add "[Generation stopped]" marker only if still viewing this session
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
      // Save partial response to the stream's session
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
    // Clean up background stream tracking
    backgroundStreams.delete(streamSessionId);

    // Always reset streaming state so new sends are possible
    isStreaming = false;
    currentAbortController = null;
    // Only touch DOM elements if the UI is still showing the stream's session
    if (session === streamSession) {
      textarea.disabled = false;
      setSendButtonToSend(sendBtn);
      textarea.focus();
    }
  }
}

// ---- Context menu ----

export function registerContextMenu() {
  Zotero.MenuManager.registerMenu({
    menuID: "chatpdf-item-menu",
    pluginID: config.addonID,
    target: "main/library/item",
    menus: [
      {
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
      },
      {
        menuType: "menuitem",
        l10nID: "chatpdf-menuitem-relatedsessions",
        onCommand: async (_event: Event, context: _ZoteroTypes.MenuManager.LibraryMenuContext) => {
          const item = context.items?.[0];
          if (!item) return;
          const parentKey = item.isRegularItem?.() ? item.key : (item.parentItem?.key || item.key);
          const title = getItemTitle(item);
          showFilteredHistory(parentKey, title);
        },
      },
    ],
  });
}

// ---- Exports ----

export function getSession(): ChatSession { return session; }
export function resetSession(): void { session = new ChatSession(); }
