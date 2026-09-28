import type { ContextMessage } from "./agent-context";
import type { Tool } from "./llm-client";
import type { ModelCapabilities } from "./model-capabilities";
import { TokenCounter } from "./token-accounting";

export class ContextBudget {
  readonly margin: number;
  constructor(readonly capabilities: ModelCapabilities, readonly counter: TokenCounter) {
    this.margin = Math.max(128, Math.ceil((capabilities.contextWindow || capabilities.inputLimit!) * 0.02));
    if (this.inputLimit() <= 0) throw new Error("The requested output reservation leaves no input token budget. Adjust this model's token settings.");
  }
  inputLimit(output = this.capabilities.requestedOutput): number {
    return Math.floor(Math.min(this.capabilities.inputLimit ?? Infinity, this.capabilities.contextWindow ? this.capabilities.contextWindow - output : Infinity) - this.margin);
  }
  count(messages: ContextMessage[], tools: Tool[] = []): number { return this.counter.count(messages, tools); }
  fits(messages: ContextMessage[], tools: Tool[] = [], output = this.capabilities.requestedOutput): boolean { return this.count(messages, tools) <= this.inputLimit(output); }
  assertFits(messages: ContextMessage[], tools: Tool[] = [], output = this.capabilities.requestedOutput): void {
    if (!this.fits(messages, tools, output)) throw new Error("The complete request exceeds this model's input token budget. History and stored results are preserved.");
  }
  shouldCompact(messages: ContextMessage[], tools: Tool[], instruction: ContextMessage): boolean {
    return this.count(messages, tools) >= Math.floor(this.inputLimit() * 0.8) || !this.fits([...messages, instruction], tools);
  }
  outputAllowance(messages: ContextMessage[], tools: Tool[], desired: number): number {
    const input = this.count(messages, tools);
    if (input > (this.capabilities.inputLimit ?? Infinity) - this.margin) return 0;
    return Math.max(0, Math.min(desired, this.capabilities.maxOutput, this.capabilities.contextWindow ? this.capabilities.contextWindow - input - this.margin : Infinity));
  }
}
