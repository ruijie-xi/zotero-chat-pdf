import type { ModelBudgetSettings } from "./model-profile";
import { buildLLMHeaders, getProviderApiBase, normalizeProvider, ProviderSettings } from "./llm-provider";
import { getPref } from "../utils/prefs";

export type VisionContent = ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "auto" } })[];
/** Transport-only messages. Persisted chat messages remain plain text. */
export type ProviderMessage = Omit<ChatMessage, "content"> & { content: string | VisionContent };

export interface MessageSource {
  /** Stable library-qualified identity exposed to agent tools and persisted in history. */
  id: string;
  key: string;
  libraryID?: number;
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
  /** Provider-specific extra content (e.g. Gemini thought_signature). Echoed back verbatim. */
  extra_content?: Record<string, unknown>;
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
  iterations?: IterationRecord[];
  usage?: TokenUsage;
  status?: "complete" | "cancelled" | "error";
  errorMessage?: string;
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
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
    [key: string]: unknown;
  };
}

/** Sum provider-reported usage without estimating fields the provider omitted. */
export function sumTokenUsage(usages: Iterable<TokenUsage | undefined>): TokenUsage | undefined {
  const total: TokenUsage = {};
  let hasUsage = false;
  for (const usage of usages) {
    if (!usage) continue;
    hasUsage = true;
    total.prompt_tokens = (total.prompt_tokens || 0) + (usage.prompt_tokens || 0);
    total.completion_tokens = (total.completion_tokens || 0) + (usage.completion_tokens || 0);
    total.total_tokens = (total.total_tokens || 0) + (
      usage.total_tokens ?? ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0))
    );
    total.prompt_cache_hit_tokens = (total.prompt_cache_hit_tokens || 0) + (usage.prompt_cache_hit_tokens || 0);
    total.prompt_cache_miss_tokens = (total.prompt_cache_miss_tokens || 0) + (usage.prompt_cache_miss_tokens || 0);
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0;
    if (reasoningTokens) {
      total.completion_tokens_details = {
        ...(total.completion_tokens_details || {}),
        reasoning_tokens: (total.completion_tokens_details?.reasoning_tokens || 0) + reasoningTokens,
      };
    }
  }
  return hasUsage ? total : undefined;
}

export interface IterationRecord {
  /** Visible narration or a partial answer before automatic continuation; the final segment is stored separately. */
  content?: string;
  reasoning?: string;
  toolCalls: {
    toolName: string;
    args: Record<string, unknown>;
    result: string;
    durationMs: number;
    contextDelivery?: "complete" | "omitted" | "paged";
    contextMessage?: string;
    resultId?: string;
  }[];
  /** Provider-reported usage for this exact model request. */
  usage?: TokenUsage;
}

export interface ChatResult {
  finishReason?: string;
  content: string;
  reasoning?: string;
  tool_calls?: ToolCall[];
  /**
   * The raw `message` object from the API response (non-streaming only).
   * Includes provider-specific fields (e.g. `reasoning_content`, `thought_signature`)
   * that must be echoed back verbatim in multi-turn tool-calling conversations.
   */
  rawMessage?: Record<string, unknown>;
  /**
   * Original content as returned by the API, including any thought tags.
   * Used by agent-loop to echo back the correct content in multi-turn conversations.
   * Only set when content differs from the cleaned version (e.g. Gemini thought tags).
   */
  rawContent?: string;
  /** Message-level extra_content (e.g. Gemini's {google: {thought: true}}). */
  extra_content?: Record<string, unknown>;
  usage?: TokenUsage;
}

/** Visible segments in display order, without tool outputs or private reasoning. */
export function visibleAssistantText(content: string, iterations: IterationRecord[] = []): string {
  return [...iterations.map(iteration => iteration.content), content].filter(Boolean).join("\n\n");
}

export type StreamCallback = (chunk: string, done: boolean) => void;
export type ThinkingCallback = (chunk: string, done: boolean) => void;

export type ThinkingMode = "default" | "enabled" | "disabled";
export type ThinkEffort = "default" | "high" | "max";

export interface LLMSettings extends ModelBudgetSettings, ProviderSettings {
  apiBase: string;
  apiKey: string;
  model: string;
  thinkingMode: ThinkingMode;
  thinkEffort: ThinkEffort;
}

export interface ChatCompletionBodyOptions {
  maxTokens?: number;
  stream: boolean;
  tools?: Tool[];
  includeUsage?: boolean;
  includeThinkingParams?: boolean;
}

const DEFAULT_API_BASE = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-flash";

export function normalizeThinkingMode(value: unknown): ThinkingMode {
  return value === "enabled" || value === "disabled" ? value : "default";
}

export function normalizeThinkEffort(value: unknown): ThinkEffort {
  return value === "high" || value === "max" ? value : "default";
}

