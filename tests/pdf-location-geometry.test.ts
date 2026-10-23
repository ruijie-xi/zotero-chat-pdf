import { describe, expect, it } from "vitest";
import { findPdfContentMatches, locateInPdfLayout, pdfRectsToRegion, regionToPdfRect } from "../src/modules/pdf-location-geometry";
import type { PdfTextLayout } from "../src/modules/pdf-renderer";

export function layoutFixture(): PdfTextLayout {
  return { page: 2, pageLabel: "iv", viewBox: [0, 0, 600, 800],
    viewport: { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] },
    styles: { f: { ascent: 0.8, descent: -0.2 } },
    items: [
      { str: "Theorem 3.2: energy", transform: [10, 0, 0, 10, 50, 700], width: 180, height: 10, fontName: "f", hasEOL: true },
      { str: "conservation holds.", transform: [10, 0, 0, 10, 50, 680], width: 150, height: 10, fontName: "f", hasEOL: true },
    ] };
}
describe("PDF content matching and geometry", () => {
  it("maps normalized ligatures, line breaks, hyphens and Unicode back to original offsets", () => {
    const text = "😀 A coefﬁ-\n cient is con\u00adserved. Energy\n conservation. ENERGY conservation.";
    const first = findPdfContentMatches(text, "coefficient")[0];
    expect(text.slice(first.start, first.end)).toBe("coefﬁ-\n cient");
    expect(first.match_method).toBe("normalized");
    expect(findPdfContentMatches(text, "conserved")).toHaveLength(1);
    expect(findPdfContentMatches(text, "energy conservation")).toHaveLength(2);
    expect(findPdfContentMatches("ﬁ", "f")).toEqual([{ start: 0, end: 1, match_method: "normalized" }]);
    expect(findPdfContentMatches("x-y", "xy")).toEqual([]);
    expect(findPdfContentMatches("x-y", "x-y")[0].match_method).toBe("exact");
    expect(findPdfContentMatches("abc", "\u00ad ")).toEqual([]);
  });
  it("returns all overlapping occurrences, without splitting surrogate pairs", () => {
    expect(findPdfContentMatches("aaaa", "aa")).toHaveLength(3);
    expect(findPdfContentMatches("x😀x😀", "😀").map(m => [m.start, m.end])).toEqual([[1, 3], [4, 6]]);
  });
  it("highlights whole text items across lines and preserves the original match", () => {
    const match = locateInPdfLayout(layoutFixture(), "energy conservation")[0];
    expect(match.matched_text).toBe("energy\nconservation");
    expect(match.rects).toEqual([[50, 698, 230, 708], [50, 678, 200, 688]]);
    expect(match.precision).toBe("text-item");
    const roundtrip = regionToPdfRect(match.region!, layoutFixture());
    roundtrip.forEach((v, i) => expect(v).toBeCloseTo([48, 676, 232, 710][i]));
  });
  it.each([
    [600, 800, [1, 0, 0, -1, -10, 820]],
    [800, 600, [0, 1, 1, 0, -20, -10]],
    [600, 800, [-1, 0, 0, 1, 610, -20]],
    [800, 600, [0, -1, -1, 0, 820, 610]],
  ])("round trips rotated pages and nonzero crop origins", (width, height, transform) => {
    const layout = { ...layoutFixture(), viewBox: [10, 20, 610, 820] as [number, number, number, number],
      viewport: { width: width as number, height: height as number, transform: transform as number[] } };
    const rect: [number, number, number, number] = [50, 400, 210, 450];
    const region = pdfRectsToRegion([rect], layout)!;
    regionToPdfRect(region, layout).forEach((v, i) => expect(v).toBeCloseTo(rect[i]));
  });
  it("does not claim a partial rectangle when some matching text has unusable geometry", () => {
    const layout = layoutFixture(); layout.items[1].transform = [0, 0, 0, 0, 50, 680];
    expect(locateInPdfLayout(layout, "energy conservation")[0]).toMatchObject({ precision: "page-only", region: null, rects: [] });
    layout.styles.f.vertical = true;
    expect(locateInPdfLayout(layout, "Theorem")[0].precision).toBe("page-only");
  });
});
