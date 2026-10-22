import { applyModelProfile, loadModelProfiles } from "./model-profile";
import { createLibraryAccessControl } from "./library-access-control";
import { ChatSession } from "./chat-session";
import { createChatInput } from "./tiptap-input";
import { IMAGE_INPUT_HELP } from "./image-input";
import { getPref } from "../utils/prefs";
import { h, XUL_NS, XULMenuList } from "../utils/dom";
import { uiLabel, uiText } from "../utils/ui-text";
import { getPanelState, abortCurrentStream, resetStreamingUI } from "./panel-state";
import { showHistoryView, hideHistoryView } from "./history-view";
import { refreshSourceChips } from "./source-chips";
import { clearChatMessages, renderChatHistory, updateUsageBar } from "./message-renderer";
import { handleSend, resendEditedMessage } from "./send-handler";
import { MESSAGE_EDIT_EVENT, type MessageEditRequest } from "./message-editor";
import { autoSaveSession } from "./session-persistence";
import { installInputSources } from "./chat-input-sources";

function getCurrentProfileName(): string {
  return (getPref("activeProfile") as string) || "";
}

function refreshProfileSelect(root: HTMLElement): void {
  const select = root.querySelector("#chatpdf-profile-select") as XULMenuList | null;
  if (!select) return;
  const doc = root.ownerDocument!;
  const popup = select.querySelector("menupopup")!;
  popup.replaceChildren();
  const profiles = loadModelProfiles();
  const currentProfile = getCurrentProfileName();
  if (profiles.length === 0) {
    select.style.display = "none";
    return;
  }
  select.style.display = "";
  for (const p of profiles) {
    const opt = doc.createElementNS(XUL_NS, "menuitem");
    opt.setAttribute("value", p.name);
    opt.setAttribute("label", p.name);
    popup.appendChild(opt);
  }
  select.value = currentProfile || profiles[0].name;
}


