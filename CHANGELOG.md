# Changelog

## 0.2.0

### New features

- **Document size limit with smart truncation** — A new `Max Document Characters` setting (default: 300K chars) caps the total document content embedded in the LLM system prompt. When documents exceed the budget, each is proportionally truncated rather than silently omitted, with a clear marker showing where content was cut.
- **Source chip size indicators** — Each ready source chip now shows its character count (e.g. "85K"). If a document was truncated, the chip turns orange and shows the included percentage (e.g. "85K (42%)").
- **Total context usage summary** — A summary line below the source chips shows total document size vs. the configured limit (e.g. "170K / 300K chars"). Turns red when documents exceed the limit.

### Changed

- Renamed preference `maxContextChars` → `maxDocumentChars` with a new default of 300,000 (previously 100,000). The setting now specifically controls the document content budget rather than the overall API request size.

### Fixed

- Previously, two large papers could silently exceed the context limit with no feedback. Documents are now always truncated to fit, and the UI clearly shows how much of each document is included.

## 0.1.0

Initial release.
