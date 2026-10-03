import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Tokenizer } from "@huggingface/tokenizers";
import { TokenCounter } from "../src/modules/token-accounting";
import { ContextBudget } from "../src/modules/context-budget";
import { AgentContext } from "../src/modules/agent-context";
import type { ModelCapabilities } from "../src/modules/model-capabilities";
import fixtures from "./fixtures/deepseek-v4-tokens.json";

const tokenizer = new Tokenizer(JSON.parse(readFileSync("addon/content/tokenizers/deepseek-v4.json", "utf8")), JSON.parse(readFileSync("addon/content/tokenizers/deepseek-v4-config.json", "utf8")));
const settings = { apiBase: "https://api.deepseek.com/v1", apiKey: "", model: "deepseek-flash", thinkingMode: "default" as const, thinkEffort: "default" as const };
const capabilities: ModelCapabilities = { contextWindow: 10000, maxOutput: 4000, generation: { outputTokens: 4000, retryCeiling: 4000, source: "model-maximum", thinkingMode: "default", thinkEffort: "default" }, tokenizer: "deepseek-v4", source: "endpoint", fetchedAt: 1, imageTokens: 1024 };
const counter = () => new TokenCounter(tokenizer, settings, capabilities);

describe("local token accounting", () => {
  it.each(fixtures)("matches the Rust reference for $text", fixture => {
    expect(tokenizer.encode(fixture.text, { add_special_tokens: false }).ids).toEqual(fixture.ids);
  });
  it("distinguishes equal character lengths and counts schemas/replay without changing the prefix", () => {
    const c = counter();
    expect(c.text("a".repeat(64))).not.toBe(c.text("甲".repeat(64)));
    const messages = [{ role: "user" as const, content: "Read these documents" }];
    const original = JSON.stringify(messages);
    const plain = c.count(messages);
    expect(c.count(messages, [{ type: "function", function: { name: "read", description: "Read evidence", parameters: { type: "object" } } }])).toBeGreaterThan(plain);
    expect(c.count([...messages, { role: "assistant", content: "", reasoning_content: "Some provider replay", tool_calls: [{ id: "one", type: "function", function: { name: "read", arguments: '{"page":1}' } }] }])).toBeGreaterThan(plain);
    expect(JSON.stringify(messages)).toBe(original);
  });
  it("memoizes complete fields without changing boundary tokenization", () => {
    const c = counter();
    c.text("some"); c.text("thing");
    expect(c.text("something")).toBe(tokenizer.encode("something", { add_special_tokens: false }).ids.length);
    const messages = [{ role: "user" as const, content: "something" }];
    c.count(messages);
    messages[0].content += " else";
    expect(c.count(messages)).toBe(counter().count(messages));
  });
  it("accounts for image tokens without encoding base64 and includes cached input in calibration", () => {
    const c = counter();
    const images = (url: string) => [{ role: "user" as const, content: [{ type: "image_url" as const, image_url: { url, detail: "auto" as const } }] }];
    expect(c.count(images("data:image/png;base64,a"))).toBe(c.count(images("data:image/png;base64," + "a".repeat(100000))));
    const messages = [{ role: "user" as const, content: "hello" }];
    c.observe(messages, [], { prompt_tokens: 1000, prompt_cache_hit_tokens: 999 });
    expect(c.count(messages)).toBe(1000);
  });
  it("reserves output against combined capacity and respects separate input limits", () => {
    const budget = new ContextBudget(capabilities, counter());
    expect(budget.inputLimit()).toBe(5800);
    expect(budget.inputLimit(2000)).toBe(7800);
    expect(budget.inputLimit(4000)).toBe(5800);
    const separate = new ContextBudget({ ...capabilities, contextWindow: undefined, inputLimit: 10000 }, counter());
    expect(separate.inputLimit(4000)).toBe(9800);
    const both = new ContextBudget({ ...capabilities, inputLimit: 5000 }, counter());
    expect(both.inputLimit()).toBe(4800);
  });
  it("pages exact Unicode evidence and records only the actual delivered range", () => {
    const memory = AgentContext.create([{ role: "system", content: "policy" }], "model", 0);
    const original = memory.storeResult("😀中文".repeat(50), "read_document", ["1:A"]);
    const allowed = new Set(["1:A"]);
    let start = 0;
    let reconstructed = "";
    while (start < original.content.length) {
      const page = memory.readResultPage(original.id, start, 1000, allowed, text => counter().text(text) < 100);
      const body = page.content.slice(page.content.indexOf("\n") + 1);
      expect(body).toBe(original.content.slice(page.start, page.end));
      expect(body).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      const stored = memory.storeResult(page.content, "read_tool_result", ["1:A"]);
      stored.parentRange = { id: original.id, start: page.start, end: page.end };
      memory.markDelivered(stored.id);
      reconstructed += body;
      start = page.end;
    }
    expect(reconstructed).toBe(original.content);
    expect(original.delivered).toBe(true);
    expect(original.ranges).toEqual([[0, original.content.length]]);
    expect(() => memory.readResultPage(original.id, 1, 3, allowed)).toThrow("Unicode");
    expect(() => memory.readResultPage(original.id, 0, 3, new Set())).toThrow("scope");
  });
});
