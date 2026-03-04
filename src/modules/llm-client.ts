import { getPref } from "../utils/prefs";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type StreamCallback = (chunk: string, done: boolean) => void;

/** Callback for reasoning/thinking tokens (e.g. DeepSeek R1). */
export type ThinkingCallback = (chunk: string, done: boolean) => void;

export async function chat(
  messages: ChatMessage[],
  onStream?: StreamCallback,
  onThinking?: ThinkingCallback,
  signal?: AbortSignal,
): Promise<string> {
  const apiBase = getPref("llmApiBase") || "https://api.deepseek.com/v1";
  const apiKey = getPref("llmApiKey");
  const model = getPref("llmModel") || "deepseek-chat";

  if (!apiKey) {
    throw new Error("LLM API key not configured. Set it in ChatPDF preferences.");
  }

  const url = `${apiBase.replace(/\/+$/, "")}/chat/completions`;
  const streaming = !!onStream;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: streaming,
    }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM API error (${res.status}): ${text}`);
  }

  if (!streaming) {
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }

  // SSE streaming
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";
  let thinkingDone = false;

  function processChunk(parsed: any) {
    const delta = parsed.choices?.[0]?.delta;
    if (!delta) return;

    // Reasoning/thinking content (DeepSeek R1, QwQ, etc.)
    const reasoning = delta.reasoning_content;
    if (reasoning && onThinking) {
      onThinking(reasoning, false);
    }

    // Regular content
    const content = delta.content;
    if (content) {
      // If we were receiving thinking and now get content, signal thinking done
      if (!thinkingDone && onThinking) {
        thinkingDone = true;
        onThinking("", true);
      }
      fullText += content;
      onStream!(content, false);
    }
  }

  while (true) {
    if (signal?.aborted) break;
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // Keep the last potentially incomplete line in the buffer
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;

      const data = trimmed.slice(6);
      if (data === "[DONE]") {
        if (!thinkingDone && onThinking) {
          onThinking("", true);
        }
        onStream!("", true);
        return fullText;
      }

      try {
        processChunk(JSON.parse(data));
      } catch {
        // Skip malformed JSON lines
      }
    }
  }

  // Handle any remaining buffer
  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith("data: ") && trimmed.slice(6) !== "[DONE]") {
      try {
        processChunk(JSON.parse(trimmed.slice(6)));
      } catch {
        // Skip
      }
    }
  }

  if (!thinkingDone && onThinking) {
    onThinking("", true);
  }
  onStream?.("", true);
  return fullText;
}
