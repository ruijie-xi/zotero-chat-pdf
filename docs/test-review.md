# Test relevance and value review

Reviewed against the 0.10.1 working tree on 2026-10-23, after commit `8f95e1d`.

## Scope and result

The starting suite contained 58 files and 510 executed cases. The first pass removed eight obsolete or duplicate cases, leaving 57 files and 502 cases. Checking that a test imports current code was insufficient: it did not establish that the test detected a distinct failure.

The second pass compared assertions, mock behavior and production branches across suites. It removes another 40 cases, leaving 57 files and 462 cases. No cases were skipped, hidden from discovery, or packed into loops solely to reduce the displayed count. Production code is unchanged.

## Second-pass decisions

| Area | Removed cases | Reason and remaining owner |
| --- | ---: | --- |
| Tokenizer fixtures | 12 | Reduce direct third-party encoder checks from 16 strings to four bundled-vocabulary compatibility samples: Chinese, mathematical text, compound Unicode and special tokens. Keep all project token accounting, cache invalidation, calibration, image reservation and exact paging tests. |
| Generation policy | 7 | Thinking/provider permutations repeat the same provider-independent maximum calculation. `generation-integration` covers changing thinking settings and manual limits; `model-capabilities` covers custom/Go metadata and overrides. Keep invalid-limit rejection in `generation-policy`. Disabled-thinking request fields remain covered by `pdf-transcription`. |
| Generation integration | 2 | Two token-usage numbers drove the same simulated answer; retain one honestly named request-body propagation test. Remove the duplicate short-checkpoint allowance test, owned by `agent-compaction`. |
| Agent compaction | 2 | Remove duplicate reasoning-only exhaustion and duplicate cancellation at the same post-response abort guard. Retain the richer exhaustion test and strengthen the surviving cancellation test to check unchanged events, active context and one request. |
| Prompt wording | 2 | Delete tests that equated literal prompt sentences with PDF reading or safe summarization behavior. Actual Markdown/image delivery, rendering resolution, source revocation, stored evidence and refusal to execute summarizer tools remain tested. Remove equivalent prose assertions from mixed tests too. |
| Model-profile storage | 1 | The assertion only restated `JSON.stringify` plus a preference write. Actual profile save/load and replacement-key persistence remain tested through the preferences pane, with account isolation checked separately. |
| Source identity | 3 | Qualified-ID construction/parsing and bare-key construction already execute through session and tool tests. Keep the otherwise uncovered empty-key rejection, fallback library and Windows-safe cache-name cases. |
| Markdown rendering | 3 | The existing DOM rendering test already exercises script removal, unsafe links and KaTeX through the sanitizer. Add the missing script-text removal assertion there. Keep distinct encoded-link, style, SVG/iframe, safe-image and XHTML cases. |
| Image fallback | 4 | Remove the redundant missing-metadata text case; the image request test already starts with a successful text-only request without metadata. Remove repeated 401/429/503 transport classification from the agent-level matrix; `vision-support` owns rejection classification and `llm-transport` owns HTTP retries. Retain a non-modality image-format failure through the full loop, plus successful fallback, session isolation and cancellation. |
| Vision rejection | 2 | Remove 403 and 503 copies of the non-eligible-status guard. Keep authentication, throttling, server, size and malformed-image categories, explicit rejection patterns and echoed-request exclusion. |
| Request-size recovery | 1 | Keep the 401 integration case proving that an unrelated error is propagated without splitting or changing context. The additional 422 case enters the identical catch path; its status handling remains in `llm-transport`. |
| Connection recovery | 1 | Streaming and non-streaming connections enter the same transport retry loop before response parsing. Keep the richer connection-retry test and the separate non-streaming provider request tests. |

## Assertions improved without count reductions

- Replace fixed totals such as 25 tools or 23 tools with exact registry/schema comparisons and the expected exclusion of `inspect_pdf_page` and `read_image`. This detects missing or incorrectly filtered tools without freezing the registry size.
- Remove fixed counts of dropdowns and suggested models. Keep native XUL markup and actual provider/model selection behavior.
- Remove preference assertions that only exercised the test harness's simulated binding listener. Provider switching, model suggestions, profile save/load and credential replacement still exercise production handlers.
- Remove tooltip/prose fragments unrelated to the behavior under test. Preserve source-menu identity, focus, removal, persistence and keyboard dismissal.

## First-pass cleanup

| Change | Reason | Current coverage retained |
| --- | --- | --- |
| Remove the retired vision-gate/MinerU preferences test | Those controls and preference readers no longer exist. The remaining save/load assertions were already covered. | Current provider selection, profile saving, credential replacement and transcription profile selection. |
| Replace five retired bridge-operation names with one unknown operation | All five names exercise the same current `default` rejection; there are no separate conversion handlers. | Unsupported-operation rejection, protocol validation, browser-origin rejection and the shared executor. |
| Remove the duplicate Go conversation-ID case from `generation-integration.test.ts` | The same case remains in `provider-session.test.ts`. | Conversation identity across compaction and follow-up turns, plus captured answer/title routing. |
| Remove `tool-search.test.ts` and consolidate its checks into `pdf-text.test.ts` | Overlapping-window merging was tested twice. | Full merged snippet text without duplicate context, distant matches, case-insensitive matching and exact snippet offsets. |
| Remove retired tool names, conversion controls and the old workflow phrase from mixed tests | These assertions only memorialized completed feature removals. | Page-reading behavior, source-menu stability and keyboard dismissal. |
| Remove the unused `visionSupport` preference fixture and retired PDF-asset cache fixture | Current code does not read that preference or those extracted-figure files. | Advisory vision metadata, explicit image-rejection recovery, and rejecting a PDF passed to a standalone-image reader before filesystem access. |

## Retained boundaries

- Saved-session migrations, legacy custom model profiles and unqualified source IDs remain supported by current code. Their tests protect existing user data and are not obsolete because their fixtures are old.
- On-demand Markdown transcription, independent visual profiles, local PDF text/geometry and original page images are current features. Names containing “conversion” do not by themselves indicate retired external OCR behavior.
- Native/MCP schema parity, TurnScope, library authorization, cancellation, atomic persistence, transport recovery and secret exclusion remain current contracts.
- Keep all eight arrow-key combinations: production registers eight separate bindings, so this is not a redundant cross product. Likewise, the retryable HTTP status allowlist, filesystem traversal forms, DNS/IP boundaries and PDF rotation transforms have independent failure modes.
- Keep model-selection, captured answer/title routing and replacement-key persistence regressions from the preceding fix. Tests protecting active credentials and account isolation are still current.
- No application code, dependencies, test discovery rules or production settings were changed by this cleanup.

## Verification

`npm run verify` passed type checking, ESLint, **57 files / 462 cases**, and production packaging on 2026-10-23. Output is kept under `.scaffold/test-review/deep-verify.log` and is not committed. The earlier inventory records import relevance only; it is not evidence that each case is necessary. This review does not establish exhaustive branch or mutation coverage, nor does passing mocked provider tests establish live service acceptance. Production code was unchanged, so native acceptance checks from the preceding feature/fix commit were not repeated for this test-only cleanup.
