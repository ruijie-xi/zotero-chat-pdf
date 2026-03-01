import { getPref } from "../utils/prefs";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type StreamCallback = (chunk: string, done: boolean) => void;

export async function chat(
  messages: ChatMessage[],
  onStream?: StreamCallback,
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

  while (true) {
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
        onStream!("", true);
        return fullText;
      }

      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) {
          fullText += content;
          onStream!(content, false);
        }
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
        const parsed = JSON.parse(trimmed.slice(6));
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) {
          fullText += content;
          onStream!(content, false);
        }
      } catch {
        // Skip
      }
    }
  }

  onStream?.("", true);
  return fullText;
}
