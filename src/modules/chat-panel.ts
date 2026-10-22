import { installCitationLinks } from "./source-citation";
import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";
import { XUL_NS, preserveBottomScroll } from "../utils/dom";
import { uiLabel, uiText } from "../utils/ui-text";
import {
  createPanelState, getPanelState, destroyPanelState,
} from "./panel-state";
import { showFilteredHistory } from "./history-view";
import { refreshSourceChips } from "./source-chips";
import { dismissSourceMenu } from "./source-chip-ui";
import { autoSaveSession } from "./session-persistence";
import { buildChatUI } from "./chat-view";
import { addItemToSession, insertInputChip } from "./session-sources";
export { addItemToSession } from "./session-sources";
import {
  getItemTitle,
  getChatAttachment,
} from "./zotero-items";
import {
  clampPanelWidth,
  PANEL_DEFAULT_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_MINIMIZED_WIDTH,
  PANEL_RESIZE_STEP,
  controlHostContentWidth,
  findPanelHost,
  normalizePreferredPanelWidth,
  panelWidthAfterDrag,
  recoverCorruptZoteroContextWidth,
} from "./panel-resize";

// Re-export for external consumers (hooks.ts, etc.)
export { showFilteredHistory } from "./history-view";
export { abortCurrentStream } from "./panel-state";

const CHAT_PANEL_ID = "chatpdf-panel-container";

function getPersistedPanelWidth(): number {
  return normalizePreferredPanelWidth(getPref("panelWidth"))
    ?? PANEL_DEFAULT_WIDTH;
}

function persistPanelWidth(width: number): void {
  setPref("panelWidth", Math.round(width));
}

// ---- Side panel injection ----

