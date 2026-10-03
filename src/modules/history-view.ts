import { h } from "../utils/dom";
import { formatRelativeDate } from "../utils/format";
import * as ChatHistory from "./chat-history";
import * as MDCache from "./md-cache";
import { ChatSession } from "./chat-session";
import {
  getPanelState, resetStreamingUI, setSendButtonToStop,
} from "./panel-state";
import { renderChatHistory, refreshSourceChips, renderLiveStreamState, updateUsageBar } from "./message-renderer";
import { autoSaveSession } from "./send-handler";
import { recoverSource } from "./source-chips";
import { filterHistory } from "./history-search";
import { uiText } from "../utils/ui-text";

function initHistoryControls(root: HTMLElement): void {
  if (root.querySelector("#chatpdf-history-controls")) return;
  const doc = root.ownerDocument!, state = getPanelState(root);
  const controls = h(doc, "div", { id: "chatpdf-history-controls", className: "chatpdf-history-controls" });
  const query = h(doc, "input", { type: "search", id: "chatpdf-history-search", placeholder: uiText("Search chats or paper titles", "搜索聊天或论文标题"), "aria-label": uiText("Search history", "搜索历史记录") }) as HTMLInputElement;
  query.value = state.historyQuery || "";
  const options = h(doc, "div", { className: "chatpdf-history-options" });
  const includeEmpty = h(doc, "input", { type: "checkbox", id: "chatpdf-history-include-empty" }) as HTMLInputElement;
  const pinnedOnly = h(doc, "input", { type: "checkbox", id: "chatpdf-history-pinned-only" }) as HTMLInputElement;
  includeEmpty.checked = state.historyIncludeEmpty; pinnedOnly.checked = state.historyPinnedOnly;
  options.append(h(doc, "label", {}, includeEmpty, uiText("Include empty chats", "显示空会话")), h(doc, "label", {}, pinnedOnly, uiText("Pinned only", "仅置顶")));
  controls.append(query, options, h(doc, "span", { id: "chatpdf-history-count", "aria-live": "polite" }));
  root.insertBefore(controls, root.querySelector("#chatpdf-history-filter-bar") || root.querySelector("#chatpdf-history-list"));
  const refresh = () => { state.historyVisibleCount = 50; void loadHistoryList(root); };
  query.addEventListener("input", () => { state.historyQuery = query.value; refresh(); });
  includeEmpty.addEventListener("change", () => { state.historyIncludeEmpty = includeEmpty.checked; refresh(); });
  pinnedOnly.addEventListener("change", () => { state.historyPinnedOnly = pinnedOnly.checked; refresh(); });
}

/** Show history filtered to a specific parent item. Called from context menu. */
export function showFilteredHistory(parentKey: string, title: string): void {
  for (const win of Zotero.getMainWindows()) {
    const root = (win as any).document?.querySelector("#chatpdf-root") as HTMLElement | null;
    if (root) {
      const state = getPanelState(root);
      state.historyFilterParentKey = parentKey;
      state.historyFilterTitle = title;
      showHistoryView(root);
    }
  }
}

export function showHistoryView(root: HTMLElement): void {
  getPanelState(root).showingHistory = true;
  initHistoryControls(root);
  (root.querySelector("#chatpdf-history-controls") as HTMLElement).hidden = false;
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

  loadHistoryList(root);
}

