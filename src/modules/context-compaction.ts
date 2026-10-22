import { AgentContext, COMPACT_PROMPT, ContextMessage } from "./agent-context";
import { chatWithTools, ProviderContextError, Tool, TokenUsage, sumTokenUsage, LLMSettings } from "./llm-client";
import { ContextBudget } from "./context-budget";
import { logGenerationResult } from "./debug-log";
import { ProviderRequestSizeError } from "./llm-transport";

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

/** Keep each image with its preceding source/page label, without changing pixels. */
function splitImageGroup(group: ContextMessage[]): ContextMessage[][] {
  const [message] = group;
  if (group.length !== 1 || message.role !== "user" || !Array.isArray(message.content)) return [group];
  const parts: typeof message.content[] = [];
  let pending: typeof message.content = [];
  for (const part of message.content) {
    pending.push(part);
    if (part.type === "image_url") { parts.push(pending); pending = []; }
  }
  if (parts.length < 2) return [group];
  parts.at(-1)!.push(...pending);
  const middle = Math.ceil(parts.length / 2);
  return [parts.slice(0, middle), parts.slice(middle)].map(content => [{ ...message, content: content.flat() }]);
}

export async function compactAgentContext(
  context: AgentContext, tools: Tool[], latestUser: ContextMessage, budget: ContextBudget,
  onUsage: (usage?: TokenUsage) => void, signal?: AbortSignal, recoverProviderError = false,
  settings?: LLMSettings,
  validate?: () => void,
  requestSizeError?: ProviderRequestSizeError,
): Promise<boolean> {
  checkAbort(signal);
  const original = context.messages;
  exchangeGroups(original);
  const target = Math.max(32, Math.min(4096, Math.floor(budget.inputLimit() * 0.1)));
  let compactUsage: TokenUsage | undefined;
  let requiredOutput = budget.outputLimit();
  let sizeRecovery = !!requestSizeError;
  const references = original.filter(message => message.resultId).map(message => `${message.tool_call_id}: ${message.resultId}`).join("; ");
  const instruction: ContextMessage = { role: "user", content: COMPACT_PROMPT + `\nAim for at most ${target} tokens. Preserve essential continuation information.` +
    (references ? `\nOriginal result references: ${references}` : "") };
  const summarize = async (messages: ContextMessage[]): Promise<string> => {
    const request = [...messages, instruction];
    let previousOutput = 0;
    const initialOutput = requiredOutput;
    for (let attempt = 0; attempt < 3; attempt++) {
      checkAbort(signal);
      validate?.();
      const maxTokens = budget.outputLimit(initialOutput * 2 ** attempt);
      if (maxTokens <= previousOutput) throw new Error("Automatic compaction exhausted the configured generation limit. Original history is preserved.");
      if (!budget.fits(request, tools, maxTokens)) {
        requiredOutput = maxTokens;
        throw new ProviderContextError("Compaction needs a smaller group to reserve the complete generation allowance.");
      }
      budget.assertFits(request, tools, maxTokens);
      previousOutput = maxTokens;
      const result = await chatWithTools(request, tools, undefined, undefined, signal, false, { maxTokens, settings });
      onUsage(result.usage);
      compactUsage = sumTokenUsage([compactUsage, result.usage]);
      (context.data.requests ||= []).push({ kind: "compact", generation: context.data.checkpoints.length, usage: result.usage,
        inputTokens: budget.count(request, tools), countMethod: "local-bpe-estimate", finishReason: result.finishReason, ...budget.requestMetadata(maxTokens) });
      void logGenerationResult("compact", settings?.model || "unknown", budget.requestMetadata(maxTokens), budget.count(request, tools), result);
      budget.counter.observe(request, tools, result.usage);
      checkAbort(signal);
      if (result.finishReason === "length") continue;
      if (!result.tool_calls?.length && result.content.trim() && budget.counter.text(result.content) <= target) return result.content.trim();
      throw new Error("Automatic compaction did not return a complete checkpoint within its token target. History and stored results were preserved.");
    }
    throw new Error("Automatic compaction exhausted its output allowance after three attempts. History and stored results were preserved.");
  };
  const summarizeGroups = async (head: ContextMessage[], groups: ContextMessage[][], rejected?: ProviderRequestSizeError): Promise<string> => {
    checkAbort(signal);
    try {
      // The caller already observed this rejection; do not resend that same body.
      if (rejected) throw rejected;
      return await summarize([...head, ...groups.flat()]);
    } catch (error) {
      if (!(error instanceof ProviderRequestSizeError)) throw error;
      sizeRecovery = true;
      const parts = groups.length === 1 ? splitImageGroup(groups[0]) : groups;
      if (parts.length < 2) throw new Error("The endpoint rejected even one complete exchange or image (HTTP 413). Original history and results are preserved. Use an endpoint with a larger request limit, or explicitly request a smaller page region or lower DPI.", { cause: error });
      const middle = Math.ceil(parts.length / 2);
      const notes = await summarizeGroups(head, parts.slice(0, middle));
      return summarizeGroups([original[0], { role: "assistant", content: notes }], parts.slice(middle));
    }
  };
  let summary: string;
  try {
    if (recoverProviderError || !budget.fits([...original, instruction], tools)) throw new ProviderContextError("Summarize complete exchanges in smaller groups.");
    summary = await summarizeGroups([original[0]], exchangeGroups(original.slice(1)), requestSizeError);
  } catch (error) {
    if (!(error instanceof ProviderContextError)) throw error;
    const groups = exchangeGroups(original.slice(1));
    summary = "";
    // Preserve the full selected output reservation when partitioning input.
    for (let partition = 0; partition < 3; partition++) {
      const recoveryOutput = requiredOutput;
      let notes = "";
      let pending: ContextMessage[] = [];
      const base = () => [original[0], ...(notes ? [{ role: "assistant" as const, content: notes }] : [])];
      const fits = (messages: ContextMessage[]) => budget.fits([...messages, instruction], tools, recoveryOutput)
        && (!recoverProviderError || budget.count([...messages, instruction], tools) <= budget.inputLimit(recoveryOutput) * 0.5);
      const flush = async () => {
        if (!pending.length) return;
        notes = await summarizeGroups(base(), exchangeGroups(pending), requestSizeError);
        requestSizeError = undefined;
        pending = [];
      };
      try {
        for (const group of groups) {
          if (!fits([...base(), ...pending, ...group])) await flush();
          if (!fits([...base(), ...group])) throw new Error("A complete exchange cannot fit this model's compaction input/output token budget. Original history is preserved. Use a model with a larger window or reduce its output reservation.", { cause: error });
          pending.push(...group);
        }
        await flush();
        summary = notes;
        break;
      } catch (retryError) {
        if (!(retryError instanceof ProviderContextError) || requiredOutput <= recoveryOutput || partition === 2) throw retryError;
      }
    }
  }
  const checkpoint: ContextMessage = { role: "assistant", content: context.checkpointContent(summary) };
  const tail: ContextMessage[] = [];
  const before = budget.count(original, tools);
  const retainedLimit = Math.min(budget.inputLimit() * 0.55, before * 0.5);
  const userIndex = original.findLastIndex(message => message.role === "user" && message.content === latestUser.content);
  // Keep recent complete groups after the current user, in their original order.
  for (const group of exchangeGroups(!sizeRecovery && userIndex >= 0 ? original.slice(userIndex + 1) : []).reverse()) {
    const candidate = [...group, ...tail];
    // Signed replay may depend on the old prefix. The checkpoint retains its outcome.
    if (group.some(message => message.reasoning_content || message.extra_content || message.tool_calls?.some(call => call.extra_content))) break;
    if (budget.count([original[0], checkpoint, latestUser, ...candidate], tools) > retainedLimit) break;
    tail.unshift(...group);
  }
  const after = budget.count([original[0], checkpoint, latestUser, ...tail], tools);
  const byteSize = (messages: ContextMessage[]) => new TextEncoder().encode(JSON.stringify(messages)).byteLength;
  const reduced = sizeRecovery ? byteSize([original[0], checkpoint, latestUser]) < byteSize(original) : after < before;
  if (!summary || !reduced || after > budget.inputLimit() * 0.55) throw new Error("Automatic compaction did not free enough request capacity. Original history and results were preserved.");
  checkAbort(signal);
  validate?.();
  context.compact(summary, latestUser, compactUsage, tail);
  Zotero.debug(`[ChatPDF] compact: beforeTokens=${before}, afterTokens=${after}, countMethod=local-bpe-estimate, generation=${context.data.checkpoints.length}`);
  return sizeRecovery;
}