export function injectChatPanel(win: Window): void {
  const doc = win.document;

  if (doc.getElementById(CHAT_PANEL_ID)) return;

  const panelHost = findPanelHost(doc);
  if (!panelHost) {
    Zotero.debug("[ChatPDF] Could not find layout container to inject panel");
    return;
  }
  const { layoutBox, hostContent } = panelHost;
  const hostLayout = layoutBox as HTMLElement;

  const state = createPanelState(win);

  // --- Inject CSS ---
  const katexLink = doc.createElementNS("http://www.w3.org/1999/xhtml", "link") as HTMLLinkElement;
  katexLink.rel = "stylesheet";
  katexLink.href = `chrome://${config.addonRef}/content/katex.css`;
  katexLink.id = "chatpdf-katex-css";
  doc.documentElement?.appendChild(katexLink);

  const cssLink = doc.createElementNS("http://www.w3.org/1999/xhtml", "link") as HTMLLinkElement;
  cssLink.rel = "stylesheet";
  cssLink.href = `chrome://${config.addonRef}/content/chatpdf.css`;
  cssLink.id = "chatpdf-main-css";
  doc.documentElement?.appendChild(cssLink);

  // Use an XHTML handle with explicit drag logic. A native XUL splitter stops
  // when its nearest Zotero sibling reaches min-width and creates an apparent
  // proportional maximum.
  const splitter = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
  splitter.id = "chatpdf-splitter";
  splitter.setAttribute("role", "separator");
  splitter.setAttribute("aria-orientation", "vertical");
  splitter.setAttribute("aria-label", uiText("Resize ChatPDF panel", "调整 ChatPDF 面板宽度"));
  splitter.tabIndex = 0;

  const vbox = doc.createElementNS(XUL_NS, "vbox") as HTMLElement;
  vbox.id = CHAT_PANEL_ID;
  vbox.setAttribute("flex", "0");
  let preferredWidth = getPersistedPanelWidth();
  vbox.setAttribute("width", String(preferredWidth));

  const root = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
  root.id = "chatpdf-root";
  installCitationLinks(root);
  root.dataset.chatpdfWindowId = state.windowId;
  vbox.appendChild(root);

  // --- Create minimized bar (hidden by default) ---
  const minimizedBar = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
  minimizedBar.id = "chatpdf-minimized-bar";
  minimizedBar.setAttribute("role", "button");
  minimizedBar.setAttribute("aria-label", uiLabel("restore"));
  minimizedBar.tabIndex = 0;
  minimizedBar.style.display = "none";
  const minimizedLabel = doc.createElementNS("http://www.w3.org/1999/xhtml", "span") as HTMLElement;
  minimizedLabel.className = "chatpdf-minimized-label";
  minimizedLabel.textContent = "ChatPDF";
  minimizedBar.appendChild(minimizedLabel);
  vbox.appendChild(minimizedBar);

  let minimized = false;
  let dragging = false;
  let dragStartX = 0;
  let dragStartWidth = 0;
  let panelIsAfterSplitter = true;
  let hostContentWidthController: ReturnType<typeof controlHostContentWidth> | null = null;

  function layoutWidth(): number {
    return hostLayout.getBoundingClientRect().width || win.innerWidth;
  }

  function splitterWidth(): number {
    return splitter.getBoundingClientRect().width || 5;
  }

  function reservedLayoutWidth(): number {
    let width = splitterWidth();
    for (const child of Array.from(hostLayout.children)) {
      if (child === splitter || child === vbox || child === hostContent) continue;
      const element = child as HTMLElement;
      const style = win.getComputedStyle(element);
      if (!style || style.display === "none" || style.position === "absolute" || style.position === "fixed") continue;
      width += element.getBoundingClientRect().width;
    }
    return width;
  }

  function renderPanelWidth(): void {
    const availableWidth = layoutWidth();
    const reservedWidth = reservedLayoutWidth();
    const renderedWidth = minimized
      ? PANEL_MINIMIZED_WIDTH
      : clampPanelWidth(preferredWidth, availableWidth, reservedWidth);
    vbox.style.width = `${renderedWidth}px`;
    vbox.style.minWidth = `${renderedWidth}px`;
    vbox.style.flexBasis = `${renderedWidth}px`;
    vbox.setAttribute("width", String(renderedWidth));
    vbox.setAttribute("minwidth", String(renderedWidth));
    hostContentWidthController?.setWidth(availableWidth - reservedWidth - renderedWidth);
    if (!minimized) {
      splitter.setAttribute("aria-valuemin", String(Math.min(PANEL_MIN_WIDTH, Math.max(0, availableWidth - reservedWidth))));
      splitter.setAttribute("aria-valuemax", String(Math.max(0, Math.round(availableWidth - reservedWidth))));
      splitter.setAttribute("aria-valuenow", String(renderedWidth));
    }
  }

  function setPreferredWidth(width: number, persist = false): void {
    preserveBottomScroll(root.querySelector("#chatpdf-messages"), () => {
      preferredWidth = clampPanelWidth(width, layoutWidth(), reservedLayoutWidth());
      renderPanelWidth();
    });
    if (persist) persistPanelWidth(preferredWidth);
  }

  function finishResize() {
    if (!dragging) return;
    dragging = false;
    doc.documentElement?.classList.remove("chatpdf-panel-resizing");
    win.removeEventListener("mousemove", onResizeMove, true);
    win.removeEventListener("mouseup", finishResize, true);
    persistPanelWidth(preferredWidth);
  }

  function onResizeMove(event: Event) {
    if (!dragging) return;
    const requestedWidth = panelWidthAfterDrag(
      dragStartWidth,
      dragStartX,
      (event as MouseEvent).clientX,
      panelIsAfterSplitter,
    );
    setPreferredWidth(requestedWidth);
  }

  function startResize(event: Event) {
    const mouseEvent = event as MouseEvent;
    if (mouseEvent.button !== 0 || minimized) return;
    mouseEvent.preventDefault();
    mouseEvent.stopPropagation();
    dragging = true;
    dragStartX = mouseEvent.clientX;
    dragStartWidth = vbox.getBoundingClientRect().width;
    panelIsAfterSplitter = splitter.getBoundingClientRect().left <= vbox.getBoundingClientRect().left;
    doc.documentElement?.classList.add("chatpdf-panel-resizing");
    win.addEventListener("mousemove", onResizeMove, true);
    win.addEventListener("mouseup", finishResize, true);
  }

  splitter.addEventListener("mousedown", startResize);
  splitter.addEventListener("dblclick", () => setPreferredWidth(PANEL_DEFAULT_WIDTH, true));
  splitter.addEventListener("keydown", (event: Event) => {
    const keyEvent = event as KeyboardEvent;
    if (keyEvent.key !== "ArrowLeft" && keyEvent.key !== "ArrowRight") return;
    keyEvent.preventDefault();
    const panelAfterHandle = splitter.getBoundingClientRect().left <= vbox.getBoundingClientRect().left;
    const pointerDelta = keyEvent.key === "ArrowRight" ? PANEL_RESIZE_STEP : -PANEL_RESIZE_STEP;
    setPreferredWidth(
      panelWidthAfterDrag(preferredWidth, 0, pointerDelta, panelAfterHandle),
      true,
    );
  });

  // --- Minimize / Restore logic ---

  function minimizePanel() {
    minimized = true;
    root.style.display = "none";
    minimizedBar.style.display = "";
    vbox.classList.add("chatpdf-panel-minimized");
    splitter.style.display = "none";
    renderPanelWidth();
    minimizedBar.focus();
  }

  function restorePanel() {
    minimized = false;
    minimizedBar.style.display = "none";
    root.style.display = "";
    vbox.classList.remove("chatpdf-panel-minimized");
    splitter.style.display = "";
    renderPanelWidth();
  }

  minimizedBar.addEventListener("click", restorePanel);
  minimizedBar.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    restorePanel();
    (root.querySelector(".chatpdf-minimize-btn") as HTMLButtonElement | null)?.focus();
  });

  hostLayout.appendChild(splitter);
  hostLayout.appendChild(vbox);

  // Size Zotero's app content as one unit. Never clear constraints on its
  // internal tabs deck, context pane, collections pane, or item pane.
  hostContentWidthController = controlHostContentWidth(hostContent);
  const zoteroContextPane = doc.getElementById("zotero-context-pane") as HTMLElement | null;
  const recoveredContextWidth = recoverCorruptZoteroContextWidth(
    zoteroContextPane?.getAttribute("width"),
    layoutWidth(),
  );
  if (zoteroContextPane && recoveredContextWidth !== null) {
    zoteroContextPane.setAttribute("width", String(recoveredContextWidth));
    zoteroContextPane.style.width = `${recoveredContextWidth}px`;
    Zotero.debug(`[ChatPDF] Recovered corrupt Zotero context pane width as ${recoveredContextWidth}px`);
  }
  const onWindowResize = () => renderPanelWidth();
  const ResizeObserverCtor = (win as any).ResizeObserver as typeof ResizeObserver | undefined;
  const layoutResizeObserver = ResizeObserverCtor
    ? new ResizeObserverCtor(onWindowResize)
    : null;
  layoutResizeObserver?.observe(hostLayout);
  win.addEventListener("resize", onWindowResize);
  win.addEventListener("blur", finishResize, true);
  renderPanelWidth();

  let cleanedUp = false;
  state.panelCleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    dismissSourceMenu(root);
    finishResize();
    win.removeEventListener("resize", onWindowResize);
    win.removeEventListener("blur", finishResize, true);
    layoutResizeObserver?.disconnect();
    splitter.removeEventListener("mousedown", startResize);
    hostContentWidthController?.restore();
    hostContentWidthController = null;
    doc.documentElement?.classList.remove("chatpdf-panel-resizing");
  };

  // Build the chat UI once — it persists for the window lifetime
  buildChatUI(root, minimizePanel);
}

