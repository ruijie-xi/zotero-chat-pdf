import { describe, expect, it } from "vitest";
import { textMatches } from "../src/modules/pdf-text";
describe("PDF text search snippets", () => {
  it("merges overlapping windows without repeating their shared context", () => {
    const text = "before alpha match shared context another match after";
    const matches = textMatches(text, "match", 50);
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toContain("alpha match");
    expect(matches[0].text).toContain("another match");
    expect(matches[0].text.match(/shared context/g)).toHaveLength(1);
  });
  it("retains distinct distant matches and exact offsets", () => {
    expect(textMatches("match" + ".".repeat(100) + "MATCH", "match", 5)).toEqual([
      { offset: 0, text: "match" }, { offset: 105, text: "MATCH" },
    ]);
  });
});
