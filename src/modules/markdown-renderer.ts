import { Marked } from "marked";
import katex from "katex";

const marked = new Marked();

// Configure marked for safe output
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
    // If rendering fails, return escaped plain text so the answer is never lost
    Zotero.debug(`[ChatPDF] Markdown render error: ${err}`);
    return escapeXml(text).replace(/\n/g, "<br/>");
  }
}

function renderMarkdownUnsafe(text: string): string {
  // Step 1: Extract and replace math blocks with placeholders
  const mathBlocks: { placeholder: string; html: string }[] = [];
  let counter = 0;

  // Display math first ($$...$$) — must come before inline
  let processed = text.replace(/\$\$([\s\S]+?)\$\$/g, (_match, latex) => {
    const placeholder = `%%MATH_BLOCK_${counter++}%%`;
    try {
      const html = katex.renderToString(latex.trim(), {
        displayMode: true,
        output: "html",
        throwOnError: false,
      });
      mathBlocks.push({ placeholder, html: `<div class="chatpdf-math-display">${html}</div>` });
    } catch {
      mathBlocks.push({ placeholder, html: `<code class="chatpdf-math-error">$$${escapeXml(latex)}$$</code>` });
    }
    return placeholder;
  });

  // Inline math ($...$) — avoid matching $$ or escaped \$
  processed = processed.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (_match, latex) => {
    const placeholder = `%%MATH_BLOCK_${counter++}%%`;
    try {
      const html = katex.renderToString(latex.trim(), {
        displayMode: false,
        output: "html",
        throwOnError: false,
      });
      mathBlocks.push({ placeholder, html });
    } catch {
      mathBlocks.push({ placeholder, html: `<code class="chatpdf-math-error">$${escapeXml(latex)}$</code>` });
    }
    return placeholder;
  });

  // Step 2: Render markdown
  let html = marked.parse(processed) as string;

  // Step 3: Re-insert math blocks
  for (const { placeholder, html: mathHtml } of mathBlocks) {
    html = html.replace(placeholder, mathHtml);
  }

  // Step 4: Sanitize — strip dangerous tags/attributes
  html = sanitize(html);

  // Step 5: Make output XHTML-safe
  // Zotero uses XHTML namespace where innerHTML requires well-formed XML.
  // marked outputs HTML5 void elements (<br>, <hr>, <img ...>) which are
  // not valid XHTML. Convert them to self-closing form.
  html = toXhtml(html);

  return html;
}

/**
 * Convert HTML5 void elements to XHTML self-closing form.
 * e.g. <br> → <br/>, <hr> → <hr/>, <img src="..."> → <img src="..."/>
 */
function toXhtml(html: string): string {
  // Self-close void elements that aren't already self-closed
  const voidTags = "area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr";
  // Match <tag ...> that doesn't already end with />
  const re = new RegExp(`<(${voidTags})(\\s[^>]*?)?\\/?>`, "gi");
  return html.replace(re, (_match, tag, attrs) => {
    return `<${tag}${attrs || ""}/>`;
  });
}

/**
 * Escape text for safe inclusion in XML/XHTML.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Simple HTML sanitizer: remove script tags, on* event attributes, and javascript: URLs.
 */
function sanitize(html: string): string {
  // Remove <script> tags
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  // Remove on* event handlers
  html = html.replace(/\s+on\w+\s*=\s*"[^"]*"/gi, "");
  html = html.replace(/\s+on\w+\s*=\s*'[^']*'/gi, "");
  // Remove javascript: URLs
  html = html.replace(/href\s*=\s*"javascript:[^"]*"/gi, 'href="#"');
  html = html.replace(/href\s*=\s*'javascript:[^']*'/gi, "href='#'");
  return html;
}
