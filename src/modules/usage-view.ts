import { h, preserveBottomScroll } from "../utils/dom";
import { formatTokens } from "../utils/format";
import { uiText } from "../utils/ui-text";
import type { TokenUsage } from "./llm-client";
import { getPanelState } from "./panel-state";

/** Render token usage bar. */
export function updateUsageBar(root: HTMLElement, usage?: TokenUsage): void {
  const bar = root.querySelector("#chatpdf-usage-bar") as HTMLElement | null;
  if (!bar) return;
  const stats = getPanelState(root).session.contextStats;
  const available = stats ? Math.max(0, Math.round(100 * (1 - stats.inputTokens / stats.inputLimit))) : 0;
  const contextText = stats ? uiText(`Context ≈${formatTokens(stats.inputTokens)} / ${formatTokens(stats.inputLimit)} tokens (${available}% available)`, `上下文 ≈${formatTokens(stats.inputTokens)} / ${formatTokens(stats.inputLimit)} tokens（可用 ${available}%）`) : "";
  const generationText = stats?.outputLimit ? uiText(`Generation ≤${formatTokens(stats.outputLimit)} tokens incl. thinking`, `生成额度 ≤${formatTokens(stats.outputLimit)} tokens（含思考）`) : "";
  const rows = [contextText, generationText, formatUsageText(usage, uiText("Session", "会话累计"))].filter(Boolean);
  const text = rows.join(" · ");
  preserveBottomScroll(root.querySelector("#chatpdf-messages"), () => {
    bar.hidden = !text;
    if (bar.localName !== "details") { bar.textContent = text; return; }
    let summary = bar.querySelector("summary");
    if (!summary) {
      summary = h(root.ownerDocument!, "summary");
      summary.addEventListener("click", event => {
        event.preventDefault();
        preserveBottomScroll(root.querySelector("#chatpdf-messages"), () => { (bar as HTMLDetailsElement).open = !(bar as HTMLDetailsElement).open; });
      });
      bar.append(summary, h(root.ownerDocument!, "div", { className: "chatpdf-usage-details" }));
    }
    summary.textContent = [stats ? uiText(`Context ${available}% free`, `上下文剩余 ${available}%`) : "", compactUsage(usage, uiText("Session", "会话"))].filter(Boolean).join(" · ");
    bar.querySelector(".chatpdf-usage-details")!.replaceChildren(...rows.map(row => h(root.ownerDocument!, "div", {}, row)));
  });
  if (!text) return;
  bar.title = uiText("Context is a local estimate after output and safety reservations. Session totals come from the provider; cache rate is hit / (hit + miss). Cached input still occupies context.", "上下文是扣除输出和安全预留后的本地估算；会话累计用量由接口返回。缓存命中率为命中数除以命中与未命中数之和；缓存输入仍占上下文。");
  if (stats?.outputLimit) bar.title += uiText(` Generation allowance: ${stats.outputLimit} tokens; model maximum: ${stats.modelMaxOutput}. An allowance is not actual consumption.`, ` 生成额度为 ${stats.outputLimit} tokens，模型上限为 ${stats.modelMaxOutput}；额度不代表实际消耗。`);
}

function compactUsage(usage: TokenUsage | undefined, label: string): string {
  if (!usage) return "";
  const total = usage.total_tokens ?? (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
  const parts = [`${label} ${formatTokens(total)} tokens`];
  const hit = usage.prompt_cache_hit_tokens || 0, miss = usage.prompt_cache_miss_tokens || 0;
  if (hit + miss) parts.push(uiText(`Cache ${(100 * hit / (hit + miss)).toFixed(1)}%`, `缓存命中 ${(100 * hit / (hit + miss)).toFixed(1)}%`));
  return parts.join(" · ");
}

export function formatUsageText(usage?: TokenUsage, label?: string): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (label) parts.push(label);
  if (usage.prompt_tokens) parts.push(`${uiText("In", "输入")}: ${formatTokens(usage.prompt_tokens)}`);
  if (usage.completion_tokens) parts.push(`${uiText("Out", "输出")}: ${formatTokens(usage.completion_tokens)}`);
  if (usage.completion_tokens_details?.reasoning_tokens) {
    parts.push(`${uiText("Reasoning", "思考")}: ${formatTokens(usage.completion_tokens_details.reasoning_tokens)}`);
  }
  if (usage.total_tokens) parts.push(`${uiText("Total", "合计")}: ${formatTokens(usage.total_tokens)}`);
  if (usage.prompt_cache_hit_tokens || usage.prompt_cache_miss_tokens) {
    const hit = usage.prompt_cache_hit_tokens || 0;
    const miss = usage.prompt_cache_miss_tokens || 0;
    const cacheTotal = hit + miss;
    const rate = cacheTotal > 0 ? `${(100 * hit / cacheTotal).toFixed(1)}%` : "n/a";
    parts.push(uiText(`Cache hit: ${rate} (${formatTokens(hit)} hit / ${formatTokens(miss)} miss)`, `缓存命中: ${rate}（命中 ${formatTokens(hit)} / 未命中 ${formatTokens(miss)}）`));
  }
  return parts.join(" \u00B7 ");
}

export function appendUsageMeta(container: HTMLElement, usage?: TokenUsage): void {
  const text = formatUsageText(usage, uiText("Turn", "本次"));
  const existing = container.querySelector(".chatpdf-msg-usage");
  if (existing) existing.remove();
  if (!text) return;
  const doc = container.ownerDocument!;
  const details = h(doc, "details", { className: "chatpdf-msg-usage" });
  details.append(h(doc, "summary", {}, compactUsage(usage, uiText("Turn", "本次"))), h(doc, "div", { className: "chatpdf-usage-details" }, text));
  container.append(details);
}
