import { h } from "../utils/dom";
import { formatChars } from "../utils/format";
import { SourceItem } from "./chat-session";
import {
  conversionRequestFromSource,
  releaseConversion,
  recoverConversion,
  startConversion,
  subscribeConversion,
  waitForConversion,
} from "./conversion-manager";
import * as MDCache from "./md-cache";
import * as ChatHistory from "./chat-history";
import { createAbortController, getPanelState, PanelState } from "./panel-state";
import { openPdfForSourceKey } from "./zotero-items";
import { summarizeSelfChecks } from "./vision-self-check";
import { openConversionInspector, conversionProgressText, conversionSummaryText } from "./conversion-inspector";
import { uiText } from "../utils/ui-text";

/** Convert a source using the configured PDF engine. */
export async function convertSource(
  source: SourceItem,
  onProgress?: (msg: string) => void,
  externalSignal?: AbortSignal,
  panelState?: PanelState,
  targetSession = panelState?.session,
  recoverOnly = false,
  force = false,
): Promise<void> {
  if (source.kind === "image") return;
  if (!targetSession) throw new Error("Conversion requires an owning chat session.");
  const controllers = panelState?.conversionAbortControllers ?? new Map();
  if (controllers.has(source.id)) return;
  const previousStatus = source.status;
  const previousError = source.errorMessage;
  const stillAttached = () => targetSession.getSource(source.id) === source;
  targetSession.setSourceStatus(source.id, "converting");
  const { controller: convController, signal: convSignal } = createAbortController(panelState?.win);
  controllers.set(source.id, convController);
  const forwardAbort = () => convController.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  if (externalSignal?.aborted) forwardAbort();
  onProgress?.("Starting conversion...");
  let unsubscribe: () => void = () => undefined;
  let jobId = "";
  const progressTimer = panelState && onProgress ? panelState.win.setInterval(() => {
    if (stillAttached() && source.status === "converting" && source.conversionStatus) onProgress(conversionProgressText(source.conversionStatus));
  }, 1000) : undefined;
  const owner = `ui:${panelState?.windowId || "detached"}:${source.id}`;
  try {
    const request = conversionRequestFromSource(source);
    if (force) request.force = true;
    const started = recoverOnly
      ? await recoverConversion(request, owner, convSignal)
      : await startConversion(request, owner);
    if (!started) {
      if (stillAttached()) targetSession.setSourceStatus(source.id, previousStatus, previousError);
      onProgress?.("No existing conversion to recover");
      return;
    }
    jobId = started.jobId;
    source.conversionStatus = started;
    const releaseOwner = () => releaseConversion(jobId, owner);
    convSignal.addEventListener("abort", releaseOwner, { once: true });
    if (convSignal.aborted) releaseOwner();
    unsubscribe = subscribeConversion(jobId, (status) => {
      if (stillAttached()) source.conversionStatus = status;
      onProgress?.(status.progress);
    });
    const finished = await waitForConversion(jobId, convSignal);
    convSignal.removeEventListener("abort", releaseOwner);
    if (finished.state === "ready") {
      const [markdown, manifest] = await Promise.all([MDCache.read(source.cacheKey, source.key), MDCache.readManifest(source.cacheKey, source.key)]);
      if (convSignal.aborted || !stillAttached()) return;
      targetSession.setSourceReady(source.id, markdown);
      source.selfCheck = manifest?.converter === "vision" ? summarizeSelfChecks(manifest.chunks, manifest.pageCount) : undefined;
      onProgress?.("Ready");
    } else if (finished.state === "cancelled") {
      if (stillAttached()) targetSession.setSourceStatus(source.id, "pending");
      onProgress?.("Conversion stopped");
    } else {
      throw new Error(finished.error || finished.progress || "Conversion failed");
    }
  } catch (err: any) {
    if (err.name === "AbortError" || convSignal.aborted) {
      Zotero.debug(`[ChatPDF] convertSource aborted for ${source.key}`);
      if (stillAttached()) targetSession.setSourceStatus(source.id, "pending");
      onProgress?.("Conversion stopped");
    } else {
      Zotero.debug(`[ChatPDF] convertSource error: ${err.message}\n${err.stack}`);
      if (stillAttached()) targetSession.setSourceStatus(source.id, "error", err.message);
      onProgress?.(err.message);
      throw err;
    }
  } finally {
    if (progressTimer !== undefined) panelState?.win.clearInterval(progressTimer);
    unsubscribe();
    if (jobId) releaseConversion(jobId, owner);
    externalSignal?.removeEventListener("abort", forwardAbort);
    if (controllers.get(source.id) === convController) controllers.delete(source.id);
    if (jobId && stillAttached()) {
      await ChatHistory.saveSession(targetSession.toSavedSession()).catch((err: any) => {
        Zotero.debug(`[ChatPDF] save after source conversion failed: ${err.message}`);
      });
    }
  }
}

