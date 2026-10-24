import { describe, expect, it } from "vitest";
import { renderMarkdown, renderMarkdownInto, sanitizeHtml } from "../src/modules/markdown-renderer";

describe("Markdown HTML sanitizer", () => {
  it("imports sanitized links and math without a privileged innerHTML assignment", () => {
    const target = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    Object.defineProperty(target, "innerHTML", { set() { throw new Error("Chrome innerHTML must not be used"); } });
    const href = "zotero://open-pdf/library/items/PDF12345?page=2&chatpdf_rects=%5B%5B10%2C20%2C30%2C40%5D%5D";
    renderMarkdownInto(target, `[Equation](${href})\n\n$x^2$ <img src=x onerror=bad()> <script>bad()</script> [Bad](javascript:alert)`);
    expect(target.querySelector("a")?.getAttribute("href")).toBe(href);
    expect(target.querySelector("a")?.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
    expect(target.querySelector(".katex")).not.toBeNull();
    expect(target.querySelector("[onerror], script, a[href^='javascript:']")).toBeNull();
    expect(target.textContent).not.toContain("bad()");
    renderMarkdownInto(target, "Replacement");
    expect(target.textContent).toBe("Replacement\n");
  });
  it("removes inline event handlers and styles", () => {
    const html = sanitizeHtml('<img src="https://example.com/a.png" onerror="x" style="display:none">');
    expect(html).toContain("https://example.com/a.png");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("style");
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

});
