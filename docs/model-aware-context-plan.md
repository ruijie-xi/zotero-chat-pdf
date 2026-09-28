# Model-aware token budgeting and legacy cleanup

Status: implemented in 0.9.1, 2026-09-28. Design baseline: `f93b4a5` (0.9.0). See the implementation/validation notes below and `llm-workflow.md` for the shipped behavior.

This supersedes the broad removal recommendations in `character-unit-audit.md`. The agreed boundary is: document/tool text size and exact text positions may use characters; every decision about model context, compaction, request delivery capacity, or model output uses tokens and model capabilities.

## 1. Unit boundaries

| Domain | Units / policy |
| --- | --- |
| Document and stored tool-result size | Characters and lines/pages remain valid; label them explicitly. Document size does not imply current model-context occupancy. |
| Text retrieval | Preserve existing character offsets and caller `max_chars` semantics as a source selection, not a model allowance. Prefer paragraph/line boundaries, and never split a surrogate pair. Report the actual returned range. |
| Model input, schemas, replay, images, compaction | Model-aware tokens. Estimated and provider-measured counts are different fields. |
| Model output | Tokens, with provider-specific accounting for reasoning and combined/separate input-output limits. |
| File/network/memory limits | Bytes remain bytes; unrelated transport and I/O protections are unchanged. |
| Title length and editor operations | Presentation and string operations remain independent of context budgeting. |

Keep `charCount` in document manifests, useful `chars` metadata in tools, and `formatChars` for explicitly labeled document badges. Remove `ceil(text.length / 4)` as a model-token estimate. Character-only tool metadata is acceptable without a token estimate. Accurate token metadata need not be appended to every model-visible tool result: the harness owns request accounting.

## 2. Model capabilities

Introduce `model-capabilities.ts` and one shared model-profile type. Resolve by normalized configured endpoint, protocol, exact model identifier, and local profile identity where account limits can differ. Do not derive capacities from fuzzy model-name matches or from historical character preferences.

Normalized fields include optional combined context tokens, optional input-token limit, maximum output tokens, output/reasoning accounting rules, tokenizer identity/revision or count capability, image-token rules, source of capability data, resolution time, and resolved model/version identity when supplied by the provider.

Resolution order:

1. A user-entered per-model token override, shown as an explicit override of discovered values.
2. Supported metadata from the configured provider endpoint.
3. Last verified metadata or a versioned provider adapter/catalog entry for that exact model/endpoint family, with provenance and staleness shown.
4. Unknown. Ask for model capacity in model setup when it cannot otherwise be resolved. Do not silently select a global default window. The agent must not repeatedly ask about configuration during a working turn.

Use short, abortable discovery requests and cache capabilities, initially for 24 hours with a manual refresh control. Freeze the effective capability snapshot for a send; apply background refreshes on the next turn. An explicit provider limit rejection can trigger validated limit recovery at a safe complete-exchange boundary. A counting-only capability update invalidates counting caches, not transcript content or the provider prompt prefix. A model/protocol change follows explicit replay compatibility rules.

Provider metadata and token counting must use the configured service or an explicitly supported endpoint on that service. Never forward private prompts or credentials to a third-party counting service. Registry/tokenizer artifacts must be bundled or retrieved through a verified adapter, not executed from an arbitrary URL in model metadata.

Current official examples:

