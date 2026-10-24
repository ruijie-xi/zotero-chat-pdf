import { h } from "../utils/dom";
import { uiText as label } from "../utils/ui-text";
import type { ChatSession } from "./chat-session";
import { renderMarkdownInto } from "./markdown-renderer";
import type { VisualRef, VisualVersion } from "./visual-model";
import { sanitizeVisualSvg, svgDataUrl } from "./visual-sanitize";
import { visualFontCSS } from "./visual-renderer";
import { atomicWrite } from "../utils/atomic-storage";
import { getItemByKey } from "./zotero-items";

const viewers = new WeakMap<Document, () => void>();
function button(doc: Document, text: string, run: () => void | Promise<void>): HTMLButtonElement {
  const element = h(doc, "button", { type: "button", className: "chatpdf-visual-button" }, text) as HTMLButtonElement;
  element.addEventListener("click", () => { Promise.resolve().then(run).catch(error => Zotero.alert(doc.defaultView!, "ChatPDF", String(error))); });
  return element;
}
function description(doc: Document, visual: VisualVersion): HTMLElement {
  const block = h(doc, "div", { className: "chatpdf-visual-description" });
  renderMarkdownInto(block, visual.description);
  return block;
}
function citationButtons(doc: Document, session: ChatSession, visual: VisualVersion): HTMLElement {
  const citations = h(doc, "div", { className: "chatpdf-visual-citations" });
  for (const c of visual.citations) citations.append(button(doc, c.label || label(`Original · p. ${c.page}`, `原文 · 第 ${c.page} 页`), async () => {
    const source = session.getSource(c.sourceId);
    if (!source) throw new Error(label("This source has been removed from the conversation.", "这篇文献已从对话中移除。"));
    const item = await getItemByKey(source.key, source.libraryID);
    if (!item?.isPDFAttachment()) throw new Error("PDF attachment unavailable.");
    await (Zotero as any).Reader.open(item.id, { pageIndex: c.page - 1 });
  }));
  return citations;
}
export function createVisualCard(root: HTMLElement, session: ChatSession, ref: VisualRef): HTMLElement {
  const doc = root.ownerDocument!;
  const visual = session.visuals.get(ref);
  const card = h(doc, "article", { className: "chatpdf-visual-card", "data-visual-id": ref.id, "data-visual-version": String(ref.version) });
  if (!visual) { card.textContent = label("This image is unavailable.", "这张图片暂不可用。"); return card; }
  card.append(h(doc, "div", { className: "chatpdf-visual-card-heading" }, h(doc, "strong", {}, visual.title), h(doc, "span", { className: "chatpdf-visual-badge" }, `v${visual.version} · ${visual.dataMode === "illustrative" ? label("Illustration", "解释性示意") : label("Paper data", "文献数据")}`)));
  const open = button(doc, label("Enlarge image", "放大图片"), () => openImage(doc, visual));
  open.classList.add("chatpdf-visual-preview");
  if (visual.png?.startsWith("data:image/png;base64,")) open.prepend(h(doc, "img", { src: visual.png, alt: visual.title, loading: "lazy" }));
  card.append(open, description(doc, visual), citationButtons(doc, session, visual));
  return card;
}

