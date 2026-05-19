import { ChatSession } from "./chat-session";
import { ChatInputEditor } from "./tiptap-input";
import { IterationRecord } from "./llm-client";

/** Live state of an active stream (foreground or background). */
export interface StreamState {
  session: ChatSession;
  abortController: AbortLike;
  /** Accumulated content text so far. */
  fullText: string;
  /** Accumulated reasoning/thinking text so far. */
  fullReasoning: string;
  /** Whether the thinking phase is done. */
  thinkingDone: boolean;
  /** Total thinking time in seconds (set when thinking completes). */
  thinkingElapsed: number;
  /** Timestamp when thinking started (for live timer display). */
  thinkingStartTime: number;
  /** Completed iteration records (for stacked display). */
  iterations: IterationRecord[];
}

/** Model profile for switching between LLM configurations. */
export interface ModelProfile {
  name: string;
  apiBase: string;
  apiKey: string;
  model: string;
  thinkingMode?: string;
  thinkEffort?: string;
}

/** Minimal AbortController-like interface. */
export interface AbortLike {
  abort(): void;
  signal: AbortSignal;
}

// ---- Singleton mutable state ----

export let session = new ChatSession();
export let showingHistory = false;
export let chatInput: ChatInputEditor | null = null;
export let isStreaming = false;
export let currentAbortController: AbortLike | null = null;

/** History filter state */
export let historyFilterParentKey: string | null = null;
export let historyFilterTitle: string | null = null;

/** AbortControllers for in-progress MinerU conversions, keyed by source key. */
export const conversionAbortControllers = new Map<string, AbortLike>();

/**
 * Track active streams keyed by session ID.
 * When a stream is running for a session that the user navigated away from,
 * this map keeps the live state so we can resume the UI if the user comes back.
 */
export const backgroundStreams = new Map<string, StreamState>();

/** Track active poll intervals for cleanup. */
export const activePollIntervals = new Set<number>();

/** Store copy handler reference for cleanup in removeChatPanel. */
export let copyHandler: ((e: Event) => void) | null = null;

// ---- Setters for module-level state ----

export function setSession(s: ChatSession): void { session = s; }
export function setShowingHistory(v: boolean): void { showingHistory = v; }
export function setChatInput(v: ChatInputEditor | null): void { chatInput = v; }
export function setIsStreaming(v: boolean): void { isStreaming = v; }
export function setCurrentAbortController(v: AbortLike | null): void { currentAbortController = v; }
export function setHistoryFilterParentKey(v: string | null): void { historyFilterParentKey = v; }
export function setHistoryFilterTitle(v: string | null): void { historyFilterTitle = v; }
export function setCopyHandler(v: ((e: Event) => void) | null): void { copyHandler = v; }

// ---- Abort / streaming helpers ----

/** Create an AbortController -- works in both chrome and content contexts. */
export function createAbortController(): { controller: AbortLike; signal: AbortSignal } {
  const Ctor = (typeof AbortController !== "undefined")
    ? AbortController
    : (Zotero.getMainWindow() as any).AbortController;
  const controller = new Ctor();
  return { controller, signal: controller.signal };
}

/** Abort the current LLM stream if one is active. */
export function abortCurrentStream(): void {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  isStreaming = false;
}

/** Reset the input UI to the non-streaming state.
 *  Call this whenever switching to a different session so the textarea
 *  and send button aren't stuck in the old stream's "stop" mode.
 *  IMPORTANT: This detaches the currentAbortController so that background
 *  streams continue running even though the UI has moved on. */
export function resetStreamingUI(root: HTMLElement): void {
  currentAbortController = null;
  isStreaming = false;
  if (chatInput) chatInput.setEditable(true);
  const sb = root.querySelector("#chatpdf-send") as HTMLButtonElement;
  if (sb) setSendButtonToSend(sb);
}

// ---- Send button appearance ----

export function setSendButtonToStop(sendBtn: HTMLButtonElement): void {
  sendBtn.textContent = "\u25A0"; // square stop icon
  sendBtn.title = "Stop";
  sendBtn.classList.add("chatpdf-send-btn-stop");
  sendBtn.disabled = false;
}

export function setSendButtonToSend(sendBtn: HTMLButtonElement): void {
  sendBtn.textContent = "\u2191"; // up arrow
  sendBtn.title = "Send";
  sendBtn.classList.remove("chatpdf-send-btn-stop");
}
