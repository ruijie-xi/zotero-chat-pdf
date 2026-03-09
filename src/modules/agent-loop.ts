import { ChatMessage, ToolCall, Tool, chatWithTools, StreamCallback, TokenUsage, IterationRecord } from "./llm-client";
import { executeTool } from "./tools";
import { ChatSession, ToolCallRecord } from "./chat-session";
import { getPref } from "../utils/prefs";

export { ToolCallRecord } from "./chat-session";
export { IterationRecord } from "./llm-client";

/**
 * Extended thinking callback with per-iteration block signaling.
 * @param chunk  The thinking text chunk (empty string when done).
 * @param done   True when the current thinking block is complete.
 * @param isNewBlock  True on the first chunk of a new thinking block (new iteration).
 */
export type AgentThinkingCallback = (chunk: string, done: boolean, isNewBlock: boolean) => void;

export interface AgentCallbacks {
  /** Called when tool calls for an iteration are complete (for tool block rendering + state tracking). */
  onIterationComplete?: (iteration: number, maxIterations: number, record: IterationRecord) => void;
  /** Tool call start/end for live status display during execution. */
  onToolCallStart?: (name: string, args: Record<string, unknown>) => void;
  onToolCallEnd?: (name: string, result: string, durationMs: number) => void;
  /** Stream content chunks from the final LLM response. */
  onStream?: StreamCallback;
  /**
   * Stream reasoning/thinking chunks with per-iteration block boundaries.
   * isNewBlock=true signals the start of a new thinking block.
   * done=true signals the current block should be finalized.
   */
  onThinking?: AgentThinkingCallback;
}

export interface AgentResult {
  content: string;
  reasoning?: string;
  iterations: IterationRecord[];
  totalIterations: number;
  usage?: TokenUsage;
}

