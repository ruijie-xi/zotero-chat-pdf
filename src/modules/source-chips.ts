import { h } from "../utils/dom";
import { SourceItem } from "./chat-session";
import * as ChatHistory from "./chat-history";
import { getPanelState } from "./panel-state";
import { openPdfForSourceKey } from "./zotero-items";
import { createSourceChip, SourceChipView } from "./source-chip-ui";

function saveCurrentSession(root: HTMLElement): void {
  const { session } = getPanelState(root);
  ChatHistory.saveSession(session.toSavedSession()).catch((err: any) => {
    Zotero.debug(`[ChatPDF] save after source removal failed: ${err.message}`);
  });
}

interface SourceRow {
  source: SourceItem;
  element: HTMLElement;
  view: SourceChipView;
}
const sourceRows = new WeakMap<Element, Map<string, SourceRow>>();

/** Render the source chips UI in the panel. */
function renderSourceChips(root: HTMLElement): void {
  const state = getPanelState(root);
  const { session } = state;
  const container = root.querySelector("#chatpdf-source-chips");
  if (!container) return;
  const doc = root.ownerDocument!;
  const sources = session.getSources();
  const rows = sourceRows.get(container) || new Map<string, SourceRow>();
  sourceRows.set(container, rows);
  const wanted: HTMLElement[] = [];
  const sourceIds = new Set(sources.map(source => source.id));
  for (const [id, row] of rows) {
    if (!sourceIds.has(id) || session.getSource(id) !== row.source) { row.view.dismiss(); row.element.remove(); rows.delete(id); }
  }

  for (const source of sources) {
    let row = rows.get(source.id);
    if (!row) {
      const view = createSourceChip(root, source, {
        open: () => {
          if (source.kind === "image") state.chatInput?.insertMention({ key: source.id, title: source.title });
          else void openPdfForSourceKey(source.key, source.libraryID).catch(err => Zotero.debug(`[ChatPDF] Open source failed: ${err.message}`));
        },
        remove: () => {
          state.backgroundStreams.get(session.id)?.abortController.abort();
          session.removeSource(source.id); saveCurrentSession(root); refreshSourceChips(root);
        },
      });
      const element = h(doc, "div", { className: "chatpdf-source-entry" }); element.append(view.element);
      row = { source, element, view }; rows.set(source.id, row);
    }
    row.view.update(); wanted.push(row.element);
  }

  // Reconcile only additions/removals/reordering; never detach an unchanged row.
  for (const [index, row] of wanted.entries()) {
    if (container.children[index] !== row) container.insertBefore(row, container.children[index] || null);
  }


}

/** Refresh source chips without allowing Firefox to move the active chat cursor. */
export function refreshSourceChips(root: HTMLElement): void {
  const chatInput = getPanelState(root).chatInput;
  if (chatInput) {
    chatInput.preserveSelectionDuring(() => renderSourceChips(root));
  } else {
    renderSourceChips(root);
  }
}
