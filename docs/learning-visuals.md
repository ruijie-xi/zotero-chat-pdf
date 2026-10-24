# Static drawing tools

`create_visual` and `update_visual` produce static images directly in chat, outside collapsed tool details. Click an image to enlarge it, inspect/copy its drawing source, or save PNG, SVG and source files. The viewer has a single layout. There is no gallery, parameter control, playback, state attachment, HTML widget or model-authored JavaScript runtime. The surrounding chat carries the explanation.

## Formats and limits

- SVG supports shapes, text, gradients and internal definitions/references. A dedicated sanitizer rejects executable elements, animation, external references, images, foreignObject and CSS blocks. The ordinary Markdown sanitizer is unchanged.
- Mermaid uses bundled 12.2.0 in strict mode with HTML labels and configuration directives disabled. Presentation styles are flattened inside the sandbox and decorative filters omitted.
- TikZ uses the unmodified upstream TikZJax bundle, local WASM/core and 140 BaKoMa fonts, with a separate terminable compiler worker. No local TeX installation, external compiler or network service is used. Only one compilation runs at once: its 2500-page WASM memory alone is approximately 156 MiB. The preloaded environment has finite package/font coverage; it does not supply arbitrary packages, external files or full CJK support. SVG labels can use Chinese system fonts.

Explicit limits: 256000 source characters, 10000 SVG elements / 100 nesting levels, 1000 Mermaid edges and 60 seconds per TikZ compilation. Excessive/invalid input is rejected, never silently truncated. PNG previews have a maximum dimension of 1600 pixels; vector SVG and original sources remain available. SVG exports embed the required bundled TeX fonts. Export uses the saved image version without rerunning a model.

## Versions, sources and compatibility

The shared native/MCP registry exposes `create_visual`, `read_visual`, `update_visual` and `inspect_visual`. New drawings accept only `svg`, `mermaid` and `tikz`. Updates require an exact expected version; failed renders retain the previous version. Historical messages reference immutable versions. Complete source is available through `read_visual(include_source=true)`. `inspect_visual(preview=true)` delivers an actual rendered PNG for model inspection; successful rendering does not verify scientific claims.

Images and versions remain in the optional schema-6 `visuals` field of the atomic session file. Clear, source removal and history editing revoke outstanding renders. Citations must be in the current TurnScope before and after rendering; historical images cannot restore removed sources. Illustrative examples and paper data retain distinct labels, and paper data requires original-page citations.

Earlier interactive/HTML versions restore as `snapshot` records using their saved creation-time image. Their original source remains available to the model for a requested redraw, but is never executed. Old controls, mutable reader state and layout choices are discarded. `snapshot` is restore-only and cannot be created through tools. Sessions without drawings continue to open normally.

## Renderer and MCP

Fixed public renderer assets use the content-accessible `chrome://chatpdf-visual/` package; other resources retain their registration. A trusted shell embeds an opaque-origin sandbox connected by a private MessageChannel. Its CSP denies network, forms, objects and nested frames. SVG is sanitized and TikZ runs in a terminable worker. Closing/cancellation removes the temporary renderer. Viewing a saved image creates no live renderer. Raw model markup never enters Zotero's privileged DOM.

MCP returns complete text and PNG content plus compact structured drawing identifiers. There is no MCP App resource, UI metadata, SDK or custom external interface. Compatibility resource listing is empty for previously connected adapters. The companion adapter remains a thin transport. Reconnect existing external MCP clients after updating it.

## Validation

`npm run verify` checks both privileged/browser TypeScript targets, lint, domain/security tests and the production package. Tests cover immutable versions, failed updates, source scope, cancellation, legacy snapshot migration, removed-format rejection and malicious SVG rejection. Companion tests cover untruncated text/image delivery without App resources.

Isolated Zotero acceptance uses separate profile/data/cache directories, dummy credentials and synthetic diagrams. Evidence is under `.scaffold/static-visual-work/`. This validates runtime/UI behavior, not the scientific correctness of future model-generated drawings.
