import { Marked } from "marked";
import katex from "katex";

const marked = new Marked();

marked.setOptions({
  gfm: true,
  breaks: true,
});

/**
 * Render a markdown string (with LaTeX math) to HTML.
 * Math delimiters: $...$ for inline, $$...$$ for display.
 * LaTeX is converted to HTML via KaTeX (requires katex.css + fonts).
 *
 * The output is sanitized to be XHTML-safe (required by Zotero's XUL panels).
 */
export function renderMarkdown(text: string): string {
  try {
    return renderMarkdownUnsafe(text);
  } catch (err) {
    Zotero.debug(`[ChatPDF] Markdown render error: ${err}`);
    return escapeXml(text).replace(/\n/g, "<br/>");
  }
}

/** Replace a math pattern with a placeholder, rendering via KaTeX. */
function replaceMath(
  text: string,
  pattern: RegExp,
  displayMode: boolean,
  wrapError: (latex: string) => string,
  mathBlocks: { placeholder: string; html: string }[],
  counter: { value: number },
): string {
  return text.replace(pattern, (_match, latex) => {
    const placeholder = `%%MATH_BLOCK_${counter.value++}%%`;
    try {
      const html = katex.renderToString(latex.trim(), {
        displayMode,
        output: "html",
        throwOnError: false,
      });
      const wrapped = displayMode
        ? `<div class="chatpdf-math-display">${html}</div>`
        : html;
      mathBlocks.push({ placeholder, html: wrapped });
    } catch {
      mathBlocks.push({ placeholder, html: `<code class="chatpdf-math-error">${wrapError(latex)}</code>` });
    }
    return placeholder;
  });
}

