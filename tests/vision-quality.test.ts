import { describe, expect, it } from "vitest";
import { buildChunkPlan, mergeChunks } from "../src/modules/pdf-conversion";
import { checkPageCoverage, checkVisionMath, checkVisionSymbols, normalizeVisionMarkdown, parseVisionPages } from "../src/modules/vision-quality";

describe("vision PDF quality gates", () => {
  it("rejects missing, duplicated, reordered and empty pages, including a missing cover", () => {
    for (const text of ["<!-- chatpdf-page:2 -->\nbody", "<!-- chatpdf-page:1 -->\nbody\n<!-- chatpdf-page:1 -->\nbody",
      "<!-- chatpdf-page:2 -->\nbody\n<!-- chatpdf-page:1 -->\nbody", "<!-- chatpdf-page:1 -->\n\n<!-- chatpdf-page:2 -->\nbody"]) {
      expect(() => parseVisionPages(text, [1, 2])).toThrow();
    }
    expect(parseVisionPages("<!-- chatpdf-page:1 -->\n[blank page]", [1]).get(1)).toBe("[blank page]");
  });
  it("rejects a page marker with fabricated content unrelated to the text layer", () => {
    const cover = "Journal manuscript original research author metadata abstract algorithm convergence stability numerical experiments discretization solution energy pressure velocity density theorem proof references appendix";
    expect(() => checkPageCoverage(cover, "This is a cover page.", 1)).toThrow("coverage");
    expect(() => checkPageCoverage(cover, cover, 1)).not.toThrow();
    expect(() => checkPageCoverage("", "Scanned page transcription", 1)).not.toThrow();
    expect(() => checkPageCoverage("\u534e\u4e2d\u79d1\u6280\u5927\u5b66\u6570\u5b66\u8ba1\u7b97\u6709\u9650\u5143\u7ed3\u6784\u4fdd\u6301\u78c1\u6d41\u4f53\u529b\u5b66\u5b9a\u7406\u8bc1\u660e", "Unrelated text", 1)).toThrow("coverage");
  });
  it("checks the same formula delimiters as the renderer and keeps captions searchable", () => {
    expect(() => checkVisionMath("$u^2$\n$$\\int_0^1 x\\,dx = \\frac12$$\n\\[E=mc^2\\]")).not.toThrow();
    expect(() => checkVisionMath("$$\\frac{broken}$$")).toThrow("KaTeX");
    expect(normalizeVisionMarkdown("![Figure 1: energy](figure.jpg)")).toBe("*Figure 1: energy*");
  });
  it("always emits chunk markers, including single-chunk PDFs", () => {
    expect(buildChunkPlan(9, 4)).toEqual([{ index: 1, startPage: 1, endPage: 4 }, { index: 2, startPage: 5, endPage: 8 }, { index: 3, startPage: 9, endPage: 9 }]);
    expect(mergeChunks("paper.pdf", 1, [{ index: 1, startPage: 1, endPage: 1, markdown: "body" }])).toContain("<!-- chatpdf-chunk:1 pages:1-1 -->");
    expect(() => buildChunkPlan(1, 0)).toThrow();
  });
  it("rejects repeated Greek symbols replaced with other legal math", () => {
    expect(() => checkVisionSymbols("ν ν ν", "$v+v+v$", 21)).toThrow("Greek symbol ν");
    expect(() => checkVisionSymbols("μ μ μ", "$\\mu+\\mu+\\kappa$", 6)).toThrow("Greek symbol μ");
    expect(() => checkVisionSymbols("𝜈 𝜈 𝜈 ϕ ϕ ϕ", "$\\nu+\\nu+\\nu+\\varphi+\\phi+\\phi$", 1)).not.toThrow();
  });
  it("rejects lost hat and tilde decorations while accepting equivalent wide commands", () => {
    expect(() => checkVisionSymbols("ˆp ˆp ˜u ˜u", "$\\bar{p}+\\bar{u}$", 21)).toThrow("hat");
    expect(() => checkVisionSymbols("˜u ˜u", "$\\bar{u}$", 21)).toThrow("tilde");
    expect(() => checkVisionSymbols("ˆp ˆp ˜u ˜u ¯B ¯B", "$\\widehat{p}+\\widetilde{u}+\\overline{B}$", 1)).not.toThrow();
  });
  it("does not pretend to check symbols without a sufficient text-layer baseline", () => {
    expect(() => checkVisionSymbols("", "Scanned formula $v^2$", 1)).not.toThrow();
    expect(() => checkVisionSymbols("ν ˆp", "$v+\\bar{p}$", 1)).not.toThrow();
  });
});
