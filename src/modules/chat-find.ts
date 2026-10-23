import { h } from "../utils/dom";
import { isComposingKey } from "../utils/keyboard";
import { uiText } from "../utils/ui-text";

const CONTENT = ".chatpdf-message-user, .chatpdf-live-content, .chatpdf-iteration-content";
const SKIP = "button, input, textarea, select, script, style, svg, .katex-mathml, .chatpdf-reasoning-block, .chatpdf-tool-block, [hidden], [contenteditable='true']";
const BLOCK = /^(?:p|div|pre|li|h[1-6]|tr|td|th|blockquote|br)$/;

/** Search user/assistant body text without rewriting Markdown, formulas or live DOM nodes. */
export function findChatMatches(messages: HTMLElement, query: string): Range[] {
  const words = query.trim().split(/\s+/u);
  if (!words[0]) return [];
  const pattern = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const ranges: Range[] = [];
  for (const content of messages.querySelectorAll<HTMLElement>(CONTENT)) {
    if (content.closest(SKIP)) continue;
    const spans: { node: Text; start: number; end: number }[] = [];
    let text = "";
    const visit = (node: Node) => {
      if (node.nodeType === 3) {
        const start = text.length;
        text += node.textContent || "";
        spans.push({ node: node as Text, start, end: text.length });
      } else if (node.nodeType === 1) {
        const element = node as Element;
        if (element.matches(SKIP)) return;
        const block = BLOCK.test(element.localName);
        if (block) text += "\n";
        for (const child of Array.from(node.childNodes)) if (child) visit(child);
        if (block) text += "\n";
      }
    };
    visit(content);
    const regex = new RegExp(pattern, "giu");
    let spanIndex = 0;
    for (const match of text.matchAll(regex)) {
      const start = match.index!;
      const end = start + match[0].length;
      while (spanIndex < spans.length && spans[spanIndex].end <= start) spanIndex++;
      const first = spans[spanIndex];
      let lastIndex = spanIndex;
      while (lastIndex < spans.length && spans[lastIndex].end < end) lastIndex++;
      const last = spans[lastIndex];
      if (!first || !last) continue;
      const range = messages.ownerDocument!.createRange();
      range.setStart(first.node, start - first.start);
      range.setEnd(last.node, end - last.start);
      ranges.push(range);
    }
  }
  return ranges;
}

