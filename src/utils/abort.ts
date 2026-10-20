/** Preserve cancellation as a terminal state rather than a model-visible tool error. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error("The request was cancelled."), { name: "AbortError" });
}
