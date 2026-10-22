> Historical record. The legacy whole-document conversion pipeline has been retired. The current implementation uses [on-demand page Markdown](pdf-markdown-reading.md) and [original-page inspection](direct-pdf-reading.md). Legacy conversion instructions below no longer apply.

# FEEC paper conversion failures and retry recovery

Diagnosed on 2026-10-05 using the daily conversion journal, saved PDF.js page text and cached page images. Paper: *Finite element exterior calculus for spectra and pseudospectra of advection-diffusion of differential forms*, attachment `1:ERRRX979`, 38 pages. Job `d050c745-fbf3-46d9-8ce9-392eb3afdccc` used `deepseek-v4.1-flash`, four pages per chunk, two workers, 150 DPI, streaming and same-response self-check.

## Evidence

Four runs between 09:41 and 10:06 China time recorded 40 model requests: 18 accepted, 20 rejected and two cancelled after a sibling worker failed. The 20 rejections consist of 16 failures reporting missing hats on page 4 and four missing/duplicate self-check footers. Recorded usage totals 104,153 input and 78,617 output tokens. No HTTP rate-limit, authentication, truncation or timeout error was recorded in these requests.

Page 4 contains two printed integrals. Both PDF.js and an independent text extractor map their glyphs to standalone U+02C6 (`ˆ`). The previous symbol gate counted those as two hat accents and rejected a transcription without `\hat` or `\widehat`. Visual inspection confirms that these locations are integrals. The boundary-condition spaces elsewhere on the page carry circles, which are separate glyphs. This is a false positive in the text-layer baseline, not evidence that a model omitted hats.

Chunks covering pages 5-38 were saved and reused. Accepted subrequests for pages 1-2 and page 3 were discarded when page 4 failed, because persistence occurred only after a complete four-page chunk succeeded. Each retry consequently resubmitted already accepted content in that chunk. Missing self-check footers also caused binary splitting, although that failure concerns the response contract rather than page coverage.

## Repair

- Treat standalone U+02C6 as an ambiguous font mapping, not a mandatory hat baseline. Attached modifier accents and combining accents remain checked; Greek-symbol, page-coverage and KaTeX gates remain active. Do not rewrite PDF text or insert invented hats into model output.
- Retry self-check response-contract failures once on the same page batch with explicit feedback. A second such failure stops the batch. Coverage failures and reported unreadable pages retain splitting; permanent HTTP errors retain their existing behavior.
- Atomically checkpoint every accepted page before advancing to another subrequest. Journal its Markdown digest and per-page self-check metadata. Retry revalidates saved pages against freshly rendered text, digest and self-check records, then requests only contiguous missing pages. Existing completed chunks remain reusable. Changed PDF bytes or conversion settings continue to prevent incompatible reuse.
- Include checkpointed pages in progress without double counting completed chunks. The conversion inspector can display a digest-validated saved page even when another page in its chunk failed. Partial checkpoints do not make the complete document Ready; the existing complete-cache commit contract still applies.

Standalone text-layer symbols can be ambiguous. This repair reduces false rejections; it does not certify equation placement, mathematical equivalence or a model's self-check. An accepted conversion remains subject to scientific review against the original PDF.

## Validation

Regression tests reproduce the two integral mappings, retain rejection of attached/combining lost hats, bound missing-footer retries to two identical page batches, preserve accepted split pages through a sibling failure, request only the remaining page on retry, reject changed checkpoint bodies without network access, verify atomic page writes and journal propagation, and count partial saved pages without duplication. `npm run verify` passed: TypeScript, ESLint, 53 test files / 363 tests, and the production XPI build. Build-tool caches were redirected into the ignored workspace scaffold directory to comply with the filesystem sandbox.

An isolated native Zotero test used a PDF copied from the paper's first four pages, a separate profile/data/cache and dummy credentials. Responses came from a localhost fixture: original extracted text for pages 1-3 and a manually supplied page-4 response containing the actual integrals. The fixture deliberately inserted invalid LaTeX on page 4 until the first run failed, then omitted its self-check footer once during retry. It verified three journaled page checkpoints before chunk completion, a visible validated page in the inspector, recovery requesting only page 4, a complete merged self-check, four cached page images and zero remaining PDF renderer browsers. Request pages were `[1,2,3,4]`, `[1,2]`, `[3,4]`, `[3]`, `[4]`, `[4]`, followed by `[4]`, `[4]` on retry. Evidence is ignored `.scaffold/feec-retry-native/result.json`.

The native test validates Zotero execution, actual PDF.js font mapping, persistence, inspector display and retry scheduling. Its synthetic responses do not establish real-provider recognition or correctness of the complete paper. Read-only checks confirmed that the daily paper's journal remained at 40 requests and 34 completed pages throughout testing. The original completed chunks were not changed.