/** A window-local find bar; shortcuts are claimed only while focus is in this panel. */
export function installChatFind(root: HTMLElement, messages: HTMLElement, actions: HTMLElement): () => void {
  const doc = root.ownerDocument!;
  const win = doc.defaultView!;
  // CSS highlights are available in current Zotero. Older hosts keep active-match selection.
  const host = win as Window & {
    Highlight?: new (...ranges: Range[]) => { add(range: Range): void; priority: number };
    CSS?: { highlights?: Map<string, unknown> };
  };
  const registry = host.CSS?.highlights;
  const HighlightCtor = host.Highlight;
  const label = uiText("Find in this chat", "在当前会话中查找");
  const button = h(doc, "button", { type: "button", className: "chatpdf-toolbar-btn", "data-action": "find", title: `${label} (Ctrl+F / ⌘F)`, "aria-label": label, "aria-expanded": "false" }, uiText("Find", "查找"));
  actions.prepend(button);
  const bar = h(doc, "div", { className: "chatpdf-find-bar", role: "search", "aria-label": label, hidden: "hidden" });
  const input = h(doc, "input", { type: "search", className: "chatpdf-find-input", placeholder: label, "aria-label": label }) as HTMLInputElement;
  const count = h(doc, "span", { className: "chatpdf-find-count", role: "status", "aria-live": "polite", "aria-atomic": "true" });
  const control = (text: string, title: string) => h(doc, "button", { type: "button", className: "chatpdf-find-button", title, "aria-label": title }, text) as HTMLButtonElement;
  const previous = control("↑", uiText("Previous match (Shift+Enter)", "上一个（Shift+Enter）"));
  const next = control("↓", uiText("Next match (Enter)", "下一个（Enter）"));
  const dismiss = control("×", uiText("Close find (Esc)", "关闭查找（Esc）"));
  bar.append(input, count, previous, next, dismiss);
  root.insertBefore(bar, messages);
  let matches: Range[] = [];
  let current = -1;
  let returnFocus: HTMLElement | null = null;
  let timer: number | undefined;
  let selectionRange: Range | undefined;

  function clearHighlights() {
    registry?.delete("chatpdf-find-all");
    registry?.delete("chatpdf-find-current");
    const selection = win.getSelection();
    if (selectionRange && selection?.rangeCount && selection.getRangeAt(0) === selectionRange) selection.removeAllRanges();
    selectionRange = undefined;
  }

  function paint() {
    clearHighlights();
    count.textContent = input.value.trim() ? `${current + 1} / ${matches.length}` : "";
    previous.disabled = next.disabled = matches.length === 0;
    if (!HighlightCtor || !registry) return;
    const all = new HighlightCtor();
    for (const range of matches) all.add(range);
    registry.set("chatpdf-find-all", all);
    if (matches[current]) {
      const active = new HighlightCtor(matches[current]);
      active.priority = 1;
      registry.set("chatpdf-find-current", active);
    }
  }

  function reveal() {
    const range = matches[current];
    if (!range) return;
    // Scroll nested body/code viewports, then the chat itself, never the host page.
    for (let element = range.startContainer.parentElement; element; element = element.parentElement) {
      const style = win.getComputedStyle(element);
      const rect = range.getBoundingClientRect?.();
      const box = element.getBoundingClientRect();
      if (rect && rect.height) {
        if (/(auto|scroll)/.test(style?.overflowY || "") && (rect.top < box.top || rect.bottom > box.bottom)) {
          element.scrollTop += rect.top - box.top - element.clientHeight / 2;
        }
        if (/(auto|scroll)/.test(style?.overflowX || "") && (rect.left < box.left || rect.right > box.right)) {
          element.scrollLeft += rect.left - box.left - element.clientWidth / 2;
        }
      }
      if (element === messages) break;
    }
    if (!HighlightCtor || !registry) {
      const selection = win.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      selectionRange = range;
    }
  }

  function refresh(jump: boolean, reset = false) {
    if (timer !== undefined) win.clearTimeout(timer);
    timer = undefined;
    const active = matches[current];
    matches = findChatMatches(messages, input.value);
    const retained = reset ? -1 : matches.findIndex(range => range.startContainer === active?.startContainer && range.startOffset === active?.startOffset);
    current = matches.length ? (retained >= 0 ? retained : Math.max(0, Math.min(current, matches.length - 1))) : -1;
    if (reset && matches.length) current = 0;
    paint();
    if (jump) reveal();
  }

  function close(restoreFocus = true) {
    bar.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (timer !== undefined) win.clearTimeout(timer);
    timer = undefined;
    matches = [];
    current = -1;
    clearHighlights();
    if (restoreFocus) (returnFocus?.isConnected ? returnFocus : button).focus();
  }

  function open() {
    if (messages.style.display === "none" || root.style.display === "none") return;
    if (bar.hidden) {
      returnFocus = doc.activeElement as HTMLElement | null;
      bar.hidden = false;
      button.setAttribute("aria-expanded", "true");
      refresh(true, true);
    }
    input.focus();
    input.select();
  }

  function move(direction: number) {
    if (timer !== undefined) refresh(false);
    if (!matches.length) return;
    current = (current + direction + matches.length) % matches.length;
    paint();
    reveal();
  }

  function onKey(event: KeyboardEvent) {
    if (isComposingKey(event) || !root.contains(event.target as Node) || root.style.display === "none" || messages.style.display === "none") return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopImmediatePropagation();
      open();
    } else if (!bar.hidden && (event.key === "Escape" || (event.key === "Enter" && event.target === input))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") close();
      else move(event.shiftKey ? -1 : 1);
    }
  }

  button.addEventListener("click", open);
  input.addEventListener("input", () => refresh(true, true));
  previous.addEventListener("click", () => move(-1));
  next.addEventListener("click", () => move(1));
  dismiss.addEventListener("click", () => close());
  win.addEventListener("keydown", onKey, true);
  const Observer = (win as any).MutationObserver as typeof MutationObserver;
  const observer = new Observer(records => {
    const unavailable = messages.style.display === "none" || root.style.display === "none";
    button.hidden = messages.style.display === "none";
    if (unavailable) { if (!bar.hidden) close(false); return; }
    if (bar.hidden || !records.some(record => record.type !== "attributes")) return;
    // Streaming updates refresh the count/highlights without moving someone reading earlier text.
    if (timer === undefined) timer = win.setTimeout(() => refresh(false), 100);
  });
  observer.observe(messages, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["style"] });
  observer.observe(root, { attributes: true, attributeFilter: ["style"] });
  paint();
  return () => {
    close(false);
    observer.disconnect();
    win.removeEventListener("keydown", onKey, true);
    button.remove();
    bar.remove();
  };
}
