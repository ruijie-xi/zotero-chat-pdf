import { h } from "../utils/dom";
import { renderMarkdown } from "./markdown-renderer";

/** Update only the current narration node; completed segments never move. */
export class AssistantSegments {
  private current?: HTMLElement;

  constructor(private container: HTMLElement) {}

  update(text: string): void {
    if (!this.current && !text) return;
    if (!this.current) {
      this.current = h(this.container.ownerDocument!, "div", { className: "chatpdf-live-content" });
      this.container.appendChild(this.current);
    }
    try { this.current.innerHTML = renderMarkdown(text); }
    catch { this.current.textContent = text; }
  }

  finish(text: string): void {
    this.update(text);
    if (this.current) this.current.className = "chatpdf-iteration-content";
    this.current = undefined;
  }
}