export function getChatCompletionUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/, "")}/chat/completions`;
}

export function getLLMSettings(): LLMSettings {
  const provider = normalizeProvider(getPref("llmProvider"));
  return {
    provider,
    contextWindowTokens: Number(getPref("contextWindowTokens")) || undefined,
    inputTokenLimit: Number(getPref("inputTokenLimit")) || undefined,
    maxOutputTokens: Number(getPref("maxOutputTokens")) || undefined,
    requestedOutputTokens: Number(getPref("requestedOutputTokens")) || undefined,
    imageTokenReserve: Number(getPref("imageTokenReserve")) || undefined,
    tokenizerMode: String(getPref("tokenizerMode") || "auto"),
    apiBase: getProviderApiBase({ provider, apiBase: (getPref("llmApiBase") as string) || DEFAULT_API_BASE }),
    apiKey: (getPref("llmApiKey") as string) || "",
    model: (getPref("llmModel") as string) || DEFAULT_MODEL,
    thinkingMode: normalizeThinkingMode(getPref("llmThinkingMode")),
    thinkEffort: normalizeThinkEffort(getPref("llmThinkEffort")),
  };
}

export function applyThinkingSettings(
  body: Record<string, unknown>,
  settings: Pick<LLMSettings, "thinkingMode" | "thinkEffort">,
): void {
  const thinkingMode = normalizeThinkingMode(settings.thinkingMode);
  const thinkEffort = normalizeThinkEffort(settings.thinkEffort);

  if (thinkingMode !== "default") {
    body.thinking = { type: thinkingMode };
  }

  if (thinkEffort !== "default" && thinkingMode !== "disabled") {
    body.reasoning_effort = thinkEffort;
    if (thinkingMode === "default") {
      body.thinking = { type: "enabled" };
    }
  }
}

export function buildChatCompletionBody(
  settings: Pick<LLMSettings, "model" | "thinkingMode" | "thinkEffort">,
  messages: ProviderMessage[],
  options: ChatCompletionBodyOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages: messages.map(message => {
      const { resultId: _resultId, ...providerMessage } = message as ProviderMessage & { resultId?: string };
      return providerMessage;
    }),
    stream: options.stream,
  };

  if (options.tools?.length) body.tools = options.tools;
  if (options.maxTokens) body.max_tokens = options.maxTokens;
  if (options.stream && options.includeUsage !== false) {
    body.stream_options = { include_usage: true };
  }
  if (options.includeThinkingParams !== false) {
    applyThinkingSettings(body, settings);
  }

  return body;
}

/** Detect Gemini API endpoints to enable provider-specific features. */
function isGeminiApi(url: string): boolean {
  return /generativelanguage\.googleapis\.com/i.test(url);
}

// ---------------------------------------------------------------------------
// Gemini <thought> tag streaming parser
// ---------------------------------------------------------------------------

/**
 * Streaming parser for Gemini's `<thought>...</thought>` tags embedded in content.
 * Separates thinking from actual content and routes to appropriate callbacks.
 * Handles tag boundaries split across multiple SSE chunks.
 */
function createThoughtTagFilter(
  onThinking: ((text: string) => void) | undefined,
  onContent: ((text: string) => void) | undefined,
) {
  let insideThought = false;
  // Buffer for potential partial tags at chunk boundaries
  let tagBuf = "";

  const OPEN_TAG = "<thought>";
  const CLOSE_TAG = "</thought>";

  function emit(text: string) {
    if (!text) return;
    if (insideThought) {
      onThinking?.(text);
    } else {
      onContent?.(text);
    }
  }

  return {
    /** Process a content chunk. May be called many times. */
    push(chunk: string) {
      let src = tagBuf + chunk;
      tagBuf = "";

      while (src.length > 0) {
        const tag = insideThought ? CLOSE_TAG : OPEN_TAG;
        const idx = src.indexOf(tag);

        if (idx >= 0) {
          // Emit text before the tag
          emit(src.slice(0, idx));
          if (insideThought) {
            // Closing thought — switch back to content mode
            insideThought = false;
          } else {
            // Opening thought — switch to thought mode
            insideThought = true;
          }
          src = src.slice(idx + tag.length);
        } else {
          // No complete tag found — check if src ends with a partial tag match
          const candidate = insideThought ? CLOSE_TAG : OPEN_TAG;
          let partialLen = 0;
          for (let i = 1; i < candidate.length && i <= src.length; i++) {
            if (src.endsWith(candidate.slice(0, i))) {
              partialLen = i;
            }
          }

          if (partialLen > 0) {
            // Hold back the potential partial tag
            emit(src.slice(0, src.length - partialLen));
            tagBuf = src.slice(src.length - partialLen);
          } else {
            emit(src);
          }
          break;
        }
      }
    },

    /** Flush any remaining buffered content. Call when stream ends. */
    flush() {
      if (tagBuf) {
        emit(tagBuf);
        tagBuf = "";
      }
    },

    get isInsideThought() { return insideThought; },
  };
}

/**
 * Extract `<thought>` content from a non-streaming Gemini response.
 * Returns [cleanContent, reasoning].
 */
function extractGeminiThought(content: string): [string, string] {
  const match = content.match(/^<thought>([\s\S]*?)<\/thought>([\s\S]*)$/);
  if (match) {
    return [match[2].trimStart(), match[1]];
  }
  return [content, ""];
}


// ---------------------------------------------------------------------------
// chatWithTools() — LLM call with tool/function calling support
// ---------------------------------------------------------------------------

export class ProviderContextError extends Error {
  constructor(message: string) { super(message); this.name = "ProviderContextError"; }
}

export async function chatWithTools(
  messages: ProviderMessage[],
  tools?: Tool[],
  onStream?: StreamCallback,
  onThinking?: ThinkingCallback,
  signal?: AbortSignal,
  /** Use non-streaming mode. Returns rawMessage for provider-specific field preservation. */
  nonStreaming?: boolean,
  requestOptions?: { maxTokens?: number; settings?: LLMSettings },
): Promise<ChatResult> {
  const settings = requestOptions?.settings || getLLMSettings();

  if (!settings.apiKey) {
    throw new Error("LLM API key not configured. Set it in ChatPDF preferences.");
  }

  const url = getChatCompletionUrl(getProviderApiBase(settings));
  const streaming = !nonStreaming;
  const gemini = isGeminiApi(url);

  const body = buildChatCompletionBody(settings, messages, {
    stream: streaming,
    tools,
    includeUsage: true,
    includeThinkingParams: !gemini,
    maxTokens: requestOptions?.maxTokens,
  });
  if (gemini) {
    body.extra_body = { google: { thinking_config: { include_thoughts: true } } };
  }

  Zotero.debug(`[ChatPDF] chatWithTools: ${messages.length} messages, ${tools?.length ?? 0} tools, stream=${streaming}, thinking=${settings.thinkingMode}, effort=${settings.thinkEffort}`);

  const res = await fetch(url, {
    method: "POST",
    headers: buildLLMHeaders(settings),
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    if ((res.status === 400 || res.status === 413) && /context_length_exceeded|maximum context length|context window|too many tokens|prompt is too long|exceed.{0,40}context/i.test(text)) {
      throw new ProviderContextError(`Provider context limit: ${text}`);
    }
    const imageHint = messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === "image_url"))
      ? " This request includes images. Check that the selected model and endpoint support vision and OpenAI-compatible image_url inputs."
      : "";
    throw new Error(`LLM API error (${res.status}): ${text}${imageHint}`);
  }

  // ---- Non-streaming path ----
  if (!streaming) {
    const data = await res.json() as any;
    const msg = data.choices?.[0]?.message;
    if (!msg) {
      return { content: "" };
    }

    const content: string = msg.content || "";
    const result: ChatResult = {
      content,
      rawMessage: msg,
      finishReason: data.choices?.[0]?.finish_reason,
    };

    // Detect thinking: dedicated fields first (DeepSeek, etc.)
    if (msg.reasoning_content) result.reasoning = msg.reasoning_content;
    else if (msg.reasoning) result.reasoning = msg.reasoning;
    else if (msg.thought) result.reasoning = msg.thought;

    // Gemini: extract <thought> tags from content
    if (gemini && content) {
      const [clean, thinking] = extractGeminiThought(content);
      if (thinking) {
        result.rawContent = content;
        result.content = clean;
        result.reasoning = thinking;
      }
    }

    // Preserve message-level extra_content (Gemini thought flag)
    if (msg.extra_content) result.extra_content = msg.extra_content;

    if (data.usage) result.usage = data.usage;

    if (msg.tool_calls?.length) {
      result.tool_calls = msg.tool_calls.map((tc: any) => {
        const mapped: ToolCall = {
          id: tc.id || "",
          type: "function" as const,
          function: {
            name: tc.function?.name || "",
            arguments: tc.function?.arguments || "{}",
          },
        };
        if (tc.extra_content) mapped.extra_content = tc.extra_content;
        return mapped;
      });
      Zotero.debug(`[ChatPDF] chatWithTools: non-streaming tool_calls: ${JSON.stringify(result.tool_calls!.map(tc => ({ name: tc.function.name, argsLen: tc.function.arguments.length })))}`);
    }
    return result;
  }

  // ---- Streaming path ----
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let fullRawContent = "";    // Original content including thought tags (for Gemini echo-back)
  let fullReasoning = "";
  let thinkingDone = false;
  let messageExtraContent: Record<string, unknown> | undefined;

  // Accumulate tool call fragments by index
  const toolCallMap = new Map<number, { id: string; name: string; argFragments: string[]; extra_content?: Record<string, unknown> }>();
  let streamUsage2: TokenUsage | undefined;
  let finishReason: string | undefined;

  // Gemini: parse <thought> tags from content
  const thoughtFilter = gemini
    ? createThoughtTagFilter(
        (text) => {
          fullReasoning += text;
          if (onThinking) onThinking(text, false);
        },
        (text) => {
          fullText += text;
          if (onStream) onStream(text, false);
        },
      )
    : null;

  function processChunk(parsed: any) {
    if (parsed.usage) streamUsage2 = parsed.usage;
    if (parsed.choices?.[0]?.finish_reason) finishReason = parsed.choices[0].finish_reason;

    const delta = parsed.choices?.[0]?.delta;
    if (!delta) return;

    // Capture message-level extra_content (Gemini thought flag)
    if (delta.extra_content) messageExtraContent = delta.extra_content;

    // --- Thinking via dedicated fields (DeepSeek, OpenRouter, etc.) ---
    const reasoning = delta.reasoning_content || delta.reasoning;
    if (reasoning) {
      fullReasoning += reasoning;
      if (onThinking) onThinking(reasoning, false);
    }

    const content = delta.content;
    if (content) {
      fullRawContent += content;

      if (thoughtFilter) {
        // Gemini: route through tag parser to separate <thought> from content
        thoughtFilter.push(content);
      } else {
        // Standard provider: content signals end of thinking
        if (!thinkingDone && fullReasoning && onThinking) {
          thinkingDone = true;
          onThinking("", true);
        }
        fullText += content;
        if (onStream) onStream(content, false);
      }
    }

    const toolCallDeltas = delta.tool_calls as any[] | undefined;
    if (toolCallDeltas) {
      Zotero.debug(`[ChatPDF] chatWithTools: tool_calls delta, ${toolCallDeltas.length} entries`);
      for (const tcDelta of toolCallDeltas) {
        let idx: number = tcDelta.index ?? -1;

        if (idx < 0) {
          // Gemini may omit index for parallel tool calls.
          // Use id to find existing entry or assign next index.
          if (tcDelta.id) {
            let found = false;
            for (const [k, v] of toolCallMap) {
              if (v.id === tcDelta.id) { idx = k; found = true; break; }
            }
            if (!found) idx = toolCallMap.size;
          } else {
            // No id, no index — append args to last entry
            idx = Math.max(0, toolCallMap.size - 1);
          }
        }

        if (!toolCallMap.has(idx)) {
          toolCallMap.set(idx, { id: tcDelta.id || "", name: tcDelta.function?.name || "", argFragments: [] });
        }
        const tc = toolCallMap.get(idx)!;
        if (tcDelta.id) tc.id = tcDelta.id;
        if (tcDelta.function?.name) tc.name = tcDelta.function.name;
        if (tcDelta.function?.arguments) {
          tc.argFragments.push(tcDelta.function.arguments);
        }
        if (tcDelta.extra_content) tc.extra_content = tcDelta.extra_content;
      }
    }
  }

  function buildResult(): ChatResult {
    const result: ChatResult = { content: fullText, finishReason };
    if (fullReasoning) result.reasoning = fullReasoning;
    // rawContent only when it differs (Gemini thought tags present)
    if (gemini && fullRawContent && fullRawContent !== fullText) {
      result.rawContent = fullRawContent;
    }
    if (messageExtraContent) result.extra_content = messageExtraContent;
    if (streamUsage2) result.usage = streamUsage2;
    if (toolCallMap.size > 0) {
      result.tool_calls = Array.from(toolCallMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => {
          const mapped: ToolCall = {
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.argFragments.join("") },
          };
          if (tc.extra_content) mapped.extra_content = tc.extra_content;
          return mapped;
        });
      Zotero.debug(`[ChatPDF] chatWithTools: final tool_calls: ${JSON.stringify(result.tool_calls.map(tc => ({ name: tc.function.name, argsLen: tc.function.arguments.length })))}`);
    }
    return result;
  }

  while (true) {
    if (signal?.aborted) break;
    const { done, value } = await (reader as any).read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;

      const data = trimmed.slice(6);
      if (data === "[DONE]") {
        thoughtFilter?.flush();
        if (!thinkingDone && fullReasoning && onThinking) {
          onThinking("", true);
        }
        if (onStream) onStream("", true);
        return buildResult();
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

  thoughtFilter?.flush();
  if (!thinkingDone && fullReasoning && onThinking) {
    onThinking("", true);
  }
  if (onStream) onStream("", true);
  return buildResult();
}
