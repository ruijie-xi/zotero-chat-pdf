# ChatPDF LLM and Tool Workflow

This document describes the agent-only workflow in the `0.9.x` working tree. See [Agent capabilities](agent-capabilities.md) for document representations, library editing guarantees and prefix-cache behavior.

## Runtime Boundary

ChatPDF runs in Zotero's privileged Firefox chrome context, not Node.js.

- UI nodes must be valid XHTML or XUL.
- Local I/O uses `IOUtils` and `PathUtils`.
- Network calls use the runtime `fetch` implementation and Zotero-specific fallbacks already present in the code.
- Runtime modules must not assume Node globals or packages are available.
- PDF conversion defaults to a configured vision-capable LLM; MinerU remains an optional independent service.

## Main Components

Provider selection uses `llmProvider` (`custom`, `deepseek`, or `opencode-go`) and is stored with each model profile. Missing or unknown values remain custom, preserving legacy endpoints and credentials. Built-in providers resolve to their fixed HTTPS endpoints in the UI and transport; custom retains the editable OpenAI-compatible base. Switching providers isolates in-pane drafts, including keys and token overrides; saved profiles persist those configurations across restarts.

`llm-provider.ts` supplies shared request headers. Go sends the honest `ChatPDF/<version>` user agent and the persisted `ChatSession.id` in `x-opencode-session` for agent steps, retries, compaction and title generation. API tests and metadata refreshes use separate stable pane-local IDs. No client is impersonated. [OpenCode Go documentation](https://opencode.ai/docs/go/#where-can-i-use-it) targets coding-agent traffic; paper-reading acceptance has not been validated.

Go's public `/models` response currently omits token capacities. For the exact supported DeepSeek IDs only, the bundled fallback uses 1,000,000 context tokens and 384,000 maximum output tokens from OpenCode's [models.dev provider catalogue](https://github.com/anomalyco/models.dev/tree/dev/providers/opencode-go/models), including inherited [V4.1 Flash](https://github.com/anomalyco/models.dev/blob/dev/models/deepseek/deepseek-v4.1-flash.toml), [V4 Flash 0731](https://github.com/anomalyco/models.dev/blob/dev/models/deepseek/deepseek-v4-flash-0731.toml) and [Vision Exp](https://github.com/anomalyco/models.dev/blob/dev/models/deepseek/deepseek-v4-flash-vision-exp.toml) limits (checked 2026-10-03). This source is displayed as `provider-preset`; endpoint capacity metadata and manual overrides take precedence. These are catalogue values, not authenticated capacity measurements. Go selects explicit local tokenizer estimation; no remote tokenizer receives conversation text. Unknown models still require explicit limits and estimation mode. Known Go DeepSeek models share the automatic 1,024-token per-image estimate; other non-official endpoints require an explicit per-image reserve. Provider-reported usage calibrates later requests.

| Component | Responsibility |
| --- | --- |
| `hooks.ts` | Add-on startup/shutdown, preferences, menu registration, and window injection |
| `chat-panel.ts` | Side-panel DOM, toolbar, resizing, drag/drop, and session/source coordination |
| `panel-state.ts` | One `PanelState` per Zotero window: session, editor, streams, abort controllers, polling, and listeners |
| `send-handler.ts` | Turn scoping, send lifecycle, streaming UI, terminal states, autosave, and title generation |
| `agent-loop.ts` | LLM/tool iterations, safe tool scheduling, callbacks, and usage accumulation |
| `llm-client.ts` | OpenAI-compatible request construction, SSE parsing, tool fragments, and provider thinking fields |
| `tools.ts` | Tool schemas, risk metadata, validation, dispatch, and result accounting |
| `research-tools.ts` | Stable PDF discovery/evidence and library-edit tool schemas and dispatch |
| `pdf-text.ts` | Local PDF text/page caches, index reuse, revision-aware search and continuation |
| `library-changes.ts` | Captured edit scope, transaction preflight, durable receipts and conflict-safe undo |
| `library-approval.ts` | Trusted batch review of concrete changes or reversals |
| `source-citation.ts` | Library-qualified PDF page links and native reader routing |
| `safe-web-client.ts` | Public HTTP(S) validation, redirect checks, timeout, MIME, and streamed byte limits |
| `chat-session.ts` | Session library, TurnScope messages, prompt construction, history, and schema-v2 serialization |
| `chat-history.ts` | Atomic session/index repository, index recovery, and deletion tombstones |
| `source-identity.ts` | Stable library-qualified source IDs and cache keys |
| `source-chips.ts` | Source UI, user-owned conversion lifecycle, stop, removal, and lazy cache loading |
| `conversion-manager.ts` | Shared owner-aware jobs, conversion history, cancellation, restart recovery, and cache commits |
| `chatpdf-bridge.ts` | One exact-protocol loopback endpoint for selection and conversion control |
| `pdf-renderer.ts` | Private Zotero PDF.js realm, page rasterization, bounded initialization and disposal |
| `vision-client.ts` | Vision requests, batching, cancellation, retries, per-page coverage and formula syntax gates |
| `vision-self-check.ts` | Same-response structured local edits, strict edit validation and checkpoint self-check records |
| `vision-conversion-config.ts` | Separate saved conversion profile, validated parameters and credential-free job settings |
| `pdf-conversion.ts` | Shared chunk planning, merge markers and cache-contract validation |
| `mineru-client.ts` | PDF chunk planning, upload, polling, ZIP download/extraction, progress, and stage errors |
| `md-cache.ts` | Legacy reads plus private staging, atomic document replacement, and startup swap repair |
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

The editor returns both visible text and mention IDs. If the user includes source mentions, those IDs become the TurnScope. If no mentions are present, TurnScope defaults to the full SessionLibrary. Pending or converting sources do not block sending: raw text, page images, status and conversion waiting remain independently available within TurnScope.

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

Converted PDFs are not embedded into the system prompt. The model reads them through tools.

The system prompt describes capabilities; the agent chooses its tools and order. Volatile source metadata, conversion states and edit access appear only in the current user's immutable scope block. Tool definitions keep fixed schemas and order across permission changes. Between compactions, complete provider exchanges remain unchanged and new messages append to the same working context, including across follow-up turns and compatible session restores. Legacy sessions without exact replay metadata are reconstructed once from visible messages and tool provenance.

Model limits are resolved for the exact endpoint, account and model: explicit profile token overrides take precedence over endpoint `/models` metadata. Metadata is cached for 24 hours in memory and can be refreshed from Preferences. Limits are frozen for each turn. Unknown capacity requires explicit token settings; old character-limit preferences are ignored.

Model capacity, generation policy, and input planning are separate. `generation-policy.ts` resolves a per-request generation allowance before input is examined. An explicit `requestedOutputTokens` value is a user ceiling for all requests and retries, including reasoning; invalid overrides fail validation. Automatic mode uses the full resolved model output maximum from endpoint metadata or an explicit capacity override, regardless of thinking mode or effort. The plugin imposes no additional generation ceiling and does not fall back to a smaller provider default. Unknown endpoints follow the same policy once their capacity and tokenizer requirements are satisfied. The explicit thinking-off switch suppresses a saved effort value. Raw model metadata is cached, but policy is recomputed for each settings snapshot. DeepSeek requires an explicit `max_tokens` to exceed its default, and still enforces its service maximum; see the [Chat Completions specification](https://api-docs.deepseek.com/api/create-chat-completion/) (verified 2026-09-29).

For a shared window C, resolved generation allowance O, optional input limit I, and safety margin M, the input budget is `min(I, C - O) - M`. The safety margin is 2% of the model window (at least 128 tokens). Separate input/output limits are handled independently. Input pressure never silently shrinks O: compact completed exchanges or deliver paged tool results; if an indivisible exchange cannot fit, preserve history and report the capacity conflict. Automatic compaction starts at 80% of this input budget, or earlier if the checkpoint instruction would not fit. A checkpoint must reduce context and leave the result below 55% of the input budget. Titles and checkpoints retain the selected thinking policy and generation allowance; their short visible-text targets are separate. A truncated title is not committed. The usage bar and Preferences distinguish generation allowance from actual consumption and model maximum.

The bundled official DeepSeek V4 BPE vocabulary runs locally in pure JavaScript. The request counter includes message envelopes, tools, arguments and replay fields; complete-field memoization never changes provider bytes. Request totals are explicitly labeled estimates because server templates are not public. Provider prompt usage calibrates the estimate upward for the same turn; cached input still occupies context. Unsupported models require explicitly selecting the approximate tokenizer mode. Official DeepSeek V4 images reserve the documented 1,024-token upper bound per image; other models require an explicit reserve. Image base64 size is never treated as model tokens. Document/source size badges and exact retrieval cursors still use characters.


Compaction uses the same model, system prompt, and ordered tool definitions, appending a task-independent checkpoint instruction. Its tools are never dispatched. Generated memory preserves objectives, constraints, outcomes, pending work, evidence references, and uncertainty. Program-maintained unread-result ranges and operation receipts survive independently of summary wording. After compaction, a new stable prefix is built; the first resumed request may miss cache. Recent complete exchanges may remain verbatim when they fit the retained-context target; provider-signed/reasoning replay is not moved across a changed prefix. All tool bodies remain recoverable from the result archive.

A checkpoint response ending with `finish_reason: length` is retried with the exact same messages, tools, model, and thinking settings while the complete larger allowance fits. Automatic allowances can grow to the model maximum; explicit user ceilings never grow. If more generation space is needed, complete exchanges are repartitioned into smaller groups without shrinking the allowance. Each group has at most three generation attempts, with at most three partition passes. All attempt usage is counted; truncated drafts are never committed as checkpoints. Exhaustion retains the original history and working state. Sanitized per-request metadata records model/mode, policy source, initial and actual allowance, model maximum, input estimate/budget, finish reason, and provider usage for agent, checkpoint, and title calls.

Results too large for immediate delivery are stored completely and represented by an explicit result ID. `read_tool_result` returns exact, zero-based, end-exclusive character pages and the next cursor; page size adapts to working capacity. It checks both current session membership and TurnScope. No fixed 80,000-character result limit or cumulative reading quota remains. Full result bodies are stored once in `agentContext.results`; UI iteration history and exact provider events are hydrated from references when a session is loaded. Compaction changes the active event view, not the full transcript. Binary images are never serialized; restoring a working view containing images requires reconstruction and explicit image rereading.

Sessions write schema v4 and agent context v2. Old tool histories normalize once into iteration records. The first save of an older session atomically backs up its original bytes under the same private cache before replacing it; deleting the session also deletes that migration backup. Historical `inputChars` metadata remains historical data and is never relabeled as tokens.

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

### Document Tools

- `list_sources`
- `read_document`
- `list_document_chunks`
- `read_document_chunk`
- `search_document`
- `list_images`
- `read_image`
- `read_tool_result` (session result IDs with current source-scope enforcement)

These tools accept stable source IDs and refuse sources outside TurnScope. Search output merges overlapping context windows so repeated neighboring matches do not duplicate the same source lines. Caller-specified match limits remain explicit; large document reads remain possible through narrower line ranges or page-based chunks.

### Image Inputs

The panel accepts PNG, JPEG and WebP through **Add image**, file drag-and-drop, clipboard image paste, and Zotero image attachments. Standalone images are atomically copied into the source cache and are ready without MinerU. Their image kind and stable source identity survive session restoration; removing a source removes it from the model's available scope.

`list_images` lists cached PDF figures by relative path. `read_image` accepts only a source in TurnScope and a path inside that source's cache (or no path for a standalone image). Absolute paths, URLs, traversal and symlinked cache entries are rejected. File signatures and byte sizes are checked before delivery. SVG and GIF are not supported. Missing cache files produce explicit errors; PDF figures require an existing conversion cache.

Limits are **10 MiB per image** and **20 MiB of image bytes per turn**, including repeated reads. Oversized inputs are rejected, never silently resized or truncated. Image payloads are separate from the text character budget; visual token usage comes from the provider.

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
- `convert_session_source`
- `add_and_convert_zotero_item`

Lookup schemas support `library_id`. `search_zotero_annotations` lists annotations when `query` is omitted, or searches highlighted text, comments, tags, and corresponding paper metadata when a query is provided. It returns annotation, attachment, and bibliographic item keys. List/search tools do not silently impose hidden result caps; optional caller limits remain explicit.

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
- MinerU upload URL requests, PDF upload, polling delays, result downloads, and extraction;
- session mutations and UI callbacks that follow those operations.

A conversion launched from a source chip has an owner scoped to that source and window. Removing the source releases
that owner and aborts the shared job only when no other panel or bridge owner remains. Explicit bridge cancellation is
job-wide.

## PDF Conversion and Cache

Prompt v3 optionally enables the original model's self-check in the same response, after its Markdown, with a compact JSON list of exact page-local edits or an empty list. No review request or replayed image/transcript input is added. Edits are applied only with unique, nonoverlapping anchors; uncertain pages and invalid packets fail. The corrected Markdown passes the normal gates before commitment. Chunk metadata records checked pages, applied edits and a final-Markdown digest, so compatible saved checks require no new API calls. The panel's checked-page badge reports the model's own assertion rather than independent scientific verification. The bridge status advertises this capability as `pdf_self_check: same-response`. Existing v2 caches/jobs retain their original behavior until explicit reconversion.

Vision is the default engine. A saved conversion profile may differ from the chat model; blank uses the active chat profile. PDF.js renders in a disposable XUL browser using the local Zotero reader assets, with no external rendering binaries. Defaults are four pages per request, two workers, 150 DPI, JPEG quality 85, page-image caching enabled and 180 seconds per API attempt. All images are sent to the selected conversion provider. See [the conversion contract and validation limits](pdf-vision-conversion.md).

Vision jobs pin the model, endpoint, profile, chunk size, image policy and prompt version without persisting keys. SHA-256 detects a changed source before resuming. Per-page markers, tolerant text/symbol coverage guards, KaTeX syntax and the merged/chunk/line-range cache contract gate commits. Repeated Greek symbols and hat/tilde/bar decorations are checked against the text layer; this is an omission guard, not mathematical equivalence verification. Invalid/empty/truncated output is split with validation feedback, with one extra attempt for a single page. 429 and transient server errors respect bounded backoff and Retry-After. Workers are settled before disposal or terminal states. Compatible staged chunks survive errors; explicit Retry can resume a failed forced conversion while retaining an older ready cache. Opening/re-adding sources never starts new vision transcription. Restart recovery of an active job may finish its previously requested work.

**Reconvert** bypasses terminal jobs and starts clean staging, preventing stale assets from another engine from appearing in the replacement. Ready cache reads do not require a current conversion profile. Page images live in `attachments/pages/` and remain available through image tools. Both engines emit chunk markers for single-chunk results as well.

MinerU remains optional. The configurable defaults are language `ch` and timeout 15 minutes. PDFs up to 120 pages use one task; longer PDFs use resumable 25-page chunks. Each successful chunk is stored before the next begins.

Polling timeouts do not cancel the remote MinerU task. Adding a source again or opening a saved session checks compatible saved uploads, preferring a completed older task over a queued duplicate, and recovers results through the usual atomic cache commit. Automatic recovery never uploads new PDF bytes. Error chips offer Retry; explicit conversion retries reuse existing uploads and staged chunks before submitting missing work. A failed recovery status request is reported rather than silently creating another upload. Forced conversion bypasses saved terminal tasks.

```text
<cacheDir>/
  documents/<library-qualified-cache-key>/
    document.md
    manifest.json
    chunks/<index>.md
    attachments/pages/page-<page>.jpg  # vision, when enabled
    attachments/full/...            # MinerU
    attachments/chunk-<index>/...
  conversions/
    jobs.json
    staging/<job-id>/...
  history/
  debug-logs/
```

Document, chunk, manifest, session, and history-index writes use temporary files followed by atomic replacement. Errors retain their stage so upload, polling, ZIP download, and extraction failures remain distinguishable.

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

Isolated Zotero smoke tests use separate profile/data/cache directories and temporary add-on installation. Local mocks verify native transport and panel behavior without provider credentials; real provider transcription requires a separately controlled credentialed run. See the [PDF vision validation record](pdf-vision-validation.md) for the current distinction and test coverage.

CI runs both dependency auditing and functional verification after a successful locked install. An audit failure still fails the job, but does not hide the typecheck, lint, test, and build results. Installation failure or cancellation prevents functional verification.
