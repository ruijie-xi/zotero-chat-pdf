import { h } from "../utils/dom";
import { uiText } from "../utils/ui-text";
import { formatChars } from "../utils/format";
import type { SourceItem } from "./chat-session";
import { conversionProgressText, conversionSummaryText } from "./conversion-inspector";

interface Actions { open(): void; inspect(): void; convert(force?: boolean): void; stop(): void; remove(): void; }
export interface SourceChipView { element: HTMLElement; update(): void; dismiss(): void; }
const menus = new WeakMap<HTMLElement, () => void>();
export function dismissSourceMenu(root: HTMLElement): void { menus.get(root)?.(); }

/** Keep the chip and every primary control attached through progress/status updates. */
export function createSourceChip(root: HTMLElement, source: SourceItem, actions: Actions): SourceChipView {
  const doc = root.ownerDocument!;
  const chip = h(doc, "div", { className: "chatpdf-source-chip" });
  const indicator = h(doc, "span");
  const title = h(doc, "span", { className: "chatpdf-chip-title" });
  const badge = h(doc, "span");
  const buttons = h(doc, "span", { className: "chatpdf-chip-actions" });
  const primary = h(doc, "button", { type: "button", className: "chatpdf-chip-text-btn", "data-action": "convert-source" });
  const inspect = h(doc, "button", { type: "button", className: "chatpdf-chip-text-btn", "data-action": "view-conversion",
    "aria-label": uiText("View conversion process", "查看转换过程") }, uiText("Process", "过程"));
  const more = h(doc, "button", { type: "button", className: "chatpdf-chip-text-btn", "data-action": "source-menu",
    "aria-label": uiText("Source actions", "文献操作"), "aria-haspopup": "menu", "aria-expanded": "false" }, "⋯");
  let dismiss = () => {};
  chip.append(indicator, title, badge, buttons); buttons.append(primary, inspect, more);
  chip.addEventListener("click", () => actions.open());
  primary.addEventListener("click", event => { event.stopPropagation(); if (source.status === "converting") actions.stop(); else actions.convert(); });
  inspect.addEventListener("click", event => { event.stopPropagation(); actions.inspect(); });
  const showMenu = (x?: number, y?: number) => {
    menus.get(root)?.();
    const menu = h(doc, "div", { className: "chatpdf-source-menu", role: "menu" });
    const add = (label: string, action: () => void) => {
      const button = h(doc, "button", { type: "button", role: "menuitem" }, label);
      button.addEventListener("click", event => { event.stopPropagation(); dismiss(); action(); }); menu.append(button);
    };
    add(uiText("Open source", "打开文献"), actions.open);
    if (source.kind !== "image") {
      add(uiText("View conversion process", "查看转换过程"), actions.inspect);
      if (source.status === "converting") add(uiText("Stop conversion", "停止转换"), actions.stop);
      else {
        if (source.status !== "ready") add(source.status === "error" ? uiText("Continue saved work", "继续已有工作") : uiText("Convert PDF", "转换 PDF"), () => actions.convert());
        if (source.status === "ready" || source.status === "error") add(uiText("Reconvert PDF", "重新识别 PDF"), () => actions.convert(true));
      }
    }
    add(uiText("Remove from chat", "从会话移除"), actions.remove);
    if (source.conversionStatus) menu.append(h(doc, "div", { className: "chatpdf-source-menu-summary" },
      [conversionProgressText(source.conversionStatus), conversionSummaryText(source.conversionStatus)].filter(Boolean).join("\n")));
    root.append(menu); more.setAttribute("aria-expanded", "true");
    const origin = root.getBoundingClientRect(), anchor = more.getBoundingClientRect();
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min((x ?? anchor.left) - origin.left, origin.width - rect.width))}px`;
    menu.style.top = `${Math.max(0, Math.min((y ?? anchor.bottom) - origin.top, origin.height - rect.height))}px`;
    const outside = (event: Event) => { if (!menu.contains(event.target as Node) && !more.contains(event.target as Node)) dismiss(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); dismiss(); more.focus(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const choices = [...menu.querySelectorAll<HTMLButtonElement>("button")];
        const current = choices.indexOf(doc.activeElement as HTMLButtonElement);
        choices[(current + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length]?.focus();
      }
    };
    dismiss = () => {
      menu.remove(); more.setAttribute("aria-expanded", "false");
      doc.removeEventListener("pointerdown", outside, true); doc.removeEventListener("keydown", key);
      doc.defaultView?.removeEventListener("blur", dismiss);
      if (menus.get(root) === dismiss) menus.delete(root);
    };
    menus.set(root, dismiss); doc.addEventListener("pointerdown", outside, true); doc.addEventListener("keydown", key);
    doc.defaultView?.addEventListener("blur", dismiss, { once: true });
    menu.querySelector<HTMLButtonElement>("button")?.focus();
  };
  more.addEventListener("click", event => { event.stopPropagation(); if (more.getAttribute("aria-expanded") === "true") dismiss(); else showMenu(); });
  chip.addEventListener("contextmenu", event => { event.preventDefault(); event.stopPropagation(); showMenu((event as MouseEvent).clientX, (event as MouseEvent).clientY); });
  const update = () => {
    chip.className = `chatpdf-source-chip chatpdf-source-chip-${source.status}`;
    indicator.className = `chatpdf-chip-indicator chatpdf-chip-indicator-${source.status}`;
    title.textContent = source.title; title.title = source.title;
    const status = source.conversionStatus;
    const summary = status ? [conversionProgressText(status), conversionSummaryText(status)].filter(Boolean).join("\n") : "";
    chip.title = source.errorMessage || (source.kind === "image" ? uiText("Image source", "图片来源") : uiText("Open PDF", "打开 PDF"));
    inspect.title = [uiText("View conversion process", "查看转换过程"), summary].filter(Boolean).join("\n");
    inspect.hidden = source.kind === "image";
    badge.className = `chatpdf-chip-badge chatpdf-chip-badge-${source.status}`;
    badge.textContent = source.kind === "image" ? uiText("Image", "图片") : source.status === "ready" && source.markdown ? `${formatChars(source.markdown.length)} chars`
      : source.status === "error" ? uiText("Error", "失败") : source.status === "converting" ? status?.totalPages ? `${status.completedPages || 0}/${status.totalPages}` : uiText("Converting", "转换中") : "";
    badge.hidden = !badge.textContent;
    if (source.selfCheck) badge.textContent += ` · ✓${source.selfCheck.pagesChecked}/${source.selfCheck.pagesTotal}`;
    badge.title = source.selfCheck ? uiText(`Model self-check: ${source.selfCheck.pagesChecked}/${source.selfCheck.pagesTotal}; ${source.selfCheck.editsApplied} edits; not independent verification`, `模型自查：${source.selfCheck.pagesChecked}/${source.selfCheck.pagesTotal} 页，${source.selfCheck.editsApplied} 处修改；不是独立复核`) : summary;
    primary.hidden = source.kind === "image" || source.status === "ready";
    primary.textContent = source.status === "converting" ? uiText("Stop", "停止") : source.status === "error" ? uiText("Retry", "重试") : uiText("Convert", "转换");
    primary.title = source.status === "error" ? uiText("Continue saved work", "优先继续已有工作") : primary.textContent;
  };
  update(); return { element: chip, update, dismiss: () => dismiss() };
}
