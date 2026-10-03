# PDF vision conversion validation

Validation date: 2026-10-03. The production package is `.scaffold/build/chat-pdf.xpi`. The pipeline validation used isolated profiles; the subsequent user-authorized daily-profile installation is recorded below. No release was published.

## Automated checks

The full `npm run verify` gate covers TypeScript, ESLint, Vitest and the production build. Conversion-specific tests cover page omission/reordering, Chinese and English text coverage, Greek-symbol substitutions, lost math accents, validation feedback on retries, invalid math, truncation, provider-specific request fields, HTTP retry/authentication behavior, cancellation, safe settings snapshots, renderer load/timeout cleanup, compatible chunk reuse, changed source bytes, cache hits and protection of an older ready cache. Existing MinerU recovery tests continue to run.

The v2 full gate passed: 34 test files and 244 tests, followed by a successful production XPI build. The subsequent same-response self-check build passed 35 test files and 254 tests, TypeScript, ESLint and the production build. The cache-error diagnostics update subsequently passed 35 files and 255 tests plus the same checks and build. `npm audit --audit-level=low` reported zero vulnerabilities after updating only development transitive dependencies `brace-expansion` to 5.0.12 and `undici` to 7.30.0. A locked reinstall confirmed the actual installed versions; the existing direct dependency configuration was preserved.

## Native Zotero smoke tests

The native tests ran Zotero 9.0.6 on Windows with separate profile, data and cache directories. They installed the built XPI temporarily and drove the real panel through Zotero's local debugger. Office integration installation was disabled in the isolated profiles to prevent a first-run installer dialog from blocking background rendering. The user's running Zotero instance was not the test target. Zotero 7, 8 and 10 were not executed in this test run.

| Test | Endpoint | Evidence | Result |
| --- | --- | --- | --- |
| Three-page synthetic PDF, including a scanned text page | Configured OpenCode Go `deepseek-v4.1-flash` API | Native PDF.js JPEGs, real model Markdown, three page markers, two cache chunks, three images, zero renderer browsers after cleanup | Passed |
| 128-page generated PDF | Local mock | 32 four-page chunks, 128 JPEGs, 34 requests including forced omission/split recovery, contiguous merged line ranges, final pages 125–128, zero renderer browsers after cleanup | Passed |

The real API returned the scanned text `Synthetic scanned page: energy E = mc^2`. The accepted three-page run reported 3,449 input tokens, 105 output tokens and 3,554 total tokens. The live harness held the existing API key only in the external test process; the isolated Zotero profile contained a dummy key. Credential values were not saved in test results.

The mock deliberately omitted the first page of a batch. The plugin rejected it and completed smaller requests before committing. This validates transport, scheduling, validation, ordering, assets and persistence, but does not measure the mock's OCR or scientific accuracy.

Local diagnostics are under ignored `.scaffold/vision-live/result.json` and `.scaffold/vision-long-clean/result.json`. Failed early diagnostic runs are retained separately and are not counted as passed conversions.

The package was also retested in a fresh isolated profile after the locked dependency reinstall and source-byte snapshot change: three pages, two chunks, three JPEGs, four mock requests including split recovery, and no remaining renderer browser. Evidence: `.scaffold/vision-final-smoke/result.json`. This earlier smoke test preceded the v2 symbol gate.

The final v2 package passed the same native three-page smoke test in a fresh profile: two chunks, three JPEGs, four mock requests including omission/split recovery, and zero remaining renderer browsers. Evidence: `.scaffold/vision-v2-final-smoke/result.json`. Final XPI SHA-256: `891190b056106b656fb815fdc201d3bcfcdb5e13229f293770bd6dc8210db63d`.

## Approved 35-page research-paper benchmark

After the user authorized sending this specific private PDF to OpenCode Go, the real native pipeline converted the English mathematical proof using `deepseek-v4.1-flash`. The initial v1 gate accepted all 35 pages in nine chunks, with 35 page images and 14 API requests in approximately 245 seconds. SHA-256, ordered page markers, chunk bodies, character counts and contiguous line ranges agreed. Independent review found all 65 numbered equations represented on their source pages and 416 renderable math spans. Evidence is retained locally under ignored `.scaffold/vision-live-english/`.

