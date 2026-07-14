import { h } from "../utils/dom";
import { formatRelativeDate } from "../utils/format";
import * as ChatHistory from "./chat-history";
import * as MDCache from "./md-cache";
import { ChatSession } from "./chat-session";
import {
  getPanelState, resetStreamingUI, setSendButtonToStop,
} from "./panel-state";
import { renderChatHistory, refreshSourceChips, renderLiveStreamState } from "./message-renderer";
import { autoSaveSession } from "./send-handler";

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
  listEl.innerHTML = "";

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
    let sessions = await ChatHistory.listSessions();
    if (state.historyFilterParentKey) {
      const filterKey = state.historyFilterParentKey;
      sessions = sessions.filter(s => s.referencedParentKeys?.includes(filterKey));
    }
    if (sessions.length === 0) {
      const msg = state.historyFilterParentKey
        ? `No sessions found for "${state.historyFilterTitle || state.historyFilterParentKey}"`
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
        if (state.session.id === meta.id) state.session = new ChatSession();
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
