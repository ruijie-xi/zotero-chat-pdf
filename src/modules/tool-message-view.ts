import { h } from "../utils/dom";
import { uiText } from "../utils/ui-text";
import { applyLibraryChanges, listLibraryChanges, type LibraryChangeSet } from "./library-changes";
import { renderLibraryPreview } from "./library-change-preview";
import type { ToolCallRecord } from "./chat-session";

/** Create a collapsible tool call block for display in the assistant bubble. */
export function createToolBlock(doc: Document, toolHistory: ToolCallRecord[], totalMs: number): HTMLElement {
  const block = h(doc, "div", { className: "chatpdf-tool-block" });
  const toggle = h(doc, "button", { className: "chatpdf-tool-toggle", type: "button", "aria-expanded": "false" });
  toggle.textContent = uiText(`Used ${toolHistory.length} tool${toolHistory.length !== 1 ? "s" : ""} · ${(totalMs / 1000).toFixed(1)}s`, `使用了 ${toolHistory.length} 个工具 · ${(totalMs / 1000).toFixed(1)} 秒`);
  const content = h(doc, "div", { className: "chatpdf-tool-content" });

  for (let i = 0; i < toolHistory.length; i++) {
    const tr = toolHistory[i];
    const entry = h(doc, "div", { className: "chatpdf-tool-entry" });
    const argsStr = JSON.stringify(tr.args);
    const nameRow = h(doc, "div", { className: "chatpdf-tool-name" }, `${i + 1}. ${tr.toolName}`);
    entry.appendChild(nameRow);
    let receipt: any;
    if (tr.toolName === "change_zotero_library") {
      try {
        const parsed = JSON.parse(tr.result.split("\n\n[Tool result metadata:")[0]);
        if (parsed.change_id && Array.isArray(parsed.changes)) receipt = parsed;
      } catch { /* Failed and legacy results retain their original display. */ }
    }
    const resultContainer = receipt ? h(doc, "details", { className: "chatpdf-library-technical-details" }) : entry;
    if (receipt) {
      const plan: LibraryChangeSet = { id: receipt.change_id, status: receipt.status, changes: receipt.changes.map((change: any) => {
        const identity = { kind: change.kind, libraryID: change.library_id, key: change.key, title: change.title };
        return { before: change.before ? { ...identity, data: change.before } : null, after: change.after ? { ...identity, data: change.after } : null };
      }) };
      entry.append(h(doc, "div", { className: "chatpdf-library-change-status" }, receipt.status === "applied" ? uiText("Changes applied", "修改已完成")
        : receipt.status === "undone" ? uiText("Changes undone", "修改已撤销") : uiText("Change preview", "修改预览")), renderLibraryPreview(doc, plan, receipt.status === "undone"));
      resultContainer.append(h(doc, "summary", {}, uiText("Technical details", "技术详情")));
    }
    if (argsStr !== "{}") {
      resultContainer.appendChild(h(doc, "div", { className: "chatpdf-tool-args" }, argsStr));
    }
    if ((tr.contextDelivery === "omitted" || tr.contextDelivery === "paged") && tr.contextMessage) {
      entry.appendChild(h(doc, "div", { className: "chatpdf-tool-context-warning" }, tr.contextMessage));
    }
    resultContainer.appendChild(h(doc, "div", { className: "chatpdf-tool-result" }, tr.result));
    if (receipt) entry.append(resultContainer);
    entry.appendChild(h(doc, "div", { className: "chatpdf-tool-duration" }, `${tr.durationMs}ms`));
    if (tr.toolName === "change_zotero_library") {
      try {
        if (receipt?.status === "applied" && receipt.change_id) {
          const undo = h(doc, "button", { className: "chatpdf-library-undo" }, uiText("Undo changes", "撤销修改")) as HTMLButtonElement;
          undo.addEventListener("click", async event => {
            if (!event.isTrusted) return;
            undo.disabled = true;
            try {
              const plan = (await listLibraryChanges()).find(record => record.id === receipt.change_id);
              if (!plan) throw new Error("Change receipt unavailable.");
              await applyLibraryChanges(plan, { mode: "ask", items: [], collections: [] }, async () => true, undefined, true);
              undo.textContent = uiText("Undone", "已撤销");
            } catch (error: any) { undo.disabled = false; undo.title = error.message; undo.textContent = uiText("Undo conflict — inspect details", "撤销冲突，请查看详情"); }
          });
          entry.append(undo);
        }
      } catch { /* Older or failed tool results have no actionable receipt. */ }
    }
    content.appendChild(entry);
  }

  toggle.addEventListener("click", () => {
    toggle.setAttribute("aria-expanded", String(block.classList.toggle("chatpdf-tool-block-expanded")));
  });
  block.appendChild(toggle);
  block.appendChild(content);
  return block;
}
