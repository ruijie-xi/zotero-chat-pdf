import { describe, expect, it, vi } from "vitest";
import { readVisionResponse, VISION_MAX_RESPONSE_BYTES } from "../src/modules/vision-response";

const packet = (content: string, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason }] })}\r\n\r\n`;
function stream(text: string, size = 1): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += size) controller.enqueue(bytes.slice(offset, offset + size));
    controller.close();
  } }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}
describe("vision response transport", () => {
  it("handles split UTF-8/SSE frames, final usage, and ignores reasoning", async () => {
    const onContent = vi.fn(), onUsage = vi.fn();
    const response = stream(': heartbeat\n\n' + 'data: {"choices":[{"index":0,"delta":{"reasoning_content":"PRIVATE"}}]}\n\n'
      + packet("<!-- chatpdf-page:1 -->\n中文 Ω") + packet(" body", "stop")
      + 'data: {"choices":[],"usage":{"prompt_tokens":23,"completion_tokens":9}}\n\n' + 'data: [DONE]');
    const result = await readVisionResponse(response, new AbortController().signal, onContent, onUsage);
    expect(result.content).toBe("<!-- chatpdf-page:1 -->\n中文 Ω body");
    expect(onContent).toHaveBeenLastCalledWith(result.content);
    expect(result.usage).toMatchObject({ prompt_tokens: 23, completion_tokens: 9 });
    expect(onUsage).toHaveBeenCalledTimes(1);
  });
  it("accepts a same-response JSON reply and does not issue another request", async () => {
    const response = new Response(JSON.stringify({ choices: [{ message: { content: "body" }, finish_reason: "stop" }] }));
    expect((await readVisionResponse(response, new AbortController().signal)).content).toBe("body");
  });
  it.each(["length", "content_filter", null])("rejects incomplete output (%s), preserving usage", async finish => {
    const usage = vi.fn();
    await expect(readVisionResponse(stream(packet("partial", finish) + 'data: {"usage":{"completion_tokens":7}}\n\n'),
      new AbortController().signal, undefined, usage)).rejects.toThrow("truncated");
    expect(usage).toHaveBeenCalledWith({ completion_tokens: 7 });
  });
  it("cancels a blocked reader promptly when the user stops", async () => {
    const cancel = vi.fn(), controller = new AbortController();
    const response = new Response(new ReadableStream({ cancel }), { headers: { "Content-Type": "text/event-stream" } });
    const result = readVisionResponse(response, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalled();
  });
  it("rejects malformed frames and oversized responses without accepting partial text", async () => {
    await expect(readVisionResponse(stream('data: INVALID\n\n'), new AbortController().signal)).rejects.toThrow("invalid JSON");
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(VISION_MAX_RESPONSE_BYTES + 1)); }, cancel }));
    await expect(readVisionResponse(response, new AbortController().signal)).rejects.toThrow("8 MiB");
    expect(cancel).toHaveBeenCalled();
  });
});
