import type { AgentCallbacks } from "./agent-loop";
import type { StreamState } from "./panel-state";
import { saveSession } from "./chat-history";
import { formatToolStatus } from "../utils/format";
import { uiText } from "../utils/ui-text";

/** Provider callbacks update the turn, independent of the currently visible chat. */
export function createTurnCallbacks(stream: StreamState): AgentCallbacks {
  const publish = (immediate = true) => stream.render?.(immediate);
  const finishThinking = () => {
    stream.thinkingDone = true;
    stream.thinkingElapsed = stream.thinkingStartTime ? Math.floor((Date.now() - stream.thinkingStartTime) / 1000) : 0;
  };
  return {
    onContextStats: stats => { stream.session.contextStats = stats; publish(); },
    onContextSaved: () => saveSession(stream.session.toSavedSession()),
    onCompaction: active => {
      stream.statusText = active ? uiText("Compacting context… Work will continue automatically.", "正在整理上下文，完成后自动继续…") : "";
      publish();
    },
    onOutputContinuation: () => {
      stream.statusText = uiText("Output limit reached. Continuing automatically…", "已达到本次输出额度，正在自动继续…");
      publish();
    },
    onUsage: usage => { stream.usage = usage; publish(); },
    onIterationComplete: (iteration, maximum, record) => {
      stream.iterations.push(record);
      stream.fullReasoning = "";
      finishThinking();
      if (record.toolCalls.length || record.content !== undefined) stream.fullText = "";
      stream.statusText = maximum > 0 ? uiText(`Step ${iteration}/${maximum}`, `第 ${iteration}/${maximum} 步`) : uiText(`Step ${iteration}`, `第 ${iteration} 步`);
      publish();
    },
    onToolCallStart: (name, args) => {
      finishThinking();
      stream.statusText = formatToolStatus(name, args, stream.session);
      publish();
    },
    onThinking: (chunk, done, newBlock) => {
      if (newBlock) {
        stream.fullReasoning = "";
        stream.thinkingDone = false;
        stream.thinkingStartTime = Date.now();
        stream.thinkingElapsed = 0;
        stream.statusText = "";
      }
      if (done) finishThinking();
      else stream.fullReasoning += chunk;
      publish(done);
    },
    onStream: (chunk, done) => {
      if (!done) { stream.fullText += chunk; stream.statusText = ""; }
      publish(done);
    },
  };
}
