# Changelog

## Unreleased

### Fixed

- Preserve MinerU result ZIP assets beside each converted PDF so Markdown image links have matching local files.
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