This was a structural pass, **not a mathematical-fidelity pass**. Visual comparison found Greek nu changed to Latin v, mu changed to kappa, and hat/tilde/bar decorations changed or placed on the wrong symbols. Legal LaTeX and preserved equation numbers did not catch those errors.

The implementation was strengthened with prompt version `page-transcription-v2`, quality gate `page-markers-text-symbols-katex-v2`, and validation feedback during split/single-page retries. The same full-paper run then stopped on page 15 when all tilde decorations disappeared. Three validated chunks (pages 1–12) remained in staging, no canonical Markdown cache was committed, and the renderer was cleaned up. Evidence: `.scaffold/vision-live-english-v2/result.json` and its conversion registry.

A one-page comparison used only page 15 from the same authorized document:

| Model / settings | Observed result |
| --- | --- |
| `deepseek-v4.1-flash`, 300 DPI | Both attempts lost all tildes; rejected, no committed cache |
| `deepseek-v4-flash-vision-exp`, 150 DPI | Both attempts failed the accent gate; rejected, no committed cache |
| `gpt-6-luna`, 150 DPI | HTTP 400 `ModelProtocolUnsupported`; this model did not accept Chat Completions on the tested endpoint |
| `mimo-v2.5`, 150 DPI | First response lost tildes; the feedback retry exhausted its 8,000-token generation limit in reasoning and returned `finish_reason: length`; rejected, no committed cache |

The source image at 300 DPI visibly contained the missing decorations. Higher render resolution alone did not correct this failure. Test profiles held dummy keys; the external proxy held the existing key in memory and forwarded only to the approved service. The normal Zotero model/profile settings were not changed.

All isolated Zotero test processes closed. The original Zotero process and its existing child processes remained running. The Git index was empty; no files were staged, committed or released.

## User-authorized daily-profile installation

At 15:02 local time (Asia/Shanghai), after the user explicitly requested installation, the previous XPI was backed up to ignored `.scaffold/install-backups/chatpdf-before-vision-20261003-150213.xpi` and its SHA-256 verified against the installed file (`78d7f727d7600c5bfef00f2f0873d6eaf38eb8a9e0fef4291277919b0b80d861`). No conversion jobs were active. Zotero closed normally, the final XPI replaced the old one, and Zotero restarted using the existing `ej0u85cg.default` profile.

The installed SHA-256 matches the final build recorded above. The running bridge reported version 0.9.5 and the unchanged cache directory. Since the previous build also used 0.9.5, runtime feature loading was separately confirmed: a deliberately invalid conversion-engine request returned the new `options.engine must be vision or mineru` validation message before resolving any document. This did not create a conversion or upload a PDF. Existing model settings, credentials, library data and caches were not rewritten by the installer. Installation diagnostics are under ignored `.scaffold/install-vision/`.

## Same-response structured self-check

Prompt version `page-transcription-v3` asks the original model to continue its Markdown response with a short JSON footer containing exact page-local edits, or an empty edit list. It does not start a second review request or replay the completed Markdown and page images. The client validates unique anchors, page boundaries, nonoverlapping edits and the response schema, applies edits locally, removes the footer and reruns the existing quality gates. Uncertainty or an invalid footer rejects the chunk. Validated records include the final Markdown digest; retry reuse requires matching content and page coverage. A complete self-check record is required before committing a self-checked cache.

Unit coverage includes exact corrections, header deletion, invalid or ambiguous edits, injected page markers, missing footers, invalid corrected math, digest-bound recovery, commit protection and the source-chip summary. Old caches display `Not self-checked`; newly accepted conversions display `Self-check X/Y`. This is the original model's self-check, not independent mathematical verification.

The native mock test applied one correction from `E = mc^3` to `E = mc^2`, committed all three pages in two chunks, displayed `Self-check 3/3`, excluded the JSON footer from Markdown and left zero renderer browsers. Its four requests included deliberately forced omission/split recovery. The final production package passed this test again. Evidence: ignored `.scaffold/vision-selfcheck-mock/result.json` and `.scaffold/vision-selfcheck-final-mock/result.json`.

