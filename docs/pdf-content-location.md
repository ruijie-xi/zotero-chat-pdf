# PDF content location and region citations

`locate_pdf_content` finds a literal phrase, theorem heading, equation number or caption in a session PDF. It returns all matches with original text, up to 100 context characters on either side, PDF page numbers, printed page labels when available, PDF-space rectangles, normalized crop regions, and citations. Native chat and MCP use the same schema and executor. The tool is read-only, local, enabled by default, and subject to TurnScope, source revocation and cancellation.

```json
{"key":"1:PDF12345","query":"Theorem 3.2","page":8}
```

The optional one-based `page` avoids full-document text extraction. Without it, the existing revision-aware page text cache supplies candidate pages; a flat Zotero index is upgraded to page-mapped PDF.js text when necessary. Coordinate extraction runs only on candidate pages and uses a separate atomic `pdf-locations/<source>/page-<n>.json` cache. Warm calls reuse geometry across queries, chats and MCP sessions. PDF changes invalidate caches. No vision-model call, page rasterization, external OCR, embedding model, or persistent annotation is required for location.

Matching normalizes case, whitespace, NFKC compatibility ligatures, soft hyphens, and line-end hyphenation while retaining offsets into the original extracted text. It is not semantic or arbitrary fuzzy search. Use keywords to discover a relevant passage, then locate a distinctive phrase from it. Several occurrences remain separate alternatives; no occurrence-count limit is applied. Results disclose pages without extractable text. An empty match set is not proof that image-only content is absent.

Coordinates cover complete PDF text items. They do not promise character-level selection, paragraph segmentation, or the extent of a whole equation/figure whose number/caption matched. Unusable or vertical text geometry yields a page-only result. Multiple lines retain separate rectangles. Inspection regions include a two-point margin, clipped to the page, while highlights retain item bounds. Regions are measured from the top-left of the displayed, rotated page and can be passed directly to `inspect_pdf_page`. That tool also returns a region citation for an explicitly requested crop. Search results remain navigation aids; inspect original images when verifying formulas or ambiguous content.

## Link behavior

Ordinary page links keep Zotero's `zotero://open-pdf/.../items/<key>?page=<n>` format. ChatPDF adds URL-encoded `chatpdf_rects` (PDF-space rectangles) or `chatpdf_region` (normalized crop), and locator citations include `chatpdf_revision`, a SHA-256 token of local file revision metadata with no path exposed. Copy returned links unchanged. The plugin resolves the library-qualified attachment, validates the target against page bounds, and calls Zotero Reader with `position: {pageIndex, rects}`. The reader scrolls and briefly highlights without saving an annotation. Changed-file locator links report an error and request a new lookup rather than highlighting stale coordinates.

Page-only links need no geometry extraction. Region links are an extension handled by ChatPDF's chat click handler; other MCP host chat renderers or external applications are not guaranteed to support them and may open only the page. The companion MCP transport needs no duplicated implementation, but clients must refresh their discovered catalog.

Assistant messages import the existing sanitizer's output as DOM nodes. Zotero's privileged `innerHTML` setter otherwise removes even allowlisted `zotero:` addresses. The tag, attribute and URL scheme allowlists remain unchanged, and KaTeX remains locally generated.

## Verification scope

Unit tests cover normalization with original offsets, repeated and cross-line matches, crop origins and page rotation, invalid geometry and links, cache reuse/invalidation, cancellation, source removal, disabled tools and the shared catalog. Native acceptance and its measured timing are recorded in `docs/project-status.md` after running the isolated Zotero fixture. Synthetic fixtures establish transport and navigation behavior; they do not establish extraction accuracy for every PDF font or layout.