/** Adding a known source recovers uploaded results without starting a new upload. */
export function recoverSource(source: SourceItem, root: HTMLElement, targetSession = getPanelState(root).session): void {
  if (source.kind === "image" || source.status === "ready") return;
  const state = getPanelState(root);
  void convertSource(source, () => refreshSourceChips(root), undefined, state, targetSession, true)
    .catch(() => refreshSourceChips(root));
}

function saveCurrentSession(root: HTMLElement): void {
  const { session } = getPanelState(root);
  if (!session.hasMessages() && session.getSources().length === 0) return;
  ChatHistory.saveSession(session.toSavedSession()).catch((err: any) => {
    Zotero.debug(`[ChatPDF] save after source removal failed: ${err.message}`);
  });
}

interface SourceRow {
  source: SourceItem;
  element: HTMLElement;
  chip?: HTMLElement;
  signature: string;
  progress?: HTMLElement;
}
const sourceRows = new WeakMap<Element, Map<string, SourceRow>>();

/** Render the source chips UI in the panel. */
function renderSourceChips(root: HTMLElement): void {
  const state = getPanelState(root);
  const { session } = state;
  const container = root.querySelector("#chatpdf-source-chips");
  if (!container) return;
  const doc = root.ownerDocument!;
  const sources = session.getSources();
  const rows = sourceRows.get(container) || new Map<string, SourceRow>();
  sourceRows.set(container, rows);
  const wanted: HTMLElement[] = [];
  const sourceIds = new Set(sources.map(source => source.id));
  for (const [id, row] of rows) {
    if (!sourceIds.has(id) || session.getSource(id) !== row.source) { row.element.remove(); rows.delete(id); }
  }

  for (const source of sources) {
    let row = rows.get(source.id);
    if (!row) {
      row = { source, element: h(doc, "div", { className: "chatpdf-source-entry" }), signature: "" };
      rows.set(source.id, row);
      if (source.kind !== "image") {
        const detailRow = h(doc, "div", { className: "chatpdf-source-conversion-row" });
        const inspect = h(doc, "button", { type: "button", className: "chatpdf-chip-text-btn", "data-action": "view-conversion" }, uiText("View conversion process", "查看转换过程"));
        // This control stays attached during every streamed progress update.
        inspect.addEventListener("click", () => openConversionInspector(root, source, async () => {
          await convertSource(source, () => refreshSourceChips(root), undefined, getPanelState(root)).catch(() => {});
          refreshSourceChips(root);
        }));
        row.progress = h(doc, "span");
        detailRow.append(inspect, row.progress); row.element.appendChild(detailRow);
      }
    }
    wanted.push(row.element);
    if (row.progress) {
      const status = source.conversionStatus;
      const text = status ? [conversionProgressText(status), conversionSummaryText(status)].filter(Boolean).join("\n") : "";
      if (row.progress.textContent !== text) row.progress.textContent = text;
      row.progress.hidden = !text;
    }
    const signature = JSON.stringify([source.kind, source.status, source.title, source.errorMessage, source.markdown?.length,
      source.selfCheck?.pagesChecked, source.selfCheck?.pagesTotal, source.selfCheck?.editsApplied]);
    if (row.signature === signature) continue;
    row.signature = signature;
    const chipTitle = source.errorMessage || (source.kind === "image" ? "Image source — requires a vision-capable model" : "Open PDF");
    const chip = h(doc, "div", { className: `chatpdf-source-chip chatpdf-source-chip-${source.status}`, title: chipTitle });
    chip.addEventListener("click", () => {
      if (source.kind === "image") {
        state.chatInput?.insertMention({ key: source.id, title: source.title });
        return;
      }
      openPdfForSourceKey(source.key, source.libraryID).catch((err: any) => {
        Zotero.debug(`[ChatPDF] open source chip failed for ${source.key}: ${err.message}`);
      });
    });

    // Status indicator
    const statusIndicator = h(doc, "span", { className: `chatpdf-chip-indicator chatpdf-chip-indicator-${source.status}` });
    chip.appendChild(statusIndicator);

    // Title
    const titleEl = h(doc, "span", { className: "chatpdf-chip-title" }, source.title);
    chip.appendChild(titleEl);

    // Size badge for ready sources
    if (source.kind === "image") {
      chip.appendChild(h(doc, "span", { className: "chatpdf-chip-badge chatpdf-chip-badge-ready" }, "Image"));
    } else if (source.status === "ready" && source.markdown) {
      const charLen = source.markdown.length;
      const sizeText = formatChars(charLen);
      const badge = h(doc, "span", { className: "chatpdf-chip-badge chatpdf-chip-badge-ready" }, `${sizeText} chars`);
      chip.appendChild(badge);
      if (source.selfCheck) {
        const check = source.selfCheck;
        const label = check.pagesChecked ? `Self-check ${check.pagesChecked}/${check.pagesTotal}` : "Not self-checked";
        chip.appendChild(h(doc, "span", { className: "chatpdf-chip-badge", title: `Same-model self-check; ${check.editsApplied} local edits. This is not independent verification.` }, label));
      }
    } else if (source.status !== "pending" && source.status !== "ready") {
      const statusLabels: Record<string, string> = {
        converting: "Converting...",
        error: "Error",
      };
      const badge = h(doc, "span", { className: `chatpdf-chip-badge chatpdf-chip-badge-${source.status}` }, statusLabels[source.status] || "");
      chip.appendChild(badge);
    }

    // Actions
    const actions = h(doc, "span", { className: "chatpdf-chip-actions" });

    if ((source.status === "ready" || source.status === "error") && source.kind !== "image") {
      const reconvert = h(doc, "button", { className: "chatpdf-chip-text-btn", title: uiText("Recognize the PDF again and replace its cache. This may incur model charges.", "重新识别 PDF 并替换缓存，可能产生模型费用。") }, uiText("Reconvert", "重新识别"));
      reconvert.addEventListener("click", (e: Event) => {
        e.stopPropagation();
        void convertSource(source, () => refreshSourceChips(root), undefined, state, state.session, false, true)
          .catch(() => refreshSourceChips(root));
      });
      actions.appendChild(reconvert);
    }

    if ((source.status === "pending" || source.status === "error") && source.kind !== "image") {
      const label = source.status === "error" ? uiText("Retry", "继续已有工作") : uiText("Convert", "转换");
      const hint = source.status === "error" ? uiText("Reuse validated saved work where possible; remaining pages may incur model charges.", "优先复用已通过检查的结果；剩余页面可能产生模型费用。") : label;
      const convertBtn = h(doc, "button", { className: "chatpdf-chip-text-btn", title: hint }, label);
      convertBtn.addEventListener("click", (e: Event) => {
        e.stopPropagation();
        convertSource(source, () => refreshSourceChips(root), undefined, state).catch(() => refreshSourceChips(root));
        refreshSourceChips(root);
      });
      actions.appendChild(convertBtn);
    }

    if (source.status === "converting") {
      const stopBtn = h(doc, "button", { className: "chatpdf-chip-text-btn chatpdf-chip-stop-btn", title: "Stop conversion" }, "Stop");
      stopBtn.addEventListener("click", (e: Event) => {
        e.stopPropagation();
        const controller = state.conversionAbortControllers.get(source.id);
        if (controller) {
          Zotero.debug(`[ChatPDF] User stopped conversion for ${source.key}`);
          controller.abort();
        }
        refreshSourceChips(root);
      });
      actions.appendChild(stopBtn);
    }

    const removeBtn = h(doc, "button", { className: "chatpdf-chip-text-btn chatpdf-chip-remove-btn", title: "Remove source" }, "Remove");
    removeBtn.addEventListener("click", (e: Event) => {
      e.stopPropagation();
      const controller = state.conversionAbortControllers.get(source.id);
      if (controller) {
        Zotero.debug(`[ChatPDF] Removing source ${source.key}; aborting active conversion`);
        controller.abort();
        state.conversionAbortControllers.delete(source.id);
      }
      session.removeSource(source.id);
      saveCurrentSession(root);
      refreshSourceChips(root);
    });
    actions.appendChild(removeBtn);

    chip.appendChild(actions);
    if (row.chip) row.element.replaceChild(chip, row.chip);
    else row.element.prepend(chip);
    row.chip = chip;
  }

  // Reconcile only additions/removals/reordering; never detach an unchanged row.
  for (const [index, row] of wanted.entries()) {
    if (container.children[index] !== row) container.insertBefore(row, container.children[index] || null);
  }

  // Total source size summary
  const readySources = sources.filter((s) => s.status === "ready" && s.markdown);
  if (readySources.length > 0) {
    const totalChars = readySources.reduce((sum, s) => sum + (s.markdown?.length ?? 0), 0);
    const summary = container.querySelector(".chatpdf-source-summary") || h(doc, "div", { className: "chatpdf-source-summary" });
    const text = `${formatChars(totalChars)} chars`;
    if (summary.textContent !== text) summary.textContent = text;
    if (summary !== container.lastElementChild) container.appendChild(summary);
  } else container.querySelector(".chatpdf-source-summary")?.remove();
}

/** Refresh source chips without allowing Firefox to move the active chat cursor. */
export function refreshSourceChips(root: HTMLElement): void {
  const chatInput = getPanelState(root).chatInput;
  if (chatInput) {
    chatInput.preserveSelectionDuring(() => renderSourceChips(root));
  } else {
    renderSourceChips(root);
  }
}