export function buildChatUI(root: HTMLElement, onMinimize?: () => void) {
  const doc = root.ownerDocument!;
  const state = getPanelState(root);
  root.innerHTML = "";
  state.showingHistory = false;

  // 0. Title bar with minimize button
  const titleBar = h(doc, "div", { className: "chatpdf-title-bar" });
  const titleText = h(doc, "span", { className: "chatpdf-title-bar-text" }, "ChatPDF");
  titleBar.appendChild(titleText);
  const titleActions = h(doc, "div", { className: "chatpdf-title-actions" });
  const historyBtn = h(doc, "button", { type: "button", className: "chatpdf-toolbar-btn", "data-action": "history", "aria-expanded": "false" }, uiLabel("history"));
  const newChatBtn = h(doc, "button", { type: "button", className: "chatpdf-toolbar-btn", "data-action": "new-chat" }, uiLabel("newChat"));
  titleActions.append(historyBtn, newChatBtn);
  titleBar.append(titleActions);
  if (onMinimize) {
    const minimizeBtn = h(doc, "button", { type: "button", className: "chatpdf-minimize-btn", title: uiLabel("minimize"), "aria-label": uiLabel("minimize") }, "\u2212");
    minimizeBtn.addEventListener("click", onMinimize);
    titleActions.appendChild(minimizeBtn);
  }
  root.appendChild(titleBar);

  // 1. Messages area
  const messagesArea = h(doc, "div", { className: "chatpdf-messages", id: "chatpdf-messages" });

  const welcome = h(doc, "div", { className: "chatpdf-welcome" });
  const welcomeIcon = h(doc, "div", { className: "chatpdf-welcome-icon" }, "\uD83D\uDCAC");
  const welcomeText = h(doc, "div", { className: "chatpdf-welcome-text" }, uiLabel("welcome"));
  const welcomeHint = h(doc, "div", { className: "chatpdf-welcome-hint" }, uiLabel("welcomeHint"));
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
  const historyTitle = h(doc, "span", { className: "chatpdf-header-title" }, uiLabel("historyTitle"));
  const backButton = h(doc, "button", { type: "button", className: "chatpdf-toolbar-btn" }, uiText("Back to chat", "返回会话"));
  historyHeader.appendChild(historyTitle);
  historyHeader.appendChild(backButton);
  backButton.addEventListener("click", () => hideHistoryView(root));
  root.appendChild(historyHeader);

  const historyFilterBarEl = h(doc, "div", { className: "chatpdf-history-filter-bar", id: "chatpdf-history-filter-bar", style: "display:none" });
  root.appendChild(historyFilterBarEl);

  const historyList = h(doc, "div", { className: "chatpdf-history-list", id: "chatpdf-history-list", style: "display:none" });
  root.appendChild(historyList);

  // 2. Resize handle + Source chips area
  const resizeHandle = h(doc, "div", { className: "chatpdf-resize-handle" });
  root.appendChild(resizeHandle);

  const sourceArea = h(doc, "div", { className: "chatpdf-sources", id: "chatpdf-sources" });
  sourceArea.append(h(doc, "div", { className: "chatpdf-sources-heading", id: "chatpdf-sources-heading" }));
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
  const imageButton = h(doc, "button", { type: "button", className: "chatpdf-toolbar-btn", title: IMAGE_INPUT_HELP }, uiLabel("addImage"));
  const imagePicker = h(doc, "input", { type: "file", accept: "image/png,image/jpeg,image/webp", multiple: "multiple", style: "display:none" }) as HTMLInputElement;
  const imageStatus = h(doc, "div", { className: "chatpdf-image-status", role: "status" });
  imageButton.addEventListener("click", () => imagePicker.click());
  const profileSelect = doc.createElementNS(XUL_NS, "menulist") as XULMenuList;
  profileSelect.setAttribute("class", "chatpdf-profile-select");
  profileSelect.id = "chatpdf-profile-select";
  profileSelect.setAttribute("native", "true");
  profileSelect.setAttribute("aria-label", uiLabel("modelProfile"));
  profileSelect.style.display = "none";
  profileSelect.appendChild(doc.createElementNS(XUL_NS, "menupopup"));
  toolbar.appendChild(imageButton);
  toolbar.appendChild(imagePicker);
  toolbar.appendChild(profileSelect);
  inputArea.appendChild(toolbar);
  inputArea.appendChild(createLibraryAccessControl(root));

  const inputWrapper = h(doc, "div", { className: "chatpdf-input-wrapper" });

  try {
    state.chatInput = createChatInput(
      doc,
      () => { if (!state.isStreaming) handleSend(root); },
      () => { if (!state.isStreaming) handleSend(root); },
    );
  } catch (err: any) {
    Zotero.debug(`[ChatPDF] TipTap creation FAILED: ${err.message}\n${err.stack}`);
  }

  const sendBtn = h(doc, "button", { type: "button", className: "chatpdf-send-btn", id: "chatpdf-send", title: uiLabel("send"), "aria-label": uiLabel("send") }, "\u2191");

  if (state.chatInput) inputWrapper.appendChild(state.chatInput.element);
  inputWrapper.appendChild(sendBtn);
  inputArea.appendChild(inputWrapper);

  const usageBar = h(doc, "details", { className: "chatpdf-usage-bar", id: "chatpdf-usage-bar", hidden: "hidden" });

  const inputHint = h(doc, "div", { className: "chatpdf-input-hint", title: uiLabel("inputHelp") }, uiLabel("inputHint"));
  inputArea.appendChild(inputHint);
  inputArea.appendChild(usageBar);
  inputArea.appendChild(imageStatus);

  root.appendChild(inputArea);

  installInputSources(root, inputWrapper, imagePicker, imageStatus);

  // ---- Event handlers ----

  sendBtn.addEventListener("click", () => {
    if (state.isStreaming) {
      abortCurrentStream(root);
    } else {
      handleSend(root);
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
    const version = ++state.sessionLoadVersion;
    abortCurrentStream(root);
    await autoSaveSession(root);
    if (state.sessionLoadVersion !== version || !root.isConnected) return;
    state.session = new ChatSession();
    imageStatus.textContent = "";
    resetStreamingUI(root);
    hideHistoryView(root);
    clearChatMessages(root);
    const msgs = root.querySelector("#chatpdf-messages");
    if (msgs) {
      msgs.appendChild(welcome);
    }
    updateUsageBar(root);
    refreshSourceChips(root);
  };
  newChatBtn.addEventListener("click", handleNewChat);
  root.addEventListener(MESSAGE_EDIT_EVENT, (event: Event) => {
    void resendEditedMessage(root, (event as CustomEvent & { detail: MessageEditRequest }).detail);
  });

  profileSelect.addEventListener("command", () => {
    const profiles = loadModelProfiles();
    const selected = profiles.find(p => p.name === profileSelect.value);
    if (selected) {
      applyModelProfile(selected);
      getPanelState(root).session.contextStats = undefined;
      updateUsageBar(root, getPanelState(root).session.getTokenUsage());
      Zotero.debug(`[ChatPDF] Switched to profile: ${selected.name}`);
    }
  });

  renderChatHistory(root);
  refreshSourceChips(root);
  refreshProfileSelect(root);
}