The real API test used only the generated three-page synthetic PDF. It completed three pages in two requests, displayed `Self-check 3/3` and left zero renderer browsers. The model returned no edits. Usage was 4,067 input tokens and 135 output tokens (4,202 total), compared with the earlier synthetic baseline of 3,449 input and 105 output tokens. The added instructions and short footer therefore added 618 input and 30 output tokens in this particular run, with no additional review call. These figures are not a general cost estimate. Both responses ended normally with thinking disabled. Evidence: ignored `.scaffold/vision-selfcheck-live/result.json`. This test verifies the real response contract and pipeline, not full-paper scientific accuracy.

At 16:01 local time, the verified self-check package replaced the installed v2 package after a normal Zotero shutdown. No conversions were active. The previous XPI was saved to ignored `.scaffold/install-backups/chatpdf-before-self-check-20261003-160144.xpi`. Installed and built SHA-256 values match: `97fc4152478050317907b4f4c0a58aec7c422df954bd36870027988c9e9f0cf7`. The running bridge explicitly reported `pdf_self_check: same-response`. The existing 19-page paper cache was checked and remained unchanged; it has not been reconverted with this mechanism. Installation evidence is under ignored `.scaffold/install-vision/self-check-installation.json` and `.scaffold/install-vision/self-check-runtime-status.json`.

## Daily-profile cache-commit failure and recovery

The user's 19-page reconversion completed all five chunks and their self-check records, then failed while swapping the finished staging directory into the existing cache. The previous ready cache and all validated new chunks remained intact. A cached retry before restarting Zotero also failed at commit. The stored error had been fully redacted because the native error contained a local path, so its original operating-system code was unavailable.

Read-only sharing and permissions checks did not identify a current lock or access restriction. Windows and isolated native Zotero rename probes succeeded and restored the original cache with byte/checksum verification. Initial conversion followed by Reconvert also passed with mock responses in an isolated profile. These observations do not establish the original failure's precise cause.

Cache-commit failures now retain the failed operation and a whitelisted error name or `NS_ERROR_*` code in a path-free message, while retaining converted pages and the existing rollback/retry behavior. A regression test covers a persistent move failure, preservation of both caches and the sanitized diagnostic. The verified update was installed after a normal daily-profile restart, with the prior XPI backed up to ignored `.scaffold/install-backups/chatpdf-before-cache-diagnostics-20261003-163917.xpi`. Installed SHA-256: `ab71d679c1f474733e4aa8ba3e6e1fecadcefcdaec15fd6c93161be5225b4411`. Its isolated native smoke test covered both initial conversion and replacement: three pages, two chunks, six mock requests including forced initial split recovery, `Self-check 3/3`, and zero remaining renderers. Evidence: ignored `.scaffold/vision-cache-diagnostics-smoke/result.json`.

At 16:42 local time, the saved daily-profile job reached `Ready` with all five chunks committed and self-check coverage of 19/19 pages. All five chunk digests matched the saved pre-recovery self-check records; no retranscription was needed. The temporary staging and swap backup were absent after success. Final Markdown SHA-256: `4d248ba5f836e0333c04f68571e82e35649475df7ef2dfe680e26d2c98a196cc`. Evidence: ignored `.scaffold/install-vision/cache-commit-error/recovery-result.json`. The model had reported zero edits; this recovery verifies persistence and record coverage, not the paper's mathematical fidelity.

## Conversion inspector and streaming validation

The final inspector build passed `npm run verify`: 39 test files, 276 tests, TypeScript, ESLint and the production build. New coverage includes split UTF-8/SSE frames, reasoning-field exclusion, final usage-only frames, same-response JSON compatibility, malformed/truncated/oversized output, blocked-reader cancellation, separate validated-page counts, request history across recovery, safe draft rendering, exact edit display, page navigation and disposal during pending reads. Commit-stage tests prove that a trusted finalized checkpoint retries without rendering or model calls and that changed checkpoint Markdown cannot be committed. Legacy cache and registry tests preserve page navigation and recorded request metadata without generating model requests.

