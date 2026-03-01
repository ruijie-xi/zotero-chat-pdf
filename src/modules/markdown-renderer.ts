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
 * LaTeX is converted to MathML (native Firefox rendering, no CSS/fonts needed).
 */
export function renderMarkdown(text: string): string {
  // Step 1: Extract and replace math blocks with placeholders
  const mathBlocks: { placeholder: string; html: string }[] = [];
  let counter = 0;

  // Display math first ($$...$$) — must come before inline
  let processed = text.replace(/\$\$([\s\S]+?)\$\$/g, (_match, latex) => {
    const placeholder = `%%MATH_BLOCK_${counter++}%%`;
    try {
      const html = katex.renderToString(latex.trim(), {
        displayMode: true,
        output: "mathml",
        throwOnError: false,
      });
      mathBlocks.push({ placeholder, html: `<div class="chatpdf-math-display">${html}</div>` });
    } catch {
      mathBlocks.push({ placeholder, html: `<code class="chatpdf-math-error">$$${latex}$$</code>` });
    }
    return placeholder;
  });

  // Inline math ($...$) — avoid matching $$ or escaped \$
  processed = processed.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (_match, latex) => {
    const placeholder = `%%MATH_BLOCK_${counter++}%%`;
    try {
      const html = katex.renderToString(latex.trim(), {
        displayMode: false,
        output: "mathml",
        throwOnError: false,
      });
      mathBlocks.push({ placeholder, html });
    } catch {
      mathBlocks.push({ placeholder, html: `<code class="chatpdf-math-error">$${latex}$</code>` });
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

  return html;
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
