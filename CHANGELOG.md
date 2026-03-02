# Changelog

## 0.2.0

### New features

- **Editable system prompt** — Customize the system prompt from the preferences panel. Includes English and Chinese defaults with one-click reset buttons.
- **Edit and resend messages** — Click the edit button on any user message to modify and resend it. The conversation is truncated from that point and the edited message is sent as a new request.
- **Copy assistant messages** — A copy button appears on hover over assistant responses, copying the raw Markdown to clipboard.
- **Collapsible reasoning/thinking block** — For thinking models (e.g. DeepSeek R1), reasoning tokens are displayed in a collapsible block with a live timer, separate from the main response.
- **Document size limit with smart truncation** — A new `Max Document Characters` setting (default: 300K chars) caps the total document content in the LLM system prompt. When documents exceed the budget, each is proportionally truncated with a clear marker showing where content was cut.
- **Source chip size indicators** — Each ready source chip now shows its character count (e.g. "85K"). Truncated documents show an orange badge with the included percentage (e.g. "85K (42%)").
- **Total context usage summary** — A summary line below the source chips shows total document size vs. the configured limit (e.g. "170K / 300K chars"). Turns red when over the limit.
- **Resizable source area** — Drag the handle between the messages area and sources to resize.
- **Send guard** — Cannot send a message while sources are still pending or converting. A warning is shown instead.
- **Math delimiter support** — LaTeX math expressions in LLM responses are rendered via KaTeX.

### Changed

- Renamed preference `maxContextChars` → `maxDocumentChars` with a new default of 300,000 (previously 100,000). The setting now controls the document content budget specifically.
- Debug logging throughout the LLM pipeline (`[ChatPDF]` prefix in Zotero error console).

### Fixed

- **User message duplication** — Fixed a critical bug where the user message was always included twice in the LLM request (once from history, once as the new message). `buildMessages()` is now called before `addUserMessage()`.
- **Edit-resend rendering** — Fixed stale messages remaining in the DOM after editing. The UI now re-renders from session state instead of surgical DOM removal.
- **Preference script timing** — Fixed the preference panel failing to initialize when DOM elements weren't ready. The script now retries until pane elements are in the DOM.
- Large documents could silently exceed the context limit with no feedback. Documents are now truncated to fit, with clear UI indicators.

## 0.1.0

Initial release.
