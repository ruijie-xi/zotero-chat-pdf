export const PANEL_DEFAULT_WIDTH = 350;
export const PANEL_MIN_WIDTH = 280;
export const PANEL_MINIMIZED_WIDTH = 36;
export const PANEL_RESIZE_STEP = 24;
export const ZOTERO_CONTEXT_DEFAULT_WIDTH = 400;
export const ZOTERO_CONTEXT_MIN_WIDTH = 357;
export const ZOTERO_TABS_MIN_WIDTH = 570;

export interface PanelHost {
  layoutBox: HTMLElement;
  hostContent: HTMLElement;
}

/** Prefer the boundary around Zotero's complete app content, not its internal panes. */
export function findPanelHost(doc: Document): PanelHost | null {
  const browser = doc.getElementById("browser") as HTMLElement | null;
  const appContent = doc.getElementById("appcontent") as HTMLElement | null;
  if (browser && appContent?.parentElement === browser) {
    return { layoutBox: browser, hostContent: appContent };
  }
  const tabsDeck = doc.getElementById("tabs-deck") as HTMLElement | null;
  if (tabsDeck?.parentElement) {
    return { layoutBox: tabsDeck.parentElement as HTMLElement, hostContent: tabsDeck };
  }
  return null;
}

/**
 * Keep the panel inside its physical host. There is deliberately no
 * proportional maximum: the panel may use all space except the resize handle.
 */
export function clampPanelWidth(
  requestedWidth: number,
  layoutWidth: number,
  reservedWidth: number,
): number {
  const physicalMaximum = Math.max(0, layoutWidth - reservedWidth);
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

export interface HostContentWidthController {
  setWidth: (width: number) => void;
  restore: () => void;
}

/** Size Zotero's complete content root explicitly, without touching its internal panes. */
export function controlHostContentWidth(element: HTMLElement): HostContentWidthController {
  const widthAttribute = element.getAttribute("width");
  const minWidthAttribute = element.getAttribute("minwidth");
  const flexAttribute = element.getAttribute("flex");
  const minWidth = element.style.minWidth;
  const maxWidth = element.style.maxWidth;
  const width = element.style.width;
  const flexBasis = element.style.flexBasis;
  const flexGrow = element.style.flexGrow;
  const flexShrink = element.style.flexShrink;
  const overflow = element.style.overflow;
  element.setAttribute("minwidth", "0");
  element.setAttribute("flex", "0");
  element.style.minWidth = "0px";
  element.style.flexGrow = "0";
  element.style.flexShrink = "0";
  element.style.overflow = "hidden";
  return {
    setWidth(nextWidth: number) {
      const safeWidth = Math.max(0, Math.round(nextWidth));
      element.setAttribute("width", String(safeWidth));
      element.style.width = `${safeWidth}px`;
      element.style.maxWidth = `${safeWidth}px`;
      element.style.flexBasis = `${safeWidth}px`;
    },
    restore() {
      if (widthAttribute === null) element.removeAttribute("width");
      else element.setAttribute("width", widthAttribute);
      if (minWidthAttribute === null) element.removeAttribute("minwidth");
      else element.setAttribute("minwidth", minWidthAttribute);
      if (flexAttribute === null) element.removeAttribute("flex");
      else element.setAttribute("flex", flexAttribute);
      element.style.minWidth = minWidth;
      element.style.maxWidth = maxWidth;
      element.style.width = width;
      element.style.flexBasis = flexBasis;
      element.style.flexGrow = flexGrow;
      element.style.flexShrink = flexShrink;
      element.style.overflow = overflow;
    },
  };
}

/**
 * Return a safe replacement only for clearly corrupt Zotero context widths.
 * Legitimate widths are left entirely under Zotero's control.
 */
export function recoverCorruptZoteroContextWidth(
  value: unknown,
  hostWidth: number,
): number | null {
  const width = Number(value);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(hostWidth) || hostWidth <= 0) {
    return null;
  }
  const corruptThreshold = Math.max(4096, hostWidth * 4);
  if (width <= corruptThreshold) return null;
  const physicalMaximum = Math.max(ZOTERO_CONTEXT_MIN_WIDTH, hostWidth - ZOTERO_TABS_MIN_WIDTH);
  return Math.round(Math.min(ZOTERO_CONTEXT_DEFAULT_WIDTH, physicalMaximum));
}