async function exportImage(doc: Document, visual: VisualVersion, kind: "source" | "svg" | "png"): Promise<void> {
  const extensions = { svg: "svg", mermaid: "mmd", tikz: "tex", snapshot: "json" };
  const extension = kind === "source" ? extensions[visual.kind] : kind;
  const picker = (Components.classes as any)["@mozilla.org/filepicker;1"].createInstance((Components.interfaces as any).nsIFilePicker);
  picker.init((doc.defaultView as any).browsingContext, label("Save image", "保存图片"), picker.modeSave);
  picker.defaultString = `${visual.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80)}-v${visual.version}.${extension}`;
  picker.appendFilter(extension.toUpperCase(), `*.${extension}`);
  const result = await new Promise<number>(resolve => picker.open(resolve));
  if (result === picker.returnCancel || !picker.file) return;
  let bytes: Uint8Array;
  if (kind === "source") bytes = new TextEncoder().encode(visual.source);
  else if (kind === "png") {
    if (!visual.png?.startsWith("data:image/png;base64,")) throw new Error("Saved PNG unavailable.");
    bytes = Uint8Array.from(doc.defaultView!.atob(visual.png.split(",")[1]), c => c.charCodeAt(0));
  } else {
    if (!visual.svg) throw new Error("Saved SVG unavailable.");
    bytes = new TextEncoder().encode(await displaySvg(visual.svg, doc));
  }
  await atomicWrite(picker.file.path, bytes);
}
async function displaySvg(source: string, doc: Document): Promise<string> {
  const svg = sanitizeVisualSvg(source, doc);
  return svg.replace(/(<svg\b[^>]*>)/, `$1<style>${await visualFontCSS(svg)}</style>`);
}
function openImage(doc: Document, visual: VisualVersion): void {
  viewers.get(doc)?.();
  const win = doc.defaultView!;
  const focused = doc.activeElement as HTMLElement | null;
  const overlay = h(doc, "div", { className: "chatpdf-visual-overlay", role: "dialog", "aria-modal": "true", "aria-label": visual.title });
  const viewer = h(doc, "div", { className: "chatpdf-image-viewer" });
  const bar = h(doc, "div", { className: "chatpdf-image-bar" }, h(doc, "strong", {}, visual.title));
  const stage = h(doc, "div", { className: "chatpdf-image-stage" });
  const image = h(doc, "img", { alt: visual.title }) as HTMLImageElement;
  const status = h(doc, "div", { className: "chatpdf-visual-status", role: "status" });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true; overlay.remove(); doc.removeEventListener("keydown", keyboard, true); win.removeEventListener("unload", close); viewers.delete(doc);
    if (focused?.isConnected) focused.focus();
  };
  const keyboard = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === "Tab") {
      const list = (Array.from(overlay.querySelectorAll("button,textarea,summary")) as HTMLElement[]).filter(e => e.getClientRects().length);
      if (event.shiftKey && doc.activeElement === list[0]) { event.preventDefault(); list[list.length - 1]?.focus(); }
      else if (!event.shiftKey && doc.activeElement === list[list.length - 1]) { event.preventDefault(); list[0]?.focus(); }
    }
  };
  viewers.set(doc, close);
  doc.addEventListener("keydown", keyboard, true);
  win.addEventListener("unload", close, { once: true });
  overlay.addEventListener("click", event => { if (event.target === overlay) close(); });
  if (visual.png) bar.append(button(doc, label("Save PNG", "保存 PNG"), () => exportImage(doc, visual, "png")));
  if (visual.svg) bar.append(button(doc, label("Save SVG", "保存 SVG"), () => exportImage(doc, visual, "svg")));
  const closeButton = button(doc, label("Close", "关闭"), close);
  bar.append(closeButton);
  stage.append(image); viewer.append(bar, stage);
  if (visual.kind === "snapshot") status.textContent = label("Saved image from an earlier interactive visual.", "此前交互图的静态快照。");
  else {
    const source = h(doc, "details", { className: "chatpdf-image-source" }, h(doc, "summary", {}, label("Source", "绘图源码")));
    const code = h(doc, "textarea", { readonly: "true", "aria-label": label("Drawing source", "绘图源码") }) as HTMLTextAreaElement;
    code.value = visual.source;
    source.append(code, button(doc, label("Copy source", "复制源码"), () => win.navigator.clipboard.writeText(visual.source)), button(doc, label("Save source", "保存源码"), () => exportImage(doc, visual, "source")));
    viewer.append(source);
  }
  viewer.append(status); overlay.append(viewer); doc.documentElement!.append(overlay);
  if (visual.png?.startsWith("data:image/png;base64,")) image.src = visual.png;
  if (visual.svg) void displaySvg(visual.svg, doc).then(svg => { if (!closed) image.src = svgDataUrl(svg); }).catch(error => { if (!closed) status.textContent = String(error); });
  closeButton.focus();
}
