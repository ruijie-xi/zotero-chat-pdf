/** Use declared input capabilities, never infer vision support from a model name. */
export function modelVisionSupport(metadata?: Record<string, any>, override?: string): boolean | undefined {
  if (override === "enabled") return true;
  if (override === "disabled") return false;
  for (const value of [metadata?.supports_vision, metadata?.vision, metadata?.capabilities?.vision]) {
    if (typeof value === "boolean") return value;
  }
  const modalities = metadata?.input_modalities ?? metadata?.architecture?.input_modalities ?? metadata?.modalities?.input;
  if (Array.isArray(modalities) && modalities.every(value => typeof value === "string")) {
    return modalities.some(value => value.toLowerCase() === "image");
  }
  return undefined;
}

export function requireVisionModel(supported?: boolean): void {
  if (supported === true) return;
  throw new Error(supported === false
    ? "ChatPDF requires a vision-capable chat model that accepts image_url inputs. Select a vision model in Preferences."
    : "The endpoint did not declare image-input support. Select a vision-capable model, then set Vision inputs to Confirmed in its profile if the endpoint omits this metadata.");
}
