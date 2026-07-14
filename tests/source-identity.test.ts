import { describe, expect, it } from "vitest";
import { makeSourceId, parseSourceId, sourceCacheKey } from "../src/modules/source-identity";

describe("source identity", () => {
  it("qualifies a key with its library", () => {
    expect(makeSourceId("ABC123", 7)).toBe("7:ABC123");
  });

  it("keeps a legacy key usable", () => {
    expect(makeSourceId("ABC123")).toBe("ABC123");
  });

  it("rejects an empty key", () => {
    expect(() => makeSourceId(" ")).toThrow("Source key is required");
  });

  it("parses a qualified ID", () => {
    expect(parseSourceId("42:PDFKEY")).toEqual({ libraryID: 42, key: "PDFKEY" });
  });

  it("uses a fallback library for legacy IDs", () => {
    expect(parseSourceId("PDFKEY", 8)).toEqual({ libraryID: 8, key: "PDFKEY" });
  });

  it("creates Windows-safe cache keys", () => {
    expect(sourceCacheKey({ libraryID: 9, key: "A/B:C" })).toBe("9-A_B_C");
  });

});
