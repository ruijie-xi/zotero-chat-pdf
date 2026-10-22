import { logLLMTransportFailure } from "./debug-log";

export interface TransportAttempt {
  phase: "connect" | "response";
  receivedData: boolean;
}

const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const PERMANENT_QUOTA_CODES = new Set([
  "insufficient_quota", "billing_hard_limit_reached", "billing_not_active",
  "credits_exhausted", "usage_limit_exceeded", "subscription_expired",
]);
const MAX_RETRY_WAIT_MS = 30_000;

function retryAfterMs(value?: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const text = value.trim();
  const delay = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1000
    : text.includes(",") ? Date.parse(text) - Date.now() : NaN;
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

/** An HTTP rejection before any model output; never constructed from SSE data. */
export class ProviderHttpError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(readonly status: number, responseText: string, retryAfter?: string | null, hint = "") {
    super(`LLM API error (${status}): ${responseText}${hint}`);
    this.name = "ProviderHttpError";
    let quotaError = false;
    try {
      const payload = JSON.parse(responseText);
      const error = payload?.error || payload;
      quotaError = [error?.code, error?.type].some(code => PERMANENT_QUOTA_CODES.has(String(code).toLowerCase()));
    } catch { /* Plain-text provider errors remain eligible by status. */ }
    this.retryable = RETRYABLE_HTTP_STATUS.has(status) && !quotaError;
    this.retryAfterMs = retryAfterMs(retryAfter);
  }
}

/** A gateway body-size rejection, distinct from token capacity or vision support. */
export class ProviderRequestSizeError extends ProviderHttpError {
  constructor(readonly requestBytes: number, readonly imageCount: number, readonly inlineImageBytes: number) {
    super(413, `Request Entity Too Large. The endpoint rejected a ${(requestBytes / 1048576).toFixed(2)} MiB request containing ${imageCount} image(s). This is a per-request gateway limit, not a vision-capability rejection.`);
    this.name = "ProviderRequestSizeError";
  }
}

function abortError(): Error {
  const error = new Error("The request was cancelled.");
  error.name = "AbortError";
  return error;
}

export function assertRequestActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function isNetworkError(error: unknown): boolean {
  const value = error as { name?: string; message?: string } | null;
  return value?.name === "NetworkError"
    || (value?.name === "TypeError" && /networkerror|failed to fetch|fetch failed|load failed|network request failed/i.test(value.message || ""));
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  assertRequestActive(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Retry transient HTTP/network failures at most twice, before any model data. */
export async function withLLMTransport<T>(
  url: string, model: string, signal: AbortSignal | undefined,
  request: (attempt: TransportAttempt) => Promise<T>,
): Promise<T> {
  const endpoint = new URL(url).host;
  for (let attempt = 1; ; attempt++) {
    assertRequestActive(signal);
    const state: TransportAttempt = { phase: "connect", receivedData: false };
    try {
      const result = await request(state);
      assertRequestActive(signal);
      return result;
    } catch (error) {
      assertRequestActive(signal);
      const http = error instanceof ProviderHttpError ? error : undefined;
      if (error instanceof ProviderRequestSizeError) {
        void logLLMTransportFailure({ endpoint, model, attempt, phase: state.phase, receivedData: state.receivedData,
          retry: false, status: 413, requestBytes: error.requestBytes, imageCount: error.imageCount, inlineImageBytes: error.inlineImageBytes });
      }
      if ((error as Error)?.name === "AbortError" || (http ? !http.retryable : !isNetworkError(error))) throw error;
      const delayMs = Math.max(1000 * attempt, http?.retryAfterMs || 0);
      const retry = !state.receivedData && attempt < 3 && delayMs <= MAX_RETRY_WAIT_MS;
      void logLLMTransportFailure({ endpoint, model, attempt, phase: state.phase, receivedData: state.receivedData, retry,
        ...(http ? { status: http.status, delayMs } : {}) });
      Zotero.debug(`[ChatPDF] LLM ${http ? `HTTP ${http.status}` : "network"} failure: endpoint=${endpoint}, phase=${state.phase}, attempt=${attempt}/3, receivedData=${state.receivedData}, retry=${retry}`);
      if (retry) {
        await waitForRetry(delayMs, signal);
        continue;
      }
      if (http) {
        if (attempt > 1) http.message += ` Request failed after ${attempt} attempts.`;
        if (delayMs > MAX_RETRY_WAIT_MS) http.message += ` The provider requested a wait of ${Math.ceil(delayMs / 1000)} seconds; retry later.`;
        throw http;
      }
      throw new Error(state.receivedData
        ? `Connection to ${endpoint} was interrupted while receiving the model response. Partial output was preserved; send a follow-up to continue.`
        : `Could not receive a model response from ${endpoint} after ${attempt} attempts. Check the connection, proxy/VPN, or provider availability, then retry.`, { cause: error });
    }
  }
}
