import type { ContextMessage } from "./agent-context";

/** A request-history watermark, never a cumulative reading allowance. */
export const IMAGE_WINDOW = { triggerBytes: 20 * 1024 * 1024, targetBytes: 10 * 1024 * 1024 };
export const OFFLOADED_IMAGE_TEXT = "[Previously delivered image bytes are no longer included in this request. This reference is not visual evidence. Use the source/page/region label above with inspect_pdf_page or read_image to inspect the original again when needed. Do not infer unseen details from this placeholder.]";

export interface ImageOffloadPlan {
  selections: Map<number, Set<number>>;
  imageCount: number;
  beforeBytes: number;
  afterBytes: number;
  targetBytes: number;
}

/** Exact inline Base64 payload size; remote references do not expand the body. */
export function inlineImageBytes(url: string): number {
  return /^data:image\/[^,]+;base64,/.test(url) ? url.length - url.indexOf(",") - 1 : 0;
}

/** Select oldest delivered occurrences once per watermark crossing, leaving new evidence intact. */
export function planImageOffload(
  messages: ContextMessage[], delivered: ReadonlySet<number>, force = false,
  policy = IMAGE_WINDOW,
): ImageOffloadPlan | undefined {
  let beforeBytes = 0;
  const candidates: { message: number; part: number; bytes: number }[] = [];
  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach((part, partIndex) => {
      if (part.type !== "image_url") return;
      const bytes = inlineImageBytes(part.image_url.url);
      beforeBytes += bytes;
      if (bytes && delivered.has(index) && (message.role === "user" || message.role === "tool")) candidates.push({ message: index, part: partIndex, bytes });
    });
  });
  if ((!force && beforeBytes <= policy.triggerBytes) || !candidates.length) return;
  const targetBytes = force ? Math.min(policy.targetBytes, Math.floor(beforeBytes / 2)) : policy.targetBytes;
  const selections = new Map<number, Set<number>>();
  let afterBytes = beforeBytes, imageCount = 0;
  for (const candidate of candidates) {
    if (afterBytes <= targetBytes) break;
    if (!selections.has(candidate.message)) selections.set(candidate.message, new Set());
    selections.get(candidate.message)!.add(candidate.part);
    afterBytes -= candidate.bytes;
    imageCount++;
  }
  return imageCount ? { selections, imageCount, beforeBytes, afterBytes, targetBytes } : undefined;
}
