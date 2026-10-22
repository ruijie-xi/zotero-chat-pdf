import type { PdfTextRecord } from "./pdf-text";

export function textMatches(text: string, query: string, snippetChars: number): { offset: number; text: string }[] {
  if (!query) return [];
  const lower = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const matches: { offset: number; text: string }[] = [];
  let at = 0;
  while ((at = lower.indexOf(needle, at)) !== -1) {
    const start = Math.max(0, at - Math.floor(Math.max(0, snippetChars - needle.length) / 2));
    const end = Math.min(text.length, Math.max(at + needle.length, start + snippetChars));
    const previous = matches[matches.length - 1];
    if (!previous || start > previous.offset + previous.text.length) matches.push({ offset: start, text: text.slice(start, end) });
    else previous.text = text.slice(previous.offset, Math.max(previous.offset + previous.text.length, end));
    at += needle.length;
  }
  return matches;
}


/** Return every merged passage; ranking never removes an occurrence. */
export function collectPdfSearchPassages(record: PdfTextRecord, query: string, snippetChars: number) {
  const needle = query.toLocaleLowerCase();
  const edges = record.pages.map(page => {
    const lines = [...page.text.matchAll(/[^\r\n]+/g)].filter(line => line[0].trim());
    return [...new Set([...lines.slice(0, 2), ...lines.slice(-2)])].map(line => ({
      start: line.index!, end: line.index! + line[0].length,
      normalized: line[0].trim().toLocaleLowerCase().replace(/\s+/g, " ").replace(/\d+/g, "#"),
    }));
  });
  const frequencies = new Map<string, number>();
  if (record.origin === "pdfjs") for (const lines of edges) {
    for (const line of new Set(lines.map(line => line.normalized))) {
      if (line.length >= 8 && /\p{L}/u.test(line)) frequencies.set(line, (frequencies.get(line) || 0) + 1);
    }
  }
  const threshold = Math.max(2, Math.ceil(record.pages.length / 3));
  return record.pages.flatMap((page, index) => {
    const margins = edges[index].filter(line => (frequencies.get(line.normalized) || 0) >= threshold);
    const lower = page.text.toLocaleLowerCase();
    let next = needle ? lower.indexOf(needle) : -1;
    return textMatches(page.text, query, snippetChars).map(passage => {
      let count = 0, onlyMargins = true;
      while (next >= 0 && next < passage.offset + passage.text.length) {
        count++;
        if (!margins.some(line => next >= line.start && next + needle.length <= line.end)) onlyMargins = false;
        next = lower.indexOf(needle, next + needle.length);
      }
      return { ...passage, pdf_page: page.page, page_label: page.pageLabel || null, match_count: count,
        likely_repeated_margin: record.origin === "pdfjs" ? onlyMargins && count > 0 : null };
    });
  });
}
