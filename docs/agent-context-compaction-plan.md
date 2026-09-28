> Historical implementation plan for 0.9.0. Token capacity policy is superseded by [model-aware-context-plan.md](model-aware-context-plan.md) and the current [LLM workflow](llm-workflow.md). Historical incident evidence below is unchanged.

# Recoverable agent context management

Status: implemented in version 0.9.0, 2026-09-28, including output-budget retries and chronological narration rendering; see `llm-workflow.md` for actual runtime behavior. The capacity policy currently uses the existing explicit character setting rather than automatic token-window discovery. It compacts completed exchanges into a checkpoint and recovers recent evidence from stored results; it does not replay old signed thinking across rewritten prefixes. Active image context is rebuilt after restart. Provider-specific cache performance and summary quality require real-provider evaluation.

Updated requirement: provider prompt-cache reuse is a first-class design constraint, including the compaction request itself and continuation across user turns.

## Objective

An agent must be able to continue authorized research across arbitrarily many document reads without a cumulative reading allowance. The harness manages the finite working context, resource failures, cancellation, and permissions. Compaction must resume the same task without requiring the user to send another message.

Finite provider context windows still apply to each request. The design removes cumulative tool-delivery quotas; it does not promise unlimited input in one request or guaranteed completion of every possible task.

## Verified incident

A local session requested detailed summaries of three papers. The saved session and matching metadata logs were inspected read-only. Private document contents are not copied into this proposal.

- Model label: `deepseek / deepseek-flash`.
- 20 model iterations, 19 tool calls: 5 results delivered, 14 withheld.
- Delivered tool text: 196,858 JavaScript string characters, including metadata. Withheld results totaled 189,745 characters, including overlapping retries.
- First paper: two successful reads of 64,422 and 72,977 characters.
- Second paper: an 80,472-character result exceeded the fixed 80,000-character per-result cap. Smaller retries eventually delivered 48,872 and 6,194 characters.
- A later 41,051-character result encountered only 10,892 characters of remaining allowance. Subsequent retries reduced the allowance further.
- From iteration 11, the reported remaining allowance was zero. Even a 338-character chunk-status response and a 197-character tool response were withheld. The third paper's body never reached the main model.
- Tools executed and their full text was saved. The harness replaced their model-visible results with omission notices; this was not evidence of a provider context rejection.
- The final answer asked the user to send another message to complete the research.
- Provider-reported cumulative usage: 1,164,981 input tokens and 35,095 output tokens. The last request used 81,259 input tokens. Cumulative usage is not the size of a single context window.

## Root cause in current code

`tool-result-budget.ts` computes, for the default 240,000-character setting:

```text
reserve = 32,000
remaining = max(0, 240,000 - currentContextChars - reserve)
singleResultLimit = 80,000
batchLimit = min(120,000, remaining)
```

`agent-loop.ts` keeps appending tool results, assistant content, tool-call arguments, and provider reasoning throughout the turn. It never compacts that working context. Omission notices themselves consume more space. The notices recommend smaller retries even when no positive result can fit. The gate applies to all tool results, including navigation metadata and error messages.

`chat-session.ts` only reduces history when constructing a new user turn. It replaces historical tool bodies with call provenance and drops old messages to fit a character budget. That is not a semantic checkpoint and cannot reclaim space during the active turn.

The gate was introduced in commit `bf303324c5f345f3adbc67a5239c0edbe47fb4fd`. Its preservation of full history is useful, but its recovery instructions do not provide recovery once the context is full. Raising `contextMaxChars` also leaves the independent 80,000/120,000 caps in place.

## Proposed architecture

### 1. Separate the transcript from the working context

Keep full user messages, assistant outputs, tool arguments, tool results, and provider usage in the durable transcript. A separate working-context view contains:

- The original system policy and latest user request.
- A harness-generated current source scope, reconstructed from authoritative session state.
- A checkpoint summarizing older work.
- Recent complete assistant/tool exchanges and the current evidence needed for the next decision.

