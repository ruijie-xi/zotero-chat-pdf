# Character-unit audit and model-aware context requirements

Audited on 2026-09-28 against commit `f93b4a5f036424b78b34065b6129f69fa811b6dc` (version 0.9.0). This report changes no runtime behavior.

Requirement update: the user subsequently clarified that document/tool character counts may remain. Only model-capacity decisions must use model-aware tokens. The removal recommendations below are a historical audit proposal; the current detailed plan is [Model-aware token budgeting and legacy cleanup](model-aware-context-plan.md).

## Scope and interpretation

The audit covers tracked application source, preferences/localization, types, tests, scripts, workflows, and documentation. Generated XPI/bundle output, dependency implementations, Git history, and users' stored conversations/cache files are outside the source inventory. Existing persisted schemas were inspected through their readers/writers, without editing user data.

Searches cover `char`, `characters`, `chars`, `character_count`, `contextMaxChars`, Chinese equivalents, and indirect string-length budgets, clipping, offsets, and document-size badges. A broad literal search also finds legitimate encoding/editor operations; those are classified separately rather than equated with capacity units. Most current text-size counts use JavaScript `String.length`, i.e. UTF-16 code units, not Unicode graphemes or model tokens.

## Findings: user-visible surfaces

| Location | Current appearance / behavior | Required disposition |
| --- | --- | --- |
| `addon/content/preferences.xhtml:142-143`, `addon/locale/en-US/preferences.ftl:20` | Working-context size is explicitly labeled in characters; minimum 20,000 and step 10,000. | Replace with model-scoped token capacity and a compaction policy derived from that capacity. |
| `addon/prefs.js:16`, `typings/prefs.d.ts:25`, `typings/i10n.d.ts:12`, `AGENTS.md:103` | Global `contextMaxChars=240000` and its localization/type surfaces. | Remove the active character preference. Handle an old saved preference as a deprecated input, not a numeric token conversion. |
| `src/modules/source-chips.ts:120-126`, `src/utils/format.ts:46-51` | Document badges such as `137K` / `173K` count Markdown string length, with no unit shown. | Remove the ambiguity. Prefer document/page/readiness information; any token estimate must identify its model and must not imply that all source text is in working context. |
| `src/modules/source-chips.ts:187-189` | Source-list summary explicitly displays `... chars`. | Remove character totals from the product UI. |
| `src/modules/source-chips.ts:122-125`, `src/modules/chat-session.ts:55`, `addon/content/chatpdf.css:769` | Legacy `contextRatio` and truncation badge show the included fraction of a document. | Remove or redefine with evidence of what the current agent actually received; whole-document size is not context occupancy. |
| `src/modules/send-handler.ts:78,82,87`, `src/modules/chat-session.ts:188` | Title prompt says maximum 50 characters; title strings are clipped to 50 and title-generation inputs to 300 per message. | Separate title presentation from model capacity. A complete product-unit cleanup also revises this prompt and clipping policy. |
| `src/modules/chatpdf-bridge.ts:58-59` | Validation error says language must be at most 32 characters. | This is a language-field validation rule, not an LLM budget. Replace character-based public wording if the product removes the unit everywhere. |

## Findings: active context and compaction policy

| Location | Current behavior |
| --- | --- |
| `src/modules/agent-context.ts:54-65` | `contextSize()` sums tool-schema JSON length, message envelopes and text length. Each image is assigned 32,768 character-equivalent units. `contextLimit()` uses a 240,000 default and a 20,000 minimum. |
| `src/modules/agent-loop.ts:50,89-90` | Every model shares the global character limit. Compaction starts above 75%; result pages use 25%, with a 1,000 minimum. |
| `src/modules/agent-loop.ts:106` | A provider context rejection reduces the character limit to 75%, floored at 20,000; it does not discover the real model window. |
| `src/modules/agent-loop.ts:178-184` | Direct-result delivery uses 82% of the character limit minus current estimated size and 500 units per call. A result that does not fit is paged; context above 50% requests compaction. |
| `src/modules/context-compaction.ts:32-35` | Summary target is 12% of the character limit, clamped to 1,000-12,000; the prompt explicitly asks for a maximum number of characters. |
| `src/modules/context-compaction.ts:59,70,74-75,80-83` | Full-request fit, intermediate-summary size (30%), recovery grouping (55% / 65%), and reduction acceptance (85% of previous size / 55% of capacity) all use character accounting. |
| `src/modules/context-compaction.ts:42-44` | Output retries already use tokens (8,192 / 16,384 / 32,768), but are fixed and not checked against model-specific output or total-window limits. This must be included in the model-capacity refactor. |