- [DeepSeek model listing](https://api-docs.deepseek.com/api/list-models/): `context_window` counts input plus output, and `max_output_tokens` is an output ceiling.
- [OpenRouter model listing](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties): model/provider context limits and output limits; effective routing limits must be respected.
- [Gemini models](https://ai.google.dev/api/models): input and output limits are separate fields.

An output ceiling is not a requirement to reserve that entire ceiling for every request. Reserve the output allowance actually requested.

## 3. Token accounting: first implementation gate

Introduce `token-accounting.ts`. It measures the actual provider-bound request representation, including system text, ordered tool schemas, message structure, tool calls/results, retained replay fields, and multimodal input. Do not count transport-only fields or base64 length as model tokens.

Select a provider adapter with one of these supported modes:

- A provider count endpoint for an equivalent request, when available. The adapter must demonstrate that protocol conversion does not omit tools, system instructions, images, or replay fields; otherwise label the result an estimate.
- A verified tokenizer matching the selected model, with the provider's message/template rules. Verify JS/WASM operation in Zotero's Firefox chrome runtime; no Node/Python service is assumed in the installed plugin.
- A local tokenizer-based estimate with explicitly identified tokenizer/template assumptions and error bounds calibrated against provider input usage. This is not an exact count and must be labeled accordingly. No character-ratio fallback is permitted.

If there is no supported tokenizer or count route, report that capability as unsupported and require a supported adapter/configuration rather than silently claim exact token budgeting. Any approximate-tokenizer mode must be explicit; selecting a window alone does not identify the tokenizer.

[DeepSeek token documentation](https://api-docs.deepseek.com/quick_start/token_usage/) links an offline tokenizer example, but the compatibility of those assets with the current selected model must be verified before adoption. It also points to dimension-based image counting. [Gemini countTokens](https://ai.google.dev/api/tokens) supports counting with system instructions and tools. This audit has not established a DeepSeek Chat Completions count endpoint; the implementation must not assume one exists.

Return count, method, tokenizer revision, confidence/uncertainty, and an input-breakdown suitable for diagnostics. Calibrate estimates from actual `prompt_tokens`, counting cached input as context occupancy too. Usage from the previous response is an observation about that request, not the exact count of the next one. Replayed reasoning is counted according to what the adapter actually sends, not by adding all billed reasoning tokens from the previous response.

Cache immutable segment/tokenization work, but respect tokenizer merges and provider template boundaries. Summing independently tokenized arbitrary string pieces is not automatically exact. Recompute affected boundaries or the whole serialized input when required; validate incremental and full accounting against each other.

## 4. One request budget planner

Introduce `context-budget.ts` as the single pure policy layer for ordinary agent, compaction, and auxiliary model requests.

For a combined context window C, optional input ceiling Imax, requested output allowance O, and safety/uncertainty reserve M:

`B = min(Imax when present, C - O) - M`

For independently limited input/output, use the provider's input ceiling minus M, and separately enforce the output ceiling. O includes reasoning where the protocol charges it to the output allowance. M derives from the adapter's known overhead/uncertainty and calibrated counting error; it is not another character allowance.

Recommended initial soft trigger: 80% of usable input budget B. Also reserve enough space for the compaction instruction and its requested output: the actual trigger cannot exceed the summarizer's safe input ceiling. A planned request that does not fit is handled before submission even below the soft trigger. This prevents a large tool response from jumping past the threshold.

Compaction should bring working input below about 50-60% of B, while minimizing actual summary size and preserving useful recent exchanges. This is a ceiling/target for the entire retained working context, not an instruction to inflate summaries to that size. Summary-visible token target, recent-tail budget, reasoning/output allowance, and retry budget are derived independently and checked together against the model's capacity.

The planner produces fit/compact/page/configuration-error decisions with token reasons. It does not execute tools or rewrite original events. Remove scattered character-based 25%, 50%, 55%, 65%, 75%, 82%, 85%, per-call 500-unit, and image 32,768-unit decisions once their token equivalents are integrated. Percentages remain legitimate policy parameters; their dimensional base must be an effective token budget.

## 5. Tool execution, storage, and delivery

1. Execute an authorized tool once and persist its complete result and operation receipt.
2. Keep source length and retrieval offsets independent of model capacity. A caller's `max_chars` limits source selection only.
3. Measure the completed exchange, including all response envelopes. If it fits, deliver the complete selected result.
4. If compaction can make it fit, reclaim older completed context and reuse the stored result. Never repeat the original tool's side effect to recover context space.
5. If a selected result cannot fit even in a fresh working view, expose a result reference and explicit pagination. Choose the actual text boundary by token budget, preserving exact original substrings. A preliminary boundary search must finish with measurement of the complete planned request; token counts over arbitrary substrings need not be monotonic.
6. Record the actual returned source range from retrieval itself. Do not reconstruct `parentRange` from the requested `max_chars`, because token-aware delivery may return less. Report `next_start` and selected/returned ranges clearly.

Operate at complete tool-exchange boundaries. Preserve assistant/tool-call pairing; do not submit half-executed groups to the summarizer. Oversized results can have complete reference envelopes while their full bodies remain stored. Pending operations, side-effect receipts, unread ranges, and source authorization are harness-maintained state independent of summary wording.

There is no cumulative document-reading quota. Byte transport limits remain explicit and independent.

## 6. Compaction and cache behavior

Keep the prompt task-independent. Preserve active goals, instructions, constraints, established evidence, completed actions, unresolved questions, next steps, precise evidence references, and uncertainty. A compact operation cannot answer the user task or dispatch tools. State summary targets in tokens; enforce them through counting rather than trusting generated prose.

Normal summarization reuses the current system, tools in their existing order, model, and compatible settings, appending only the compact request. Preserve message bytes, raw tool arguments, and supported replay fields. No timestamps, capacity counters, or new source inventory are inserted into the leading prompt. No per-iteration reformatting or silent deletion of old result bodies to improve fit.

On truncated summary output, increase the output allowance within the model ceiling and remaining combined-window capacity, with a bounded attempt count (initially three). Keep prompt bytes unchanged whenever the larger allowance still fits. A larger allowance reduces available input on a shared-window model: if it no longer fits, use complete-exchange recovery groups instead of sending a predictably invalid request. Never commit a truncated checkpoint or append its partial reasoning to the next summary request.

Validate the candidate checkpoint plus deterministic harness state and retained recent tail. Retain recent complete exchanges verbatim where the provider permits replay after a prefix change; signed thinking/replay fields must pass provider-specific compatibility rules and must not be blindly copied across generations. Keep the tail within a token budget, with the current user instruction once at the correct chronological position. The retained tail must not force retention of an unbounded current turn. Preserve older active constraints in the checkpoint and keep exact evidence recoverable.

Commit the new working generation only after fit, progress, pairing, cancellation, and source-validity checks pass. A failed/cancelled summary leaves the full archive and prior usable working state intact. Model usage from all attempts is accounted once. The first request after a new checkpoint has an intentionally changed prefix; subsequent requests append to that stable generation. This does not guarantee a provider cache hit, which must be measured separately.

## 7. Legacy deletion and migration

| Area | Action |
| --- | --- |
| `ChatSession.buildMessages()` / old `buildSystemPrompt()` | Remove the unused whole-document-in-system path. Repository callers of `buildMessages` were not found. |
| `truncateHistory(..., Infinity)` | Replace the active reconstruction caller with straightforward ordered mapping/filtering, then delete the helper and its dead character-truncation branches. |
| Proportional document allocation / truncation markers | Delete with the legacy path. No first-N-character document injection remains. |
| `SourceItem.contextRatio` and truncated badge/CSS | Delete. Preserve labeled document character counts as source metadata. |
| `DEFAULT_NO_DOCS_PROMPT_*` | Delete if the complete caller scan confirms only the removed path uses them. The agent can discover sources through tools. |
| `DEFAULT_SYSTEM_PROMPT_EN/CN` | Do not delete blindly: preferences still import them. Move shared defaults to a small prompt module and align them with the agent workflow. Preserve actual user-custom prompt text; migrate only known built-in defaults deliberately. |
| `contextMaxChars` and historical `maxContextChars` / `maxDocumentChars` | Remove active defaults, setting UI, types, and runtime reads. Ignore obsolete stored values, optionally clear them after successful settings migration. Never divide their numbers into guessed tokens. |
| Old `contextSize`, `contextLimit`, `resultPageChars` | Remove policy helpers/fields after integrating the token planner. Keep public source-selection `max_chars` and stored character ranges. |
| Fixed `length / 4` tool metadata | Remove. Keep useful character/line metadata; model metrics use actual/estimated token fields. |
| Duplicated `ModelProfile` declarations | Consolidate profile types and capability handling. |
| Legacy `toolHistory` / reasoning display paths | Normalize old records once at the loading boundary into canonical iterations. Remove dual runtime write/render branches after fixture tests establish equivalent display. Function parameter names alone are not legacy schemas. |
| Historical `contextDelivery: omitted` | Preserve its meaning: the model did not receive the original result. Normalize to explicit historical non-delivery/provenance metadata; never relabel it as successful delivery. |
| Old `inputChars` telemetry | Read as historical character telemetry only; do not manufacture token usage. New request records store token fields. |
| Plans and workflow docs | Rewrite current policy in one authoritative workflow document. Mark prior audit/design requirements as superseded; retain historical incident facts and changelog accuracy. |

Use a focused migration module at the session boundary. Proposed new schemas: saved session v4 and agent-context v2. Write only the new canonical form; read old forms through explicit migrations. Preserve event order, IDs, source scope, result bodies, unread ranges, side effects, terminal statuses, and actual provider usage. Counting caches may be rebuilt without touching provider message bytes.

Migrate lazily when a session is opened/saved; keep an original private backup on first successful rewrite and use existing atomic storage. Do not bulk-delete historical sessions, rewrite evidence, or copy user records into the repository. Prefer serialization-level identity tests for events/results and semantic identity tests for normalized display.

## 8. UI and telemetry

- Source badges: explicitly labeled characters/pages/status. Keep them visually distinct from model context.
- Model settings: automatic capability source, effective token window, output ceiling, tokenizer/count method, and optional per-profile token override. Compact threshold is a percentage of usable model input, with an advanced override if needed.
- Context indicator: current working input tokens and available input capacity/percentage, with an estimate marker when applicable. Show model maximum separately from reserved output.
- Existing session usage: cumulative actual input/output/reasoning/cache usage, kept distinct from current occupancy.
- Compact status: stage and before/after token counts; preserve chronological narration rendering.
- New request telemetry: capability snapshot, counting method/revision, estimated input, uncertainty reserve, output allowance, effective token capacity, actual input/output/cache usage, finish reason, and context generation. Optional character/byte diagnostics remain explicitly named as raw-text/transport metrics and never drive capacity.

## 9. Implementation phases and gates

1. Capability/counting proof: DeepSeek first for the current deployment; verify metadata semantics, matching tokenizer assets, Firefox runtime behavior, representative multilingual/formula/tool/vision inputs, and comparison with actual provider usage. Add other provider adapters behind explicit capability support. No invented generic exactness.
2. Pure token planner and request integration: normal agent and compact requests first, then auxiliary title requests. Validate shared/separate windows, output reserves, overflow, larger-summary retries, unknown metadata, and small-window edge cases.
3. Storage/delivery integration: exact-range token-sized pages, complete-exchange boundaries, deterministic coverage, no duplicate mutations, cancellation, source removal, and restart recovery.
4. Legacy deletion and schema migration: remove dead branches, consolidate prompts/profile types, migrate old data, and update the single authoritative workflow document.
5. UI and acceptance: clearly separate source sizes, current context tokens, and billed session tokens. Run all verification and isolated Zotero smoke tests. Then test the user's provider on a controlled long conversation and report actual cache hit/miss values separately for normal requests, compact requests, first resumed request, and later requests.

Required regressions include model switching between small/large windows without changing a global character setting; threshold tests with equal character lengths but different token counts; tool schemas and multimodal overhead; incremental/full token-count equivalence; oversized results and Unicode-exact pagination; first and repeated compact operations; no-progress/length/cancelled summary behavior; original archive preservation; old-session migration; stable request prefixes across restart/follow-ups; and clear separation of current context use from cumulative usage.

Acceptance requires `npm ci --ignore-scripts`, `npm audit --audit-level=low`, `npm run verify`, isolated real Zotero panel testing, and provider-specific validation of count accuracy/cache behavior where an adapter claims that support. Mock success alone is not evidence of provider counting accuracy or actual prompt-cache hits.

## 10. Implementation and validation (0.9.1)

The model capability resolver, shared profile fields, pure token budget planner, local tokenizer counter, agent/compact/title preflight, token-fitted result delivery, exact range receipts, v4/v2 persistence and atomic legacy backups are implemented. Dead document embedding/truncation code, context ratios, old capacity preferences, duplicate profile types, tool-history writes/render branches and fixed character/token conversion are removed. Document characters, retrieval offsets, storage byte caps and presentation clipping remain explicit.

The initial capability adapters support OpenAI-compatible `/models` metadata (DeepSeek and OpenRouter field shapes), plus explicit per-profile token overrides. Native Gemini `countTokens` and native provider protocols are extension points, not claimed implemented adapters. The bundled DeepSeek V4 vocabulary matches the official tokenizer's text tokenization in Rust-reference fixtures. Request template overhead remains an estimate; unknown models require explicit approximate mode. Capacity metadata is cached in memory for 24 hours, so restart performs a fresh lookup. No remote tokenizer receives conversation text.

Real provider validation used only 400 generated bilingual records, with thinking disabled and a fixed tool schema. On the configured `deepseek-flash` (DeepSeek-V4.1-Flash) endpoint:

- Model metadata: combined window 1,048,576; maximum output 393,216 tokens.
- Initial local estimate: 12,562; actual prompt: 12,716 tokens (1.21% under, inside the safety reserve). The next estimate calibrated to 12,716.
- Identical repeat: 12,544 cached / 12,716 prompt tokens (98.65%).
- Same-prefix compaction: 12,672 cached / 13,027 prompt tokens (97.27%); 446 output tokens; complete checkpoint; retained context estimated at 610 tokens.

These measurements are a small synthetic validation, not a universal error bound or guaranteed cache rate. The isolated Zotero test separately verifies the packaged tokenizer runtime, first/retry/follow-up prefix equality, narration node identity/order, automatic continuation and status cleanup. Final validation: clean `npm ci --ignore-scripts`, `npm audit --audit-level=low` (0 vulnerabilities), and `npm run verify` (166 tests across 23 files, type checking, lint, production build) passed.
