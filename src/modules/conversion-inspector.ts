import { h } from "../utils/dom";
import type { SourceItem } from "./chat-session";
import { cancelConversion, getConversionDetails, getConversionDraft, latestConversionForDocument,
  readConversionPage, subscribeConversion, ConversionStatus } from "./conversion-manager";
import { getPanelState } from "./panel-state";
import { renderMarkdown } from "./markdown-renderer";
import { openPdfForSourceKey } from "./zotero-items";

const duration = (ms: number) => `${Math.floor(Math.max(0, ms) / 60000)}:${String(Math.floor(Math.max(0, ms) / 1000) % 60).padStart(2, "0")}`;
const terminal = (status: ConversionStatus) => ["ready", "error", "cancelled", "interrupted"].includes(status.state);
const phases: Record<string, string> = { resolve_pdf: "Preparing PDF", render: "Rendering page images", vision: "Waiting for model",
  validate: "Checking results", retry: "Waiting to retry", commit: "Writing cache", ready: "Ready", suspended: "Paused for restart" };

export function conversionProgressText(status: ConversionStatus, now = Date.now()): string {
  const elapsed = duration((terminal(status) ? Date.parse(status.updatedAt) : now) - (status.runStartedAt || Date.parse(status.createdAt)));
  const pages = status.totalPages ? `${status.completedPages || 0}/${status.totalPages} pages validated · ` : "";
  let phase = phases[status.stage] || status.progress || status.state;
  if (status.activeRequests && !terminal(status)) phase = `${status.receivingRequests || 0} receiving / ${status.activeRequests - (status.receivingRequests || 0)} waiting requests`;
  if (status.state === "cancelled") phase = "Stopped";
  if (status.state === "error" || status.state === "interrupted") phase = `Failed at: ${phase}`;
  return `${pages}${phase} · ${elapsed}`;
}

