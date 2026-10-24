import { describe, expect, it } from "vitest";
import { makeSourceId, parseSourceId, sourceCacheKey } from "../src/modules/source-identity";

describe("source identity", () => {
  it("rejects an empty key", () => {
    expect(() => makeSourceId(" ")).toThrow("Source key is required");
  });

  it("uses a fallback library for legacy IDs", () => {
    expect(parseSourceId("PDFKEY", 8)).toEqual({ libraryID: 8, key: "PDFKEY" });
  });

  it("creates Windows-safe cache keys", () => {
    expect(sourceCacheKey({ libraryID: 9, key: "A/B:C" })).toBe("9-A_B_C");
  });

});