export async function runAgentLoop(
  messages: ChatMessage[],
  tools: Tool[],
  session: ChatSession,
  callbacks: AgentCallbacks = {},
  signal?: AbortSignal,
): Promise<AgentResult> {
  const maxIterations = (getPref("agentMaxIterations") as number | undefined) ?? 10;
  const iterations: IterationRecord[] = [];
  const currentMessages: Record<string, unknown>[] = messages.map(m => ({ ...m }));
  const totalUsage: TokenUsage = {};

  function accumulateUsage(u?: TokenUsage) {
    if (!u) return;
    totalUsage.prompt_tokens = (totalUsage.prompt_tokens || 0) + (u.prompt_tokens || 0);
    totalUsage.completion_tokens = (totalUsage.completion_tokens || 0) + (u.completion_tokens || 0);
    totalUsage.total_tokens = (totalUsage.total_tokens || 0) + (u.total_tokens || 0);
  }

  /**
   * Wrap the onThinking callback for a single chatWithTools call.
   * Tracks whether the first chunk has been emitted to set isNewBlock,
   * and whether chatWithTools signaled done (so we don't double-fire).
   */
  function makeThinkingWrapper() {
    let isFirst = true;
    let doneSignaled = false;

    const wrapper = callbacks.onThinking
      ? (chunk: string, done: boolean) => {
          if (done) {
            if (!doneSignaled && !isFirst) {
              doneSignaled = true;
              callbacks.onThinking!("", true, false);
            }
            return;
          }
          callbacks.onThinking!(chunk, false, isFirst);
          isFirst = false;
        }
      : undefined;

    return {
      wrapper,
      /** Manually finalize the thinking block if chatWithTools didn't. */
      ensureDone() {
        if (!doneSignaled && !isFirst && callbacks.onThinking) {
          doneSignaled = true;
          callbacks.onThinking("", true, false);
        }
      },
      /** Whether any thinking chunks were emitted. */
      get hadThinking() { return !isFirst; },
      get isDone() { return doneSignaled; },
    };
  }

  const loopStartTime = Date.now();
  Zotero.debug(`[ChatPDF] runAgentLoop: start, maxIterations=${maxIterations}, tools=[${tools.map(t => t.function.name).join(",")}], messages=${messages.length}, totalChars=${messages.reduce((s, m) => s + (m.content?.length ?? 0), 0)}`);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal?.aborted) {
      Zotero.debug(`[ChatPDF] runAgentLoop: aborted at iteration ${iteration + 1}`);
      break;
    }

    Zotero.debug(`[ChatPDF] runAgentLoop: iteration ${iteration + 1}/${maxIterations}, messages=${currentMessages.length}`);

    // On last iteration, don't pass tools to force a text response
    const isLastIteration = iteration === maxIterations - 1;
    const iterationTools = isLastIteration ? undefined : tools;

    if (iterationTools) {
      // ---- Tool-calling iteration: STREAMING to show thinking live ----
      const thinking = makeThinkingWrapper();

      const result = await chatWithTools(
        currentMessages as ChatMessage[],
        iterationTools,
        undefined, // don't stream content to UI during tool iterations
        thinking.wrapper,
        signal,
      );

      // Finalize the thinking block for this iteration
      thinking.ensureDone();

      accumulateUsage(result.usage);
      Zotero.debug(`[ChatPDF] runAgentLoop: iteration ${iteration + 1} result: content=${result.content.length} chars, reasoning=${result.reasoning?.length ?? 0} chars, tool_calls=${result.tool_calls?.length ?? 0}`);

      if (result.tool_calls && result.tool_calls.length > 0) {
        // Reconstruct assistant message from streaming result
        const assistantMsg: Record<string, unknown> = {
          role: "assistant",
          content: result.content || "",
          tool_calls: result.tool_calls,
        };
        // Include reasoning for providers that expect it echoed back
        if (result.reasoning) {
          assistantMsg.reasoning_content = result.reasoning;
        }
        currentMessages.push(assistantMsg);

        // Execute tools in parallel
        const iterToolCalls: ToolCallRecord[] = [];
        const toolResults = await Promise.all(
          result.tool_calls.map(async (tc: ToolCall) => {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.function.arguments || "{}"); } catch {
              Zotero.debug(`[ChatPDF] runAgentLoop: failed to parse args for ${tc.function.name}`);
            }

            callbacks.onToolCallStart?.(tc.function.name, args);
            const t0 = Date.now();
            const toolResult = await executeTool(tc.function.name, args, session);
            const durationMs = Date.now() - t0;

            Zotero.debug(`[ChatPDF] runAgentLoop: tool ${tc.function.name} done in ${durationMs}ms, result=${toolResult.length} chars`);
            callbacks.onToolCallEnd?.(tc.function.name, toolResult, durationMs);

            iterToolCalls.push({ toolName: tc.function.name, args, result: toolResult, durationMs });

            return {
              role: "tool" as const,
              content: toolResult,
              tool_call_id: tc.id,
              name: tc.function.name,
            };
          })
        );

        for (const msg of toolResults) currentMessages.push(msg);

        const iterRecord: IterationRecord = {
          reasoning: result.reasoning,
          toolCalls: iterToolCalls,
        };
        iterations.push(iterRecord);
        callbacks.onIterationComplete?.(iteration + 1, maxIterations, iterRecord);
        continue;
      } else {
        // No tool calls — this is the final answer (content was buffered, not streamed)
        const iterRecord: IterationRecord = { reasoning: result.reasoning, toolCalls: [] };
        iterations.push(iterRecord);

        callbacks.onStream?.(result.content, false);
        callbacks.onStream?.("", true);

        const totalDuration = Date.now() - loopStartTime;
        Zotero.debug(`[ChatPDF] runAgentLoop: completed in ${totalDuration}ms, ${iteration + 1} iterations`);

        return {
          content: result.content,
          reasoning: result.reasoning,
          iterations,
          totalIterations: iteration + 1,
          usage: totalUsage.total_tokens ? totalUsage : undefined,
        };
      }
    } else {
      // ---- Final iteration (or forced text): STREAM both thinking and content ----
      const thinking = makeThinkingWrapper();

      const result = await chatWithTools(
        currentMessages as ChatMessage[],
        undefined, // no tools
        callbacks.onStream
          ? (chunk: string, done: boolean) => { if (!done) callbacks.onStream!(chunk, false); }
          : undefined,
        thinking.wrapper,
        signal,
      );

      thinking.ensureDone();
      accumulateUsage(result.usage);
      callbacks.onStream?.("", true);

      const iterRecord: IterationRecord = { reasoning: result.reasoning, toolCalls: [] };
      iterations.push(iterRecord);

      const totalDuration = Date.now() - loopStartTime;
      Zotero.debug(`[ChatPDF] runAgentLoop: completed in ${totalDuration}ms, ${iteration + 1} iterations`);

      return {
        content: result.content,
        reasoning: result.reasoning,
        iterations,
        totalIterations: iteration + 1,
        usage: totalUsage.total_tokens ? totalUsage : undefined,
      };
    }
  }

  // Max iterations reached — force final streaming call
  Zotero.debug(`[ChatPDF] runAgentLoop: max iterations (${maxIterations}) reached, making final call`);
  currentMessages.push({
    role: "user",
    content: "Please provide your final answer based on the information gathered so far.",
  });

  const thinking = makeThinkingWrapper();

  const finalResult = await chatWithTools(
    currentMessages as ChatMessage[],
    undefined,
    callbacks.onStream
      ? (chunk: string, done: boolean) => { if (!done) callbacks.onStream!(chunk, false); }
      : undefined,
    thinking.wrapper,
    signal,
  );

  thinking.ensureDone();
  accumulateUsage(finalResult.usage);
  callbacks.onStream?.("", true);

  if (finalResult.reasoning) {
    const iterRecord: IterationRecord = { reasoning: finalResult.reasoning, toolCalls: [] };
    iterations.push(iterRecord);
  }

  const totalDuration = Date.now() - loopStartTime;
  Zotero.debug(`[ChatPDF] runAgentLoop: max-iter final done in ${totalDuration}ms total`);

  return {
    content: finalResult.content,
    reasoning: finalResult.reasoning,
    iterations,
    totalIterations: maxIterations,
    usage: totalUsage.total_tokens ? totalUsage : undefined,
  };
}
