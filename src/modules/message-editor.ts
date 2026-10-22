import { h } from "../utils/dom";
import { uiLabel } from "../utils/ui-text";
import { isComposingKey } from "../utils/keyboard";
import { getPanelState } from "./panel-state";

export const MESSAGE_EDIT_EVENT = "chatpdf-edit-message";
export interface MessageEditRequest { sessionId: string; index: number; text: string }

/** Editing emits an intent; the panel controller owns history and sending. */
export function enterEditMode(root: HTMLElement, row: HTMLElement, bubble: HTMLElement, originalText: string): void {
  if (row.querySelector(".chatpdf-edit-area")) return;
  const doc = root.ownerDocument!;
  const sessionId = getPanelState(root).session.id;
  const editButton = row.querySelector<HTMLElement>(".chatpdf-edit-btn");
  const wrap = bubble.parentElement as HTMLElement;
  wrap.hidden = true;
  if (editButton) editButton.hidden = true;
  const area = h(doc, "div", { className: "chatpdf-edit-area" });
  const input = h(doc, "textarea", { className: "chatpdf-edit-textarea", "aria-label": uiLabel("edit") }) as HTMLTextAreaElement;
  input.value = originalText;
  const cancel = h(doc, "button", { className: "chatpdf-edit-cancel-btn", type: "button" }, uiLabel("cancel"));
  const send = h(doc, "button", { className: "chatpdf-edit-save-btn", type: "button" }, uiLabel("send")) as HTMLButtonElement;
  area.append(input, h(doc, "div", { className: "chatpdf-edit-actions" }, cancel, send));
  row.append(area);
  const resize = () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; };
  const close = () => {
    area.remove();
    wrap.hidden = false;
    if (editButton) { editButton.hidden = false; editButton.focus(); }
  };
  const submit = () => {
    if (send.disabled) return;
    const text = input.value.trim();
    const index = Number(row.dataset.msgIndex);
    if (!text || !Number.isInteger(index) || index < 0) { close(); return; }
    send.disabled = true;
    const detail: MessageEditRequest = { sessionId, index, text };
    root.dispatchEvent(new (doc.defaultView as Window & typeof globalThis).CustomEvent(MESSAGE_EDIT_EVENT, { detail }));
  };
  cancel.addEventListener("click", close);
  send.addEventListener("click", submit);
  input.addEventListener("input", resize);
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (isComposingKey(event)) return;
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
    if (event.key === "Escape") { event.preventDefault(); close(); }
  });
  resize();
  input.focus();
}
