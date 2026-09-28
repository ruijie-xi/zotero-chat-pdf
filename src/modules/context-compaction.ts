import { AgentContext, COMPACT_PROMPT, ContextMessage, contextSize } from "./agent-context";
import { chatWithTools, ProviderContextError, Tool, TokenUsage, sumTokenUsage, LLMSettings } from "./llm-client";

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) { const error = new Error("Compaction cancelled."); error.name = "AbortError"; throw error; }
}

/** Never split an assistant's tool calls from their results. */
export function exchangeGroups(messages: ContextMessage[]): ContextMessage[][] {
  const groups: ContextMessage[][] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      const group = groups.at(-1);
      if (!group?.[0].tool_calls?.some(call => call.id === message.tool_call_id)) throw new Error("Unpaired tool result in working context.");
      group.push(message);
    } else groups.push([message]);
  }
  for (const group of groups) {
    if (group[0].tool_calls?.some(call => !group.some(message => message.tool_call_id === call.id))) throw new Error("Pending tool calls cannot be compacted.");
  }
  return groups;
}

export async function compactAgentContext(
  context: AgentContext, tools: Tool[], latestUser: ContextMessage, limit: number,
  onUsage: (usage?: TokenUsage) => void, signal?: AbortSignal, recoverProviderError = false,
  settings?: LLMSettings,
): Promise<void> {
  checkAbort(signal);
  const original = context.messages;
  exchangeGroups(original);
  const target = Math.min(12_000, Math.max(1_000, Math.floor(limit * 0.12)));
  let compactUsage: TokenUsage | undefined;
  const references = original.filter(message => message.resultId).map(message => `${message.tool_call_id}: ${message.resultId}`).join("; ");
  const instruction: ContextMessage = { role: "user", content: COMPACT_PROMPT + `\nAim for no more than ${target} characters.` +
    (references ? `\nOriginal result references for the tool responses above: ${references}` : "") };
  const summarize = async (messages: ContextMessage[]): Promise<string> => {
    // Reasoning consumes the same output allowance as the visible checkpoint.
    // Retry the identical prompt with more output room; never replay tools or
    // append a truncated draft to the working context. The cacheable prefix,
    // model, thinking settings and tool definitions stay unchanged.
    const request = [...messages, instruction];
    for (const maxTokens of [8_192, 16_384, 32_768]) {
      checkAbort(signal);
      const result = await chatWithTools(request, tools, undefined, undefined, signal, false, { maxTokens, settings });
      onUsage(result.usage);
      compactUsage = sumTokenUsage([compactUsage, result.usage]);
      (context.data.requests ||= []).push({ kind: "compact", generation: context.data.checkpoints.length, usage: result.usage,
        inputChars: contextSize(request, tools), finishReason: result.finishReason, outputLimit: maxTokens });
      checkAbort(signal);
      if (result.finishReason === "length") continue;
      if (!result.tool_calls?.length && result.content.trim()) return result.content.trim();
      throw new Error("Automatic compaction did not return a complete text checkpoint. History and stored results were preserved; retry to continue.");
    }
    throw new Error("Automatic compaction exhausted its output allowance after three attempts (up to 32768 tokens, including reasoning). History and stored results were preserved; retry to continue.");
  };
  let summary: string;
  try {
    if (recoverProviderError || contextSize([...original, instruction], tools) > limit) throw new ProviderContextError("Summarize complete exchanges in smaller groups.");
    summary = await summarize(original);
  } catch (error) {
    if (!(error instanceof ProviderContextError)) throw error;
    const groups = exchangeGroups(original.slice(1));
    let notes = "";
    let pending: ContextMessage[] = [];
    const base = () => [original[0], ...(notes ? [{ role: "assistant" as const, content: notes }] : [])];
    const flush = async () => {
      if (!pending.length) return;
      notes = await summarize([...base(), ...pending]);
      if (notes.length > limit * 0.3) throw new Error("Compaction failed to reduce context. Original history was preserved.");
      pending = [];
    };
    for (const group of groups) {
      if (contextSize([...base(), ...pending, ...group, instruction], tools) > limit * 0.55) await flush();
      if (contextSize([...base(), ...group, instruction], tools) > limit * 0.65) throw new Error("A single exchange exceeds the provider recovery window. Original history is preserved; increase the configured context size or change the model.", { cause: error });
      pending.push(...group);
    }
    await flush();
    summary = notes;
  }
  const before = contextSize(original, tools);
  const after = contextSize([original[0], { role: "assistant", content: context.checkpointContent(summary) }, latestUser], tools);
  if (!summary || after >= before * 0.85 || after > limit * 0.55) throw new Error("Automatic compaction did not free enough space. Original history and results were preserved; retry to continue.");
  checkAbort(signal);
  context.compact(summary, latestUser, compactUsage);
  Zotero.debug(`[ChatPDF] compact: beforeChars=${before}, afterChars=${after}, generation=${context.data.checkpoints.length}`);
}
