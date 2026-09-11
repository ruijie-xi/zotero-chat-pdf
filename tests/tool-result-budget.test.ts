import { describe, expect, it } from "vitest";
import { prepareToolResultsForContext } from "../src/modules/tool-result-budget";

describe("tool result context protection", () => {
  it("passes complete results that fit the explicit context budgets", () => {
    const result = prepareToolResultsForContext(
      [{ toolName: "read_document", result: "evidence" }],
      10_000,
      240_000,
    );
    expect(result).toEqual([{ content: "evidence", contextDelivery: "complete" }]);
  });

  it("withholds an oversized result without silently truncating it", () => {
    const full = "x".repeat(90_000);
    const [result] = prepareToolResultsForContext(
      [{ toolName: "search_document", result: full }],
      10_000,
      240_000,
    );
    expect(result.contextDelivery).toBe("omitted");
    expect(result.content).toContain("produced 90000 characters");
    expect(result.content).toContain("retained in the session tool history");
    expect(result.content).not.toContain(full);
  });

  it("protects the aggregate batch budget as well as individual results", () => {
    const results = prepareToolResultsForContext(
      [
        { toolName: "read_document", result: "a".repeat(70_000) },
        { toolName: "read_document", result: "b".repeat(70_000) },
      ],
      10_000,
      240_000,
    );
    expect(results.map((result) => result.contextDelivery)).toEqual(["complete", "omitted"]);
  });
});
