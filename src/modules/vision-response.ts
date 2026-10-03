import { throwIfConversionAborted } from "./pdf-conversion";
import { VisionQualityError } from "./vision-quality";
import type { TokenUsage } from "./llm-client";
import { safeConversionUsage } from "./conversion-details";

export const VISION_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Accept SSE or a provider's ordinary JSON reply without making a fallback request. */
export async function readVisionResponse(response: Response, signal: AbortSignal, onContent?: (content: string) => void,
  onUsage?: (usage: TokenUsage) => void): Promise<{
  content: string; finishReason?: string; usage?: TokenUsage;
}> {
  const reader = response.body?.getReader() as { read(): Promise<{ value: Uint8Array; done: boolean }>; cancel(reason?: unknown): Promise<void>; releaseLock(): void } | undefined;
  if (!reader) throw new Error("PDF vision API returned no response body");
  const streaming = /text\/event-stream/i.test(response.headers.get("Content-Type") || "");
  let bytes = 0, buffer = "", content = "", finishReason: string | undefined, usage: TokenUsage | undefined;
  const decoder = new TextDecoder();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const frame = (value: string) => {
    const data = value.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data || data === "[DONE]") return;
    let parsed: any;
    try { parsed = JSON.parse(data); } catch { throw new VisionQualityError("PDF vision stream contains invalid JSON"); }
    if (parsed.error) throw new Error("PDF vision API reported an error while streaming");
    if (parsed.usage) { usage = safeConversionUsage(parsed.usage); onUsage?.(usage); }
    const choice = parsed.choices?.find((choice: any) => (choice.index ?? 0) === 0);
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (typeof choice?.delta?.content === "string") { content += choice.delta.content; onContent?.(content); }
  };
  const consume = (final = false) => {
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(buffer);
      if (!boundary) break;
      frame(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index + boundary[0].length);
    }
    if (final && buffer.trim()) frame(buffer);
  };
  try {
    for (;;) {
      throwIfConversionAborted(signal);
      const { value, done } = await reader.read();
      throwIfConversionAborted(signal);
      if (done) break;
      bytes += value.length;
      if (bytes > VISION_MAX_RESPONSE_BYTES) throw new Error("PDF vision response exceeds the 8 MiB safety limit");
      buffer += decoder.decode(value, { stream: true });
      if (streaming) consume();
    }
    buffer += decoder.decode();
    if (streaming) consume(true);
    else {
      const parsed = JSON.parse(buffer);
      if (parsed.error) throw new Error("PDF vision API reported a response error");
      content = parsed.choices?.[0]?.message?.content;
      finishReason = parsed.choices?.[0]?.finish_reason;
      usage = parsed.usage ? safeConversionUsage(parsed.usage) : undefined;
      if (usage) onUsage?.(usage);
      if (typeof content === "string") onContent?.(content);
    }
    if (typeof content !== "string" || !content.trim() || finishReason !== "stop") {
      throw new VisionQualityError("PDF vision output is empty, incomplete or truncated");
    }
    return { content, finishReason, usage };
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
