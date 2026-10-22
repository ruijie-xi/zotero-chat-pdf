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

  it.each([400, 401, 403, 404, 415, 422])("does not replay HTTP %i rejections", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Provider rejection", { status })));
    await expect(request()).rejects.toThrow(`LLM API error (${status})`);
    expect(fetch).toHaveBeenCalledOnce();
    expect(logLLMTransportFailure).not.toHaveBeenCalled();
  });

  it("classifies HTTP 413 once and logs exact body/image sizes without contents or credentials", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<h1>413 Request Entity Too Large</h1>", { status: 413 })));
    const content = [{ type: "text" as const, text: "Inspect 公式" },
      { type: "image_url" as const, image_url: { url: "data:image/jpeg;base64,/9j/2Q==", detail: "high" as const } },
      { type: "image_url" as const, image_url: { url: "https://example.com/page.jpg" } }];
    const error = await chatWithTools([{ role: "user", content }], [], undefined, undefined, undefined, false, { settings }).catch(error => error);
    const requestBytes = new TextEncoder().encode(vi.mocked(fetch).mock.calls[0][1]!.body as string).byteLength;
    expect(error).toMatchObject({ name: "ProviderRequestSizeError", status: 413, requestBytes, imageCount: 2, inlineImageBytes: 4 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(logLLMTransportFailure).toHaveBeenCalledWith({ endpoint: "opencode.ai", model: settings.model, phase: "response", attempt: 1,
      receivedData: false, retry: false, status: 413, requestBytes, imageCount: 2, inlineImageBytes: 4 });
    expect(JSON.stringify(vi.mocked(logLLMTransportFailure).mock.calls)).not.toMatch(/secret-test-key|公式|base64|example.com/);
  });

  it.each([408, 429, 500, 502, 503, 504])("recovers HTTP %i without changing the request or conversation", async status => {
    const body = JSON.stringify({ error: { type: "server_error", message: "Upstream request failed: Endpoint is unavailable." } });
    const fetch = vi.fn().mockResolvedValueOnce(new Response(body, { status })).mockResolvedValueOnce(success());
    vi.stubGlobal("fetch", fetch);
    const pending = request();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).content).toBe("OK");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]).toEqual(fetch.mock.calls[0]);
    expect(logLLMTransportFailure).toHaveBeenCalledWith(expect.objectContaining({ status, attempt: 1, receivedData: false, retry: true, delayMs: 1000 }));
  });

  it("bounds repeated HTTP failures and retains the original provider error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Endpoint is unavailable", { status: 429 })));
    const pending = request().catch(error => error);
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pending).message).toContain("LLM API error (429): Endpoint is unavailable");
    expect((await pending).message).toContain("after 3 attempts");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(logLLMTransportFailure).toHaveBeenLastCalledWith(expect.objectContaining({ status: 429, attempt: 3, retry: false }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["3", "date"])("honors Retry-After %s", async header => {
    vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
    const retryAfter = header === "date" ? "Wed, 21 Oct 2026 00:00:03 GMT" : header;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("Busy", { status: 503, headers: { "Retry-After": retryAfter } })).mockResolvedValueOnce(success()));
    const pending = request();
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).content).toBe("OK");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not shorten a provider wait beyond the automatic retry budget", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Busy", { status: 429, headers: { "Retry-After": "90" } })));
    await expect(request()).rejects.toThrow("wait of 90 seconds");
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["invalid", "-1", "0"])("uses bounded backoff for Retry-After %s", async header => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("Busy", { status: 429, headers: { "Retry-After": header } })).mockResolvedValueOnce(success()));
    const pending = request();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).content).toBe("OK");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["insufficient_quota", "billing_hard_limit_reached", "usage_limit_exceeded"])("does not retry explicit %s errors", async code => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code, message: "Account limit reached" } }), { status: 429 })));
    await expect(request()).rejects.toThrow(code);
    expect(fetch).toHaveBeenCalledOnce();
    expect(logLLMTransportFailure).not.toHaveBeenCalled();
  });

  it("cancels an HTTP retry wait without sending again", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Busy", { status: 503 })));
    const pending = request(controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect((await pending).name).toBe("AbortError");
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains image inputs and avoids a misleading vision hint on transient failures", async () => {
    const messages = [{ role: "user" as const, content: [{ type: "image_url" as const, image_url: { url: "data:image/png;base64,dGVzdA==", detail: "high" as const } }] }];
    const fetch = vi.fn().mockResolvedValueOnce(new Response("Endpoint is unavailable", { status: 429 })).mockResolvedValueOnce(success());
    vi.stubGlobal("fetch", fetch);
    const pending = chatWithTools(messages, [], undefined, undefined, undefined, false, { settings });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).content).toBe("OK");
    expect(fetch.mock.calls[1]).toEqual(fetch.mock.calls[0]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Busy", { status: 429, headers: { "Retry-After": "90" } })));
    const error = await chatWithTools(messages, [], undefined, undefined, undefined, false, { settings }).catch(error => error);
    expect(error.message).not.toContain("support vision");
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