/** A local, disposable viewer. Inspecting content never invokes the model. */
export function openConversionInspector(root: HTMLElement, source: SourceItem, onRetry?: () => Promise<void>): void {
  const state = getPanelState(root), session = state.session, doc = root.ownerDocument;
  if (!doc) return;
  state.conversionInspectorCleanup?.();
  const panel = h(doc, "section", { className: "chatpdf-conversion-inspector", role: "dialog", "aria-label": "PDF conversion process" });
  const header = h(doc, "div", { className: "chatpdf-conversion-inspector-header" }, h(doc, "strong", {}, source.title));
  const close = h(doc, "button", { type: "button", className: "chatpdf-chip-text-btn" }, "Back to chat");
  header.appendChild(close);
  const body = h(doc, "div", { className: "chatpdf-conversion-inspector-body" });
  const summary = h(doc, "div", { className: "chatpdf-conversion-overview", "aria-live": "polite" });
  const settings = h(doc, "div", { className: "chatpdf-conversion-muted" });
  const usage = h(doc, "div", { className: "chatpdf-conversion-muted" });
  const progress = h(doc, "progress", { max: "100", "aria-label": "Conversion and cache progress" });
  const controls = h(doc, "div", { className: "chatpdf-conversion-controls" });
  const stop = h(doc, "button", { type: "button" }, "Stop"), retry = h(doc, "button", { type: "button" }, "Retry saved work");
  const original = h(doc, "button", { type: "button" }, "Open original PDF");
  controls.append(stop, retry, original);
  const chunks = h(doc, "div", { className: "chatpdf-conversion-chunks" });
  const chunkButtons = new Map<number, HTMLElement>();
  const nav = h(doc, "div", { className: "chatpdf-conversion-controls" });
  const prev = h(doc, "button", { type: "button", "aria-label": "Previous page" }, "←"), next = h(doc, "button", { type: "button", "aria-label": "Next page" }, "→");
  const pageLabel = h(doc, "strong"), mode = h(doc, "button", { type: "button" }, "Show Markdown source");
  nav.append(prev, pageLabel, next, mode);
  const preview = h(doc, "div", { className: "chatpdf-conversion-preview" });
  const imagePane = h(doc, "div", { className: "chatpdf-conversion-image" }), textPane = h(doc, "div", { className: "chatpdf-conversion-text" });
  const pageState = h(doc, "div", { className: "chatpdf-conversion-page-state" });
  const text = h(doc, "div", { className: "chatpdf-conversion-document" }), edits = h(doc, "div", { className: "chatpdf-conversion-edits" });
  textPane.append(pageState, text, edits); preview.append(imagePane, textPane);
  const requestBox = h(doc, "details", { className: "chatpdf-conversion-log" }, h(doc, "summary", {}, "Requests and token usage"));
  const requests = h(doc, "div"); requestBox.appendChild(requests);
  const eventBox = h(doc, "details", { className: "chatpdf-conversion-log" }, h(doc, "summary", {}, "Activity timeline"));
  const events = h(doc, "div"); eventBox.appendChild(events);
  body.append(summary, progress, settings, usage, controls, chunks, nav, preview, requestBox, eventBox);
  panel.append(header, body); root.appendChild(panel);
  let closed = false, unsubscribe = () => {}, jobId = "", page = 1, sourceMode = false;
  const timer = state.win.setInterval(() => refresh(), 1000);
  let pendingVersion = "";
  let latest: ConversionStatus | undefined, pageVersion = "", generation = 0, imageLoaded = false, lastText = "", validated = false;
  const cleanup = () => {
    if (closed) return;
    closed = true; generation++; unsubscribe(); if (timer !== undefined) state.win.clearInterval(timer); panel.remove();
    if (state.conversionInspectorCleanup === cleanup) state.conversionInspectorCleanup = null;
  };
  const renderText = () => {
    text.replaceChildren();
    if (!lastText) { text.textContent = "Waiting for this page's result…"; return; }
    if (sourceMode || !validated) text.appendChild(h(doc, "pre", {}, lastText));
    else text.innerHTML = renderMarkdown(lastText).replace(/<img\b[^>]*>/gi, "");
  };
  const loadPage = async (version: string, canLoadImage: boolean) => {
    pendingVersion = version;
    const current = ++generation;
    try {
      const view = await readConversionPage(jobId, page, !imageLoaded && canLoadImage);
      if (closed || current !== generation) return;
      validated = view.validated;
      lastText = view.markdown || getConversionDraft(jobId, page);
      pageState.textContent = validated ? `Program checks passed · ${view.selfChecked ? view.edits.length ? `Model self-check: ${view.edits.length} edits` : "Model self-check: no edits" : "Model self-check not recorded"}` : "Generating · not yet validated";
      if (view.image) {
        imageLoaded = true; imagePane.replaceChildren(h(doc, "div", { className: "chatpdf-conversion-muted" }, "Page image sent to the model"),
          h(doc, "img", { src: view.image, alt: `PDF page ${page}` }));
      } else if (!imageLoaded) imagePane.textContent = latest?.options?.vision?.cachePageImages === false ? "Page images were not cached. Open the original PDF to inspect this page." : "Page image appears after rendering.";
      edits.replaceChildren();
      for (const edit of view.edits) edits.appendChild(h(doc, "div", {}, h(doc, "strong", {}, "Model self-check correction"), h(doc, "pre", { className: "chatpdf-conversion-old" }, edit.old), h(doc, "pre", { className: "chatpdf-conversion-new" }, edit.new || "[removed]")));
      renderText(); pageVersion = version;
    } catch {
      if (closed || current !== generation) return;
      lastText = getConversionDraft(jobId, page); validated = false; renderText();
      pageState.textContent = "Page result is not available yet"; pageVersion = version;
    } finally { if (current === generation) pendingVersion = ""; }
  };
  const selectPage = (value: number) => { page = value; pageVersion = ""; imageLoaded = false; imagePane.replaceChildren(); refresh(); };
  const refresh = () => {
    if (closed) return;
    if (!root.isConnected || session.getSource(source.id) !== source) { cleanup(); return; }
    const status = latestConversionForDocument(source.id);
    if (!status) {
      stop.hidden = true; retry.hidden = true;
      summary.textContent = "Conversion has not started. Viewing this panel does not start a model request."; return;
    }
    latest = status;
    if (jobId !== status.jobId) {
      unsubscribe(); jobId = status.jobId; pageVersion = ""; imageLoaded = false;
      chunks.replaceChildren(); chunkButtons.clear();
      unsubscribe = subscribeConversion(jobId, () => refresh());
    }
    const details = getConversionDetails(jobId);
    const total = details?.pageCount || status.totalPages || 0;
    if (total && page > total) page = total;
    summary.textContent = conversionProgressText(status);
    progress.setAttribute("value", String(status.state === "ready" ? 100 : Math.min(99, status.progressPercent || 0)));
    const config = status.options?.vision;
    settings.textContent = config ? `${config.model} · ${config.dpi} DPI · ${config.chunkPages} pages/request · ${config.concurrency} workers` : `${status.options?.engine || "PDF"} conversion`;
    const u = status.usage;
    usage.textContent = `${details?.requests.length || 0} model requests recorded · ${u ? `${u.prompt_tokens || 0} input / ${u.completion_tokens || 0} output tokens reported` : "Token usage not reported"} · ${status.reusedPages || 0} pages reused`;
    stop.hidden = terminal(status); retry.hidden = !status.retryable || !onRetry;
    if (status.error) summary.appendChild(h(doc, "div", { className: "chatpdf-conversion-error" }, status.error));
    for (const chunk of details?.chunks || []) {
      let button = chunkButtons.get(chunk.index);
      if (!button) {
        button = h(doc, "button", { type: "button" });
        button.addEventListener("click", () => selectPage(chunk.startPage));
        chunkButtons.set(chunk.index, button); chunks.appendChild(button);
      }
      button.className = `chatpdf-conversion-chunk chatpdf-conversion-chunk-${chunk.stage}`;
      const label = `Pages ${chunk.startPage}–${chunk.endPage} · ${chunk.stage}${chunk.startedAt ? ` · ${duration((chunk.endedAt || Date.now()) - chunk.startedAt)}` : ""}${chunk.reused ? " · saved results" : ""}`;
      if (button.textContent !== label) button.textContent = label;
    }
    for (const [index, button] of chunkButtons) {
      if (!details?.chunks.some(chunk => chunk.index === index)) { button.remove(); chunkButtons.delete(index); }
    }
    pageLabel.textContent = `Page ${page}${total ? ` / ${total}` : ""}`;
    (prev as HTMLButtonElement).disabled = page <= 1;
    (next as HTMLButtonElement).disabled = !total || page >= total;
    requests.replaceChildren();
    for (const request of details?.requests || []) requests.appendChild(h(doc, "div", { className: "chatpdf-conversion-request" },
      h(doc, "strong", {}, `Pages ${request.pages.join(", ")} · ${request.state} · ${request.state === "interrupted" ? "duration unknown" : duration((request.endedAt || Date.now()) - request.startedAt)}`),
      h(doc, "div", {}, `Estimated input: ${request.estimatedInputTokens} tokens · Images: ${(request.imageBytes / 1048576).toFixed(2)} MiB`),
      h(doc, "div", {}, request.usage ? `Reported input/output: ${request.usage.prompt_tokens ?? "unknown"}/${request.usage.completion_tokens ?? "unknown"}` : "Usage not reported"),
      ...(request.error ? [h(doc, "div", { className: "chatpdf-conversion-error" }, request.error)] : [])));
    events.replaceChildren();
    for (const event of details?.events || []) events.appendChild(h(doc, "div", {}, `${new Date(event.at).toLocaleTimeString()} · ${event.message}`));
    const chunk = details?.chunks.find(chunk => page >= chunk.startPage && page <= chunk.endPage);
    const draft = getConversionDraft(jobId, page);
    const rendered = !!details?.renderedPages.includes(page) || status.state === "ready";
    const version = `${jobId}:${page}:${chunk?.stage}:${status.state}:${draft}:${rendered}:${sourceMode}`;
    if (pageVersion !== version && pendingVersion !== version) void loadPage(version, rendered);
  };
  close.addEventListener("click", cleanup);
  prev.addEventListener("click", () => selectPage(Math.max(1, page - 1)));
  next.addEventListener("click", () => selectPage(page + 1));
  mode.addEventListener("click", () => { sourceMode = !sourceMode; mode.textContent = sourceMode ? "Show rendered result" : "Show Markdown source"; renderText(); });
  original.addEventListener("click", () => { void openPdfForSourceKey(source.key, source.libraryID); });
  stop.addEventListener("click", () => { if (jobId) void cancelConversion(jobId); });
  retry.addEventListener("click", () => { void onRetry?.().then(refresh); });
  state.conversionInspectorCleanup = cleanup;
  refresh(); close.focus();
}