Compaction only replaces the working view. It does not rewrite the user's transcript or claim that unseen results were read. Persist checkpoint coverage, source/cache versions, provenance pointers, and usage atomically with the session. A checkpoint is derived memory, never an authorization source.

These are logical views, not two independent copies of all document bytes. Store a full tool result once under an immutable result ID. Transcript events and working-context blocks reference it; materialize its exact text only when building a provider request. Keep the user-facing chat rendering separate from the provider message sequence.

Suggested persisted records:

- Transcript events: stable event IDs, user text, assistant text, tool-call IDs, original argument strings, result references, execution/delivery status, and usage. Retain intermediate assistant messages needed to reconstruct the actual exchanges, not just the final answer.
- Result artifacts: immutable contents with source identity, source/content version, length, and exact range addressing. Images retain validated local references rather than persisted base64 payloads or credentials.
- Context checkpoints: summary text, covered event boundary, evidence pointers, source versions, and the completion state of outstanding work. Generated conclusions are distinct from mechanically recorded coverage.
- Working-context state: context generation ID, model/protocol compatibility fingerprint, exact ordered provider blocks or references, and the checkpoint they use. Reuse this state across user turns and restarts when compatible.

Persist only the provider fields needed for faithful supported replay, never authentication headers or credentials. Existing `IterationRecord` objects lack tool-call IDs, raw argument strings, intermediate assistant content, and some provider replay fields. Old sessions therefore cannot be assumed to reproduce a previously cached request exactly. Perform one explicit migration/reconstruction and start a new context generation; do not invent missing signed fields.

Normal operation appends events. Explicit user editing, clearing, and deletion remain authoritative: invalidate affected checkpoints/working views and remove associated artifacts according to the session lifecycle. "Complete history" does not mean retaining content after the user requests deletion.

Reading old evidence is an explicit retrieval operation that appends its result at the tail. Do not splice retrieved text into earlier messages. Source removal and TurnScope enforcement apply to both live document reads and stored result retrieval.

### 2. Automatically compact before another request needs space

Introduce a context manager invoked before every model request, including final-answer requests. It measures the full planned request, including tool schemas, message envelopes, provider replay fields, and image token estimates, with a reserve for output and summarization.

Use a known provider tokenizer/count endpoint where supported. Otherwise use a documented conservative estimate calibrated against returned usage. Provider-reported previous usage is historical measurement, not an exact count of the next request. Unknown compatible endpoints need an explicit model context configuration; do not infer capacity from a model name alone. Keep legacy character settings as a clearly labeled migration fallback, not a reading allowance.

Start with a tunable early trigger and a lower post-compaction target, for example 75% and 45% of usable input capacity. These are engineering starting points, not provider limits. Pending result size and output reserve take precedence over these ratios.

At a safe exchange boundary, summarize older material using a cache-compatible side request to the same configured model. Preserve the system prompt, ordered tool definitions, compatible thinking settings, and existing provider message prefix; append the compaction instructions at the end. Ask for a summary of the selected older event range while keeping a recent complete tail for the resumed context. Tool schemas remain present, but the summarization path never dispatches tools. Treat a tool-call response as an invalid checkpoint. Use `tool_choice: none` only if the endpoint supports it and its cache effect has been validated; do not assume changing that option is cache-neutral. Avoid switching output modes or replacing the system prompt just to get a summary.

Validate the checkpoint, then atomically swap the working view and continue. Keep the old view until successful validation. Do not expose a partial assistant tool-call group to the summarizer or main provider. When a batch would overflow, compact the completed prefix before appending that pending exchange. Reserve capacity for the side request's final instruction and summary output before the main context fills.

The summary request itself must fit. For large historical prefixes, summarize complete exchanges incrementally; never submit an already oversized transcript hoping summarization will repair it.

### 3. Preserve research state and evidence

The checkpoint should retain:

- The user's objective, constraints, requested deliverables, and unresolved questions.
- Source IDs and versions; exact read coverage by line/page/result offsets.
- Findings, assumptions, theorem conditions, notation, formula references, and citations needed for ongoing work.
- Completed actions and their outcomes, outstanding work, errors, and pending tool deliveries.
- Explicit distinctions between directly inspected evidence, derived summaries, and unread material.