export function hideHistoryView(root: HTMLElement): void {
  const state = getPanelState(root);
  state.showingHistory = false;
  state.historyLoadVersion++;
  const controls = root.querySelector("#chatpdf-history-controls") as HTMLElement | null;
  if (controls) controls.hidden = true;
  state.historyFilterParentKey = null;
  state.historyFilterTitle = null;
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

export async function loadHistoryList(root: HTMLElement): Promise<void> {
  const state = getPanelState(root);
  const listEl = root.querySelector("#chatpdf-history-list");
  if (!listEl) return;
  const doc = root.ownerDocument!;
  const version = ++state.historyLoadVersion;

  // Show/update the dedicated filter bar element
  const filterBarEl = root.querySelector("#chatpdf-history-filter-bar") as HTMLElement | null;
  if (filterBarEl) {
    filterBarEl.innerHTML = "";
    if (state.historyFilterParentKey) {
      filterBarEl.style.display = "";
      filterBarEl.appendChild(h(doc, "span", { className: "chatpdf-history-filter-label" },
        `Sessions for: ${state.historyFilterTitle || state.historyFilterParentKey}`));
      const clearBtn = h(doc, "button", { className: "chatpdf-history-filter-clear" }, "\u00D7 Clear filter");
      clearBtn.addEventListener("click", () => {
        state.historyFilterParentKey = null;
        state.historyFilterTitle = null;
        loadHistoryList(root);
      });
      filterBarEl.appendChild(clearBtn);
    } else {
      filterBarEl.style.display = "none";
    }
  }

  try {
    const allSessions = await ChatHistory.listSessions();
    if (state.historyLoadVersion !== version || !root.isConnected) return;
    const sessions = filterHistory(allSessions, { query: state.historyQuery || "", includeEmpty: !!state.historyIncludeEmpty,
      pinnedOnly: !!state.historyPinnedOnly, parentKey: state.historyFilterParentKey });
    const visible = sessions.slice(0, state.historyVisibleCount || 50);
    const count = root.querySelector("#chatpdf-history-count");
    if (count) count.textContent = uiText(`${visible.length} of ${sessions.length} matches · ${allSessions.length} saved chats`, `显示 ${visible.length}/${sessions.length} 条匹配记录 · 共 ${allSessions.length} 条`);
    const scrollTop = (listEl as HTMLElement).scrollTop;
    listEl.replaceChildren();
    if (sessions.length === 0) {
      const msg = state.historyQuery || state.historyPinnedOnly || !state.historyIncludeEmpty && allSessions.length
        ? uiText("No matching chats. Change the search or filters; empty chats can be shown above.", "没有匹配的会话，请调整搜索或筛选；上方可选择显示空会话。") : state.historyFilterParentKey
        ? `No sessions found for "${state.historyFilterTitle || state.historyFilterParentKey}"`
        : uiText("No chat history yet", "暂无聊天记录");
      const empty = h(doc, "div", { className: "chatpdf-history-empty" }, msg);
      listEl.appendChild(empty);
      return;
    }

    for (const meta of visible) {
      const item = h(doc, "div", { className: "chatpdf-history-item", "data-session-id": meta.id });

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
      if (meta.sourceTitles.length) info.appendChild(h(doc, "div", { className: "chatpdf-history-paper-titles", title: meta.sourceTitles.join("\n") }, meta.sourceTitles.join(" · ")));
      const pin = h(doc, "button", { type: "button", className: "chatpdf-history-pin", "aria-pressed": String(!!meta.pinned), title: meta.pinned ? uiText("Unpin", "取消置顶") : uiText("Pin", "置顶") }, meta.pinned ? "★" : "☆") as HTMLButtonElement;
      pin.addEventListener("click", async event => {
        event.stopPropagation(); pin.disabled = true;
        try { await ChatHistory.setSessionPinned(meta.id, !meta.pinned); await loadHistoryList(root); }
        catch (error: any) { Zotero.debug(`[ChatPDF] Pin history failed: ${error.message}`); pin.disabled = false; }
      });

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
            if (state.session.id === meta.id) {
              state.session.title = newTitle;
              state.session.titleSource = "user";
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
      item.appendChild(pin);
      item.appendChild(deleteBtn);

      // Click to load session
      info.addEventListener("click", async () => {
        await autoSaveSession(root);

        // Check if there's a background stream for this session
        const bgStream = state.backgroundStreams.get(meta.id);
        if (bgStream) {
          Zotero.debug(`[ChatPDF] Loading session ${meta.id} which has an active background stream`);
          state.session = bgStream.session;
        } else {
          const saved = await ChatHistory.loadSession(meta.id);
          if (!saved) return;
          state.session = ChatSession.fromSavedSession(saved);
        }

        resetStreamingUI(root);

        // If this session has an active background stream, restore streaming state
        if (bgStream) {
          state.currentAbortController = bgStream.abortController;
          state.isStreaming = true;
          const sb = root.querySelector("#chatpdf-send") as HTMLButtonElement;
          if (sb) setSendButtonToStop(sb);
          state.chatInput?.setEditable(false);
        }
        // Reload markdown for sources from cache
        const currentSession = state.session;
        for (const source of currentSession.getSources()) {
          if (source.kind === "image") continue;
          if (!source.markdown) {
      if (await MDCache.has(source.cacheKey, source.key)) {
        const md = await MDCache.read(source.cacheKey, source.key);
        currentSession.setSourceReady(source.id, md);
            }
          }
        }
        hideHistoryView(root);
        // Re-render messages
        const msgs = root.querySelector("#chatpdf-messages");
        if (msgs) msgs.innerHTML = "";
        renderChatHistory(root);
        refreshSourceChips(root);

        for (const source of currentSession.getSources()) recoverSource(source, root, currentSession);

        // If there's an active background stream, render its current state
        if (bgStream && msgs) {
          renderLiveStreamState(root, bgStream);
        }
      });

      // Delete button
      deleteBtn.addEventListener("click", async (e: Event) => {
        e.stopPropagation();
        const activeStream = state.backgroundStreams.get(meta.id);
        activeStream?.abortController.abort();
        state.backgroundStreams.delete(meta.id);
        if (state.session.id === meta.id) {
          state.session = new ChatSession();
          updateUsageBar(root);
        }
        await ChatHistory.deleteSession(meta.id);
        loadHistoryList(root);
      });

      listEl.appendChild(item);
    }
    if (visible.length < sessions.length) {
      const more = h(doc, "button", { type: "button", className: "chatpdf-history-more" }, uiText("Show 50 more", "再显示 50 条"));
      more.addEventListener("click", () => { state.historyVisibleCount = (state.historyVisibleCount || 50) + 50; void loadHistoryList(root); });
      listEl.appendChild(more);
    }
    (listEl as HTMLElement).scrollTop = scrollTop;
  } catch (err: any) {
    if (state.historyLoadVersion !== version || !root.isConnected) return;
    Zotero.debug(`[ChatPDF] loadHistoryList error: ${err.message}`);
    const errEl = h(doc, "div", { className: "chatpdf-history-empty" }, "Failed to load history");
    listEl.appendChild(errEl);
  }
}
