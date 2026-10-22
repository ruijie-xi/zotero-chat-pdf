import { describe, expect, it } from "vitest";
import { modelVisionSupport, rejectsImageInput } from "../src/modules/vision-support";

describe("advisory vision metadata and explicit image rejection", () => {
  it("reads endpoint declarations without treating absent metadata as a rejection", () => {
    expect(modelVisionSupport({ id: "vision-awesome", output_modalities: ["image"] })).toBeUndefined();
    expect(modelVisionSupport({ input_modalities: ["text", "image"] })).toBe(true);
    expect(modelVisionSupport({ architecture: { input_modalities: ["text", "image"] } })).toBe(true);
    expect(modelVisionSupport({ modalities: { input: ["text"] } })).toBe(false);
    expect(modelVisionSupport({ capabilities: { vision: false } })).toBe(false);
    expect(modelVisionSupport({ supports_vision: true })).toBe(true);
    expect(modelVisionSupport({ input_modalities: ["text", 1] })).toBeUndefined();
  });

  it.each([
    "This model does not support image inputs.",
    "The endpoint cannot accept images.",
    "Model example-v4.1 does not support image inputs.",
    "Image inputs are not supported by this model.",
    "Unsupported input modality: image",
    "Unsupported content type: image_url",
    "Invalid content type. image_url is only supported by certain models.",
    "This model only accepts text input.",
  ])("recognizes an explicit rejection: %s", message => {
    expect(rejectsImageInput(400, JSON.stringify({ error: { message } }))).toBe(true);
    expect(rejectsImageInput(422, message)).toBe(true);
  });

  it.each([
    [400, "Invalid image_url"],
    [400, "Unsupported image format"],
    [400, "Image inputs are not supported at this resolution"],
    [400, "Could not decode image: corrupt base64"],
    [400, "This URL scheme is not supported for images"],
    [400, "Image is too large"],
    [413, "Images are not supported"],
    [401, "Model does not support images"],
    [403, "Model does not support images"],
    [429, "Model does not support images"],
    [500, "Model does not support images"],
    [503, "Model does not support images"],
    [400, "Invalid tool arguments"],
  ])("does not downgrade other failures (%s, %s)", (status, message) => {
    expect(rejectsImageInput(Number(status), String(message))).toBe(false);
  });

  it("reads only the actual error fields, not echoed request contents", () => {
    expect(rejectsImageInput(400, JSON.stringify({ error: { message: "Invalid parameter" }, request: { text: "images are not supported" } }))).toBe(false);
    expect(rejectsImageInput(415, JSON.stringify({ error: { code: "unsupported_image_input" } }))).toBe(true);
    expect(rejectsImageInput(401, JSON.stringify({ error: { code: "unsupported_image_input" } }))).toBe(false);
  });
});