Keep deterministic coverage and action receipts separately from generated prose. A summary must not invent coverage or silently drop pending work. Store document findings by source/section so repeated global compaction does not continually summarize the same summary. The model can retrieve original evidence to check exact formulas or quotations.

For this incident, finishing the first paper would produce reusable notes and exact source pointers. The harness could then reclaim its old raw text while continuing with the second and third papers in the same turn.

### 4. Handle a single result that cannot fit

First reclaim old context and retry delivery of the already executed result; do not rerun its tool. Deliver complete current results directly whenever the request fits. Remove the fixed per-result and per-batch character caps.

If one result or parallel batch still exceeds usable capacity, preserve it as a session-owned result artifact and return an explicit paged delivery envelope: stable result ID, total length, available ranges, delivered range, and continuation cursor. Provide a read-only `read_tool_result` tool for exact slices. Make paged delivery explicit in the tool contract, history, and UI; never mark it as complete or present a summary as the full result.

The same mechanism serves metadata, search results, and completed mutation receipts, not just documents. Keep a bounded control envelope available through context reservation and compaction. Queued delivery must make progress across compactions without an overall read quota. For tasks requiring full coverage, retain all pending ranges until read or explicitly abandoned by the agent with a stated reason.

Result handles must be scoped to session, owner, and current source authorization. They must not bypass TurnScope or revive removed sources. Prefer deterministic line/offset pagination independent of whether MinerU created page chunks. Explain actual tool errors directly; do not bury them behind generic size errors.

### 5. Keep recovery and safety in the harness

- Never re-execute mutating tools to recover from compaction, delivery failure, or a model context error. Persist completed outcomes before requesting a continuation.
- Preserve complete tool-call/result groups. Provider-specific thinking/signatures require explicit replay policies and compatibility tests; changing their prefix may invalidate them. Do not assume that retaining raw fields after a prefix rewrite is valid for every endpoint.
- Treat generated checkpoints and document text as untrusted derived data. They cannot overwrite system instructions, expand scope, enable web access, or authorize writes.
- Preserve existing SafeWebClient checks, file/path validation, atomic persistence, cancellation, and source-removal behavior.
- On a recognized provider context error, reclaim more space and retry only the model request with bounded retries. Do not classify authentication or network errors as context errors.
- On summarization failure, keep original history and pending results intact. Retry transient errors within a bound; if there is no safe progress, persist a resumable error/paused state rather than fabricate a completed answer.
- On cancellation or deletion, abort summarization and prevent late checkpoint writes from restoring removed data.
- Account for compaction requests in Turn and Session usage once, including partial/failing requests when usage is available. Show a brief automatic-compaction state in the UI.

### 6. Review the separate iteration stop

Current `agentMaxIterations` removes tools on the last iteration and forces an answer. It is a separate obstacle to long tasks, not the result-delivery failure established above.

Propose an automatic continuation mode with user cancellation, request timeouts, bounded failure retries, and a detector for repeated identical calls without new evidence or progress. A configurable explicit cost/time ceiling may pause with a resumable checkpoint, but should not silently convert unfinished work into a successful answer. Compaction housekeeping should not consume research iteration slots. Repeated calls are sometimes legitimate, so loop detection should try recovery before pausing.

### 7. Make cache reuse an invariant between compactions

The main unit of reuse is a provider-visible request prefix, not arbitrary repeated text. A passage reinserted after a changed checkpoint is not guaranteed to reuse its old KV cache. A local result-artifact hit avoids I/O or re-execution; it does not by itself create a provider prompt-cache hit.

Keep a context generation append-only until actual capacity pressure, a necessary compatibility/security change, or an explicit history edit requires a new generation:

