/** XUL namespace for creating XUL elements. */
export const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

/** Create an element in XHTML namespace (required inside Zotero XUL panels). */
export function h(doc: Document, tag: string, attrs?: Record<string, string>, ...children: (Node | string)[]): HTMLElement {
  const el = doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElement;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "className") el.className = v;
      else el.setAttribute(k, v);
    }
  }
  for (const child of children) {
    if (typeof child === "string") el.appendChild(doc.createTextNode(child));
    else el.appendChild(child);
  }
  return el;
}

/** Check if the user is near the bottom of a scrollable element. */
export function isNearBottom(el: Element, threshold = 60): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

/** Scroll to bottom only if the user hasn't scrolled up. */
export function scrollToBottomIfNeeded(el: Element): void {
  if (isNearBottom(el)) {
    el.scrollTop = el.scrollHeight;
  }
}
