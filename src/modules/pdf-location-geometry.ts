import type { PdfRect, PdfRegion, PdfTextLayout } from "./pdf-renderer";

/** Keep an offset map through case folding, ligatures and line-end hyphenation. */
function normalizedText(text: string) {
  let value = "";
  const starts: number[] = [], ends: number[] = [];
  for (let i = 0; i < text.length;) {
    const start = i, char = String.fromCodePoint(text.codePointAt(i)!);
    i += char.length;
    if (char === "\u00ad") continue;
    if (char === "-" && /\p{L}$/u.test(text.slice(0, start))) {
      const continuation = /^[ \t]*\r?\n\s*(?=\p{L})/u.exec(text.slice(i));
      if (continuation) { i += continuation[0].length; continue; }
    }
    for (const part of char.normalize("NFKC").toLowerCase()) {
      const next = /\s/u.test(part) ? " " : part;
      if (next === " " && (!value || value.endsWith(" "))) {
        if (value) ends[ends.length - 1] = i;
        continue;
      }
      value += next;
      for (let j = 0; j < next.length; j++) { starts.push(start); ends.push(i); }
    }
  }
  if (value.endsWith(" ")) { value = value.slice(0, -1); starts.pop(); ends.pop(); }
  return { value, starts, ends };
}

export function findPdfContentMatches(text: string, query: string) {
  const haystack = normalizedText(text), needle = normalizedText(query).value;
  if (!needle) return [];
  const matches: { start: number; end: number; match_method: "exact" | "case-insensitive" | "normalized" }[] = [];
  for (let at = haystack.value.indexOf(needle); at !== -1; at = haystack.value.indexOf(needle, at + 1)) {
    const start = haystack.starts[at], end = haystack.ends[at + needle.length - 1];
    if (matches[matches.length - 1]?.start === start && matches[matches.length - 1]?.end === end) continue;
    const raw = text.slice(start, end);
    matches.push({ start, end, match_method: raw === query ? "exact" : raw.toLowerCase() === query.toLowerCase() ? "case-insensitive" : "normalized" });
  }
  return matches;
}

export function validPdfRect(value: unknown): value is PdfRect {
  return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) && value[0] < value[2] && value[1] < value[3];
}
export function validPdfRegion(value: unknown): value is PdfRegion {
  const r = value as PdfRegion;
  return !!r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.x >= 0 && r.y >= 0 &&
    r.width > 0 && r.height > 0 && r.x + r.width <= 1 && r.y + r.height <= 1;
}
function bounds(points: number[][]): PdfRect {
  return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
    Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
}
function corners(rect: PdfRect) { return [[rect[0], rect[1]], [rect[0], rect[3]], [rect[2], rect[1]], [rect[2], rect[3]]]; }
function transform([x, y]: number[], [a, b, c, d, e, f]: number[]) { return [a * x + c * y + e, b * x + d * y + f]; }

export function regionToPdfRect(region: PdfRegion, layout: PdfTextLayout): PdfRect {
  const { width, height, transform: [a, b, c, d, e, f] } = layout.viewport;
  const determinant = a * d - b * c;
  if (!validPdfRegion(region) || !Number.isFinite(determinant) || !determinant) throw new Error("Invalid PDF page coordinates.");
  const rect: PdfRect = [region.x * width, region.y * height, (region.x + region.width) * width, (region.y + region.height) * height];
  return bounds(corners(rect).map(([x, y]) => [(d * (x - e) - c * (y - f)) / determinant, (-b * (x - e) + a * (y - f)) / determinant]));
}
export function pdfRectsToRegion(rects: PdfRect[], layout: PdfTextLayout, padding = 0): PdfRegion | null {
  if (!rects.length) return null;
  const box = bounds(rects.flatMap(rect => corners(rect).map(point => transform(point, layout.viewport.transform))));
  const { width, height } = layout.viewport;
  const x = Math.max(0, (box[0] - padding) / width), y = Math.max(0, (box[1] - padding) / height);
  const right = Math.min(1, (box[2] + padding) / width), bottom = Math.min(1, (box[3] + padding) / height);
  const region = { x, y, width: right - x, height: bottom - y };
  return validPdfRegion(region) ? region : null;
}

/** Item-level bounds, not character boxes. Vertical text remains explicitly unlocated. */
function itemRect(item: PdfTextLayout["items"][number], layout: PdfTextLayout): PdfRect | null {
  const style = layout.styles[item.fontName] || {};
  if (style.vertical || !item.str.trim() || item.transform.length !== 6 || !item.transform.every(Number.isFinite)) return null;
  const [a, b, c, d, e, f] = item.transform;
  const horizontal = Math.hypot(a, b), height = Math.hypot(c, d);
  if (!horizontal || !height || !Number.isFinite(item.width) || item.width <= 0) return null;
  const ascent = style.ascent ?? (style.descent !== undefined ? 1 + style.descent : 0.8);
  const points = [0, item.width].flatMap(advance => [ascent - 1, ascent].map(vertical =>
    [e + a / horizontal * advance + c * vertical, f + b / horizontal * advance + d * vertical]));
  const rect = bounds(points), page = layout.viewBox;
  rect[0] = Math.max(page[0], rect[0]); rect[1] = Math.max(page[1], rect[1]);
  rect[2] = Math.min(page[2], rect[2]); rect[3] = Math.min(page[3], rect[3]);
  return validPdfRect(rect) ? rect : null;
}

export function locateInPdfLayout(layout: PdfTextLayout, query: string) {
  let text = "";
  const spans = layout.items.map(item => {
    const start = text.length;
    text += item.str;
    const end = text.length;
    text += item.hasEOL ? "\n" : " ";
    return { start, end, rect: itemRect(item, layout), visible: !!item.str.trim() };
  });
  return findPdfContentMatches(text, query).map(match => {
    const selected = spans.filter(span => span.visible && span.start < match.end && span.end > match.start);
    const complete = selected.length > 0 && selected.every(span => span.rect);
    const rects = complete ? selected.map(span => span.rect!) : [];
    // Inspection crops get a small margin; reader highlights retain the item bounds.
    const region = pdfRectsToRegion(rects, layout, 2);
    return { ...match, matched_text: text.slice(match.start, match.end),
      context: text.slice(Math.max(0, match.start - 100), Math.min(text.length, match.end + 100)),
      rects, region, precision: region ? "text-item" as const : "page-only" as const };
  });
}
