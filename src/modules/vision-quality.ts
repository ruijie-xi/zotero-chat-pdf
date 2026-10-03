import katex from "katex";

export class VisionQualityError extends Error {}
export const VISION_QUALITY_GATE = "page-markers-text-symbols-katex-v2";

export const pageMarker = (page: number) => `<!-- chatpdf-page:${page} -->`;

/** The marker is mandatory even for an explicitly blank page. */
export function parseVisionPages(markdown: string, pages: number[]): Map<number, string> {
  const markers = [...markdown.matchAll(/^<!-- chatpdf-page:(\d+) -->[ \t]*$/gm)];
  if (markers.length !== pages.length || markers.some((m, i) => Number(m[1]) !== pages[i])) {
    throw new VisionQualityError("The model omitted, duplicated or reordered PDF page markers");
  }
  if (markdown.slice(0, markers[0]?.index).trim()) throw new VisionQualityError("Unexpected text before the first PDF page");
  const result = new Map<number, string>();
  for (let i = 0; i < markers.length; i++) {
    const text = markdown.slice(markers[i].index! + markers[i][0].length, markers[i + 1]?.index ?? markdown.length).trim();
    if (!text) throw new VisionQualityError(`PDF page ${pages[i]} has no transcription`);
    if (/<!--\s*chatpdf-(?:chunk|page):/.test(text)) throw new VisionQualityError("Unexpected conversion marker inside a page");
    result.set(pages[i], text);
  }
  return result;
}

function normalized(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\u00ad\u200b]/g, "");
}

/** Text-layer recall is a guard against omissions, never the transcription source.
 * Formula-only, scanned and sparse pages have no sufficient textual baseline. */
export function checkPageCoverage(source: string, markdown: string, page: number): void {
  const text = normalized(source);
  const output = normalized(markdown);
  const chinese = new Set(text.match(/[\u3400-\u9fff]/g) || []);
  const words = new Set(text.match(/\p{L}{4,}/gu)?.filter(w => /^[a-z]+$/.test(w)) || []);
  const baseline = chinese.size >= 20 ? chinese : words;
  if (baseline.size < 15) return;
  const hits = [...baseline].filter(word => output.includes(word)).length;
  // A deliberately tolerant floor: symbol fonts and formula normalization make
  // high text-layer thresholds unreliable. Page markers provide the other gate.
  if (hits / baseline.size < 0.35) throw new VisionQualityError(`PDF page ${page} text coverage is below 35%; refusing an incomplete conversion`);
}

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", vartheta: "θ", iota: "ι", kappa: "κ", varkappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ",
  omicron: "ο", pi: "π", varpi: "π", rho: "ρ", varrho: "ρ", sigma: "σ", varsigma: "σ", tau: "τ",
  upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", varDelta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ",
  Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω", varOmega: "Ω",
};

function mathGlyphs(text: string): string {
  return text.normalize("NFKC").replace(/[ϵϑϰϖϱςϕ]/g, c => ({ "ϵ": "ε", "ϑ": "θ", "ϰ": "κ", "ϖ": "π", "ϱ": "ρ", "ς": "σ", "ϕ": "φ" })[c]!);
}

/** A text-layer omission guard for repeated symbols, not an equation verifier.
 * It catches ν→v and lost accents even when all generated LaTeX is legal. */
export function checkVisionSymbols(source: string, markdown: string, page: number): void {
  const original = mathGlyphs(source);
  const converted = mathGlyphs(markdown.replace(/\\([A-Za-z]+)/g, (full, name: string) => GREEK[name] || full));
  const count = (text: string, glyph: string) => text.split(glyph).length - 1;
  for (const glyph of new Set(Object.values(GREEK))) {
    const expected = count(original, glyph), actual = count(converted, glyph);
    // Font encodings and grouping can change counts, so only a substantial
    // loss of a repeated symbol fails; exact equality would be unreliable.
    if (expected >= 3 && actual / expected < 0.7) {
      throw new VisionQualityError(`PDF page ${page} Greek symbol ${glyph} coverage is below 70% (${actual}/${expected}); reread the glyph without replacing it with a Latin letter or another Greek symbol`);
    }
  }
  for (const [label, sourcePattern, outputPattern] of [
    ["hat", /ˆ|\u0302/g, /\\(?:hat|widehat)\b/g],
    ["tilde", /˜|\u0303/g, /\\(?:tilde|widetilde)\b/g],
    ["bar", /¯|ˉ|\u0304/g, /\\(?:bar|overline)\b/g],
  ] as const) {
    const expected = original.match(sourcePattern)?.length || 0;
    const actual = markdown.match(outputPattern)?.length || 0;
    if (expected >= 2 && actual === 0) {
      throw new VisionQualityError(`PDF page ${page} lost all ${label} math accents; distinguish hat, tilde and bar decorations exactly as printed`);
    }
  }
}

export function checkVisionMath(markdown: string): void {
  let remaining = markdown.replace(/```[^\n]*\n[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "");
  const patterns: [RegExp, boolean][] = [
    [/\$\$([\s\S]+?)\$\$/g, true], [/\\\[([\s\S]+?)\\\]/g, true],
    [/(?<![\\$])\$(?!\$)(.+?)(?<![\\$])\$(?!\$)/g, false], [/\\\((.+?)\\\)/g, false],
  ];
  for (const [pattern, displayMode] of patterns) {
    remaining = remaining.replace(pattern, (_match, latex: string) => {
      try { katex.renderToString(latex.trim(), { displayMode, throwOnError: true, trust: false, strict: "ignore" }); }
      catch { throw new VisionQualityError("PDF transcription contains a formula that KaTeX cannot render"); }
      return "";
    });
  }
  if (/(?<!\\)\$|\\[\[\]]/.test(remaining)) throw new VisionQualityError("PDF transcription contains unclosed math delimiters");
}

/** Keep captions searchable; untrusted model image links never become assets. */
export function normalizeVisionMarkdown(markdown: string): string {
  return markdown.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, caption: string) => caption ? `*${caption}*` : "");
}
