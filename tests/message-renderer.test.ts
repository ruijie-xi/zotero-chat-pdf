import { describe, expect, it } from "vitest";
import { formatUsageText } from "../src/modules/message-renderer";

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