```text
request 1: stable system/tools | checkpoint C1 | existing exchanges
request 2: stable system/tools | checkpoint C1 | existing exchanges | new exchange
request 3: stable system/tools | checkpoint C1 | existing exchanges | new exchange | next user turn
compact:   stable system/tools | checkpoint C1 | existing exchanges | ... | summary instruction
resume:    stable system/tools | checkpoint C2 | retained recent exchanges | new work
next:      stable system/tools | checkpoint C2 | retained recent exchanges | new work | more work
```

This diagram is a logical layout; each provider determines how system, tools, and message fields are serialized into tokens. The implementation must preserve the actual provider-compatible fields and message boundaries, not merely similar displayed text.

#### Stable prefix and append-only continuation

- Keep system text and tool schemas/order deterministic. Do not insert request IDs, timestamps, progress counters, token usage, remaining capacity, or a changing source list into the leading prompt. Telemetry stays out of model input unless the agent needs it to act.
- Keep checkpoints byte-stable within a context generation. Newly learned findings, corrected assumptions, and source/scope changes are appended as messages; do not regenerate an early summary on each step.
- Append the latest TurnScope with its user request. Existing scope snapshots remain historical; runtime authorization uses current session state. Security-driven invalidation takes priority over cache reuse.
- Preserve exact completed provider messages, including argument strings, IDs, whitespace, and endpoint-compatible replay fields. Do not reformat, re-sort, or regenerate old blocks from UI text.
- Extend the same working view when the user sends a follow-up. Replace the current unconditional `buildAgentMessages()` conversion of old tool bodies to provenance with checkpoint-aware continuation. A new user turn is not an automatic compaction boundary.
- Keep the selected model and compatible request settings stable during a generation. User-requested model/policy/tool changes take effect explicitly and may start a new generation; never preserve obsolete permissions for cache performance.
- Do not remove all tool definitions to force a final answer. Keep stable definitions where possible, with execution controlled by the harness. Provider-specific enforcement options must be tested for both correctness and cache behavior.

#### Compact infrequently and reclaim enough space

Use the early trigger and lower target as hysteresis: one compaction should leave room for meaningful subsequent work. Do not compact after every tool result, every paper, or every user turn. A completed paper is a good safe boundary only when compaction is otherwise needed. Trigger earlier if required by a large pending result or summary/output reserve.

Prefer a stable current generation over a sliding window that drops a few old messages on every request. Do not keep obsolete raw evidence indefinitely merely to inflate hit rate. Compact when safety/capacity requires it; for optional compaction, compare expected future cached-input cost with summary cost and the next generation's warm-up cost. Start with deterministic trigger rules and telemetry rather than a speculative optimizer.

The summary request should reuse the already established parent prefix. The first resumed main request necessarily changes that prefix at the replaced history/checkpoint. Its retained recent tail may need recomputation even if its text is unchanged. Later requests can reuse the new generation's prefix. Never promise uninterrupted cache hits through a history rewrite.

Summary results may be reused locally only for the same source event boundary, source versions, instruction version, and relevant model/protocol settings. Existing checkpoints remain fixed; do not pay to regenerate the same summary on session restore. Initially run compaction synchronously at a safe boundary to avoid background snapshot races.

#### Provider adapters and measurable acceptance

For DeepSeek, use the provider's automatic prefix caching and reported `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`; do not add another provider's cache-control fields. Its documented cache matching also depends on persisted prefix units, so byte-prefix equality is a necessary application-side condition, not a guarantee of immediate server reuse. Other endpoints require their own capability and cache rules.

Record per-request kind (`agent` / `compact`), context generation, prefix-change reason, estimated request size, provider-reported input/cache tokens, output tokens, and latency. Keep raw document text out of metadata logs. Record local prefix fingerprints for diagnosing unexpected rebuilds, without presenting them as measured cached-token counts. Missing usage fields remain unknown.

Report weighted hit rate as total hit tokens divided by total hit-plus-miss tokens, rather than averaging request percentages. Also report absolute miss tokens, total input/output, compaction overhead, time to first token, and completed task coverage. Include the full warm-up and compaction cycle. The incident already had approximately 94.5% input cache hits while failing its task; hit percentage alone is not acceptance.

