import { describe, expect, it } from "vitest";
import { renderMarkdown, sanitizeHtml } from "../src/modules/markdown-renderer";

describe("Markdown HTML sanitizer", () => {
  it("removes scripts and their content", () => {
    const html = sanitizeHtml("<p>safe</p><script>alert(1)</script>");
    expect(html).toContain("safe");
    expect(html).not.toContain("script");
    expect(html).not.toContain("alert");
  });

  it("removes inline event handlers and styles", () => {
    const html = sanitizeHtml('<img src="https://example.com/a.png" onerror="x" style="display:none">');
    expect(html).toContain("https://example.com/a.png");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("style");
  });

  it("blocks javascript links", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">click</a>')).not.toContain("href");
  });

  it("blocks encoded whitespace javascript links", () => {
    expect(sanitizeHtml('<a href="java\nscript:alert(1)">click</a>')).not.toContain("href");
  });

  it("keeps public links and adds rel protection", () => {
    const html = sanitizeHtml('<a href="https://example.com">paper</a>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("drops SVG and iframe payloads", () => {
    const html = sanitizeHtml("<svg><a>bad</a></svg><iframe src='https://example.com'></iframe><p>ok</p>");
    expect(html).toBe("<p>ok</p>");
  });

  it("unwraps unknown harmless elements", () => {
    expect(sanitizeHtml("<custom><strong>text</strong></custom>")).toBe("<strong>text</strong>");
  });

  it("keeps safe raster data images", () => {
    expect(sanitizeHtml('<img src="data:image/png;base64,AAAA" alt="x">')).toContain("data:image/png;base64,AAAA");
  });

  it("renders XHTML-safe void tags", () => {
    expect(renderMarkdown("line 1\n\n---\n\nline 2")).toContain("<hr/>");
  });

  it("renders local KaTeX after sanitizing model HTML", () => {
    const html = renderMarkdown("Equation $E=mc^2$ <script>bad()</script>");
    expect(html).toContain("katex");
    expect(html).not.toContain("script");
    expect(html).not.toContain("bad()");
  });
});