function renderMarkdownUnsafe(text: string): string {
  const mathBlocks: { placeholder: string; html: string }[] = [];
  const counter = { value: 0 };

  // Display math: $$...$$ and \[...\]
  let processed = replaceMath(text, /\$\$([\s\S]+?)\$\$/g, true,
    (l) => `$$${escapeXml(l)}$$`, mathBlocks, counter);
  processed = replaceMath(processed, /\\\[([\s\S]+?)\\\]/g, true,
    (l) => `\\[${escapeXml(l)}\\]`, mathBlocks, counter);

  // Inline math: $...$ and \(...\)
  processed = replaceMath(processed, /(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, false,
    (l) => `$${escapeXml(l)}$`, mathBlocks, counter);
  processed = replaceMath(processed, /\\\((.+?)\\\)/g, false,
    (l) => `\\(${escapeXml(l)}\\)`, mathBlocks, counter);

  // Render markdown
  let html = marked.parse(processed) as string;

  // Sanitize untrusted Markdown/HTML before inserting locally-generated KaTeX.
  html = sanitizeHtml(html);

  // Re-insert trusted math blocks. Display placeholders produced by marked are
  // usually wrapped in a paragraph; replace that wrapper to keep XHTML valid.
  for (const { placeholder, html: mathHtml } of mathBlocks) {
    if (mathHtml.startsWith("<div")) {
      html = html.replace(`<p>${placeholder}</p>`, mathHtml);
    }
    html = html.replace(placeholder, mathHtml);
  }

  // Convert to XHTML after all trusted fragments are present.
  html = toXhtml(html);

  return html;
}

/**
 * Convert HTML5 void elements to XHTML self-closing form.
 */
function toXhtml(html: string): string {
  const voidTags = "area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr";
  const re = new RegExp(`<(${voidTags})(\\s[^>]*?)?\\/?>`, "gi");
  return html.replace(re, (_match, tag, attrs) => {
    return `<${tag}${attrs || ""}/>`;
  });
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const ALLOWED_TAGS = new Set([
  "a", "blockquote", "br", "code", "del", "details", "div", "em", "h1", "h2", "h3",
  "h4", "h5", "h6", "hr", "img", "li", "ol", "p", "pre", "span", "strong", "sub",
  "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

const DROP_WITH_CONTENT = new Set(["script", "style", "template", "svg", "math", "iframe", "object", "embed"]);
const GLOBAL_ATTRS = new Set(["class", "title", "dir"]);
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href"]),
  img: new Set(["src", "alt", "width", "height"]),
  ol: new Set(["start"]),
  td: new Set(["colspan", "rowspan", "align"]),
  th: new Set(["colspan", "rowspan", "align", "scope"]),
  details: new Set(["open"]),
};

function getDomParser(): DOMParser {
  const Parser = (globalThis as any).DOMParser || (globalThis as any).Zotero?.getMainWindow?.()?.DOMParser;
  if (!Parser) throw new Error("DOMParser is unavailable in this runtime");
  return new Parser();
}

function sanitizeUrl(value: string, kind: "href" | "src"): string | null {
  const normalized = value.replace(/[\u0000-\u001F\u007F\s]+/g, "").trim();
  if (!normalized) return kind === "href" ? "#" : null;
  if (normalized.startsWith("#") || normalized.startsWith("/") || normalized.startsWith("./") || normalized.startsWith("../")) {
    return value.trim();
  }
  if (kind === "src" && /^data:image\/(?:png|gif|jpe?g|webp);base64,/i.test(normalized)) return normalized;
  let parsed: URL;
  try {
    parsed = new URL(normalized, "https://chatpdf.invalid/");
  } catch {
    return null;
  }
  const allowed = kind === "href"
    ? new Set(["http:", "https:", "mailto:", "zotero:"])
    : new Set(["http:", "https:", "zotero:"]);
  if (!allowed.has(parsed.protocol)) return null;
  return value.trim();
}

function sanitizeAttribute(element: Element, name: string, value: string): string | null {
  const tag = element.localName.toLowerCase();
  const lowerName = name.toLowerCase();
  if (lowerName.startsWith("on") || lowerName.includes(":")) return null;
  if (!GLOBAL_ATTRS.has(lowerName) && !TAG_ATTRS[tag]?.has(lowerName)) return null;
  if (lowerName === "href" || lowerName === "src") return sanitizeUrl(value, lowerName);
  if (lowerName === "class") return /^[A-Za-z0-9 _-]*$/.test(value) ? value : null;
  if (lowerName === "dir") return /^(ltr|rtl|auto)$/i.test(value) ? value.toLowerCase() : null;
  if (["width", "height", "start", "colspan", "rowspan"].includes(lowerName)) {
    return /^\d{1,5}$/.test(value) ? value : null;
  }
  if (lowerName === "align") return /^(left|right|center)$/i.test(value) ? value.toLowerCase() : null;
  if (lowerName === "scope") return /^(row|col|rowgroup|colgroup)$/i.test(value) ? value.toLowerCase() : null;
  if (lowerName === "open") return "";
  return value;
}

/** DOM-based allowlist sanitizer for untrusted model and web Markdown output. */
export function sanitizeHtml(html: string): string {
  const parsed = getDomParser().parseFromString(html, "text/html");
  const root = parsed.body;
  if (!root) throw new Error("Unable to create sanitizer document");

  const visit = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child) visit(child);
    }
    if (node.nodeType === 8) {
      node.parentNode?.removeChild(node);
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tag = element.localName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) {
      element.remove();
      return;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      const parent = element.parentNode;
      if (!parent) return;
      while (element.firstChild) parent.insertBefore(element.firstChild, element);
      parent.removeChild(element);
      return;
    }
    for (const attribute of Array.from(element.attributes)) {
      const safeValue = sanitizeAttribute(element, attribute.name, attribute.value);
      element.removeAttribute(attribute.name);
      if (safeValue !== null) element.setAttribute(attribute.name.toLowerCase(), safeValue);
    }
    if (tag === "a" && element.hasAttribute("href")) {
      element.setAttribute("rel", "noopener noreferrer");
    }
  };
  for (const child of Array.from(root.childNodes)) {
    if (child) visit(child);
  }
  return String(root.innerHTML);
}
