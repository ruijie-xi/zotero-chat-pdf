# Changelog

## 0.6.0

### New features

- **Long PDF conversion** - Large PDFs are converted through MinerU page-range chunks, with progress and cached chunk reuse so failed conversions can resume without starting over.
- **Long-document chat tools** - Added chunk listing, chunk reading, and document search tools so the agent can navigate books and other large converted PDFs without loading the entire document at once.

### Changed

- MinerU polling now allows longer-running chunks and uses smaller page ranges for more reliable conversion of book-length PDFs.
- The agent prompt now prefers search and chunk reads for long documents.

## 0.3.0

### New features

- **Persistent side panel** — The chat panel is now always visible on the right side of the Zotero window, independent of which item is selected. No more losing the panel when clicking another item.
- **Background stream persistence** — LLM generation continues running in the background when you switch items or browse history. Navigate back to the session to re-attach to the live stream and see the response as it arrives.
- **Stop MinerU conversion** — A "Stop" button appears on source chips while conversion is in progress. Stopping returns the source to pending status so it can be re-converted. Removing a converting source also cancels the conversion automatically.
- **Message timestamps** — Each user and assistant message shows a `hh:mm` timestamp beneath the bubble.
- **Precise history timestamps** — Session history now shows full timestamps ("Today 14:30", "Yesterday 09:15", "3 days ago 16:42", "Jan 15 10:00") instead of just the day.
- **LLM-generated session titles** — After the first response in a new chat, the LLM automatically generates a concise, language-aware title (max 50 chars). If you edit and resend the first message, the title is regenerated. Title source is tracked (`auto` / `llm` / `user`).
- **Editable session titles** — A pencil icon appears on hover in the history list. Click to edit the title inline; Enter to save, Escape to cancel. User-edited titles are never overwritten by auto-generation.
- **Per-message sources** — Sources are now snapshotted at send time and stored with each user message. Small pill chips below each user bubble show which documents were in context for that message. Sources are no longer cleared from the source area after sending.
- **Tab drag to source area** — Dragging the PDF reader tab from Zotero's tab bar now correctly adds the item to the source area. The drop handler tries multiple data formats (`zotero/tab`, `zotero/item`, `text/x-moz-url`, URI patterns) and falls back to the currently active reader tab.

### Fixed

- Save partial LLM response to session history when generation is stopped mid-stream, so the partial reply is preserved across sessions.

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