These are decision-making paths, not merely labels. Renaming variables or replacing the word “characters” with “tokens” would leave incorrect budgeting in place.

## Findings: model-facing tools and checkpoint text

| Location | Current appearance / behavior | Required disposition |
| --- | --- | --- |
| `src/modules/tools.ts:54,114-118,469-472` | `resultPageChars`, `max_chars`, zero-based character offsets, and a 40,000-character fallback page. | Use a token delivery budget and an opaque continuation cursor, or suitable line/page references. Internal exact source offsets need not become public token offsets. |
| `src/modules/agent-loop.ts:154-156,180` | Parent ranges derive from the character page request; deferred envelopes expose `total_chars`. | Migrate delivery/range accounting with the tool contract, not just its labels. |
| `src/modules/agent-context.ts:101-108,111-127` | Retrieval slices strings by numeric offsets; delivered coverage is stored as ranges over those offsets. | Preserve exact retrieval and completion coverage across pagination; do not reinterpret old offsets as tokens. |
| `src/modules/agent-context.ts:131-136,158` | Checkpoints list unread-result character totals and delivered ranges; recovered mutation receipts also contain character totals. | Remove capacity-unit prose while retaining result identity, unread coverage, and side-effect receipts. |
| `src/modules/tools.ts:548-549` | Every successful tool response appends a character count and an estimated token count computed as `ceil(result.length / 4)`. | Remove this fixed-ratio estimate. Use model-aware accounting outside the prompt unless the agent needs a budget signal. |
| `src/modules/tools.ts:624-626,710` | `list_sources` and `list_document_chunks` expose character sizes. | Prefer stable document structure/page/line metadata or properly labeled model-token estimates. |
| `src/modules/tools.ts:1359` | `web_fetch` returns both bytes and text-character totals. | Retain transport-byte accounting if useful; remove character capacity prose. |
| `src/modules/chat-session.ts:627` | Reconstructed history tells the model how many characters each earlier tool returned. | Replace the character description with result provenance/retrievability. |

Tool results appear inside expandable UI blocks too, so model-facing text is also a user-visible surface. Their generated wording is persisted in full history; removing new emissions does not retroactively erase old transcripts.

## Findings: persistence, logs, and legacy paths

| Location | Current behavior | Required disposition |
| --- | --- | --- |
| `src/modules/md-cache.ts:11`, `src/modules/conversion-manager.ts:300,309` | Chunk manifests store `charCount`. | Stop writing active size metadata in characters; tolerate legacy manifests without rewriting document bodies. |
| `src/modules/agent-context.ts:36`, `src/modules/agent-loop.ts:114`, `src/modules/context-compaction.ts:49` | Per-request metadata persists `inputChars`. | Replace new telemetry with model identity, token-estimation method, estimated input, actual provider usage, and effective model limits. |
| `src/modules/debug-log.ts:42,50,66-67` | `contentLength`, `totalChars`, `responseLength`, `reasoningLength` are string-length telemetry. `message.content.length` counts array parts for vision messages, so that field is also inconsistent across content types. | Use explicit token or transport-byte fields with correct multimodal handling; distinguish unknown from zero. |
| `src/modules/llm-client.ts:366-367`, `src/modules/send-handler.ts:474`, `src/modules/context-compaction.ts:86` | Debug lines report request/result characters and before/after compact characters. | Replace size telemetry together with the budget implementation. |
| `src/modules/tools.ts:547,652,674,681,1288,1358` | Read/search/fetch/tool debug messages report character lengths. | Remove or replace with purpose-specific token/byte/line metrics. |
| `src/modules/chat-session.ts:412-577` | Old `buildMessages`, `truncateHistory`, proportional document allocation, truncation text, size logs, and `contextRatio` remain. Both character caps are currently infinity. No repository caller of `buildMessages()` was found. | Remove unused legacy budgeting rather than preserve dormant character policy. |
| `src/modules/chat-session.ts:599,603,627,641-642,698` | Agent reconstruction still invokes `truncateHistory(..., Infinity, ...)`, emits character provenance, and logs character sizes. | Retain ordered reconstruction while replacing/removing the legacy helper and size prose. |

## Tests and documentation

