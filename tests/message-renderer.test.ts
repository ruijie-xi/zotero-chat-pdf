import { describe, expect, it, vi } from "vitest";
import { enterEditMode, MESSAGE_EDIT_EVENT } from "../src/modules/message-editor";
import { createToolBlock, formatUsageText, updateUsageBar } from "../src/modules/message-renderer";

it("renders persisted empty-collection deletion receipts with Undo", () => {
  const block = createToolBlock(document, [{ toolName: "change_zotero_library", args: {}, durationMs: 1,
    result: JSON.stringify({ change_id: "delete-empty", status: "applied", changes: [{ kind: "collection", library_id: 1, key: "EMPTY001", title: "Empty shell",
      before: { name: "Empty shell", parentKey: null }, after: null }] }) }], 1);
  expect(block.querySelector('[data-category="remove"]')?.textContent).toContain("Empty shell");
  expect(block.textContent).toMatch(/Undo|撤销/);
});

describe("token usage display", () => {
  it("reveals available usage and hides the bar when a session is cleared", () => {
    const root = document.createElement("div");
    root.innerHTML = '<div id="chatpdf-usage-bar" hidden></div>';
    const bar = root.firstElementChild as HTMLElement;
    updateUsageBar(root, { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 });
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain("Session");
    updateUsageBar(root);
    expect(bar.hidden).toBe(true);
  });

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

it("emits one edit request while a previous turn is still being cancelled", () => {
  const root = document.createElement("div");
  root.innerHTML = '<div class="chatpdf-msg-row" data-msg-index="0"><button class="chatpdf-edit-btn"></button><div><div class="chatpdf-message-user">Before</div></div></div>';
  const row = root.firstElementChild as HTMLElement;
  const handler = vi.fn();
  root.addEventListener(MESSAGE_EDIT_EVENT, handler);
  enterEditMode(root, row, row.querySelector(".chatpdf-message-user")!, "Before");
  const textarea = row.querySelector("textarea")!;
  textarea.value = "After";
  for (let n = 0; n < 2; n++) textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  expect(handler).toHaveBeenCalledTimes(1);
  expect((handler.mock.calls[0][0] as CustomEvent).detail.text).toBe("After");
});
