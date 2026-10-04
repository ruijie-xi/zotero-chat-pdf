import { h, XUL_NS, XULMenuList } from "../utils/dom";
import { getPref, setPref } from "../utils/prefs";
import { uiText } from "../utils/ui-text";
import type { LibraryEditMode } from "./library-changes";

const modes: [LibraryEditMode, string, string][] = [
  ["ask", "Review each batch", "每批审阅"], ["readonly", "Read only", "只读"],
  ["selected", "Selected items", "选中条目"], ["collection", "Current collection", "当前集合及子集合"],
  ["library", "Current library", "当前文献库"],
];
const normalized = (value: unknown): LibraryEditMode => modes.some(([mode]) => mode === value) ? value as LibraryEditMode : "ask";

export function createLibraryAccessControl(root: HTMLElement): HTMLElement {
  const doc = root.ownerDocument!;
  const control = h(doc, "div", { className: "chatpdf-library-access" });
  const label = h(doc, "label", { for: "chatpdf-library-edit-mode" }, uiText("Library access", "文献库权限"));
  const menu = doc.createElementNS(XUL_NS, "menulist") as XULMenuList;
  menu.id = "chatpdf-library-edit-mode"; menu.setAttribute("native", "true");
  const popup = doc.createElementNS(XUL_NS, "menupopup");
  for (const [mode, en, zh] of modes) {
    const option = doc.createElementNS(XUL_NS, "menuitem");
    option.setAttribute("value", mode); option.setAttribute("label", uiText(en, zh)); popup.append(option);
  }
  menu.append(popup);
  const scope = h(doc, "span", { className: "chatpdf-library-access-scope" });
  const refresh = () => {
    menu.value = normalized(getPref("agentLibraryEditMode"));
    const pane = (doc.defaultView as any)?.ZoteroPane;
    const collection = pane?.getSelectedCollection?.();
    const libraryID = pane?.getSelectedLibraryID?.();
    const selected = pane?.getSelectedItems?.() || [];
    scope.textContent = menu.value === "collection" ? collection?.name || uiText("No collection selected", "未选中集合")
      : menu.value === "selected" ? uiText(`${selected.length} selected`, `已选 ${selected.length} 项`)
        : menu.value === "library" ? (Zotero.Libraries as any).get?.(libraryID)?.name || uiText("Current library", "当前文献库") : "";
    control.title = uiText("Edit scope is captured when sending. Read-only blocks subsequent writes.", "发送时确定本轮修改范围；设为只读会阻止后续修改。");
  };
  menu.addEventListener("command", () => {
    setPref("agentLibraryEditMode", normalized(menu.value));
    for (const win of Zotero.getMainWindows()) {
      const other = win.document.querySelector("#chatpdf-library-edit-mode") as XULMenuList | null;
      if (other) other.value = normalized(getPref("agentLibraryEditMode"));
    }
    refresh();
  });
  control.addEventListener("mouseenter", refresh); menu.addEventListener("focus", refresh); popup.addEventListener("popupshowing", refresh);
  control.append(label, menu, scope); refresh(); return control;
}
