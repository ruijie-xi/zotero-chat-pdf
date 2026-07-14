# ChatPDF LLM and Tool Workflow

[简体中文](llm-workflow.zh-CN.md)

This document describes the agent-only workflow in the `0.8.0` working tree after the 2026-07-14 architecture remediation.

## Runtime Boundary

ChatPDF runs in Zotero's privileged Firefox chrome context, not Node.js.

- UI nodes must be valid XHTML or XUL.
- Local I/O uses `IOUtils` and `PathUtils`.
- Network calls use the runtime `fetch` implementation and Zotero-specific fallbacks already present in the code.
- Runtime modules must not assume Node globals or packages are available.
- MinerU and the configured OpenAI-compatible LLM provider are independent external services.

## Main Components

| Component | Responsibility |
| --- | --- |
| `hooks.ts` | Add-on startup/shutdown, preferences, menu registration, and window injection |
| `chat-panel.ts` | Side-panel DOM, toolbar, resizing, drag/drop, and session/source coordination |
| `panel-state.ts` | One `PanelState` per Zotero window: session, editor, streams, abort controllers, polling, and listeners |
| `send-handler.ts` | Turn scoping, send lifecycle, streaming UI, terminal states, autosave, and title generation |
| `agent-loop.ts` | LLM/tool iterations, safe tool scheduling, callbacks, and usage accumulation |
| `llm-client.ts` | OpenAI-compatible request construction, SSE parsing, tool fragments, and provider thinking fields |
| `tools.ts` | Tool schemas, risk metadata, validation, dispatch, and result accounting |
| `safe-web-client.ts` | Public HTTP(S) validation, redirect checks, timeout, MIME, and streamed byte limits |
| `chat-session.ts` | Session library, TurnScope messages, prompt construction, history, and schema-v2 serialization |
| `chat-history.ts` | Atomic session/index repository, index recovery, and deletion tombstones |
| `source-identity.ts` | Stable library-qualified source IDs and cache keys |
| `source-chips.ts` | Source UI, user-owned conversion lifecycle, stop, removal, and lazy cache loading |
| `mineru-client.ts` | PDF chunk planning, upload, polling, ZIP download/extraction, progress, and stage errors |
| `md-cache.ts` | Atomic document/chunk/manifest storage and legacy cache reads |
| `markdown-renderer.ts` | Markdown/KaTeX rendering, XHTML conversion, and DOM allowlist sanitization |
| `debug-log.ts` | Metadata/off/full debug logging and retention cleanup |

## Source Model

Every source has a stable ID:

```text
<libraryID>:<attachmentKey>
```

Legacy bare attachment keys are accepted only when they resolve uniquely. Cache directories use a filesystem-safe derivative of the stable ID. Old root-level and bare-key caches remain readable.

There are two distinct source sets:

- **SessionLibrary**: all sources currently attached to the chat session.
- **TurnScope**: the sources authorized for one user turn.

The editor returns both visible text and mention IDs. If the user includes source mentions, those IDs become the TurnScope. If no mentions are present, TurnScope defaults to the full SessionLibrary. Pending/converting guards apply only to the active TurnScope.

The user message persists a source snapshot for historical display. Reloading a session restores SessionLibrary from the serialized session source list, never from the last message snapshot.

## Send Lifecycle

`handleSend(root)` performs this sequence:

1. Resolve the window-owned `PanelState` and extract editor text plus source mentions.
2. Reject empty input and resolve TurnScope.
3. Reject only pending/converting sources required by that TurnScope.
4. Create a request ID and one `AbortController` owned by this send.
5. Build provider messages before appending the current user message, preventing duplication.
6. Save the user message with its TurnScope snapshot and persist immediately.
7. Register a background stream record and switch Send to Stop.
8. Run the agent loop with `ToolExecutionContext` containing session, TurnScope, signal, request ID, and window ID.
9. Stream reasoning, tool iterations, answer text, and usage to the active UI when that session remains visible.
10. Persist a completed, failed, or cancelled assistant terminal message.
11. Optionally generate the first-session title in a separate background call.
12. Restore controls and release stream ownership.

Switching sessions does not cancel a background response. Closing a window or disabling the add-on aborts work owned by that window and destroys its TipTap editor and listeners.

## Prompt Construction and Context Budget

The provider message order is:

```text
system instructions
prior user/assistant history
current user message
```

