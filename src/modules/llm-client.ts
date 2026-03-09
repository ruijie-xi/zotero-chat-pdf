import { getPref } from "../utils/prefs";

export interface MessageSource {
  key: string;
  title: string;
  parentKey?: string;
}

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: ToolCallFunction;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  timestamp?: number;
  sources?: MessageSource[];
  modelLabel?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  toolHistory?: { toolName: string; args: Record<string, unknown>; result: string; durationMs: number }[];
  iterations?: IterationRecord[];
  usage?: TokenUsage;
}

export interface ToolFunction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Tool {
  type: "function";
  function: ToolFunction;
}

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface IterationRecord {
  reasoning?: string;
  toolCalls: { toolName: string; args: Record<string, unknown>; result: string; durationMs: number }[];
}

export interface ChatResult {
  content: string;
  reasoning?: string;
  tool_calls?: ToolCall[];
  /**
   * The raw `message` object from the API response (non-streaming only).
   * Includes provider-specific fields (e.g. `reasoning_content`, `thought_signature`)
   * that must be echoed back verbatim in multi-turn tool-calling conversations.
   */
  rawMessage?: Record<string, unknown>;
  usage?: TokenUsage;
}

export type StreamCallback = (chunk: string, done: boolean) => void;
export type ThinkingCallback = (chunk: string, done: boolean) => void;

export async function chat(
  messages: ChatMessage[],
  onStream?: StreamCallback,
  onThinking?: ThinkingCallback,
  signal?: AbortSignal,
  onUsage?: (usage: TokenUsage) => void,
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
    if (data.usage && onUsage) onUsage(data.usage);
    return data.choices?.[0]?.message?.content || "";
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";
  let thinkingDone = false;
  let streamUsage: TokenUsage | undefined;

  function processChunk(parsed: any) {
    // Capture usage from chunks (some providers include it in the last chunk)
    if (parsed.usage) streamUsage = parsed.usage;

    const delta = parsed.choices?.[0]?.delta;
    if (!delta) return;

    // Detect thinking/reasoning from multiple possible field names (DeepSeek, Gemini, etc.)
    const reasoning = delta.reasoning_content || delta.reasoning || delta.thought;
    if (reasoning && onThinking) {
      onThinking(reasoning, false);
    }

    const content = delta.content;
    if (content) {
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
        if (streamUsage && onUsage) onUsage(streamUsage);
        return fullText;
      }

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      processChunk(parsed);
    }
  }

  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith("data: ") && trimmed.slice(6) !== "[DONE]") {
      try {
        processChunk(JSON.parse(trimmed.slice(6)));
      } catch {}
    }
  }

  if (!thinkingDone && onThinking) {
    onThinking("", true);
  }
  onStream?.("", true);
  if (streamUsage && onUsage) onUsage(streamUsage);
  return fullText;
}