/** Remove injected panel elements from a window. */
export function removeChatPanel(win: Window): void {
  const doc = win.document;
  const state = getPanelState(win);
  const root = doc.querySelector("#chatpdf-root") as HTMLElement | null;
  if (root) autoSaveSession(root).catch((error: any) => Zotero.debug(`[ChatPDF] unload save failed: ${error.message}`));
  state.panelCleanup?.();
  state.panelCleanup = null;

  // Clean up copy handler
  if (state.copyHandler) {
    doc.removeEventListener("copy", state.copyHandler);
    state.copyHandler = null;
  }

  // Clean up poll intervals
  for (const id of state.activePollIntervals) {
    win.clearInterval(id);
  }
  state.activePollIntervals.clear();
  state.chatInput?.destroy();
  state.chatInput = null;

  doc.getElementById(CHAT_PANEL_ID)?.remove();
  doc.getElementById("chatpdf-splitter")?.remove();
  doc.getElementById("chatpdf-katex-css")?.remove();
  doc.getElementById("chatpdf-main-css")?.remove();
  destroyPanelState(win);
}

// ---- Context menu ----

export function registerContextMenu(): void {
  Zotero.MenuManager.registerMenu({
    menuID: "chatpdf-item-menu",
    pluginID: config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "menuitem",
        l10nID: "chatpdf-menuitem-addtochatpdf",
        onCommand: async (_event: Event, context: _ZoteroTypes.MenuManager.LibraryMenuContext) => {
          const win = Zotero.getMainWindow() as Window;
          const root = win?.document?.querySelector("#chatpdf-root") as HTMLElement | null;
          if (!root) return;
          for (const item of context.items ?? []) {
            await addItemToSession(item, root);
          }
          refreshSourceChips(root);
          const state = getPanelState(root);
          let insertedSource = false;
          for (const item of context.items ?? []) {
            const pdf = getChatAttachment(item);
            if (!pdf) continue;
            const src = state.session.getSource(pdf.key, Number((pdf as any).libraryID) || undefined);
            if (src) {
              insertInputChip(src, root);
              insertedSource = true;
            }
          }
          if (insertedSource) state.chatInput?.restoreFocusAfterExternalInsert();
        },
      },
      {
        menuType: "menuitem",
        l10nID: "chatpdf-menuitem-relatedsessions",
        onCommand: async (_event: Event, context: _ZoteroTypes.MenuManager.LibraryMenuContext) => {
          const item = context.items?.[0];
          if (!item) return;
          const parentKey = item.isRegularItem?.() ? item.key : (item.parentItem?.key || item.key);
          const title = getItemTitle(item);
          showFilteredHistory(parentKey, title);
        },
      },
    ],
  });
}
