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

  // Re-insert math blocks
  for (const { placeholder, html: mathHtml } of mathBlocks) {
    html = html.replace(placeholder, mathHtml);
  }

  // Sanitize and convert to XHTML
  html = sanitize(html);
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

function sanitize(html: string): string {
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  html = html.replace(/\s+on\w+\s*=\s*"[^"]*"/gi, "");
  html = html.replace(/\s+on\w+\s*=\s*'[^']*'/gi, "");
  html = html.replace(/href\s*=\s*"javascript:[^"]*"/gi, 'href="#"');
  html = html.replace(/href\s*=\s*'javascript:[^']*'/gi, "href='#'");
  return html;
}