- `tests/agent-compaction.test.ts:19,90`: character preference and large-character-result regression.
- `tests/agent-context.test.ts:96,116`: character pages and character-based unread-result checkpoint assertions.
- `tests/chat-session.test.ts:66`: expected character provenance in reconstructed history.
- `docs/llm-workflow.md:90,96,136`: current character capacity, character-offset pagination, and image/character-budget description.
- `docs/agent-context-compaction-plan.md:3,19-23,30-43,77,103,187`: current design, incident evidence, and a proposal to retain a character fallback. The fallback proposal conflicts with the new requirement and should be superseded explicitly.
- `docs/minimal-self-contained-chatpdf-mcp-plan.md:578,608-610`: historical character-count acceptance notes, including `character_count`. That exact field does not appear in current runtime source; this is a historical document claim, not an active API field found in this audit.
- `CHANGELOG.md:80,171`: historical character-budget changes.
- `README.md` and `README.zh-CN.md`: no literal character-unit matches found.

Historical incident measurements should remain accurately identified as historical observations, even when current product behavior changes. Deleting/relabeling them as tokens would falsify the record. A product-unit removal therefore needs an explicit boundary between active documentation and archived evidence.

## Technical matches that are not capacity units

- `src/modules/tiptap-input.ts:121,182,208-219,249-273` and `tests/tiptap-input.test.ts:40-45`: native selection granularity `character`, cursor movement, and deletion. These are editor API semantics.
- `src/modules/agent-context.ts:72-73`: `charCodeAt` and string length inside a prefix fingerprint. These protect identity/cache consistency; they are not a model budget.
- `src/modules/image-input.ts:28,120`, `src/modules/mineru-client.ts:716`: byte/string encoding and binary signatures.
- `tests/web-tools.test.ts:96,113`: HTTP `charset=utf-8` fixtures.
- `docs/minimal-self-contained-chatpdf-mcp-plan.md:102`: Mermaid `flowchart`, a substring-search false positive.
- Small debug preview slices, masked-key slices, search-term length checks, line positions, array lengths, and real byte limits are also distinct from context capacity. Removing character capacity must not break encoding, text editing, exact evidence retrieval, or network limits.

## Model-capacity gap and proposed replacement

Current `LLMSettings` (`src/modules/llm-client.ts:139-145`) and both `ModelProfile` definitions (`src/modules/panel-state.ts:19-27`, `src/modules/preference-script.ts:19-27`) contain endpoint, model, credentials, and thinking settings only. There is no model-capacity discovery request, tokenizer/counting integration, model-specific input/output limit, or tokenizer identity. Existing provider token usage is retrospective accounting and does not determine the next request's budget.

The replacement should have these properties:

1. Resolve capabilities by configured provider endpoint plus exact model identity. Prefer that endpoint's model metadata; use a verified provider adapter/registry where necessary. Any manual capacity override is per model and in tokens, with its source visible. Unknown capacity stays explicitly unknown until resolved; it must not silently become a renamed global constant or a character conversion.
2. Count the complete request using supported provider counting/tokenizer capabilities. Include tools, protocol overhead, replayed reasoning, and multimodal inputs. Distinguish an estimate from provider-reported usage. Do not substitute `text.length / 4`.
3. Apply the provider's input/output-window semantics. For a shared total window, reserve requested output/reasoning and a safety margin before deciding available input; providers with separate input/output limits need their own rules. Derive compact timing, page size, summary budget, and retry ceilings from those limits.
4. Keep source storage and exact retrieval independent of tokens. Opaque cursors can retain internal offsets without exposing a public character unit or breaking historical coverage. Do not tokenize-slice and decode arbitrary partial tokens into potentially changed source text.
5. Preserve cache-friendly behavior: capability resolution and accounting live in the harness; stable system/tool/message prefixes remain unchanged within a context generation. Tokenizer accounting can cache immutable segments. Do not inject changing capacity counters into each leading prompt.
6. UI should report effective model capacity and current working-context use in tokens/percent, separately from session-wide billed usage. Source badges must not claim whole-document tokens are already occupying the request.

### Verified provider metadata examples

