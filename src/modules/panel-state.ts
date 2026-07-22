import { ChatSession } from "./chat-session";
import { ChatInputEditor } from "./tiptap-input";
import { IterationRecord } from "./llm-client";

export interface StreamState {
  session: ChatSession;
  abortController: AbortLike;
  fullText: string;
  fullReasoning: string;
  thinkingDone: boolean;
  thinkingElapsed: number;
  thinkingStartTime: number;
  iterations: IterationRecord[];
}

export interface ModelProfile {
  name: string;
  apiBase: string;
  apiKey: string;
  model: string;
  thinkingMode?: string;
  thinkEffort?: string;
}

export interface AbortLike {
  abort(reason?: unknown): void;
  signal: AbortSignal;
}

export interface PanelState {
  readonly windowId: string;
  readonly win: Window;
  session: ChatSession;
  showingHistory: boolean;
  chatInput: ChatInputEditor | null;
  isStreaming: boolean;
  currentAbortController: AbortLike | null;
  historyFilterParentKey: string | null;
  historyFilterTitle: string | null;
  conversionAbortControllers: Map<string, AbortLike>;
  backgroundStreams: Map<string, StreamState>;
  activePollIntervals: Set<number>;
  copyHandler: ((event: Event) => void) | null;
  panelCleanup: (() => void) | null;
}

const states = new Map<Window, PanelState>();

function windowFor(target: Window | Document | HTMLElement): Window {
  if ((target as Window).document) return target as Window;
  if ((target as Document).defaultView) return (target as Document).defaultView!;
  const win = (target as HTMLElement).ownerDocument?.defaultView;
  if (!win) throw new Error("ChatPDF panel is not attached to a window.");
  return win;
}

export function createPanelState(win: Window): PanelState {
  const existing = states.get(win);
  if (existing) return existing;
  const state: PanelState = {
    windowId: `window-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    win,
    session: new ChatSession(),
    showingHistory: false,
    chatInput: null,
    isStreaming: false,
    currentAbortController: null,
    historyFilterParentKey: null,
    historyFilterTitle: null,
    conversionAbortControllers: new Map(),
    backgroundStreams: new Map(),
    activePollIntervals: new Set(),
    copyHandler: null,
    panelCleanup: null,
  };
  states.set(win, state);
  return state;
}

export function getPanelState(target: Window | Document | HTMLElement): PanelState {
  return createPanelState(windowFor(target));
}

export function destroyPanelState(win: Window): void {
  const state = states.get(win);
  if (!state) return;
  state.currentAbortController?.abort();
  for (const controller of state.conversionAbortControllers.values()) controller.abort();
  for (const stream of state.backgroundStreams.values()) stream.abortController.abort();
  for (const interval of state.activePollIntervals) win.clearInterval(interval);
  state.panelCleanup?.();
  state.panelCleanup = null;
  state.chatInput?.destroy();
  states.delete(win);
}

export function createAbortController(win?: Window): { controller: AbortLike; signal: AbortSignal } {
  const Ctor = (typeof AbortController !== "undefined")
    ? AbortController
    : (win as any)?.AbortController || (Zotero.getMainWindow() as any).AbortController;
  const controller = new Ctor() as AbortLike;
  return { controller, signal: controller.signal };
}

export function abortCurrentStream(target?: Window | Document | HTMLElement): void {
  if (!target) {
    for (const state of states.values()) abortStateStream(state);
    return;
  }
  abortStateStream(getPanelState(target));
}

function abortStateStream(state: PanelState): void {
  state.currentAbortController?.abort();
  state.currentAbortController = null;
  state.isStreaming = false;
}

export function resetStreamingUI(root: HTMLElement): void {
  const state = getPanelState(root);
  state.currentAbortController = null;
  state.isStreaming = false;
  state.chatInput?.setEditable(true);
  const button = root.querySelector("#chatpdf-send") as HTMLButtonElement | null;
  if (button) setSendButtonToSend(button);
}

export function setSendButtonToStop(sendBtn: HTMLButtonElement): void {
  sendBtn.textContent = "\u25A0";
  sendBtn.title = "Stop";
  sendBtn.classList.add("chatpdf-send-btn-stop");
  sendBtn.disabled = false;
}

export function setSendButtonToSend(sendBtn: HTMLButtonElement): void {
  sendBtn.textContent = "\u2191";
  sendBtn.title = "Send";
  sendBtn.classList.remove("chatpdf-send-btn-stop");
}
