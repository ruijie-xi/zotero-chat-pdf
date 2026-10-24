import { h } from "../utils/dom";
import { uiText } from "../utils/ui-text";
import { renderMarkdownInto } from "./markdown-renderer";
import { readHistory, type HistoryReadOptions } from "./history-query";
import { validSessionId } from "./chat-history";
import { createAbortController } from "./panel-state";

export function parseHistoryCitation(href: string): HistoryReadOptions {
  const url = new URL(href);
  const match = /^\/history\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (url.protocol !== "zotero:" || url.hostname !== "chatpdf" || !match || !validSessionId(match[1]) || url.hash || url.username || url.password || url.port) throw new Error("Invalid chat citation.");
  for (const key of url.searchParams.keys()) if (!["revision", "message"].includes(key) || url.searchParams.getAll(key).length !== 1) throw new Error("Invalid chat citation parameters.");
  const revision = url.searchParams.get("revision") || "", message = url.searchParams.get("message") || "";
  if (!/^[a-f0-9]{64}$/.test(revision) || !/^\d+$/.test(message) || !Number.isSafeInteger(Number(message))) throw new Error("Invalid chat citation position.");
  return { session_id: match[1], revision, message_index: Number(message) };
}

/** Read-only overlay: never replaces the active session, editor or stream. */
export async function previewHistory(root: HTMLElement, options: HistoryReadOptions): Promise<void> {
  (root.querySelector(".chatpdf-history-preview-close") as HTMLButtonElement | null)?.click();
  const doc = root.ownerDocument!, previousFocus = doc.activeElement as HTMLElement | null;
  const dialog = h(doc, "section", { className: "chatpdf-history-preview", role: "dialog", "aria-modal": "true", "aria-label": uiText("Saved chat preview", "历史会话预览") });
  const header = h(doc, "div", { className: "chatpdf-history-preview-header" });
  const title = h(doc, "strong", {}, uiText("Loading saved chat…", "正在读取历史会话…"));
  const close = h(doc, "button", { type: "button", className: "chatpdf-history-preview-close" }, uiText("Close", "关闭"));
  header.append(title, close);
  const body = h(doc, "div", { className: "chatpdf-history-preview-body", tabindex: "0" });
  const navigation = h(doc, "div", { className: "chatpdf-history-preview-nav" });
  const { controller, signal } = createAbortController(doc.defaultView!);
  let request = 0;
  const dismiss = () => { controller.abort(); dialog.remove(); previousFocus?.focus(); };
  close.addEventListener("click", dismiss);
  dialog.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.stopPropagation(); dismiss(); }
    if (event.key === "Tab") {
      const controls = Array.from(dialog.querySelectorAll('button:not([disabled]), [tabindex="0"], a[href]')) as HTMLElement[];
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  dialog.append(header, body, navigation); root.append(dialog); close.focus();
  const load = async (read: HistoryReadOptions) => {
    const version = ++request;
    try {
      const result = await readHistory(read, new Set(), signal);
      if (!dialog.isConnected || version !== request) return;
      title.textContent = result.title || uiText("Untitled chat", "未命名会话");
      body.replaceChildren(); navigation.replaceChildren();
      for (const message of result.records) {
        const row = h(doc, "article", { className: "chatpdf-history-preview-message", "data-message-index": String(message.message_index) });
        row.append(h(doc, "div", { className: "chatpdf-history-preview-meta" },
          `${message.role === "user" ? uiText("You", "你") : uiText("Assistant", "助手")} · #${Number(message.message_index) + 1}${message.timestamp ? ` · ${new Date(Number(message.timestamp)).toLocaleString()}` : ""}${message.status ? ` · ${message.status}` : ""}`));
        const content = h(doc, "div", { className: "chatpdf-history-preview-content" });
        renderMarkdownInto(content, String(message.content || "")); row.append(content);
        if (Number(message.char_start) > 0 || Number(message.char_end) < Number(message.total_chars)) row.append(h(doc, "small", {}, `${message.char_start}–${message.char_end} / ${message.total_chars}`));
        if (Array.isArray(message.sources) && message.sources.length) row.append(h(doc, "small", {}, message.sources.map((source: any) => source.title).join(" · ")));
        if (message.error_message) row.append(h(doc, "small", {}, String(message.error_message)));
        body.append(row);
      }
      const fromStart = h(doc, "button", { type: "button" }, uiText("Read from beginning", "从头阅读"));
      fromStart.addEventListener("click", () => void load({ session_id: result.session_id, revision: result.revision })); navigation.append(fromStart);
      if (result.next_cursor) {
        const more = h(doc, "button", { type: "button" }, uiText("Next messages", "继续阅读"));
        more.addEventListener("click", () => void load({ session_id: result.session_id, revision: result.revision, cursor: result.next_cursor! })); navigation.append(more);
      }
      const target = body.querySelector(`[data-message-index="${options.message_index ?? 0}"]`) as HTMLElement | null;
      target?.classList.add("chatpdf-history-preview-target");
      target?.scrollIntoView?.({ block: "nearest" });
    } catch (error: any) {
      if (!signal.aborted && version === request) body.textContent = uiText(`Unable to read saved chat: ${error.message}`, `无法读取历史会话：${error.message}`);
    }
  };
  await load(options);
}

export function installHistoryCitationLinks(root: HTMLElement): void {
  root.addEventListener("click", event => {
    const href = (event.target as Element)?.closest?.("a")?.getAttribute("href") || "";
    if (!/^zotero:\/\/chatpdf\/history\//i.test(href)) return;
    event.preventDefault(); event.stopPropagation();
    try { void previewHistory(root, parseHistoryCitation(href)).catch(error => Zotero.alert(root.ownerDocument!.defaultView!, "ChatPDF", String(error))); }
    catch (error: any) { Zotero.alert(root.ownerDocument!.defaultView!, "ChatPDF", error.message); }
  });
}
