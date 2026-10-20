import { describe, expect, it, vi } from "vitest";
import { modelVisionSupport, requireVisionModel } from "../src/modules/vision-support";
import { runAgentLoop } from "../src/modules/agent-loop";
import { resolveModelCapabilities } from "../src/modules/model-capabilities";
import { ChatSession } from "../src/modules/chat-session";
import * as llm from "../src/modules/llm-client";

describe("required vision capability", () => {
  it("reads declared input capabilities without guessing from names or output modalities", () => {
    expect(modelVisionSupport({ id: "vision-awesome", output_modalities: ["image"] })).toBeUndefined();
    expect(modelVisionSupport({ input_modalities: ["text", "image"] })).toBe(true);
    expect(modelVisionSupport({ architecture: { input_modalities: ["text", "image"] } })).toBe(true);
    expect(modelVisionSupport({ modalities: { input: ["text"] } })).toBe(false);
    expect(modelVisionSupport({ capabilities: { vision: false } })).toBe(false);
    expect(modelVisionSupport({ supports_vision: true })).toBe(true);
    expect(modelVisionSupport({ input_modalities: ["text", 1] })).toBeUndefined();
  });
  it("requires an explicit confirmation when an endpoint omits capabilities", () => {
    expect(modelVisionSupport(undefined, "enabled")).toBe(true);
    expect(modelVisionSupport({ supports_vision: true }, "disabled")).toBe(false);
    expect(() => requireVisionModel()).toThrow("did not declare");
    expect(() => requireVisionModel(false)).toThrow("vision-capable");
    expect(() => requireVisionModel(true)).not.toThrow();
  });
  it.each([false, undefined])("rejects an unconfirmed model before any chat request (%s)", async supportsVision => {
    const session = new ChatSession();
    const messages = session.buildAgentMessages("Read my paper");
    vi.mocked(resolveModelCapabilities).mockResolvedValueOnce({ supportsVision } as any);
    const chat = vi.spyOn(llm, "chatWithTools");
    try {
      await expect(runAgentLoop(messages, [], session)).rejects.toThrow(/vision-capable|did not declare/);
      expect(chat).not.toHaveBeenCalled();
    } finally { chat.mockRestore(); }
  });
});
