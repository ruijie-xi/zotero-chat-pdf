# PDF Markdown reading and original-image review

PDF reading uses on-demand, page-level Markdown transcription. The helper defaults to the current chat model with thinking disabled, or a separately selected saved visual-model profile. Original page images remain available through inspect_pdf_page for careful review. Local extracted text supports discovery and navigation. See [Page transcription](pdf-markdown-reading.md) for the cache, model and failure contracts.

## Workflow

1. Add a PDF to the session. Sources are ready for reading immediately; local file availability is checked when a tool reads them.
2. Use `search_pdf_text` with the default `mode=documents` for library discovery: one entry per matching PDF, match counts, known pages and representative snippets. Follow its cursor for exhaustive searches. Cumulative progress distinguishes completed traversal from unavailable or missing text. Use `mode=passages` with a returned `source_id` to inspect all matching passages in that PDF.
3. Add relevant library hits with `add_zotero_item_to_session`. Use `read_pdf_text` for page navigation when a flat Zotero index could not supply page numbers.
4. Read requested pages with `read_pdf_page`, which returns per-page Markdown, original citations and explicit errors. Choose `page`, ordered `pages`, or `start_page` plus `count` (default four, not a cap). Missing pages convert individually; valid cached pages require no model request. Use `inspect_pdf_page` for careful original-image review.
5. Before transcribing, checking or deriving an exact formula, read its region at high resolution. Verify subscripts, exponents, signs, fractions and matrix entries with surrounding definitions. If detail remains unclear, narrow the crop or report uncertainty; an overview is insufficient evidence for exact notation.
6. Cite returned `zotero://open-pdf/...?...page=` links. PDF page numbers are one-based and may differ from printed labels.

The harness enforces TurnScope before I/O and delivery. Removing a source cancels its session's active turn. Closing a window aborts its work. Page images are attached after tool responses, using OpenAI-compatible `image_url` with high detail. Image bytes remain out of saved chat history; restored contexts reread images when necessary.

## Model configuration

The PDF transcription selector uses the current chat configuration by default or a saved visual profile. It overrides thinking only for conversion. Missing selected profiles produce an explicit error on uncached reads; cached pages remain usable.

All enabled tools are offered without a visual-capability gate. Endpoint metadata is advisory; unknown or negative declarations do not block requests. The old `visionSupport` setting is ignored and its confirmation menu is removed.

If an image-bearing request receives an explicit HTTP 400/415/422 rejection of image input, the native agent removes images from its outgoing working context, preserves original history and completed tool receipts, and retries with text. `inspect_pdf_page` and `read_image` become unavailable for that live session and endpoint/model/account; the shared executor rejects stale calls. A visible notice explains the evidence limitation. Follow-up turns retain text mode. Changing model/account, refreshing model settings, clearing chat or reopening its saved session allows another attempt. The rejection cache is memory-only and never serializes credentials.

Markdown reading remains available, including with a separate visual helper. Conversion failure never marks the chat model as image-incompatible. The same fallback handles images in context compaction. Authentication, rate-limit, network, image decoding/format/size and generic request failures do not trigger it. The client cannot detect silent image stripping by an intermediary. External MCP hosts own their model requests and recovery; the MCP bridge continues to provide the enabled catalog and image results.

Token capacity, tokenizer estimate and per-image token reserve remain profile settings. A text-only API test does not establish visual understanding.

## Local extraction and rendering

PDF.js is bundled with Zotero. Text search uses its text layer or a fresh, fully indexed Zotero cache. Page-mapped text extraction has no model calls. Full-page browsing defaults to 200 DPI, JPEG quality 95. A caller may request 72–600 DPI. For small formulas or tables, use `page` plus `region: {x, y, width, height}` with a 600 DPI default; explicit DPI overrides either default. Region coordinates are fractions of the displayed page measured from its top-left corner; the region must fit within the page. Crops render directly from PDF vectors into a region-sized canvas, rather than enlarging a previous JPEG. Limits of 16 megapixels and 8192 pixels per side can reduce resolution; returned dimensions and effective DPI make that reduction explicit. The existing 10 MiB per-image limit remains; there is no cumulative image-byte quota per native turn or external call. Model context capacity and provider request limits still apply. No additional batch/page cap is imposed.

The renderer uses print scheduling so hidden windows do not stall waiting for animation frames. Print-specific optional content or annotations may differ from the visible reader.

Text and images use atomic, library-qualified caches. PDF file path, size and modification time invalidate stale caches; image resolution and normalized crop coordinates also form part of the versioned cache key. A batch reuses one renderer; overlapping callers serialize per document and reuse completed cache entries. After requested images are ready, up to two adjacent pages may be rendered locally in the background using the same renderer. Prefetch yields between pages to queued foreground reads, shares cancellation, never uploads speculative pages and closes the renderer on completion or failure. Text extraction records a SHA-256 digest. Files changed without changing size or modification time are not detected by the cache stamp.

External OCR engines and a dedicated scanned-document workflow remain deferred. Requested image-only pages can use the same vision transcription service. Scans without a text layer can still be rendered as images, but are not fully searchable. Empty text does not mean the page is blank. Transcription does not create a PDF text layer or add converted content to library-wide text search. The [deferred OCR research](local-ocr-options.md) records model sizes, formula benchmarks and hosted-service limitations; it is not an implementation plan.

## Rolling image context

Native chat uses a soft 20 MiB trigger and 10 MiB target for inline Base64 currently retained in a request. It replaces the oldest image occurrences already accepted in a completed provider response with fixed source/page/region references, preserving text, receipts and original archived events. Accepted delivery does not prove visual understanding. Fresh images are never removed by this window, even when they exceed its target or trigger; total reading across a turn remains unlimited. HTTP 413 first forces further old-image offload; new oversized batches use the existing same-model checkpoint recovery. External MCP hosts manage their own request histories.

Replacement changes the prefix at the first selected image. Batched offload leaves headroom, and one-way references remain unchanged on later requests or rereads. New views append new images instead of reinserting old bytes. This reduces the frequency of prefix changes; only provider-reported usage can establish cache hits. Fully offloaded active contexts can persist exactly; active binary images still require reconstruction after restart.

## Compatibility

Session schema v5 preserves source identities and messages while retiring old conversion states. Old converted files and saved preferences are not deleted from the user's cache/profile; the new page cache does not load or resume these legacy whole-document jobs. Standalone image paths remain compatible.

The native agent and companion Zotero MCP now use one registry and executor through the [shared tool channel](shared-tools.md). Protocol 2 returns Markdown through read_pdf_page and original images through inspect_pdf_page as MCP image content; the old v1 bridge and conversion operations are unsupported. Tool switches apply to both callers, default all enabled. External clients need matching builds and a refreshed tool list. See [Project status](project-status.md).

## Verification scope

Unit tests cover advisory capabilities, source scope, cancellation, labelled batches, region coordinates, effective DPI, image delivery beyond 20 MiB, file/resolution/crop cache invalidation, renderer reuse, local prefetch, legacy source migration, source removal, and bridge retirement. The standard repository gate is `npm run verify`. An isolated Zotero panel test with a local mock provider can verify actual PDF.js rasterization and image transport; it cannot certify a real model's mathematical reading accuracy.
