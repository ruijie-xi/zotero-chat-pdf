import { Tokenizer } from "@huggingface/tokenizers";
import type { ContextMessage } from "./agent-context";
import { buildChatCompletionBody, type LLMSettings, type Tool, type TokenUsage } from "./llm-client";
import type { ModelCapabilities } from "./model-capabilities";

let tokenizerPromise: Promise<Tokenizer> | undefined;
export function loadTokenizer(): Promise<Tokenizer> {
  return tokenizerPromise ||= Promise.all([
    fetch("chrome://chatpdf/content/tokenizers/deepseek-v4.json").then(r => r.json()),
    fetch("chrome://chatpdf/content/tokenizers/deepseek-v4-config.json").then(r => r.json()),
  ]).then(([vocabulary, config]) => new Tokenizer(vocabulary, config)).catch(error => { tokenizerPromise = undefined; throw error; });
}

/** Local BPE counts plus explicit protocol estimates. Never presented as exact API usage. */
export class TokenCounter {
  private counts = new Map<string, number>();
  private calibration = 1;
  constructor(private tokenizer: Pick<Tokenizer, "encode">, readonly settings: LLMSettings, readonly capabilities: ModelCapabilities) {}

  text(text: string): number {
    const cached = this.counts.get(text);
    if (cached !== undefined) return cached;
    const count = this.tokenizer.encode(text, { add_special_tokens: false }).ids.length;
    // Bound local memoization; eviction never changes provider request bytes.
    if (this.counts.size >= 256) this.counts.delete(this.counts.keys().next().value!);
    this.counts.set(text, count);
    return count;
  }

  raw(messages: ContextMessage[], tools: Tool[] = []): number {
    const body = buildChatCompletionBody(this.settings, messages, { stream: true, tools });
    const wire = body.messages as ContextMessage[];
    let total = 3 + (tools.length ? this.text(JSON.stringify(body.tools)) : 0);
    for (const message of wire) {
      const { content, ...envelope } = message;
      total += 8 + this.text(JSON.stringify(envelope));
      if (typeof content === "string") total += this.text(content);
      else for (const part of content) {
        if (part.type === "text") total += this.text(part.text);
        else {
          if (!this.capabilities.imageTokens) throw new Error("Set a per-image token reserve for this model before sending images.");
          total += this.capabilities.imageTokens;
        }
      }
    }
    return total;
  }

  count(messages: ContextMessage[], tools: Tool[] = []): number { return Math.ceil(this.raw(messages, tools) * this.calibration); }
  observe(messages: ContextMessage[], tools: Tool[], usage?: TokenUsage): void {
    // Cached input still occupies context. Only calibrate against this exact request.
    if (usage?.prompt_tokens) this.calibration = Math.max(this.calibration, usage.prompt_tokens / Math.max(1, this.raw(messages, tools)));
  }
}
