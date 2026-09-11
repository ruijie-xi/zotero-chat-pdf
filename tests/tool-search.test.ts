import { describe, expect, it } from "vitest";
import { buildDocumentSearchResult } from "../src/modules/tools";

describe("document search output", () => {
  it("merges overlapping context windows without losing matched line numbers", () => {
    const markdown = [
      "before",
      "alpha match",
      "shared context",
      "another match",
      "after",
    ].join("\n");

    const result = buildDocumentSearchResult(markdown, "Paper", "match", undefined, 1);

    expect(result).toContain("2 matches in 1 non-overlapping context windows");
    expect(result).toContain("matches at lines 2, 4");
    expect(result.match(/shared context/g)).toHaveLength(1);
  });

  it("still honors the caller's explicit max_results limit", () => {
    const markdown = ["match one", "gap", "match two"].join("\n");
    const result = buildDocumentSearchResult(markdown, "Paper", "match", 1, 0);
    expect(result).toContain("1 matches in 1 non-overlapping context windows");
    expect(result).toContain("match one");
    expect(result).not.toContain("match two");
  });
});
