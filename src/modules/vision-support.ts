/** Use declared input capabilities, never infer vision support from a model name. */
export function modelVisionSupport(metadata?: Record<string, any>): boolean | undefined {
  for (const value of [metadata?.supports_vision, metadata?.vision, metadata?.capabilities?.vision]) {
    if (typeof value === "boolean") return value;
  }
  const modalities = metadata?.input_modalities ?? metadata?.architecture?.input_modalities ?? metadata?.modalities?.input;
  if (Array.isArray(modalities) && modalities.every(value => typeof value === "string")) {
    return modalities.some(value => value.toLowerCase() === "image");
  }
  return undefined;
}

export class ProviderImageInputError extends Error {
  constructor(message: string) { super(message); this.name = "ProviderImageInputError"; }
}

/** Only explicit modality rejections qualify, never authentication, size or image decoding errors. */
export function rejectsImageInput(status: number, body: string): boolean {
  if (![400, 415, 422].includes(status)) return false;
  let message = body, code = "";
  try {
    const parsed = JSON.parse(body);
    const error = parsed?.error ?? parsed;
    message = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : "";
    code = typeof error?.code === "string" ? error.code : "";
  } catch { /* Some providers return a plain error message. */ }
  if (/^(?:unsupported_image_input|image_input_not_supported|unsupported_image_modality|vision_not_supported)$/i.test(code)) return true;
  if (/format|mime|base64|decod|corrupt|dimensions|resolution|too large|size limit|download|fetch|url scheme/i.test(message)) return false;
  return /(?:model|endpoint|provider|api)\b[^\n]{0,100}\b(?:does not|doesn't|cannot|can't)\s+(?:currently\s+)?(?:support|accept|process)\b[^.!?\n]{0,50}\b(?:images?|image_url|vision|multimodal)\b/i.test(message)
    || /\b(?:image(?:_url| inputs?| content)?s?|vision|multimodal(?: inputs?)?)\b[^.!?\n]{0,60}\b(?:not supported|unsupported|not allowed|not accepted)\b/i.test(message)
    || /\b(?:unsupported|not supported)\s+(?:input\s+)?(?:modality|content type)\s*[:=]?\s*['"]?(?:image|image_url)\b/i.test(message)
    || /image_url is only supported by certain models/i.test(message)
    || /(?:only supports?|only accepts?)\s+(?:text|text-only)\s+(?:input|content|messages)/i.test(message);
}
