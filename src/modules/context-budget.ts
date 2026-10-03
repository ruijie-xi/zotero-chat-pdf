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
  inputLimit(output = this.capabilities.generation.outputTokens): number {
    return Math.floor(Math.min(this.capabilities.inputLimit ?? Infinity, this.capabilities.contextWindow ? this.capabilities.contextWindow - output : Infinity) - this.margin);
  }
  count(messages: ContextMessage[], tools: Tool[] = []): number { return this.counter.count(messages, tools); }
  fits(messages: ContextMessage[], tools: Tool[] = [], output = this.capabilities.generation.outputTokens): boolean { return output > 0 && output <= this.capabilities.generation.retryCeiling && this.count(messages, tools) <= this.inputLimit(output); }
  assertFits(messages: ContextMessage[], tools: Tool[] = [], output = this.capabilities.generation.outputTokens): void {
    if (!this.fits(messages, tools, output)) throw new Error("The complete request exceeds this model's input token budget. History and stored results are preserved.");
  }
  shouldCompact(messages: ContextMessage[], tools: Tool[], instruction: ContextMessage, output = this.capabilities.generation.outputTokens): boolean {
    return this.count(messages, tools) >= Math.floor(this.inputLimit(output) * 0.8) || !this.fits([...messages, instruction], tools, output);
  }
  outputLimit(desired = this.capabilities.generation.outputTokens): number {
    return Math.min(desired, this.capabilities.generation.retryCeiling);
  }
  withOutput(output: number): ContextBudget {
    return new ContextBudget({ ...this.capabilities, generation: { ...this.capabilities.generation, outputTokens: this.outputLimit(output) } }, this.counter);
  }
  requestMetadata(output = this.capabilities.generation.outputTokens) {
    return { outputLimit: output, initialOutputLimit: this.capabilities.generation.outputTokens,
      outputPolicy: this.capabilities.generation.source, modelMaxOutput: this.capabilities.maxOutput,
      contextWindow: this.capabilities.contextWindow, inputLimit: this.inputLimit(output),
      thinkingMode: this.capabilities.generation.thinkingMode, thinkEffort: this.capabilities.generation.thinkEffort };
  }
}
