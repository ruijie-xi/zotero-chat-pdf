# ChatPDF LLM and Tool Workflow

This document describes the agent-only workflow in the `0.9.x` working tree. See [Agent capabilities](agent-capabilities.md) for document representations, library editing guarantees and prefix-cache behavior.

## Runtime Boundary

ChatPDF runs in Zotero's privileged Firefox chrome context, not Node.js.

- UI nodes must be valid XHTML or XUL.
- Local I/O uses `IOUtils` and `PathUtils`.
- Network calls use the runtime `fetch` implementation and Zotero-specific fallbacks already present in the code.
- Runtime modules must not assume Node globals or packages are available.
- A visual helper transcribes requested PDF pages to cached Markdown; the chat model inspects original images for careful review. PDF.js text extraction remains local retrieval.

## Main Components

Provider selection uses `llmProvider` (`custom`, `deepseek`, or `opencode-go`) and is stored with each model profile. Missing or unknown values remain custom, preserving legacy endpoints and credentials. Built-in providers resolve to their fixed HTTPS endpoints in the UI and transport; custom retains the editable OpenAI-compatible base. Switching providers isolates in-pane drafts, including keys and token overrides; saved profiles persist those configurations across restarts.

`llm-provider.ts` supplies shared request headers. Go sends the honest `ChatPDF/<version>` user agent and the persisted `ChatSession.id` in `x-opencode-session` for agent steps, retries, compaction and title generation. API tests and metadata refreshes use separate stable pane-local IDs. No client is impersonated. [OpenCode Go documentation](https://opencode.ai/docs/go/#where-can-i-use-it) targets coding-agent traffic; paper-reading acceptance has not been validated.

Go's public `/models` response currently omits token capacities. For the exact supported DeepSeek IDs only, the bundled fallback uses 1,000,000 context tokens and 384,000 maximum output tokens from OpenCode's [models.dev provider catalogue](https://github.com/anomalyco/models.dev/tree/dev/providers/opencode-go/models), including inherited [V4.1 Flash](https://github.com/anomalyco/models.dev/blob/dev/models/deepseek/deepseek-v4.1-flash.toml), [V4 Flash 0731](https://github.com/anomalyco/models.dev/blob/dev/models/deepseek/deepseek-v4-flash-0731.toml) and [Vision Exp](https://github.com/anomalyco/models.dev/blob/dev/models/deepseek/deepseek-v4-flash-vision-exp.toml) limits (checked 2026-10-03). This source is displayed as `provider-preset`; endpoint capacity metadata and manual overrides take precedence. These are catalogue values, not authenticated capacity measurements. Go selects explicit local tokenizer estimation; no remote tokenizer receives conversation text. Unknown models still require explicit limits and estimation mode. Known Go DeepSeek models share the automatic 1,024-token per-image estimate; other non-official endpoints require an explicit per-image reserve. Provider-reported usage calibrates later requests.

| Component | Responsibility |
| --- | --- |
| `hooks.ts` | Add-on startup/shutdown, preferences, menu registration, and window injection |
| `chat-panel.ts` / `chat-view.ts` | Window injection, resizing and cleanup; panel construction and event coordination |
| `panel-state.ts` | One `PanelState` per Zotero window: session, editor, streams, abort controllers and cleanup |
| `send-handler.ts` / `turn-stream.ts` | Turn scope and lifecycle, canonical stream callbacks, cancellation and terminal state persistence |
| `assistant-message-view.ts` / `message-renderer.ts` | Shared historical/live/restored message presentation, coalesced stream updates and view disposal |
| `message-editor.ts` / `usage-view.ts` / `tool-message-view.ts` | Edit intents, expandable usage totals, tool results and undo receipts |
| `session-persistence.ts` | Autosave and asynchronous title generation |
| `session-sources.ts` / `chat-input-sources.ts` | Source additions, mentions, paste, file input and drag/drop |
| `agent-loop.ts` | LLM/tool iterations, safe tool scheduling, callbacks, and usage accumulation |
| `llm-client.ts` | OpenAI-compatible request construction, SSE parsing, tool fragments, and provider thinking fields |
| `llm-transport.ts` | Bounded recovery before response data, cancellation, and transport failure diagnostics |
| `tool-registry.ts` / `tool-settings.ts` | One ordered schema catalog and individual enable/disable switches, shared with MCP |
| `tools.ts` / `tool-validation.ts` | Shared validation, authorization, dispatch and result accounting |
| `research-tools.ts` | PDF discovery/evidence and library-edit dispatch |
| `pdf-text.ts` | Local PDF text/page caches, index reuse, revision-aware search and continuation |
| `pdf-locations.ts` | Scoped local phrase location, candidate-page geometry caches and citation target resolution |
| `pdf-location-geometry.ts` | Normalized text/offset matching and PDF/rotated-page coordinate transforms |
| `library-changes.ts` | Captured edit scope, transaction preflight, durable receipts and conflict-safe undo |
| `library-approval.ts` | Trusted batch review of concrete changes or reversals |
| `source-citation.ts` | Validated library-qualified PDF page/region links and native reader routing |
| `safe-web-client.ts` | Public HTTP(S) validation, redirect checks, timeout, MIME, and streamed byte limits |
| `chat-session.ts` | Session library, TurnScope messages, prompt construction, history, and schema-v5 serialization |
| `chat-history.ts` | Atomic session/index repository, index recovery, and deletion tombstones |
| `source-identity.ts` | Stable library-qualified source IDs and cache keys |
| `source-chips.ts` | Stable source UI, opening, removal and cancellation |
| `chatpdf-bridge.ts` / `tool-channel.ts` | Protocol 2 tool transport, isolated external sessions, images, result memory and cancellation |
| `pdf-renderer.ts` | Private Zotero PDF.js realm, page rasterization, bounded initialization and disposal |
| `markdown-renderer.ts` | Markdown/KaTeX rendering, XHTML conversion, and DOM allowlist sanitization |
| `debug-log.ts` | Metadata/off/full debug logging and retention cleanup |

## Chat Presentation and Lifecycle

Saved messages, current replies and restored background replies use the same assistant view. Completed iteration nodes and disclosure state remain stable while new text arrives. Stream callbacks update one canonical record; the attached view coalesces text updates, while a separate timer only refreshes elapsed thinking time. Disposing a view releases its timers without cancelling a background turn.

Editor submission and inline message/title editing ignore composing keys, including legacy IME key code 229. Editing a running turn waits for cancellation to persist before truncating and resending. Background completion may release only its own controller; asynchronous chat loads reject stale results. Terminal errors and cancellations survive reopening, and a view failure does not prevent saving or releasing a completed turn.

The panel keeps navigation in the header, source controls above the composer and token totals in expandable details. Expansion retains complete provider counters. Scroll following is based on the reader's position before text or viewport changes.

## Transport Recovery

Chat completion transport failures before any model data are retried at most twice, after one and two seconds, using the same request body, generation settings and conversation ID. HTTP rejections and unrelated errors are not retried. Once any SSE JSON data has arrived (including reasoning or tool fragments), a network failure terminates the request and preserves partial output instead of replaying it. Cancellation interrupts retry waits and response reads. Metadata logs record the endpoint host, model, attempt, connection/response phase and retry decision without headers or conversation text. Failed turns display their error in the existing assistant bubble and remain persisted terminal states.

## Source Model

Every source has a stable ID:

```text
<libraryID>:<attachmentKey>
```

Legacy bare attachment keys are accepted only when they resolve uniquely. Cache directories use a filesystem-safe derivative of the stable ID. Standalone image cache paths remain compatible; obsolete converted document caches are not read.

There are two distinct source sets:

- **SessionLibrary**: all sources currently attached to the chat session.
- **TurnScope**: the sources authorized for one user turn.

The editor returns both visible text and mention IDs. If the user includes source mentions, those IDs become the TurnScope. If no mentions are present, TurnScope defaults to the full SessionLibrary. New sources are ready for direct reading. The agent can inspect availability and request text or page images within TurnScope.

The user message persists a source snapshot for historical display. Reloading a session restores SessionLibrary from the serialized session source list, never from the last message snapshot.

## Send Lifecycle

`handleSend(root)` performs this sequence:

1. Resolve the window-owned `PanelState` and extract editor text plus source mentions.
2. Reject empty input and resolve TurnScope.
3. Capture the UI-selected library edit mode, library, items and collection subtree for this turn.
4. Create a request ID and one `AbortController` owned by this send.
5. Build provider messages before appending the current user message, preventing duplication.
6. Save the user message with its TurnScope snapshot and persist immediately.
7. Register a background stream record and switch Send to Stop.
8. Run the agent loop with `ToolExecutionContext` containing session, TurnScope, signal, request ID, window ID, captured library access and a trusted-review callback.
9. Stream reasoning, tool iterations, answer text, and usage to the active UI when that session remains visible.
10. Persist a completed, failed, or cancelled assistant terminal message.
11. Optionally generate the first-session title in a separate background call.
12. Restore controls and release stream ownership.

Switching sessions does not cancel a background response. Closing a window or disabling the add-on aborts work owned by that window and destroys its TipTap editor and listeners.

## Prompt Construction and Context Budget

The provider message order is:

```text
stable, source-independent system instructions
prior user/assistant history
current TurnScope metadata + user message
```

PDFs are not embedded into the system prompt. The model requests original pages through tools.

Installed plugin source is also loaded on demand through `list_plugin_source`, `search_plugin_source` and `read_plugin_source`. A build hook packages an allowlisted, versioned source snapshot at `content/source-snapshot.json`; tools expose only its exact entries, with build identity, file hashes, line ranges and explicit search pagination. This local read-only capability is independent of document and edit scope. The debugging instructions require distinguishing source-based hypotheses from reproduced failures and verified repairs; no arbitrary file reader or code modification tool is provided.

The stable system prompt permits text-based reading and summaries, requests page images for visual details, and requires identifying the evidence used and its limits. There is no transcription stage. Scope and library edit authority appear in the current user message; tool definitions remain stable. Compatible follow-up turns append immutable exchanges; incompatible old tool schemas trigger reconstruction while preserving the visible transcript.

Model limits are resolved for the exact endpoint, account and model: explicit profile token overrides take precedence over endpoint `/models` metadata. Metadata is cached for 24 hours in memory and can be refreshed from Preferences. Limits are frozen for each turn. Unknown capacity requires explicit token settings; old character-limit preferences are ignored.

Model capacity, generation policy, and input planning are separate. `generation-policy.ts` resolves a per-request generation allowance before input is examined. An explicit `requestedOutputTokens` value is a user ceiling for all requests and retries, including reasoning; invalid overrides fail validation. Automatic mode uses the full resolved model output maximum from endpoint metadata or an explicit capacity override, regardless of thinking mode or effort. The plugin imposes no additional generation ceiling and does not fall back to a smaller provider default. Unknown endpoints follow the same policy once their capacity and tokenizer requirements are satisfied. The explicit thinking-off switch suppresses a saved effort value. Raw model metadata is cached, but policy is recomputed for each settings snapshot. DeepSeek requires an explicit `max_tokens` to exceed its default, and still enforces its service maximum; see the [Chat Completions specification](https://api-docs.deepseek.com/api/create-chat-completion/) (verified 2026-09-29).

For a shared window C, resolved generation allowance O, optional input limit I, and safety margin M, the input budget is `min(I, C - O) - M`. The safety margin is 2% of the model window (at least 128 tokens). Separate input/output limits are handled independently. Input pressure never silently shrinks O: compact completed exchanges or deliver paged tool results; if an indivisible exchange cannot fit, preserve history and report the capacity conflict. Automatic compaction starts at 80% of this input budget, or earlier if the checkpoint instruction would not fit. A checkpoint must reduce context and leave the result below 55% of the input budget. Titles and checkpoints retain the selected thinking policy and generation allowance; their short visible-text targets are separate. A truncated title is not committed. The usage bar and Preferences distinguish generation allowance from actual consumption and model maximum.

The bundled official DeepSeek V4 BPE vocabulary runs locally in pure JavaScript. The request counter includes message envelopes, tools, arguments and replay fields; complete-field memoization never changes provider bytes. Request totals are explicitly labeled estimates because server templates are not public. Provider prompt usage calibrates the estimate upward for the same turn; cached input still occupies context. Unsupported models require explicitly selecting the approximate tokenizer mode. Official DeepSeek V4 images reserve the documented 1,024-token upper bound per image; other models require an explicit reserve. Image base64 size is never treated as model tokens. Exact text retrieval cursors still use characters.


Compaction uses the same model, system prompt, and ordered tool definitions, appending a task-independent checkpoint instruction. Its tools are never dispatched. Generated memory preserves objectives, constraints, outcomes, pending work, evidence references, and uncertainty. Program-maintained unread-result ranges and operation receipts survive independently of summary wording. After compaction, a new stable prefix is built; the first resumed request may miss cache. Recent complete exchanges may remain verbatim when they fit the retained-context target; provider-signed/reasoning replay is not moved across a changed prefix. All tool bodies remain recoverable from the result archive.

A checkpoint response ending with `finish_reason: length` is retried with the exact same messages, tools, model, and thinking settings while the complete larger allowance fits. Automatic allowances can grow to the model maximum; explicit user ceilings never grow. If more generation space is needed, complete exchanges are repartitioned into smaller groups without shrinking the allowance. Each group has at most three generation attempts, with at most three partition passes. All attempt usage is counted; truncated drafts are never committed as checkpoints. Exhaustion retains the original history and working state. Sanitized per-request metadata records model/mode, policy source, initial and actual allowance, model maximum, input estimate/budget, finish reason, and provider usage for agent, checkpoint, and title calls.

Results too large for immediate delivery are stored completely and represented by an explicit result ID. `read_tool_result` returns exact, zero-based, end-exclusive character pages and the next cursor; page size adapts to working capacity. It checks both current session membership and TurnScope. No fixed 80,000-character result limit or cumulative reading quota remains. Full result bodies are stored once in `agentContext.results`; UI iteration history and exact provider events are hydrated from references when a session is loaded. Compaction changes the active event view, not the full transcript. Binary images are never serialized; restoring a working view containing images requires reconstruction and explicit image rereading.

Sessions write schema v5 and agent context v2. Old tool histories normalize once into iteration records. The first save of a pre-v4 session atomically backs up its original bytes under the same private cache before replacing it; deleting the session also deletes that migration backup. Historical `inputChars` metadata remains historical data and is never relabeled as tokens.

Provider-reported usage is retained for agent and compaction requests and accumulated for each assistant turn. The footer sums all stored usage in the current session, including terminal cancelled/error turns when the provider returned usage and session-owned auxiliary calls such as title generation. It reports cache hit tokens, miss tokens, and the weighted hit percentage. Individual assistant messages continue to show their own turn totals. Context request records distinguish agent work from compaction and record the context generation, input-size estimate, and provider usage for cache diagnostics.

## Agent Loop and Tool Scheduling

`runAgentLoop()` continues until final text by default (`agentAutoContinue=true`). Stop remains available. Repeated identical calls with unchanged results trigger a warning and then a resumable error. With automatic continuation disabled, `agentMaxIterations` pauses with saved progress; it never removes tools to force a premature answer. Completed operation receipts are saved before the next mutation and recovered after interruption without automatically replaying the operation.

For each tool-call batch:

- arguments are parsed and validated;
- tool metadata identifies read-only, session-mutating, network, and costly operations;
- an all-read-only batch may execute concurrently;
- any batch containing a mutation executes every call serially in model order;
- result messages are appended in original call order;
- abort errors leave the tool layer and terminate the turn instead of becoming model-visible error strings.

Provider replay preserves DeepSeek `reasoning_content` and Gemini thought-signature fields when present.

## Tool Families

### Document tools

- `list_sources`, `get_document_status`
- `search_pdf_text` (default document discovery, explicit passage mode, cumulative coverage and continuation; one shared native/MCP implementation)
- `read_pdf_text` (session-scoped text and page navigation)
- `read_pdf_page` (session-scoped cached Markdown, on-demand visual transcription)
- `locate_pdf_content` (session-scoped local phrase/number/caption location, cached geometry and clickable region citations)
- `inspect_pdf_page` (session-scoped original visual review)
- `list_images`, `read_image` (standalone images)
- `read_tool_result` (exact stored text, with current source-scope enforcement)

Document reads enforce TurnScope before local I/O and before delivery. Removed/replaced sources cannot deliver stale page results. Original page citations distinguish PDF page numbers from printed labels.

### Image Inputs

The panel accepts PNG, JPEG and WebP through **Add image**, file drag-and-drop, clipboard image paste, and Zotero image attachments. Standalone images are atomically copied into the source cache and are ready after their local write. Their image kind and stable source identity survive session restoration; removing a source removes it from the model's available scope.

`list_images` lists a standalone image source; `read_image` reads its bytes with path, symlink, signature and size checks. PDF sources use `read_pdf_page` for cached Markdown and `inspect_pdf_page` for original-image review. Old extracted figures are no longer exposed.

The per-image limit is **10 MiB**. There is no cumulative image-byte quota per turn or external tool call, including repeated reads. Oversized inputs are rejected, never silently resized or truncated. Image payloads are separate from the text character budget; visual token usage comes from the provider.

After all tool responses in a batch, the agent appends a user message containing labeled OpenAI-compatible `image_url` data URLs. The active model and endpoint must support vision. API failures on image requests include a compatibility hint; the plugin cannot infer every custom provider's capabilities from its model name. Selected images are sent to the configured LLM provider when the agent reads them.

Persistent tool history contains image provenance and byte counts, not base64 payloads. Later turns retain that provenance and can read the cached image again when needed. This avoids automatically replaying every earlier image or treating captions as visual evidence.

### Zotero Tools

- `search_zotero_library`
- `search_zotero_annotations`
- `get_zotero_item`
- `list_zotero_collections`
- `list_collection_items`
- `get_current_zotero_selection`
- `add_zotero_item_to_session`

Lookup schemas support `library_id`. `search_zotero_annotations` lists annotations when `query` is omitted, or searches highlighted text, comments, tags, and corresponding paper metadata when a query is provided. It returns annotation, attachment, and bibliographic item keys. List/search tools do not silently impose hidden result caps; optional caller limits remain explicit.

### Web Tools

All tools, including both web tools, are enabled by default and individually configurable. `web_search` uses Brave if configured and otherwise the DuckDuckGo HTML fallback. `web_fetch` goes through `SafeWebClient`:

1. only HTTP(S) URLs are accepted;
2. credentials, localhost, loopback, private, link-local, multicast, reserved, and metadata addresses are rejected;
3. DNS answers are checked before a request;
4. redirects are handled manually and every target is revalidated;
5. a request timeout and redirect count apply;
6. only supported textual MIME types are accepted;
7. the body is streamed with a normal 5 MiB limit and a 25 MiB hard ceiling.

Oversized or unsafe responses fail explicitly. They are never silently shortened.

## Output-limit recovery

`finish_reason: length` is an incomplete response, distinct from task completion, a network failure, or input-context overflow. In automatic mode, the harness handles it before dispatching any tools:

- Reasoning-only or empty output is archived without entering the working context. In automatic generation mode, retry with a larger allowance up to the model maximum; compact first if the complete allowance cannot fit. Keep the identical message/tool prefix whenever it fits without compaction. An explicit user generation ceiling never grows. Stop explicitly if no larger allowance is permitted; never repeat unchanged empty attempts indefinitely.
- Visible partial text is retained as an iteration segment. Append a generic continuation notice at the end of the working context and continue without rewriting earlier blocks. Repeated identical partial answers stop with preserved history.
- Truncated tool calls are never executed, even if their arguments happen to parse. Preserve the raw response in the archive; exclude unanswered calls from the working context. Completed actions from earlier requests retain their receipts and are not replayed by retrying the model request.
- Every attempt records its finish reason, output allowance, and provider usage. Cancellation and disabled automatic continuation remain effective. Context compaction is used for input pressure, not as the default response to an output limit.

Generation limits apply per request, not to the whole task. Automatic-mode allowance growth alone does not change the prefix; any necessary context compaction is a separate operation. Actual cache hits remain provider-dependent.

Design references reviewed for this behavior:

- [Anthropic stop-reason guidance](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons) recommends increasing output allowance for truncated tool calls and distinguishes output truncation from context overflow and paused turns.
- [Anthropic TypeScript ToolRunner](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/lib/tools/BetaToolRunner.ts) classifies stop reasons before tool dispatch; its default `max_tokens` policy is to stop. ChatPDF's automatic recovery is an explicit harness policy beyond that default.
- [OpenCode processor](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/processor.ts) separates compaction, stop/continue state, usage persistence, and repeated-tool detection. These references motivate distinct recovery paths, not identical behavior across providers.

## Cancellation

The request signal reaches:

- streaming and non-streaming LLM requests;
- all agent tool handlers;
- safe web requests and body reads;
- PDF.js loading, text extraction, rasterization and cache delivery;
- session mutations and UI callbacks that follow those operations.

Removing a source cancels its active session turn and invalidates the source scope. Renderer cleanup disposes its private XUL browser. Other sessions are unaffected.

## PDF reading and local cache

All enabled tools are offered without a visual-capability gate. Endpoint metadata is advisory; unknown or negative declarations do not block requests. The old `visionSupport` setting is ignored and its confirmation menu is removed.

If an image-bearing request receives an explicit HTTP 400/415/422 rejection of image input, the native agent removes images from its outgoing working context, preserves original history and completed tool receipts, and retries with text. `inspect_pdf_page` and `read_image` become unavailable for that live session and endpoint/model/account; the shared executor rejects stale calls. A visible notice explains the evidence limitation. Follow-up turns retain text mode. Changing model/account, refreshing model settings, clearing chat or reopening its saved session allows another attempt. The rejection cache is memory-only and never serializes credentials.

The same fallback handles images in context compaction. Authentication, rate-limit, network, image decoding/format/size and generic request failures do not trigger it. The client cannot detect silent image stripping by an intermediary. External MCP hosts own their model requests and recovery; the MCP bridge continues to provide the enabled catalog and image results.

Zotero PDF.js runs in a disposable XUL browser. `inspect_pdf_page` renders single pages, explicit ordered page lists, or consecutive batches (default four), at 200 DPI by default for full-page browsing (caller range 72–600), JPEG quality 95, high image detail. Normalized regions default to 600 DPI and render directly from the PDF into a crop-sized canvas. Exact formula transcription, checking and derivation require a high-resolution region read in the shared tool description and native prompt. Verify fine notation and use smaller regions if necessary; report unresolved ambiguity. Rendering tests cannot guarantee model recognition accuracy. One renderer serves a batch, with cache deduplication and up to two cancellable adjacent-page prefetches that remain local. Every delivered image has a page/region label. There is no cumulative image-byte quota per native turn or MCP call. Raster limits are 16 megapixels and 8192 pixels per side; effective DPI is returned. Print scheduling supports hidden windows but print-specific PDF content may differ from display intent. Inspection images are delivered after all tool receipts; this separate review tool makes no transcription call. Ordinary read_pdf_page calls use the [page transcription service](pdf-markdown-reading.md).

Text extraction uses `getTextContent()`; discovery can reuse a fresh, complete Zotero index, whose unavailable page numbers remain null. Page-mapped reads use PDF.js. Searches report inspected files, missing text and continuation; no OCR worker or OCR API key is required. Scanned pages without text can be read visually.

```text
<cacheDir>/
  pdf-text/<library-qualified-key>.json
  pdf-pages/<library-qualified-key>/page-<number>-<dpi>.json
  documents/<image-source-key>/image.bin
  history/
  debug-logs/
```

Writes are atomic. PDF caches include file path, byte size and modification time and are regenerated when this stamp changes; resolution is also part of the page cache key. Text extraction includes a SHA-256 digest. Legacy whole-document converted files are left untouched but never loaded or resumed. New page-level Markdown caches live under pdf-markdown/ and are reused across model switches. Pre-v5 conversion states migrate to ready-to-read source identities; file availability is checked on use.

Native chat and external MCP share the tool registry, argument validator and executor. The exact protocol 2 bridge supports `status`, `tools.list`, `tools.call`, `tools.cancel` and `session.close`; no conversion/cache API remains. MCP only adapts transport and text/image content, with separate sessions and the same Zotero authorization. Settings filter discovery and reject disabled tools again at execution. See [Shared tools](shared-tools.md) for the wire contract and limits.

## Rendering and Debug Privacy

Each assistant iteration stores its visible narration independently of the final answer. The live UI updates a dedicated narration node in place, flushes it before tools start, and freezes it before adding the corresponding tool block. Completed text does not move when later iterations stream. History and background-stream restoration preserve reasoning, narration, and tool order; older v3 narration can be recovered from archived provider events by exact stored-result identity. Completion, cancellation, and errors clear pending rendering timers and activity indicators.

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

Isolated Zotero smoke tests use separate profile/data/cache directories and temporary add-on installation. Local mock endpoints verify page transport, tool ordering and panel behavior without credentials. They do not establish a real provider's scientific reading accuracy. See [Direct PDF reading](direct-pdf-reading.md).

CI runs both dependency auditing and functional verification after a successful locked install. An audit failure still fails the job, but does not hide the typecheck, lint, test, and build results. Installation failure or cancellation prevents functional verification.


### Transient HTTP recovery

Model requests retry HTTP 408, 429, 500, 502, 503 and 504 at most twice, with 1-second and 2-second backoff. A valid `Retry-After` seconds/date header extends the wait. If it asks for more than 30 seconds, the turn stops with the original provider error and a retry-later explanation rather than sending prematurely. Explicit quota/billing exhaustion codes and ordinary authentication/validation errors do not retry. Cancellation interrupts waits immediately.

Retries keep the exact model request, generation allowance, images and stable conversation header. They occur inside the HTTP client, so completed tool operations are not re-executed. A stream that has delivered any model data is never replayed. Transient failures do not disable image tools or add a vision-compatibility hint. Exhausted retries preserve the original provider error and show the total attempt count. Diagnostic logs contain status, attempt and delay metadata, without request contents or credentials.

### Rolling image history and prefix caching

Before a native model request, a soft 20 MiB trigger counts inline Base64 image payloads in the active history. On crossing it, the oldest previously delivered user/tool image occurrences are replaced in one batch toward a 10 MiB target. Only images accepted in a completed provider response are eligible; this records transport delivery, not successful visual understanding. Fresh evidence is protected even if it alone exceeds either watermark. There is no cumulative turn/call reading allowance or hard request cap.

The working projection preserves all text analysis, exact tool arguments/results, page/region labels and original archived events. Offload selections and byte accounting are recorded separately; model placeholders contain no changing counters or timestamps. A reread appends a new image occurrence and never restores bytes at an old slot. Cached source rasters and complete receipts remain available. Display notices report an offload without entering the model prefix. Active image bytes remain excluded from saved history; a fully offloaded active projection can persist exactly.

An offload changes the prefix at the first selected image, so it can reduce provider cache reuse on that request. Batched high/low watermarks leave headroom before another rewrite, while fixed one-way references support later stable prefixes. They do not guarantee a cache hit: DeepSeek requires a matching persisted prefix unit, and stable common prefixes can become reusable only after detection/persistence. Provider usage remains the measurement. See [DeepSeek cache rules](https://api-docs.deepseek.com/guides/kv_cache/) and [Harness offload behavior](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-image-offload/README.md). Unlike Harness's broad oldest-occurrence selection, ChatPDF protects new image evidence until accepted.

### Oversized request recovery

HTTP 413 from a gateway is separate from token capacity and image-input support. Native chat first forces further old-image offload toward the smaller of 10 MiB or half the retained payload, then retries without replaying tools. Every such retry removes eligible occurrences, so this path ends when none remain.

If fresh images or indivisible text still make the request too large, native chat creates a continuation checkpoint with the same configured model. Rejected checkpoint requests are divided into smaller complete exchanges; a multi-image user message can be divided again while keeping each image with its source/page/region label. Accepted groups feed their notes into the next group. This fallback keeps original requested image bytes and high-detail settings; it adds no automatic resolution degradation, cumulative quota or OCR conversion.

Only a fully completed checkpoint replaces its input working context, without a large image tail. Completed tools are not repeated. Cancellation, source-scope changes or failed checkpoint groups do not commit an incomplete summary; previously committed one-way offload decisions remain in place. If a single image or indivisible exchange still receives 413, recovery stops with an explanation instead of silently omitting new evidence. A successful recovery adds a visible notice and image tools remain available.

Transport diagnostics record the rejected serialized request's exact UTF-8 byte count, image count and decoded inline-image bytes without content or credentials. These sizes do not infer the provider's configured threshold. External MCP hosts own their LLM requests and must implement their own history window/recovery; the shared image tools retain the same behavior for both channels.
