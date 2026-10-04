import { h } from "../utils/dom";
import { uiText } from "../utils/ui-text";
import type { LibraryChangeSet } from "./library-changes";
import { renderLibraryPreview } from "./library-change-preview";

/** A model cannot manufacture an approval: only a trusted panel button resolves this request. */
export function requestLibraryApproval(root: HTMLElement, plan: LibraryChangeSet, signal?: AbortSignal, undo = false): Promise<boolean> {
  return new Promise(resolve => {
    const doc = root.ownerDocument!;
    const block = h(doc, "div", { className: "chatpdf-library-approval" });
    block.append(h(doc, "strong", {}, undo ? uiText("Review undo", "审阅撤销操作") : uiText("Review library changes", "审阅文献库修改")));
    block.append(renderLibraryPreview(doc, plan, undo));
    const accept = h(doc, "button", {}, undo ? uiText("Undo these changes", "撤销这些修改") : uiText("Apply these changes", "执行这些修改"));
    const reject = h(doc, "button", {}, uiText("Cancel changes", "取消修改"));
    const finish = (approved: boolean) => {
      signal?.removeEventListener("abort", abort);
      block.remove(); resolve(approved);
    };
    const abort = () => finish(false);
    accept.addEventListener("click", event => { if (event.isTrusted) finish(true); });
    reject.addEventListener("click", () => finish(false));
    signal?.addEventListener("abort", abort, { once: true });
    block.append(accept, reject);
    root.querySelector("#chatpdf-messages")?.append(block);
    block.scrollIntoView?.({ block: "nearest" });
    if (signal?.aborted || !block.isConnected) finish(false);
  });
}
