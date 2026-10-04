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
import { openConversionInspector, conversionProgressText } from "./conversion-inspector";
import { createSourceChip, SourceChipView } from "./source-chip-ui";

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
  view: SourceChipView;
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
    if (!sourceIds.has(id) || session.getSource(id) !== row.source) { row.view.dismiss(); row.element.remove(); rows.delete(id); }
  }

  for (const source of sources) {
    let row = rows.get(source.id);
    if (!row) {
      const convert = (force = false) => {
        const pending = convertSource(source, () => refreshSourceChips(root), undefined, state, state.session, false, force)
          .catch(() => refreshSourceChips(root));
        refreshSourceChips(root);
        return pending;
      };
      const view = createSourceChip(root, source, {
        open: () => {
          if (source.kind === "image") state.chatInput?.insertMention({ key: source.id, title: source.title });
          else void openPdfForSourceKey(source.key, source.libraryID).catch(err => Zotero.debug(`[ChatPDF] Open source failed: ${err.message}`));
        },
        inspect: () => openConversionInspector(root, source, async () => { await convert(); }),
        convert,
        stop: () => { state.conversionAbortControllers.get(source.id)?.abort(); refreshSourceChips(root); },
        remove: () => {
          state.conversionAbortControllers.get(source.id)?.abort();
          state.conversionAbortControllers.delete(source.id);
          session.removeSource(source.id); saveCurrentSession(root); refreshSourceChips(root);
        },
      });
      const element = h(doc, "div", { className: "chatpdf-source-entry" }); element.append(view.element);
      row = { source, element, view }; rows.set(source.id, row);
    }
    row.view.update(); wanted.push(row.element);
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
