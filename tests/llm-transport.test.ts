import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/modules/debug-log", () => ({ logLLMTransportFailure: vi.fn(async () => {}) }));
import { chatWithTools } from "../src/modules/llm-client";
import { logLLMTransportFailure } from "../src/modules/debug-log";

const settings = {
  provider: "opencode-go" as const, apiBase: "https://opencode.ai/zen/go/v1", apiKey: "secret-test-key",
  sessionId: "same-conversation", model: "deepseek-v4.1-flash", thinkingMode: "enabled" as const, thinkEffort: "max" as const,
};
const messages = [{ role: "user" as const, content: "Find references" }];
const networkError = () => new TypeError("NetworkError when attempting to fetch resource.");
const success = () => new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
const request = (signal?: AbortSignal, onStream = vi.fn(), onThinking = vi.fn(), nonStreaming = false) =>
  chatWithTools(messages, [], onStream, onThinking, signal, nonStreaming, { settings, maxTokens: 384000 });

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("LLM transport recovery", () => {
  it("recovers a transient Firefox connection failure with the identical body and conversation headers", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(networkError()).mockResolvedValueOnce(success());
    vi.stubGlobal("fetch", fetch);
    const pending = request();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ content: "OK", finishReason: "stop" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]).toEqual(fetch.mock.calls[0]);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ max_tokens: 384000, thinking: { type: "enabled" }, reasoning_effort: "max" });
    expect(logLLMTransportFailure).toHaveBeenCalledWith({ endpoint: "opencode.ai", model: settings.model, phase: "connect", attempt: 1, receivedData: false, retry: true });
  });

  it("bounds repeated failures and reports the endpoint without exposing credentials", async () => {
    const fetch = vi.fn().mockRejectedValue(networkError());
    vi.stubGlobal("fetch", fetch);
    const pending = request().catch(error => error);
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pending).message).toContain("opencode.ai after 3 attempts");
    expect((await pending).message).not.toContain(settings.apiKey);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(logLLMTransportFailure).toHaveBeenLastCalledWith(expect.objectContaining({ attempt: 3, retry: false }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers a response-body failure before any SSE data", async () => {
    const releaseLock = vi.fn();
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, body: { getReader: () => ({ read: async () => { throw networkError(); }, cancel: vi.fn(), releaseLock }) } }).mockResolvedValueOnce(success());
    vi.stubGlobal("fetch", fetch);
    const pending = request();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).content).toBe("OK");
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(logLLMTransportFailure).toHaveBeenCalledWith(expect.objectContaining({ phase: "response", retry: true }));
  });

  it.each([
    { content: "Partial answer" },
    { reasoning_content: "Thinking" },
    { tool_calls: [{ index: 0, id: "tool-1", function: { name: "list_sources", arguments: "{" } }] },
  ])("never replays a response after receiving model data: %j", async delta => {
    let reads = 0;
    const releaseLock = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body: { getReader: () => ({
      read: async () => { if (reads++) throw networkError(); return { done: false, value: new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`) }; },
      cancel: vi.fn(), releaseLock,
    }) } })));
    const onStream = vi.fn(), onThinking = vi.fn();
    await expect(request(undefined, onStream, onThinking)).rejects.toThrow("Partial output was preserved");
    expect(fetch).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
    if (delta.content) expect(onStream).toHaveBeenCalledWith(delta.content, false);
    if (delta.reasoning_content) expect(onThinking).toHaveBeenCalledWith(delta.reasoning_content, false);
  });

  it("also recovers non-streaming connection failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }))));
    const pending = request(undefined, undefined, undefined, true);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).content).toBe("OK");
  });

  it.each([400, 401, 429, 503])("does not replay HTTP %i rejections", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Provider rejection", { status })));
    await expect(request()).rejects.toThrow(`LLM API error (${status})`);
    expect(fetch).toHaveBeenCalledOnce();
    expect(logLLMTransportFailure).not.toHaveBeenCalled();
  });

  it("does not retry an HTTP rejection whose body cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, text: async () => { throw networkError(); } })));
    await expect(request()).rejects.toThrow("interrupted");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not retry unrelated programming errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Invalid request body")));
    await expect(request()).rejects.toThrow("Invalid request body");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("cancels retry backoff promptly and makes no further request", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError()));
    const pending = request(controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect((await pending).name).toBe("AbortError");
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats cancellation during reader.read as cancellation, never successful partial output", async () => {
    const controller = new AbortController();
    const cancel = vi.fn(), releaseLock = vi.fn(), onStream = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body: { getReader: () => ({
      read: async () => { controller.abort(); return { done: true }; }, cancel, releaseLock,
    }) } })));
    await expect(request(controller.signal, onStream)).rejects.toMatchObject({ name: "AbortError" });
    expect(onStream).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });
});