An isolated native Zotero 9.0.6 test used a synthetic three-page PDF and local SSE mock. The real panel showed an unvalidated draft, cached images actually sent to the endpoint, rendered Markdown/source switching, exact `E = mc^3` to `E = mc^2` correction, page-two navigation, separate request rows and a clean close. It observed no audit-footer leakage or 100% progress before the manager's committed Ready state. Four requests included a deliberately rejected multi-page response and its split recovery; both manifest and persisted registry contained four request records and cumulative provider-reported usage of 400 input / 320 output tokens. No renderers remained. Evidence: ignored `.scaffold/vision-transparent-compatible-smoke/result.json` and its cache registry. These mocks validate process visibility and transport, not a provider's document recognition.

Installed final XPI SHA-256: `2134b1e84e1a5536e237619e44b321b28bdde44afece6197d41d917c5d8d0d48`. Installation verified no active conversions, backed up the previous build to ignored `.scaffold/install-backups/chatpdf-before-transparent-20261003-175318.xpi`, and normally restarted the daily profile. The earlier pre-inspector backup remains at `.scaffold/install-backups/chatpdf-before-transparent-20261003-174501.xpi`. Read-only post-installation bridge checks confirmed both new capabilities and the existing Hamiltonian paper at Ready, 19/19 pages, with no new conversion request. Old request history was unavailable and is not reconstructed. Evidence: ignored `.scaffold/install-vision/transparent-installation.json` and `.scaffold/install-vision/transparent-post-installation-check.json`. No credentials were copied into the mock profile, and no document was sent to an external model during this inspector validation.

## Stable conversion controls

The source list previously rebuilt controls during progress refreshes, allowing a refresh between mouse press and release to discard a click. Source rows and their conversion-view buttons now stay attached while progress text changes. Chunk-navigation buttons in the inspector also retain their identity. The toolbar no longer contains Clear chat or Convert all; New Chat, History, individual source actions and Ctrl+Enter remain available.

The full gate passed 40 files and 279 tests, including button identity, focus, repeated updates, navigation, and removal/replacement of a source with the same identity. A native Zotero 9.0.6 test held a trusted mouse press on View conversion process for 1.8 seconds across active conversion updates. The button remained attached, release delivered exactly one click, and the inspector opened. The synthetic three-page SSE conversion still completed with the existing split-recovery, self-check and preview assertions. Evidence: ignored `.scaffold/vision-stability-smoke/result.json`. All endpoint traffic stayed on the local mock; no paid model request was made.

At 18:40 local time, the verified package was installed into the daily profile after checking for active conversions and closing Zotero normally. The previous package was backed up to ignored `.scaffold/install-backups/chatpdf-before-stable-controls-20261003-184043.xpi`. Installed XPI SHA-256: `a8cd1bf4447d63ea90ce1af5b1532c83911bcd617a71970896e10ea0bc4460e0`. The restarted bridge retained the existing cache directory and conversion records. Installation evidence: ignored `.scaffold/install-vision/stable-controls-installation.json`.

## Remaining limits

The current DeepSeek conversion model did not pass this paper's mathematical-fidelity review. The new gate catches substantial loss of repeated symbols and complete loss of an accent, but it cannot prove symbol placement, individual coefficients or equation equivalence. Even a v2 accepted chunk can contain a misplaced decoration. Do not describe a successful conversion status as verified scientific correctness.

The v3 self-check has not been validated against the complete mathematical-paper benchmarks. The original model can repeat or overlook its own transcription error, including a sharp/flat substitution. Self-check status and an empty edit list do not certify correctness.

Complex equations, Chinese scans, two-column layouts and detailed tables require representative real-document review. Earlier offline prototype results are not evidence for this native pipeline. The Zotero 7 classic PDF.js fallback is implemented, but its native runtime remains untested here; native tests covered Zotero 9.0.6 only.