Converted PDFs are not embedded into the system prompt. The model reads them through tools.

The system prompt lists only the active TurnScope and teaches the model the available document/Zotero/web workflow. Current tool results are returned in full and persisted in the assistant iteration record. When an old assistant iteration is replayed in a later prompt, its full tool body is replaced by a provenance record containing the tool name, result size, and stable request/call identity. This avoids hidden result truncation while preventing indefinite prompt amplification.

`contextMaxChars` defaults to 240,000. Prompt construction fails locally with an explicit size error if the total would exceed the budget.

## Agent Loop and Tool Scheduling

`runAgentLoop()` reads `agentMaxIterations`, calls the model, and repeats until it receives final text or reaches the iteration cap.

For each tool-call batch:

- arguments are parsed and validated;
- tool metadata identifies read-only, session-mutating, network, and costly operations;
- an all-read-only batch may execute concurrently;
- any batch containing a mutation executes every call serially in model order;
- result messages are appended in original call order;
- abort errors leave the tool layer and terminate the turn instead of becoming model-visible error strings.

Provider replay preserves DeepSeek `reasoning_content` and Gemini thought-signature fields when present.

## Tool Families

### Document Tools

- `list_sources`
- `read_document`
- `list_document_chunks`
- `read_document_chunk`
- `search_document`

These tools accept stable source IDs and refuse sources outside TurnScope. Full-document reads and searches expose exact character counts and rough token estimates.

### Zotero Tools

- `search_zotero_library`
- `get_zotero_item`
- `list_zotero_collections`
- `list_collection_items`
- `get_current_zotero_selection`
- `add_zotero_item_to_session`
- `convert_session_source`
- `add_and_convert_zotero_item`

Lookup schemas support `library_id`. List/search tools do not silently impose hidden result caps; optional caller limits remain explicit.

### Web Tools

When enabled, `web_search` uses Brave if configured and otherwise the DuckDuckGo HTML fallback. `web_fetch` goes through `SafeWebClient`:

1. only HTTP(S) URLs are accepted;
2. credentials, localhost, loopback, private, link-local, multicast, reserved, and metadata addresses are rejected;
3. DNS answers are checked before a request;
4. redirects are handled manually and every target is revalidated;
5. a request timeout and redirect count apply;
6. only supported textual MIME types are accepted;
7. the body is streamed with a normal 5 MiB limit and a 25 MiB hard ceiling.

Oversized or unsafe responses fail explicitly. They are never silently shortened.

## Cancellation

The request signal reaches:

- streaming and non-streaming LLM requests;
- all agent tool handlers;
- safe web requests and body reads;
- MinerU upload URL requests, PDF upload, polling delays, result downloads, and extraction;
- session mutations and UI callbacks that follow those operations.

A conversion launched directly from a source chip has a separate controller owned by that chip and window. Removing the source aborts that controller.

## MinerU Conversion and Cache

The configurable defaults are language `ch` and timeout 15 minutes. PDFs up to 120 pages use one task; longer PDFs use resumable 25-page chunks. Each successful chunk is stored before the next begins.

```text
<cacheDir>/
  documents/<library-qualified-cache-key>/
    document.md
    manifest.json
    chunks/<index>.md
    attachments/full/...
    attachments/chunk-<index>/...
  history/
  debug-logs/
```

Document, chunk, manifest, session, and history-index writes use temporary files followed by atomic replacement. Errors retain their stage so upload, polling, ZIP download, and extraction failures remain distinguishable.

## Rendering and Debug Privacy

Assistant Markdown is parsed by `marked`, math is rendered through KaTeX placeholders, and the HTML is normalized for XHTML. A DOM allowlist then removes disallowed elements, event/style attributes, dangerous protocols, namespaced attack surfaces, and privileged local image URLs before the result enters `innerHTML`.

Debug log modes:

- `metadata` (default): request/session correlation, sizes, model, timing, status, and usage without prompt/answer bodies;
- `off`: no request files;
- `full`: explicit diagnostic mode that may contain sensitive prompts, answers, reasoning, and tool results.

Old logs are cleaned according to `debugLogRetentionDays` (default 7).

## Verification

Run the complete local gate with:

```bash
npm run verify
npm audit --audit-level=low
```

The isolated Zotero smoke test validates temporary add-on installation and real panel behavior without accessing the user's normal profile or credentials. Provider and MinerU network behavior still requires explicit credentialed test runs.
