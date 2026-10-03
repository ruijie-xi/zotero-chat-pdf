import { parseVisionPages, VisionQualityError } from "./vision-quality";

export const SELF_CHECK_MARKER = "<!-- chatpdf-self-check:v1 -->";
export const SELF_CHECK_QUALITY_GATE = "page-markers-text-symbols-katex-self-check-v3";
export const SELF_CHECK_INSTRUCTIONS = `After transcribing all pages, continue in this SAME response with a brief self-check against the supplied images. Check missing text, equation numbers, coefficients, signs, subscripts, superscripts and glyphs (especially sharp versus flat, nu versus v, and hat/tilde/bar placement). Remove repeated running headers and raw formatting commands outside math.
Do not rewrite the Markdown or explain your reasoning. End with exactly this marker on its own line: ${SELF_CHECK_MARKER}
Then return one JSON object: {"edits":[]} if nothing needs correction, or {"edits":[{"page":N,"old":"exact original fragment","new":"corrected fragment"}]}. Each old fragment must occur exactly once on that page; include enough context to make it unique. Edits must not overlap or touch page markers. Escape LaTeX backslashes in JSON. If the image is unreadable, include "uncertain":[N] instead of guessing. Return only essential edits, with no enclosing code fence or second transcription.`;

export interface VisionSelfCheck {
  method: "same-response";
  version: 1;
  pages: number[];
  editsApplied: number;
  edits: { page: number; old: string; new: string }[];
  markdownDigest: string;
}

export interface SelfCheckSummary {
  pagesChecked: number;
  pagesTotal: number;
  editsApplied: number;
}

export function summarizeSelfChecks(chunks: { selfCheck?: VisionSelfCheck }[], pageCount: number): SelfCheckSummary {
  const checks = chunks.flatMap(chunk => chunk.selfCheck ? [chunk.selfCheck] : []);
  return { pagesChecked: new Set(checks.flatMap(check => check.pages)).size, pagesTotal: pageCount,
    editsApplied: checks.reduce((sum, check) => sum + check.editsApplied, 0) };
}

/** The model's self-check is an assertion, not independent verification. */
export function parseSelfCheckedMarkdown(response: string, pages: number[]): {
  markdown: string;
  check: Omit<VisionSelfCheck, "markdownDigest">;
} {
  const markers = [...response.matchAll(/^<!-- chatpdf-self-check:v1 -->[ \t]*$/gm)];
  if (markers.length !== 1) throw new VisionQualityError("PDF model self-check is missing or duplicated");
  const marker = markers[0];
  const markdown = response.slice(0, marker.index).trim();
  parseVisionPages(markdown, pages);
  let value: any;
  try { value = JSON.parse(response.slice(marker.index! + marker[0].length).trim()); }
  catch { throw new VisionQualityError("PDF model self-check did not return valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.edits)
    || Object.keys(value).some(key => key !== "edits" && key !== "uncertain")) {
    throw new VisionQualityError("PDF model self-check has an invalid schema");
  }
  if (value.uncertain !== undefined) {
    if (!Array.isArray(value.uncertain) || value.uncertain.some((page: unknown) => !Number.isSafeInteger(page) || !pages.includes(page as number))) {
      throw new VisionQualityError("PDF model self-check has invalid uncertain page numbers");
    }
    if (value.uncertain.length) throw new VisionQualityError(`PDF model self-check could not verify pages ${value.uncertain.join(", ")}; refusing guessed content`);
  }
  const pageMarkers = [...markdown.matchAll(/^<!-- chatpdf-page:(\d+) -->[ \t]*$/gm)];
  const patches: { start: number; end: number; text: string }[] = [];
  for (const edit of value.edits) {
    if (!edit || typeof edit !== "object" || Array.isArray(edit) || Object.keys(edit).some(key => !["page", "old", "new"].includes(key))
      || !pages.includes(edit.page) || typeof edit.old !== "string" || !edit.old || typeof edit.new !== "string"
      || /<!--\s*chatpdf-/.test(edit.old + edit.new)) {
      throw new VisionQualityError("PDF model self-check returned an invalid local edit");
    }
    const i = pages.indexOf(edit.page), start = pageMarkers[i].index! + pageMarkers[i][0].length;
    const body = markdown.slice(start, pageMarkers[i + 1]?.index ?? markdown.length);
    const at = body.indexOf(edit.old);
    if (at < 0 || body.indexOf(edit.old, at + 1) >= 0) {
      throw new VisionQualityError(`PDF page ${edit.page} self-check edit is missing or ambiguous; return an exact unique fragment`);
    }
    patches.push({ start: start + at, end: start + at + edit.old.length, text: edit.new });
  }
  patches.sort((a, b) => a.start - b.start);
  if (patches.some((patch, i) => i > 0 && patch.start < patches[i - 1].end)) {
    throw new VisionQualityError("PDF model self-check edits overlap");
  }
  let corrected = markdown;
  for (const patch of patches.reverse()) corrected = corrected.slice(0, patch.start) + patch.text + corrected.slice(patch.end);
  parseVisionPages(corrected, pages);
  return { markdown: corrected, check: { method: "same-response", version: 1, pages: [...pages], editsApplied: value.edits.length,
    edits: value.edits.map((edit: { page: number; old: string; new: string }) => ({ page: edit.page, old: edit.old, new: edit.new })) } };
}

export function reusableSelfCheck(check: VisionSelfCheck | undefined, pages: number[], digest: string): boolean {
  return !!check && check.method === "same-response" && check.version === 1 && check.markdownDigest === digest
    && Number.isSafeInteger(check.editsApplied) && check.editsApplied >= 0 && Array.isArray(check.edits) && check.edits.length === check.editsApplied
    && check.edits.every(edit => pages.includes(edit.page) && typeof edit.old === "string" && !!edit.old && typeof edit.new === "string") && Array.isArray(check.pages)
    && check.pages.length === pages.length && check.pages.every((page, i) => page === pages[i]);
}
