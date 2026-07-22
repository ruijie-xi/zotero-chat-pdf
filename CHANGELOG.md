# Changelog

[简体中文](CHANGELOG.zh-CN.md)

## Unreleased

## 0.8.5

### Fixed

- Remove the 50%-of-window maximum width so the ChatPDF side panel can be resized across the available Zotero workspace.
- Preserve normal native cursor navigation and avoid stealing focus from another editor when an asynchronous response or conversion-and-send flow finishes.

## 0.8.4

### New Features

- Add a read-only Zotero annotation agent tool that can list annotations or search highlighted text, comments, tags, and corresponding paper metadata.

### Fixed

- Validate release versions, XPI metadata, update URLs, compatibility bounds, and SHA-512 hashes before publishing; keep the fixed update-manifest release from replacing the latest user-facing release.

### Security

- Override the vulnerable transitive `adm-zip` dependency with version 0.6.0; `npm audit --audit-level=low` reports no known vulnerabilities.

## 0.8.3

### Fixed

- Read Firefox DNS callback results through `nsIDNSAddrRecord`, restoring `web_search` and `web_fetch` in Zotero 7 while retaining private-network validation.

### Security

- Replace regex-only Markdown cleanup with a DOM tag/attribute allowlist and regression tests for dangerous elements, event handlers, URL schemes, SVG, and privileged local images.
- Route web tools through a safe HTTP client that blocks local/private/reserved targets, revalidates redirects, checks DNS and MIME, enforces timeouts, and streams bounded responses.
- Default LLM debug logs to metadata-only mode, with explicit off/full options and retention cleanup.
- Update vulnerable transitive dependencies through reviewed package overrides; the production and development dependency audit now reports no known vulnerabilities.

### Changed

- Introduce library-qualified `libraryID:key` source identities, cache keys, and Zotero tool parameters while keeping legacy caches readable.
- Define per-turn source scope from editor mentions; turns without mentions use all session sources, and only in-scope pending conversions block sending.
- Propagate request cancellation through the LLM client, tools, web requests, MinerU polling/download/extraction, session mutations, and UI callbacks.
- Run read-only tool batches concurrently and all batches containing mutations serially in model order.
- Preserve complete current tool output and add explicit size/token estimates, while compacting old tool bodies into provenance records for later prompts.
- Add a configurable `contextMaxChars` budget that fails explicitly before provider submission.
- Replace module-global panel state with per-Zotero-window state and deterministic editor/listener/stream cleanup.
- Make session, history-index, document, chunk, and manifest writes serialized and atomic; rebuild missing/corrupt indexes and prevent deleted sessions from being resurrected by late background saves.
- Persist failed and cancelled assistant terminal states, and persist cleared or source-only sessions.
- Add configurable MinerU language and timeout settings with accurate stage-specific errors.
- Improve narrow-pane behavior with container queries, wrapping controls, and scrollable expanded tool results.

### Developer Experience

- Add TypeScript, ESLint, Vitest, CI, and the unified `npm run verify` command.
- Add regression tests for source identity/TurnScope, safe web access, Markdown sanitization, session restoration, and context budgeting.
- Rewrite the README as a concise user guide and maintain the contributor guide, LLM workflow, and changelog in matching English and Simplified Chinese versions.
- Add a real Zotero screenshot and clarify the project's personal-use scope and AI-assisted customization path.
- Remove obsolete Claude-specific files, roadmap/review artifacts, unused legacy code and exports, localization scaffolding, and template icons.

## 0.8.0

### New Features

- Add Zotero library agent tools for searching items, inspecting metadata, listing collections, reading the current selection, and adding/converting relevant PDFs from chat.
- Add clickable source chips so chat sources and message source snapshots can open their Zotero PDFs.
- Add a Windows `curl.exe` fallback for MinerU result ZIP downloads when Zotero fetch and Zotero.HTTP cannot reach the MinerU CDN.

### Changed

- Give the agent more autonomy to add and convert relevant Zotero PDFs while keeping broad conversion caution as guidance instead of a hard guard.
- Improve live agent rendering so streamed assistant text is not duplicated around tool-use blocks.
- Make Zotero library and collection matching more forgiving with partial, case-insensitive search.

## 0.7.0

### Fixed

- Preserve MinerU result ZIP assets beside each converted PDF so Markdown image links have matching local files.
- Fall back to Zotero.HTTP when Zotero fetch fails to download a completed MinerU result ZIP.
- Normalize MinerU ZIP asset paths before writing them so Windows Zotero builds do not reject slash-delimited relative paths.
- Store new conversions under `documents/<attachment-key>/document.md` while keeping older root-level Markdown caches readable.
- Add stage-specific MinerU network errors for upload URL requests, PDF uploads, result polling, and result ZIP downloads.
- Add MinerU host permissions for the API host, OSS upload host, and result CDN host.

### Changed

- Bump converted document manifests to version 2 so old chunk caches without assets are reconverted.
- Refresh the README to describe the current agent-only workflow, long-document tools, MinerU asset cache layout, and CDN troubleshooting.

## 0.6.0

### New Features

- Long PDF conversion through MinerU page-range chunks, with progress and cached chunk reuse so failed conversions can resume without starting over.
- Long-document chat tools for chunk listing, chunk reading, and document search, allowing the agent to navigate books and large converted PDFs without loading the entire document at once.

### Changed

- MinerU polling allows longer-running chunks and uses smaller page ranges for more reliable conversion of book-length PDFs.
- The agent prompt prefers search and chunk reads for long documents.

## 0.3.0

### New Features

- Persistent side panel that stays visible on the right side of the Zotero window.
- Background stream persistence so LLM generation can continue while you switch items or browse history.
- Stop button for MinerU conversions in progress.
- Message timestamps for user and assistant messages.
- Precise history timestamps.
- LLM-generated session titles after the first response in a new chat.
- Editable session titles in the history list.
- Per-message source snapshots displayed below user messages.
- Reader tab drag-and-drop support for adding sources.

### Fixed

- Preserve partial assistant responses in session history when generation is stopped mid-stream.

## 0.2.0

### New Features

- Editable system prompt in the preferences panel, with English and Chinese reset defaults.
- Edit and resend user messages.
- Copy assistant messages as raw Markdown.
- Collapsible reasoning/thinking block for compatible thinking models.
- Document size indicators on source chips.
- Total context usage summary below source chips.
- Resizable source area.
- Send guard for pending or converting sources.
- KaTeX rendering for LaTeX math delimiters.

### Changed

- Renamed preference `maxContextChars` to `maxDocumentChars` and raised the document content budget default to 300,000 characters.
- Added `[ChatPDF]` debug logging throughout the LLM pipeline.

### Fixed

- Fixed duplicate user messages in LLM requests by building messages before adding the current user message.
- Fixed stale DOM after edit-resend by re-rendering from session state.
- Fixed preference panel initialization timing by retrying until pane elements are available.
- Added clearer truncation feedback for large documents.

## 0.1.0

- Initial release.
