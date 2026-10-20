import { logLLMTransportFailure } from "./debug-log";

export interface TransportAttempt {
  phase: "connect" | "response";
  receivedData: boolean;
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

/** Retry only transport failures before any model data; never replay a partial response. */
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
      if ((error as Error)?.name === "AbortError" || !isNetworkError(error)) throw error;
      const retry = !state.receivedData && attempt < 3;
      void logLLMTransportFailure({ endpoint, model, attempt, phase: state.phase, receivedData: state.receivedData, retry });
      Zotero.debug(`[ChatPDF] LLM network failure: endpoint=${endpoint}, phase=${state.phase}, attempt=${attempt}/3, receivedData=${state.receivedData}, retry=${retry}`);
      if (retry) {
        await waitForRetry(1000 * attempt, signal);
        continue;
      }
      throw new Error(state.receivedData
        ? `Connection to ${endpoint} was interrupted while receiving the model response. Partial output was preserved; send a follow-up to continue.`
        : `Could not receive a model response from ${endpoint} after ${attempt} attempts. Check the connection, proxy/VPN, or provider availability, then retry.`, { cause: error });
    }
  }
}
