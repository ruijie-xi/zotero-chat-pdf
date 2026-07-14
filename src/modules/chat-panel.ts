import { config } from "../../package.json";
import { ChatSession, SourceItem } from "./chat-session";
import { createChatInput } from "./tiptap-input";
import { getPref, setPref } from "../utils/prefs";
import { h, XUL_NS } from "../utils/dom";
import {
  createPanelState, getPanelState, destroyPanelState,
  abortCurrentStream, resetStreamingUI,
  ModelProfile,
} from "./panel-state";
import { showFilteredHistory, showHistoryView, hideHistoryView } from "./history-view";
import { refreshSourceChips, convertSource } from "./source-chips";
import { renderChatHistory } from "./message-renderer";
import { handleSend, handleConvertAndSend, autoSaveSession } from "./send-handler";
import {
  addZoteroItemToSession,
  getItemFromZoteroUri,
  getItemTitle,
  getPdfAttachment,
} from "./zotero-items";

// Re-export for external consumers (hooks.ts, etc.)
export { showFilteredHistory } from "./history-view";
export { abortCurrentStream } from "./panel-state";

// ---- Model profile helpers ----

function loadModelProfiles(): ModelProfile[] {
  try {
    const raw = getPref("modelProfiles") as string;
    if (!raw) return [];
    return JSON.parse(raw) as ModelProfile[];
  } catch (e: any) {
    Zotero.debug(`[ChatPDF] loadModelProfiles parse error: ${e.message}`);
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

export async function addItemToSession(item: Zotero.Item, target: Window | HTMLElement): Promise<void> {
  await addZoteroItemToSession(item, getPanelState(target).session);
}

/** Insert an inline mention chip into the TipTap editor. */
function insertInputChip(source: SourceItem, _doc: Document, root: HTMLElement): void {
  getPanelState(root).chatInput?.insertMention({ key: source.id, title: source.title });
}

// ---- Side panel injection ----

export function injectChatPanel(win: Window): void {
  const doc = win.document;

  if (doc.getElementById("chatpdf-panel-container")) return;

  const itemPane = doc.getElementById("zotero-context-pane-inner")
    || doc.getElementById("zotero-item-pane")
    || doc.getElementById("zotero-context-pane");

  const layoutBox = doc.getElementById("zotero-layout")
    || itemPane?.closest("hbox")
    || doc.querySelector("#main-window hbox");

  if (!layoutBox) {
    Zotero.debug("[ChatPDF] Could not find layout container to inject panel");
    return;
  }

  const state = createPanelState(win);

  // --- Inject CSS ---
  const katexLink = doc.createElementNS("http://www.w3.org/1999/xhtml", "link") as HTMLLinkElement;
  katexLink.rel = "stylesheet";
  katexLink.href = `chrome://${config.addonRef}/content/katex.css`;
  katexLink.id = "chatpdf-katex-css";
  doc.documentElement?.appendChild(katexLink);

  const cssLink = doc.createElementNS("http://www.w3.org/1999/xhtml", "link") as HTMLLinkElement;
  cssLink.rel = "stylesheet";
  cssLink.href = `chrome://${config.addonRef}/content/chatpdf.css`;
  cssLink.id = "chatpdf-main-css";
  doc.documentElement?.appendChild(cssLink);

  const splitter = doc.createElementNS(XUL_NS, "splitter") as HTMLElement;
  splitter.id = "chatpdf-splitter";
  splitter.setAttribute("resizebefore", "closest");
  splitter.setAttribute("resizeafter", "closest");

  const vbox = doc.createElementNS(XUL_NS, "vbox") as HTMLElement;
  vbox.id = "chatpdf-panel-container";
  vbox.setAttribute("width", "350");
  vbox.setAttribute("flex", "0");
  vbox.setAttribute("persist", "width");

  const root = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
  root.id = "chatpdf-root";
  root.dataset.chatpdfWindowId = state.windowId;
  vbox.appendChild(root);

  // --- Create minimized bar (hidden by default) ---
  const minimizedBar = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
  minimizedBar.id = "chatpdf-minimized-bar";
  minimizedBar.style.display = "none";
  const minimizedLabel = doc.createElementNS("http://www.w3.org/1999/xhtml", "span") as HTMLElement;
  minimizedLabel.className = "chatpdf-minimized-label";
  minimizedLabel.textContent = "Chat";
  minimizedBar.appendChild(minimizedLabel);
  vbox.appendChild(minimizedBar);

  // --- Minimize / Restore logic ---
  let savedWidth = "350";

  function minimizePanel() {
    savedWidth = vbox.getAttribute("width") || "350";
    root.style.display = "none";
    minimizedBar.style.display = "";
    vbox.setAttribute("width", "36");
    vbox.style.minWidth = "36px";
    vbox.style.maxWidth = "36px";
    splitter.setAttribute("state", "collapsed");
    splitter.style.display = "none";
  }

  function restorePanel() {
    minimizedBar.style.display = "none";
    root.style.display = "";
    vbox.setAttribute("width", savedWidth);
    vbox.style.minWidth = "";
    vbox.style.maxWidth = "";
    splitter.removeAttribute("state");
    splitter.style.display = "";
  }

  minimizedBar.addEventListener("click", restorePanel);

  layoutBox.appendChild(splitter);
  layoutBox.appendChild(vbox);

  // Build the chat UI once — it persists for the window lifetime
  buildChatUI(root, minimizePanel);
}

/** Remove injected panel elements from a window. */
export function removeChatPanel(win: Window): void {
  const doc = win.document;
  const state = getPanelState(win);
  const root = doc.querySelector("#chatpdf-root") as HTMLElement | null;
  if (root) autoSaveSession(root).catch((error: any) => Zotero.debug(`[ChatPDF] unload save failed: ${error.message}`));

  // Clean up copy handler
  if (state.copyHandler) {
    doc.removeEventListener("copy", state.copyHandler);
    state.copyHandler = null;
  }

  // Clean up poll intervals
  for (const id of state.activePollIntervals) {
    win.clearInterval(id);
  }
  state.activePollIntervals.clear();
  state.chatInput?.destroy();
  state.chatInput = null;

  doc.getElementById("chatpdf-panel-container")?.remove();
  doc.getElementById("chatpdf-splitter")?.remove();
  doc.getElementById("chatpdf-katex-css")?.remove();
  doc.getElementById("chatpdf-main-css")?.remove();
  destroyPanelState(win);
}

// ---- UI Building ----

function buildChatUI(root: HTMLElement, onMinimize?: () => void) {
  const doc = root.ownerDocument!;
  const state = getPanelState(root);
  root.innerHTML = "";
  state.showingHistory = false;

  // 0. Title bar with minimize button
  const titleBar = h(doc, "div", { className: "chatpdf-title-bar" });
  const titleText = h(doc, "span", { className: "chatpdf-title-bar-text" }, "Chat");
  titleBar.appendChild(titleText);
  if (onMinimize) {
    const minimizeBtn = h(doc, "button", { className: "chatpdf-minimize-btn", title: "Minimize" }, "\u2212");
    minimizeBtn.addEventListener("click", onMinimize);
    titleBar.appendChild(minimizeBtn);
  }
  root.appendChild(titleBar);

  // 1. Messages area
  const messagesArea = h(doc, "div", { className: "chatpdf-messages", id: "chatpdf-messages" });

  const welcome = h(doc, "div", { className: "chatpdf-welcome" });
  const welcomeIcon = h(doc, "div", { className: "chatpdf-welcome-icon" }, "\uD83D\uDCAC");
  const welcomeText = h(doc, "div", { className: "chatpdf-welcome-text" }, "Ask questions about your documents");
  const welcomeHint = h(doc, "div", { className: "chatpdf-welcome-hint" }, "Drop PDFs into the sources area or use the right-click menu to add papers");
  welcome.appendChild(welcomeIcon);
  welcome.appendChild(welcomeText);
  welcome.appendChild(welcomeHint);
  messagesArea.appendChild(welcome);

  // Copy handler — stored for cleanup
  const handler = (e: Event) => {
    const win = doc.defaultView;
    const sel = win?.getSelection?.();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString();
    if (!text) return;
    const anchor = sel.anchorNode;
    if (!anchor || !messagesArea.contains(anchor)) return;
    e.preventDefault();
    try {
      const helper = (Components.classes as any)["@mozilla.org/widget/clipboardhelper;1"]
        .getService((Components.interfaces as any).nsIClipboardHelper);
      helper.copyString(text);
    } catch {
      (e as ClipboardEvent).clipboardData?.setData("text/plain", text);
    }
  };
  doc.addEventListener("copy", handler);
  state.copyHandler = handler;

  root.appendChild(messagesArea);

  // History view elements (hidden by default)
  const historyHeader = h(doc, "div", { className: "chatpdf-header-bar", id: "chatpdf-history-header", style: "display:none" });
  const historyTitle = h(doc, "span", { className: "chatpdf-header-title" }, "Chat History");
  const newChatBtnHeader = h(doc, "button", { className: "chatpdf-header-btn" }, "+ New Chat");
  historyHeader.appendChild(historyTitle);
  historyHeader.appendChild(newChatBtnHeader);
  root.appendChild(historyHeader);

  const historyFilterBarEl = h(doc, "div", { className: "chatpdf-history-filter-bar", id: "chatpdf-history-filter-bar", style: "display:none" });
  root.appendChild(historyFilterBarEl);

  const historyList = h(doc, "div", { className: "chatpdf-history-list", id: "chatpdf-history-list", style: "display:none" });
  root.appendChild(historyList);

  // 2. Resize handle + Source chips area
  const resizeHandle = h(doc, "div", { className: "chatpdf-resize-handle" });
  root.appendChild(resizeHandle);

  const sourceArea = h(doc, "div", { className: "chatpdf-sources", id: "chatpdf-sources" });
  const chipContainer = h(doc, "div", { className: "chatpdf-source-chips", id: "chatpdf-source-chips" });
  sourceArea.appendChild(chipContainer);

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

  root.appendChild(sourceArea);

  // 3. Input area
  const inputArea = h(doc, "div", { className: "chatpdf-input-area", id: "chatpdf-input-area" });

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

  try {
    state.chatInput = createChatInput(
      doc,
      () => { if (!state.isStreaming) handleSend(root); },
      () => { if (!state.isStreaming) handleConvertAndSend(root); },
    );
  } catch (err: any) {
    Zotero.debug(`[ChatPDF] TipTap creation FAILED: ${err.message}\n${err.stack}`);
  }

  const sendBtn = h(doc, "button", { className: "chatpdf-send-btn", id: "chatpdf-send", title: "Send" }, "\u2191");

  if (state.chatInput) inputWrapper.appendChild(state.chatInput.element);
  inputWrapper.appendChild(sendBtn);
  inputArea.appendChild(inputWrapper);

  const usageBar = h(doc, "div", { className: "chatpdf-usage-bar", id: "chatpdf-usage-bar" });
  inputArea.appendChild(usageBar);

  const inputHint = h(doc, "div", { className: "chatpdf-input-hint" }, "Enter to send \u00B7 Ctrl+Enter: convert & send \u00B7 Shift+Enter: new line");
  inputArea.appendChild(inputHint);

  root.appendChild(inputArea);

  // ---- Drag-and-drop ----
  inputWrapper.addEventListener("dragover", (e: Event) => {
    (e as DragEvent).preventDefault();
    inputWrapper.classList.add("chatpdf-drop-active");
  });
  inputWrapper.addEventListener("dragleave", (e: Event) => {
    const related = (e as MouseEvent).relatedTarget as Node | null;
    if (!related || !inputWrapper.contains(related)) {
      inputWrapper.classList.remove("chatpdf-drop-active");
    }
  });
  inputWrapper.addEventListener("drop", async (e: Event) => {
    const de = e as DragEvent;
    de.preventDefault();
    inputWrapper.classList.remove("chatpdf-drop-active");
    const dt = de.dataTransfer;

    if (dt) {
      const types = Array.from(dt.types);
      Zotero.debug(`[ChatPDF] drop on input: dataTransfer.types = ${JSON.stringify(types)}`);
      for (const type of types) {
        try { Zotero.debug(`[ChatPDF] drop on input: ${type} = "${dt.getData(type)}"`); } catch {}
      }
    }

    async function handleDroppedItem(item: Zotero.Item) {
      await addItemToSession(item, root);
      const pdf = getPdfAttachment(item);
      const src = state.session.getSource(pdf?.key || "", Number((pdf as any)?.libraryID) || undefined);
      if (src) insertInputChip(src, doc, root);
      refreshSourceChips(root);
    }

    // 1. zotero/item
    const zoteroItemData = dt?.getData("zotero/item");
    if (zoteroItemData) {
      for (const id of zoteroItemData.split(",").map((s: string) => parseInt(s, 10))) {
        const droppedItem = Zotero.Items.get(id);
        if (droppedItem) await handleDroppedItem(droppedItem);
      }
      return;
    }

    // 2. zotero/tab
    const tabID = dt?.getData("zotero/tab");
    if (tabID) {
      try {
        const mainWin = Zotero.getMainWindow() as any;
        const reader = (Zotero as any).Reader?.getByTabID?.(tabID);
        if (reader?.itemID) {
          const item = Zotero.Items.get(reader.itemID);
          if (item) { await handleDroppedItem(item); return; }
        }
        const tab = mainWin.Zotero_Tabs?._tabs?.find((t: any) => t.id === tabID);
        const itemID = tab?.data?.itemID;
        if (itemID) {
          const item = Zotero.Items.get(itemID);
          if (item) { await handleDroppedItem(item); return; }
        }
      } catch (err) {
        Zotero.debug(`[ChatPDF] drop on input: zotero/tab error: ${err}`);
      }
    }

    // 3. URI-based fallbacks
    const uriCandidates: string[] = [];
    const mozUrl = dt?.getData("text/x-moz-url");
    if (mozUrl) uriCandidates.push(mozUrl.split("\n")[0].trim());
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
      if (item) { await handleDroppedItem(item); return; }
    }

    // 4. Last resort: currently-open tab
    if (dt && Array.from(dt.types).length > 0) {
      try {
        const mainWin = Zotero.getMainWindow() as any;
        const selectedTabID = mainWin.Zotero_Tabs?.selectedID;
        if (selectedTabID && selectedTabID !== "zotero-pane") {
          const reader = (Zotero as any).Reader?.getByTabID?.(selectedTabID);
          if (reader?.itemID) {
            const item = Zotero.Items.get(reader.itemID);
            if (item) { await handleDroppedItem(item); return; }
          }
          const tab = mainWin.Zotero_Tabs?._tabs?.find((t: any) => t.id === selectedTabID);
          const itemID = tab?.data?.itemID;
          if (itemID) {
            const item = Zotero.Items.get(itemID);
            if (item) { await handleDroppedItem(item); return; }
          }
        }
      } catch (err) {
        Zotero.debug(`[ChatPDF] drop on input: last-resort error: ${err}`);
      }
    }
  });

  // ---- Event handlers ----

  sendBtn.addEventListener("click", () => {
    if (state.isStreaming) {
      abortCurrentStream(root);
    } else {
      handleSend(root);
    }
  });

  clearLink.addEventListener("click", async () => {
    abortCurrentStream(root);
    state.session.clearHistory();
    await autoSaveSession(root, true);
    const msgs = root.querySelector("#chatpdf-messages");
    if (msgs) {
      msgs.innerHTML = "";
      msgs.appendChild(welcome);
    }
  });

  convertAllLink.addEventListener("click", () => {
    for (const s of state.session.getSources().filter((s) => s.status === "pending")) {
      convertSource(s, () => refreshSourceChips(root), undefined, state).catch(() => {});
    }
  });

  historyBtn.addEventListener("click", () => {
    if (state.showingHistory) {
      hideHistoryView(root);
    } else {
      showHistoryView(root);
    }
  });

  const handleNewChat = async () => {
    abortCurrentStream(root);
    await autoSaveSession(root);
    state.session = new ChatSession();
    resetStreamingUI(root);
    hideHistoryView(root);
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
      setPref("llmThinkingMode", selected.thinkingMode || "default");
      setPref("llmThinkEffort", selected.thinkEffort || "default");
      setPref("activeProfile", selected.name);
      Zotero.debug(`[ChatPDF] Switched to profile: ${selected.name}`);
    }
  });

  renderChatHistory(root);
  refreshSourceChips(root);
  refreshProfileSelect(root);
}

// ---- Context menu ----

export function registerContextMenu(): void {
  Zotero.MenuManager.registerMenu({
    menuID: "chatpdf-item-menu",
    pluginID: config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "menuitem",
        l10nID: "chatpdf-menuitem-addtochatpdf",
        onCommand: async (_event: Event, context: _ZoteroTypes.MenuManager.LibraryMenuContext) => {
          const win = Zotero.getMainWindow() as Window;
          const root = win?.document?.querySelector("#chatpdf-root") as HTMLElement | null;
          if (!root) return;
          for (const item of context.items ?? []) {
            await addItemToSession(item, root);
          }
          refreshSourceChips(root);
          const state = getPanelState(root);
          for (const item of context.items ?? []) {
            const pdf = getPdfAttachment(item);
            if (!pdf) continue;
            const src = state.session.getSource(pdf.key, Number((pdf as any).libraryID) || undefined);
            if (src) insertInputChip(src, root.ownerDocument!, root);
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
