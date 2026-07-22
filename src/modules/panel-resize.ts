export const PANEL_DEFAULT_WIDTH = 350;
export const PANEL_MIN_WIDTH = 280;
export const PANEL_MINIMIZED_WIDTH = 36;
export const PANEL_RESIZE_STEP = 24;

/**
 * Keep the panel inside its physical host. There is deliberately no
 * proportional maximum: the panel may use all space except the resize handle.
 */
export function clampPanelWidth(
  requestedWidth: number,
  layoutWidth: number,
  splitterWidth: number,
): number {
  const physicalMaximum = Math.max(0, layoutWidth - splitterWidth);
  const effectiveMinimum = Math.min(PANEL_MIN_WIDTH, physicalMaximum);
  if (!Number.isFinite(requestedWidth)) return effectiveMinimum;
  return Math.round(Math.min(physicalMaximum, Math.max(effectiveMinimum, requestedWidth)));
}

/** Calculate a new width from a horizontal drag in either LTR or RTL layout. */
export function panelWidthAfterDrag(
  startWidth: number,
  startClientX: number,
  currentClientX: number,
  panelIsAfterSplitter: boolean,
): number {
  const pointerDelta = currentClientX - startClientX;
  return startWidth + (panelIsAfterSplitter ? -pointerDelta : pointerDelta);
}

/** Normalize the stored preference without applying a window-specific maximum. */
export function normalizePreferredPanelWidth(value: unknown): number | null {
  const width = Number(value);
  return Number.isFinite(width) && width >= PANEL_MIN_WIDTH ? Math.round(width) : null;
}

/**
 * Allow the host's in-flow panes to shrink below their own minimums while the
 * ChatPDF panel is present, without permanently changing Zotero inline styles.
 */
export function relaxHostWidthConstraints(
  layoutBox: Element,
  panel: HTMLElement,
  splitter: HTMLElement,
): () => void {
  const snapshots: Array<{ element: HTMLElement; minWidth: string; flexShrink: string }> = [];
  const view = layoutBox.ownerDocument?.defaultView;
  for (const child of Array.from(layoutBox.children)) {
    if (child === panel || child === splitter || !("style" in child)) continue;
    const element = child as HTMLElement;
    if (element.localName === "splitter" || element.id.includes("splitter")) continue;
    const position = view?.getComputedStyle(element)?.position;
    if (position === "absolute" || position === "fixed") continue;
    snapshots.push({
      element,
      minWidth: element.style.minWidth,
      flexShrink: element.style.flexShrink,
    });
    element.style.minWidth = "0px";
    element.style.flexShrink = "1";
  }
  return () => {
    for (const snapshot of snapshots) {
      snapshot.element.style.minWidth = snapshot.minWidth;
      snapshot.element.style.flexShrink = snapshot.flexShrink;
    }
  };
}
