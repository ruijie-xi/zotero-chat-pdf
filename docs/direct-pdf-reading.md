# Direct PDF reading

ChatPDF reads original PDF pages with the current vision-capable chat model. There is no transcription stage, Markdown document cache, conversion queue, conversion profile, MinerU client, or automatic job recovery.

## Workflow

1. Add a PDF to the session. Sources are ready for reading immediately; local file availability is checked when a tool reads them.
2. Use `search_pdf_text` for library discovery. It returns inspected coverage, snippets and an explicit continuation cursor.
3. Add relevant library hits with `add_zotero_item_to_session`. Use `read_pdf_text` for page navigation when a flat Zotero index could not supply page numbers.
4. Read relevant original pages using `read_pdf_page(key, page, dpi?)`. Substantive summaries, formulas, proofs and figure/table interpretation must use these images.
5. Cite returned `zotero://open-pdf/...?...page=` links. PDF page numbers are one-based and may differ from printed labels.

The harness enforces TurnScope before I/O and delivery. Removing a source cancels its session's active turn. Closing a window aborts its work. Page images are attached after tool responses, using OpenAI-compatible `image_url` with high detail. Image bytes remain out of saved chat history; restored contexts reread images when necessary.

## Model configuration

The model and endpoint must accept images and tool calls. `visionSupport=auto` reads the endpoint's declared input modalities or vision capability. Unknown or unsupported capability blocks the turn before chat completion. If the endpoint omits metadata, the user can choose **Confirmed** after checking image support. This setting is saved with each model profile. No model-name heuristic claims support.

Token capacity, tokenizer estimate and per-image token reserve remain profile settings. A text-only API test does not establish visual understanding.

## Local extraction and rendering

PDF.js is bundled with Zotero. Text search uses its text layer or a fresh, fully indexed Zotero cache. Page-mapped text extraction has no model calls. Rasterization renders only requested pages, default 300 DPI, JPEG quality 95. A caller may request 72–300 DPI. Limits of 16 megapixels and 8192 pixels per side can reduce resolution; returned dimensions and effective DPI make that reduction explicit. Image input is limited to 10 MiB per image and 20 MiB per turn.

The renderer uses print scheduling so hidden windows do not stall waiting for animation frames. Print-specific optional content or annotations may differ from the visible reader.

Text and images use atomic, library-qualified caches. PDF file path, size and modification time invalidate stale caches; image resolution also forms part of the cache key. Text extraction records a SHA-256 digest. Files changed without changing size or modification time are not detected by the cache stamp.

OCR and a dedicated scanned-document workflow are outside the current scope (decision: 2026-10-20). Scans without a text layer can still be rendered as images, but are not fully searchable. Empty text does not mean the page is blank. There is no automatic OCR fallback. The [deferred OCR research](local-ocr-options.md) records model sizes, formula benchmarks and hosted-service limitations; it is not an implementation plan.

## Compatibility

Session schema v5 preserves source identities and messages while retiring old conversion states. Old converted files and saved preferences are not deleted from the user's cache/profile; runtime code no longer loads or resumes them. Standalone image paths remain compatible.

The native agent and companion Zotero MCP now use one registry and executor through the [shared tool channel](shared-tools.md). Protocol 2 returns original page images externally as MCP image content; the old v1 bridge and conversion operations are unsupported. Tool switches apply to both callers, default all enabled. External clients need matching builds and a refreshed tool list. See [Project status](project-status.md).

## Verification scope

Unit tests cover capability gating, source scope, cancellation, page citations, image delivery, file/resolution cache invalidation, legacy source migration, source removal, and bridge retirement. The standard repository gate is `npm run verify`. An isolated Zotero panel test with a local mock provider can verify actual PDF.js rasterization and image transport; it cannot certify a real model's mathematical reading accuracy.
