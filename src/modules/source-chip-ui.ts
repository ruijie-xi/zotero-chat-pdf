import { h } from "../utils/dom";
import { uiText } from "../utils/ui-text";
import type { SourceItem } from "./chat-session";

interface Actions { open(): void; remove(): void; }
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
  const more = h(doc, "button", { type: "button", className: "chatpdf-chip-text-btn", "data-action": "source-menu",
    "aria-label": uiText("Source actions", "文献操作"), "aria-haspopup": "menu", "aria-expanded": "false" }, "⋯");
  let dismiss = () => {};
  chip.append(indicator, title, badge, buttons); buttons.append(more);
  chip.addEventListener("click", () => actions.open());
  const showMenu = (x?: number, y?: number) => {
    menus.get(root)?.();
    const menu = h(doc, "div", { className: "chatpdf-source-menu", role: "menu" });
    const add = (label: string, action: () => void) => {
      const button = h(doc, "button", { type: "button", role: "menuitem" }, label);
      button.addEventListener("click", event => { event.stopPropagation(); dismiss(); action(); }); menu.append(button);
    };
    add(uiText("Open source", "打开文献"), actions.open);
    add(uiText("Remove from chat", "从会话移除"), actions.remove);
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
    chip.title = source.errorMessage || (source.kind === "image" ? uiText("Image source", "图片来源") : uiText("Open PDF", "打开 PDF"));
    badge.className = `chatpdf-chip-badge chatpdf-chip-badge-${source.status}`;
    badge.textContent = source.kind === "image" ? uiText("Image", "图片") : uiText("PDF · direct reading", "PDF · 直接阅读");
    badge.title = source.kind === "image" ? "" : uiText("The assistant reads original page images on demand.", "助手按需直接查看原始 PDF 页面。");
  };
  update(); return { element: chip, update, dismiss: () => dismiss() };
}