Estimate monetary cost only with verified provider pricing/configuration; distinguish billed estimates from token measurements. A smaller useful context with fewer total misses may be better than a large high-hit context. Do not add paid warm-up calls or artificial padding merely to improve the ratio.

## Implementation sequence

1. Add exact provider-exchange persistence/replay and immutable result references, with backward-compatible session migration; add typed provider context errors and model-capacity configuration. Define context generations and a pure planner with complete-exchange boundaries and pending-delivery state.
2. Add validated semantic checkpoints and cache-compatible same-turn compaction; integrate before all model requests and into session restore. Replace new-turn history dropping with append-only checkpoint-aware continuation.
3. Add scoped result storage/retrieval and explicit paged delivery for oversize results. Remove the old omission gate only when both compaction and oversize delivery are wired in.
4. Update prompts, UI, usage accounting, and all four preference surfaces together. Review iteration control as a separate change within the same architecture.
5. Run the regressions below, `npm run verify`, and an isolated Zotero panel smoke test using a mock provider without copying credentials. A real-provider quality evaluation is separate from deterministic correctness tests.

## Acceptance criteria

- Replay the incident's result sizes with a deterministic provider: the next small read succeeds after compaction, all three sources remain accessible, and no user continuation message is required by the harness.
- Exceed the old cumulative allowance repeatedly in one task and verify continued delivery with a bounded working request size.
- An 80,472-character result is delivered whole when capacity permits; oversized single results and parallel batches are fully retrievable through explicit pages.
- Checkpoint coverage includes only delivered content; every preserved citation resolves to the original evidence. No pending result disappears during compaction.
- Tool-call IDs remain correctly paired. Mutation side effects occur exactly once, including during provider retries and resume.
- Test compact failure, malformed/no-progress summaries, context errors, cancellation, source removal, session clearing/deletion, and restart recovery.
- Test tokenizer fallback, large current user messages, schemas, reasoning replay, image accounting, and DeepSeek/Gemini compatibility independently.
- Verify total usage includes compaction exactly once and that the UI distinguishes completion from a recoverable interruption.
- Evaluate summary fidelity on mathematical papers: preserve hypotheses and formula references, and retrieve source text when exact expressions are required. Passing a size regression alone does not establish scientific fidelity.
- Assert exact existing-message prefix preservation for ordinary iterations and follow-up user turns, including save/reload where supported. Test intermediate assistant content, tool-call IDs, raw arguments, and provider replay fields. Legacy session migration is an explicit new generation.
- Assert the compaction side request preserves system/tools/settings and the selected complete parent prefix, appending instructions without dispatching tools. Assert checkpoint bytes remain unchanged until an explicit generation boundary.
- Verify compact/restart can only lose reuse at expected documented boundaries; test model/tool/policy changes and user edits as intentional invalidations. Never weaken permissions to keep a prefix stable.
- Compare real-provider cache reports for ordinary iterations, summarization, first post-compaction request, and later requests separately. Deterministic mock tests verify serialization, not actual provider cache hits. Use the same task/model/settings and comparable cache-warmth conditions for performance evaluation, and report absolute misses and completion alongside hit rate.

## External design reference

[Anthropic's compaction overview](https://platform.claude.com/docs/en/build-with-claude/compaction) distinguishes provider-managed compaction from an application-owned summarizer, including recent-turn retention and provider-specific thinking constraints. The proposed initial implementation is application-owned because ChatPDF uses configurable OpenAI-compatible Chat Completions endpoints. Native compaction can be an optional capability adapter later; it is not assumed available on the current endpoint.

[DeepSeek's context caching documentation](https://api-docs.deepseek.com/guides/kv_cache/) describes automatic caching, persisted prefix units, reported hit/miss usage, and best-effort cache retention. Application-side prefix preservation cannot guarantee cache availability on the server.

[Anthropic's prompt-caching engineering article](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything) describes stable prompt/tool prefixes and summarization requests that reuse their parent's prefix. This informs the proposed compaction side request; it is not proof that an arbitrary compatible endpoint has identical cache semantics.