export async function chatWithTools(
  messages: ChatMessage[],
  tools?: Tool[],
  onStream?: StreamCallback,
  onThinking?: ThinkingCallback,
  signal?: AbortSignal,
  /** Use non-streaming mode. Returns rawMessage for provider-specific field preservation. */
  nonStreaming?: boolean,
): Promise<ChatResult> {
  const apiBase = getPref("llmApiBase") || "https://api.deepseek.com/v1";
  const apiKey = getPref("llmApiKey");
  const model = getPref("llmModel") || "deepseek-chat";

  if (!apiKey) {
    throw new Error("LLM API key not configured. Set it in ChatPDF preferences.");
  }

  const url = `${apiBase.replace(/\/+$/, "")}/chat/completions`;
  const streaming = !nonStreaming;

  const body: Record<string, unknown> = { model, messages, stream: streaming };
  if (tools && tools.length > 0) body.tools = tools;

  const totalChars = messages.reduce((s, m) => s + (typeof m.content === "string" ? m.content.length : 0), 0);
  Zotero.debug(`[ChatPDF] chatWithTools: ${messages.length} messages, ${tools?.length ?? 0} tools, ~${totalChars} chars, stream=${streaming}`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM API error (${res.status}): ${text}`);
  }

  // ---- Non-streaming path ----
  if (!streaming) {
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) {
      return { content: "" };
    }
    const result: ChatResult = {
      content: msg.content || "",
      rawMessage: msg,
    };
    // Detect thinking from multiple possible field names
    if (msg.reasoning_content) result.reasoning = msg.reasoning_content;
    else if (msg.reasoning) result.reasoning = msg.reasoning;
    else if (msg.thought) result.reasoning = msg.thought;
    if (data.usage) result.usage = data.usage;
    if (msg.tool_calls?.length) {
      result.tool_calls = msg.tool_calls.map((tc: any) => ({
        id: tc.id || "",
        type: "function" as const,
        function: {
          name: tc.function?.name || "",
          arguments: tc.function?.arguments || "{}",
        },
      }));
      Zotero.debug(`[ChatPDF] chatWithTools: non-streaming tool_calls: ${JSON.stringify(result.tool_calls!.map(tc => ({ name: tc.function.name, argsLen: tc.function.arguments.length })))}`);
    }
    return result;
  }

  // ---- Streaming path ----
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let fullReasoning = "";
  let thinkingDone = false;

  // Accumulate tool call fragments by index
  const toolCallMap = new Map<number, { id: string; name: string; argFragments: string[] }>();
  let streamUsage2: TokenUsage | undefined;

  function processChunk(parsed: any) {
    if (parsed.usage) streamUsage2 = parsed.usage;

    const delta = parsed.choices?.[0]?.delta;
    if (!delta) return;

    // Detect thinking from multiple possible field names (DeepSeek, Gemini, etc.)
    const reasoning = delta.reasoning_content || delta.reasoning || delta.thought;
    if (reasoning) {
      fullReasoning += reasoning;
      if (onThinking) onThinking(reasoning, false);
    }

    const content = delta.content;
    if (content) {
      if (!thinkingDone && fullReasoning && onThinking) {
        thinkingDone = true;
        onThinking("", true);
      }
      fullText += content;
      if (onStream) onStream(content, false);
    }

    const toolCallDeltas = delta.tool_calls as any[] | undefined;
    if (toolCallDeltas) {
      Zotero.debug(`[ChatPDF] chatWithTools: tool_calls delta, ${toolCallDeltas.length} entries`);
      for (const tcDelta of toolCallDeltas) {
        const idx: number = tcDelta.index ?? 0;
        if (!toolCallMap.has(idx)) {
          toolCallMap.set(idx, { id: tcDelta.id || "", name: tcDelta.function?.name || "", argFragments: [] });
        }
        const tc = toolCallMap.get(idx)!;
        if (tcDelta.id) tc.id = tcDelta.id;
        if (tcDelta.function?.name) tc.name = tcDelta.function.name;
        if (tcDelta.function?.arguments) {
          tc.argFragments.push(tcDelta.function.arguments);
        }
      }
    }
  }

  while (true) {
    if (signal?.aborted) break;
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;

      const data = trimmed.slice(6);
      if (data === "[DONE]") {
        if (!thinkingDone && fullReasoning && onThinking) {
          onThinking("", true);
        }
        if (onStream) onStream("", true);
        const result: ChatResult = { content: fullText };
        if (fullReasoning) result.reasoning = fullReasoning;
        if (streamUsage2) result.usage = streamUsage2;
        if (toolCallMap.size > 0) {
          result.tool_calls = Array.from(toolCallMap.entries())
            .sort(([a], [b]) => a - b)
            .map(([, tc]) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.argFragments.join("") },
            }));
          Zotero.debug(`[ChatPDF] chatWithTools: final tool_calls: ${JSON.stringify(result.tool_calls.map(tc => ({ name: tc.function.name, argsLen: tc.function.arguments.length })))}`);
        }
        return result;
      }

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      processChunk(parsed);
    }
  }

  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith("data: ") && trimmed.slice(6) !== "[DONE]") {
      try {
        processChunk(JSON.parse(trimmed.slice(6)));
      } catch {}
    }
  }

  if (!thinkingDone && fullReasoning && onThinking) {
    onThinking("", true);
  }
  if (onStream) onStream("", true);

  const result: ChatResult = { content: fullText };
  if (fullReasoning) result.reasoning = fullReasoning;
  if (streamUsage2) result.usage = streamUsage2;
  if (toolCallMap.size > 0) {
    result.tool_calls = Array.from(toolCallMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.argFragments.join("") },
      }));
  }
  return result;
}
