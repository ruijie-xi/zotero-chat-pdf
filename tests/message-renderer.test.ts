import { describe, expect, it } from "vitest";
import { createToolBlock, formatUsageText } from "../src/modules/message-renderer";

it("renders persisted empty-collection deletion receipts with Undo", () => {
  const block = createToolBlock(document, [{ toolName: "change_zotero_library", args: {}, durationMs: 1,
    result: JSON.stringify({ change_id: "delete-empty", status: "applied", changes: [{ kind: "collection", library_id: 1, key: "EMPTY001", title: "Empty shell",
      before: { name: "Empty shell", parentKey: null }, after: null }] }) }], 1);
  expect(block.querySelector('[data-category="remove"]')?.textContent).toContain("Empty shell");
  expect(block.textContent).toMatch(/Undo|撤销/);
});

describe("token usage display", () => {
  it("shows an explicit weighted cache hit rate and hit/miss counts", () => {
    const text = formatUsageText({
      prompt_tokens: 1_000,
      completion_tokens: 200,
      total_tokens: 1_200,
      prompt_cache_hit_tokens: 700,
      prompt_cache_miss_tokens: 300,
    }, "Session");

    expect(text).toContain("Session");
    expect(text).toContain("Cache hit: 70.0%");
    expect(text).toContain("700 hit / 300 miss");
  });
});