- [DeepSeek model listing](https://api-docs.deepseek.com/api/list-models/) documents `context_window` (combined input/output token capacity) and `max_output_tokens`. Its current example for `deepseek-flash` declares 1,048,576 and 393,216 respectively. These are official documentation examples, not an authenticated measurement of this user's configured endpoint. The plugin currently reads neither field.
- [OpenRouter model listing](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) documents `context_length`, tokenizer metadata, and provider output limits.
- [Gemini model metadata](https://ai.google.dev/api/models) documents `inputTokenLimit` and `outputTokenLimit`; its field semantics differ from a single combined window.

All three references were checked on 2026-09-28. Provider metadata can change, and proxy endpoints can apply different effective limits. The model's window and exact current-request token count are separate questions; discovering one does not solve the other.

## Suggested migration order

1. Implement and validate model capability resolution and complete-request token accounting.
2. Replace all active context/compact/page decisions together; preserve archive and pending-operation invariants.
3. Migrate the retrieval contract and telemetry; read old schemas without reinterpreting old numeric units.
4. Remove character product labels, badges, prompts, and the dormant context code.
5. Update tests and active documentation, label historical evidence, and verify unchanged cache prefixes, model switching, unknown metadata, images, cancellation, restart, and exact retrieval.

No runtime changes, preference changes, installation, commit, or push were performed as part of this audit.

<!-- literal-inventory -->

## Complete literal-match inventory

The broad search produced **125 matching lines in 31 files** at the audited commit. **103 lines in 26 files** concern character-based units, schemas, policy, prompts, logs, tests or historical documentation. The other **22 lines** are editor/encoding semantics or lexical false positives. These are matching-line counts, not counts of independent defects. Indirect uses with no literal keyword are documented above.

Search: case-insensitive `char|字符|字数` over tracked text files, excluding dependency lock contents and vendored KaTeX CSS. The report itself is not part of its source snapshot.

### AGENTS.md

- Line 103: <code>| &#96;contextMaxChars&#96; | number | &#96;240000&#96; |</code>

### CHANGELOG.md

- Line 80: <code>- Add a configurable &#96;contextMaxChars&#96; budget that fails explicitly before provider submission.</code>
- Line 171: <code>- Renamed preference &#96;maxContextChars&#96; to &#96;maxDocumentChars&#96; and raised the document content budget default to 300,000 characters.</code>

### addon/content/preferences.xhtml

- Line 142: <code>&lt;html:label for="zotero-prefpane-__addonRef__-contextMaxChars" data-l10n-id="pref-context-max-chars"&gt;&lt;/html:label&gt;</code>
- Line 143: <code>&lt;html:input type="number" id="zotero-prefpane-__addonRef__-contextMaxChars" preference="contextMaxChars" style="width: 110px;" min="20000" step="10000" /&gt;</code>

### addon/locale/en-US/preferences.ftl

- Line 20: <code>pref-context-max-chars = Working context size (characters; automatic compaction, not a reading quota)</code>

### addon/prefs.js

- Line 16: <code>pref("contextMaxChars", 240000);</code>

### docs/agent-context-compaction-plan.md

- Line 3: <code>Status: implemented in version 0.9.0, 2026-09-28, including output-budget retries and chronological narration rendering; see &#96;llm-workflow.md&#96; for actual runtime behavior. The capacity policy currently uses the existing explicit character setting rather than automatic token-window discovery. It compacts completed exchanges into a checkpoint and recovers recent evidence from stored results; it does not replay old signed thinking across rewritten prefixes. Active image context is rebuilt after restart. Provider-specific cache performance and summary quality require real-provider evaluation.</code>
- Line 19: <code>- Delivered tool text: 196,858 JavaScript string characters, including metadata. Withheld results totaled 189,745 characters, including overlapping retries.</code>
- Line 20: <code>- First paper: two successful reads of 64,422 and 72,977 characters.</code>
- Line 21: <code>- Second paper: an 80,472-character result exceeded the fixed 80,000-character per-result cap. Smaller retries eventually delivered 48,872 and 6,194 characters.</code>
- Line 22: <code>- A later 41,051-character result encountered only 10,892 characters of remaining allowance. Subsequent retries reduced the allowance further.</code>
- Line 23: <code>- From iteration 11, the reported remaining allowance was zero. Even a 338-character chunk-status response and a 197-character tool response were withheld. The third paper's body never reached the main model.</code>
- Line 30: <code>&#96;tool-result-budget.ts&#96; computes, for the default 240,000-character setting:</code>
- Line 34: <code>remaining = max(0, 240,000 - currentContextChars - reserve)</code>
- Line 41: <code>&#96;chat-session.ts&#96; only reduces history when constructing a new user turn. It replaces historical tool bodies with call provenance and drops old messages to fit a character budget. That is not a semantic checkpoint and cannot reclaim space during the active turn.</code>
- Line 43: <code>The gate was introduced in commit &#96;bf303324c5f345f3adbc67a5239c0edbe47fb4fd&#96;. Its preservation of full history is useful, but its recovery instructions do not provide recovery once the context is full. Raising &#96;contextMaxChars&#96; also leaves the independent 80,000/120,000 caps in place.</code>
- Line 77: <code>Use a known provider tokenizer/count endpoint where supported. Otherwise use a documented conservative estimate calibrated against returned usage. Provider-reported previous usage is historical measurement, not an exact count of the next request. Unknown compatible endpoints need an explicit model context configuration; do not infer capacity from a model name alone. Keep legacy character settings as a clearly labeled migration fallback, not a reading allowance.</code>
- Line 103: <code>First reclaim old context and retry delivery of the already executed result; do not rerun its tool. Deliver complete current results directly whenever the request fits. Remove the fixed per-result and per-batch character caps.</code>
- Line 187: <code>- An 80,472-character result is delivered whole when capacity permits; oversized single results and parallel batches are fully retrievable through explicit pages.</code>

### docs/llm-workflow.md

- Line 90: <code>&#96;contextMaxChars&#96; defaults to 240,000 and now controls working-context compaction, not a cumulative reading allowance. The harness estimates characters for text, tool schemas, and replay fields, with a conservative allowance for image inputs. At about 75% of the configured size it summarizes completed exchanges, then resumes automatically. This is an explicit character-based fallback, not an exact tokenizer or model-capacity discovery mechanism. Recognized provider context errors trigger bounded recovery using smaller complete exchanges.</code>
- Line 96: <code>Results too large for immediate delivery are stored completely and represented by an explicit result ID. &#96;read_tool_result&#96; returns exact, zero-based, end-exclusive character pages and the next cursor; page size adapts to working capacity. It checks both current session membership and TurnScope. No fixed 80,000-character result limit or cumulative reading quota remains. Full result bodies are stored once in &#96;agentContext.results&#96;; UI iteration history and exact provider events are hydrated from references when a session is loaded. Compaction changes the active event view, not the full transcript. Binary images are never serialized; restoring a working view containing images requires reconstruction and explicit image rereading.</code>
- Line 136: <code>Limits are **10 MiB per image** and **20 MiB of image bytes per turn**, including repeated reads. Oversized inputs are rejected, never silently resized or truncated. Image payloads are separate from the text character budget; visual token usage comes from the provider.</code>

### docs/minimal-self-contained-chatpdf-mcp-plan.md

- Line 102 (technical / non-capacity): <code>flowchart LR</code>
- Line 578: <code>- Ordered chunk concatenation equals the complete document, ranges are contiguous and 1-based, and character totals match.</code>
- Line 608: <code>- A fresh-agent R10 failure found that chunk listings lacked a document character total. The release code now returns</code>
- Line 609: <code>&#96;total_lines&#96;, &#96;character_count&#96;, and &#96;chunk_count&#96;, and the new R10 session proved that the seven chunk counts sum</code>
- Line 610: <code>to the 477,779-character document total.</code>

### src/modules/agent-context.ts

- Line 36: <code>requests?: { kind: "agent" | "compact"; generation: number; usage?: TokenUsage; inputChars: number; finishReason?: string; outputLimit?: number }[];</code>
- Line 57: <code>const chars = typeof content === "string" ? content.length : content.reduce((n, part) =&gt;</code>
- Line 59: <code>return sum + chars + JSON.stringify(envelope).length;</code>
- Line 72 (technical / non-capacity): <code>for (let i = 0; i &lt; text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);</code>
- Line 108: <code>return &#96;[Stored result ${id}: characters ${start}-${end} of ${result.content.length}; end is exclusive; next_start=${end &lt; result.content.length ? end : "none"}]\n&#96; + result.content.slice(start, end);</code>
- Line 133: <code>&#96;${result.id}: ${result.content.length} characters; delivered ranges=${JSON.stringify(result.ranges || [])}&#96;);</code>
- Line 158: <code>? &#96;[Recovered completed action. Do not repeat it. Result ${result.id} (${result.content.length} characters) is stored; use read_tool_result to inspect it.]&#96;</code>

### src/modules/agent-loop.ts

- Line 50: <code>let limit = contextLimit(getPref("contextMaxChars"));</code>
- Line 90: <code>toolContext.resultPageChars = Math.max(1_000, Math.floor(limit * 0.25));</code>
- Line 114: <code>(context.data.requests ||= []).push({ kind: "agent", generation: context.data.checkpoints.length, usage: result.usage, inputChars: contextSize(context.messages, tools) });</code>
- Line 154: <code>const length = Math.min(Number(args.max_chars || toolContext.resultPageChars), toolContext.resultPageChars!);</code>
- Line 180: <code>item.message.content = &#96;[Paged tool result: result_id=${item.record.resultId}, total_chars=${item.record.result.length}. The tool executed and its complete result is stored. Body not yet delivered. Use read_tool_result(result_id="${item.record.resultId}", start=0) and follow next_start to inspect it. No cumulative read quota applies.]&#96;;</code>

### src/modules/chat-session.ts

- Line 413: <code>const maxChars = Number.POSITIVE_INFINITY;</code>
- Line 416: <code>Zotero.debug(&#96;[ChatPDF] buildMessages: systemPrompt=${systemPrompt.length} chars, userMsg=${userMessage.length} chars, maxChars=${maxChars}, historyLen=${this.history.length}&#96;);</code>
- Line 418: <code>if (systemPrompt.length + userMessage.length &gt; maxChars) {</code>
- Line 419: <code>Zotero.debug(&#96;[ChatPDF] WARNING: System prompt + user message is very large (${systemPrompt.length + userMessage.length} chars).&#96;);</code>
- Line 422: <code>const recentHistory = this.truncateHistory(systemPrompt.length, userMessage.length, maxChars,</code>
- Line 431: <code>const totalChars = messages.reduce((sum, m) =&gt; sum + m.content.length, 0);</code>
- Line 432: <code>Zotero.debug(&#96;[ChatPDF] Final message array: ${messages.length} messages, ${totalChars} total chars&#96;);</code>
- Line 434: <code>Zotero.debug(&#96;[ChatPDF]   [${m.role}] ${m.content.length} chars — "${m.content.slice(0, 60).replace(/\n/g, "\\n")}..."&#96;);</code>
- Line 442: <code>* that fit within the char budget. transformFn maps a ChatMessage to a simplified</code>
- Line 448: <code>maxChars: number,</code>
- Line 451: <code>let totalChars = systemLen + userLen;</code>
- Line 460: <code>if (totalChars + transformed.content.length &gt; maxChars) {</code>
- Line 464: <code>totalChars += transformed.content.length;</code>
- Line 469: <code>Zotero.debug(&#96;[ChatPDF] Context truncation: dropped ${droppedCount} oldest history messages to fit within ${maxChars} chars&#96;);</code>
- Line 496: <code>const maxDocChars = Number.POSITIVE_INFINITY;</code>
- Line 501: <code>const docBudget = maxDocChars - instructionText.length;</code>
- Line 577: <code>Zotero.debug(&#96;[ChatPDF] System prompt length: ${prompt.length} chars, includes ${readySources.length} documents&#96;);</code>
- Line 599: <code>Zotero.debug(&#96;[ChatPDF] buildAgentMessages: rebuilding working view; systemPrompt=${systemPrompt.length} chars, historyLen=${this.history.length}&#96;);</code>
- Line 627: <code>return &#96;- ${tc.toolName}${argsStr}: ${tc.result.length} characters returned${delivery}&#96;;</code>
- Line 641: <code>const totalChars = messages.reduce((sum, m) =&gt; sum + m.content.length, 0);</code>
- Line 642: <code>Zotero.debug(&#96;[ChatPDF] buildAgentMessages: final ${messages.length} messages, ~${totalChars} total chars&#96;);</code>
- Line 698: <code>Zotero.debug(&#96;[ChatPDF] buildAgentSystemPrompt: ${prompt.length} chars (stable source-independent prefix)&#96;);</code>

### src/modules/chatpdf-bridge.ts

- Line 59: <code>throw new Error("options.language must be a non-empty string of at most 32 characters");</code>

### src/modules/context-compaction.ts

- Line 35: <code>const instruction: ContextMessage = { role: "user", content: COMPACT_PROMPT + &#96;\nAim for no more than ${target} characters.&#96; +</code>
- Line 49: <code>inputChars: contextSize(request, tools), finishReason: result.finishReason, outputLimit: maxTokens });</code>
- Line 86: <code>Zotero.debug(&#96;[ChatPDF] compact: beforeChars=${before}, afterChars=${after}, generation=${context.data.checkpoints.length}&#96;);</code>

### src/modules/conversion-manager.ts

- Line 300: <code>charCount: cached.get(chunk.index)?.length,</code>
- Line 309: <code>charCount: chunk.markdown.length,</code>

### src/modules/debug-log.ts

- Line 50: <code>totalChars: messages.reduce((sum, message) =&gt; sum + message.content.length, 0),</code>

### src/modules/image-input.ts

- Line 28 (technical / non-capacity): <code>const ascii = (start: number, end: number) =&gt; String.fromCharCode(...bytes.subarray(start, end));</code>
- Line 120 (technical / non-capacity): <code>for (let i = 0; i &lt; bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));</code>

### src/modules/llm-client.ts

- Line 366: <code>const totalChars = messages.reduce((s, m) =&gt; s + (typeof m.content === "string" ? m.content.length : 0), 0);</code>
- Line 367: <code>Zotero.debug(&#96;[ChatPDF] chatWithTools: ${messages.length} messages, ${tools?.length ?? 0} tools, ~${totalChars} chars, stream=${streaming}, thinking=${settings.thinkingMode}, effort=${settings.thinkEffort}&#96;);</code>

### src/modules/md-cache.ts

- Line 11: <code>charCount?: number;</code>

### src/modules/mineru-client.ts

- Line 716 (technical / non-capacity): <code>uint8[i] = bytes.charCodeAt(i);</code>

### src/modules/send-handler.ts

- Line 78: <code>content: "Generate a concise, specific title for this conversation. Detect the language of the user's message and reply in that same language. Reply with ONLY the title text \u2014 no quotes, no punctuation at the end, maximum 50 characters.",</code>
- Line 474: <code>Zotero.debug(&#96;[ChatPDF] handleSend: agent result: ${fullText.length} chars, ${agentResult.iterations.length} iterations, totalIter=${agentResult.totalIterations}&#96;);</code>

### src/modules/source-chips.ts

- Line 2: <code>import { formatChars } from "../utils/format";</code>
- Line 120: <code>const charLen = source.markdown.length;</code>
- Line 121: <code>const sizeText = formatChars(charLen);</code>
- Line 187: <code>const totalChars = readySources.reduce((sum, s) =&gt; sum + (s.markdown?.length ?? 0), 0);</code>
- Line 189: <code>&#96;${formatChars(totalChars)} chars&#96;);</code>

### src/modules/tiptap-input.ts

- Line 121 (technical / non-capacity): <code>type SelectionGranularity = "character" | "line";</code>
- Line 182 (technical / non-capacity): <code>// We also handle single-character deletion explicitly since the browser's</code>
- Line 208 (technical / non-capacity): <code>// Fallback: delete one character backward (native beforeinput may not work in XHTML)</code>
- Line 214 (technical / non-capacity): <code>// Also check if there's a trigger "@" character right before the mention</code>
- Line 219 (technical / non-capacity): <code>Zotero.debug(&#96;[ChatPDF] TipTap Backspace: fallback char delete at pos ${$from.pos}&#96;);</code>
- Line 249 (technical / non-capacity): <code>// Fallback: delete one character forward</code>
- Line 259 (technical / non-capacity): <code>Zotero.debug(&#96;[ChatPDF] TipTap Delete: fallback char delete at pos ${$from.pos}&#96;);</code>
- Line 268 (technical / non-capacity): <code>ArrowLeft: ({ editor }) =&gt; moveRenderedSelection(editor, "move", "left", "character"),</code>
- Line 269 (technical / non-capacity): <code>ArrowRight: ({ editor }) =&gt; moveRenderedSelection(editor, "move", "right", "character"),</code>
- Line 272 (technical / non-capacity): <code>"Shift-ArrowLeft": ({ editor }) =&gt; moveRenderedSelection(editor, "extend", "left", "character"),</code>
- Line 273 (technical / non-capacity): <code>"Shift-ArrowRight": ({ editor }) =&gt; moveRenderedSelection(editor, "extend", "right", "character"),</code>

### src/modules/tools.ts

- Line 54: <code>resultPageChars?: number;</code>
- Line 114: <code>description: "Read exact text from a stored tool result in this session. Use result_id from a paged result or checkpoint. Offsets are zero-based characters, end-exclusive. Follow next_start until the needed content is inspected. Page size adapts to working-context capacity; there is no cumulative read allowance.",</code>
- Line 118: <code>max_chars: { type: "integer", minimum: 1, description: "Requested page length. The response explicitly reports the actual range and continuation cursor." },</code>
- Line 469: <code>const requested = args.max_chars === undefined ? (context.resultPageChars || 40_000) : Number(args.max_chars);</code>
- Line 470: <code>if (!Number.isSafeInteger(requested) || requested &lt;= 0) throw new Error("max_chars must be a positive integer.");</code>
- Line 472: <code>Math.min(requested, context.resultPageChars || 40_000),</code>
- Line 547: <code>Zotero.debug(&#96;[ChatPDF] executeTool: ${name} done in ${durationMs}ms, result=${result.length} chars&#96;);</code>
- Line 549: <code>return &#96;${result}\n\n[Tool result metadata: ${result.length} characters; approximately ${estimatedTokens} tokens; no hidden truncation applied.]&#96;;</code>
- Line 624: <code>const charCount = source.markdown.length;</code>
- Line 626: <code>lines.push(&#96;- size: ${charCount} chars, ${lineCount} lines&#96;);</code>
- Line 652: <code>Zotero.debug(&#96;[ChatPDF] list_sources: result=${result.length} chars, ${sources.length} sources, ${readyCount} ready&#96;);</code>
- Line 674: <code>Zotero.debug(&#96;[ChatPDF] read_document: key="${key}", lines ${start}-${end} of ${totalLines}, total chars=${markdown.length}&#96;);</code>
- Line 681: <code>Zotero.debug(&#96;[ChatPDF] read_document: returning ${result.length} chars&#96;);</code>
- Line 710: <code>const size = chunk.charCount ? &#96;, ${chunk.charCount} chars&#96; : "";</code>
- Line 1288: <code>Zotero.debug(&#96;[ChatPDF] duckDuckGoSearch: got ${html.length} chars HTML for "${query}"&#96;);</code>
- Line 1358: <code>Zotero.debug(&#96;[ChatPDF] web_fetch: cleaned content ${text.length} chars from ${url}&#96;);</code>
- Line 1359: <code>return &#96;Content from ${res.finalUrl} (${res.bytesRead} bytes, ${text.length} text characters):\n\n${text}&#96;;</code>

### src/utils/format.ts

- Line 46: <code>/** Format character counts for display (e.g. 1500 -&gt; "2K", 1234567 -&gt; "1.2M"). */</code>
- Line 47: <code>export function formatChars(n: number): string {</code>

### tests/agent-compaction.test.ts

- Line 19: <code>vi.mocked(Zotero.Prefs.get).mockImplementation(key =&gt; String(key).endsWith("contextMaxChars") ? limit : undefined);</code>
- Line 90: <code>it("delivers an 80472-character result whole when it fits", async () =&gt; {</code>

### tests/agent-context.test.ts

- Line 96: <code>const context = { session, requestId: "test", windowId: "window", turnScope: new Set([source.id]), resultPageChars: 6 };</code>
- Line 116: <code>expect(context.messages[1].content).toContain(&#96;${result.id}: 10 characters; delivered ranges=[[0,5]]&#96;);</code>

### tests/chat-session.test.ts

- Line 66: <code>expect(combined).toContain("50000 characters returned");</code>

### tests/tiptap-input.test.ts

- Line 40 (technical / non-capacity): <code>["ArrowLeft", false, "move", "left", "character"],</code>
- Line 41 (technical / non-capacity): <code>["ArrowRight", false, "move", "right", "character"],</code>
- Line 44 (technical / non-capacity): <code>["ArrowLeft", true, "extend", "left", "character"],</code>
- Line 45 (technical / non-capacity): <code>["ArrowRight", true, "extend", "right", "character"],</code>

### tests/web-tools.test.ts

- Line 96 (technical / non-capacity): <code>{ status: 200, headers: { "content-type": "text/html; charset=utf-8" } },</code>
- Line 113 (technical / non-capacity): <code>{ status: 200, headers: { "content-type": "text/html; charset=utf-8" } },</code>

### typings/i10n.d.ts

- Line 12: <code>| 'pref-context-max-chars'</code>

### typings/prefs.d.ts

- Line 25: <code>"contextMaxChars": number;</code>
