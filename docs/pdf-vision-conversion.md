# PDF conversion with a vision model

Vision is the default PDF conversion engine. It renders the PDF locally using Zotero's bundled PDF.js, sends page images to an OpenAI-compatible vision model, and installs validated Markdown in the existing document cache. MinerU remains an optional engine, and existing MinerU or offline vision caches remain readable.

## Configuration

Select **Vision model** under **PDF conversion engine** in ChatPDF preferences. **Conversion model profile** may select a saved model profile independently of the chat model; an empty value uses the active chat profile. The endpoint must accept OpenAI-compatible `image_url` messages and non-streaming chat completions. A text-only model cannot perform this conversion.

An endpoint's model list alone does not establish image or protocol support. For example, the tested OpenCode Go `gpt-6-luna` route rejected Chat Completions with `ModelProtocolUnsupported`. Responses-only model routes are outside this pipeline's current protocol support.

| Preference | Default | Allowed values |
| --- | --- | --- |
| Conversion model profile | Active chat profile | Empty or an existing saved profile name |
| Pages per request | 4 | 1–10 |
| Concurrent requests | 2 | 1–4 |
| Render DPI | 150 | 72–300 |
| Cache rendered page images | Enabled | Boolean |
| API request timeout | 180 seconds | 30–1,800 seconds per attempt |
| Model self-check | Enabled | Boolean; structured local edits in the same response |

The conversion profile supplies its API key and token budgets. For providers with no known capacity metadata, configure explicit context/input and output limits. Conversion estimates text locally using the bundled tokenizer and reserves tokens per image; official DeepSeek and known Go DeepSeek models have an automatic image estimate, while other endpoints require an explicit per-image reserve. These are budget estimates, not provider guarantees. Thinking is disabled where the endpoint supports that control.

Changing the conversion profile does not replace a ready cache. Use **Reconvert** to apply the selected engine and settings. **Retry** continues compatible saved work after failure. If the PDF bytes, pinned profile/model/endpoint, rendering settings or prompt version change, start a fresh conversion rather than mixing outputs.

## Rendering and requests

A disposable, hidden browser hosts local PDF.js assets. Rendering does not open a reader tab or require an external PDF renderer. Pages become white-background JPEG images at quality 85. Oversized pages are scaled down to at most 16 megapixels and 8,192 pixels on either side, so the effective DPI may be lower than requested. Password-protected PDFs must be unlocked first.

Rendering runs serially; up to the configured number of workers send requests concurrently. Each request includes the page numbers and their images. The prompt asks for the original language, text, metadata, equations, tables and verbatim figure captions, with an explicit marker before every page. It does not ask for summaries or invented figure descriptions. Model-supplied image links are reduced to captions; the cached images are the original rendered pages.

Explicit safety limits are 10 MiB per JPEG, 20 MiB of JPEG bytes per request and 8 MiB per API response. Request batches that exceed the image or input-token budget are split. An individually oversized image fails with an instruction to lower DPI. No silently truncated output is committed.

## Validation and recovery

Before saving a chunk, the pipeline requires:

1. Exactly one ordered `<!-- chatpdf-page:N -->` marker for every supplied page, with nonempty content or an explicit `[blank page]`.
2. At least 35% coverage of a sufficient PDF text-layer baseline. This deliberately tolerant omission guard uses distinct English words or Chinese characters; it does not use extracted text as the transcription input. Sparse, scanned and formula-only pages may have no usable baseline.
3. Repeated Greek symbols retained against the text layer: when a symbol occurs at least three times, at least 70% of those occurrences must remain. Unicode mathematical alphabets and common LaTeX variants are normalized. If at least two hat, tilde or bar accents occur in the source, that accent must not disappear entirely.
4. Renderable KaTeX syntax for recognized math and closed math delimiters.
5. A complete provider response with `finish_reason: stop`.

### Same-response self-check and token overhead

With **Model self-check in the same response** enabled, prompt v3 asks the original conversion model to continue after its transcription with `<!-- chatpdf-self-check:v1 -->` and one short JSON result. A clean response ends with `{"edits":[]}`. Corrections use only `{"page":N,"old":"exact original fragment","new":"corrected fragment"}` entries; the model does not generate a second full transcription or explanations. This uses the original page images and generation context in the same API response, so it adds only the self-check instruction and result tokens. It creates no separate review API call and does not replay the images or transcript as additional input.

The plugin requires exact, page-local, unique and nonoverlapping edit anchors. It rejects unknown pages, edits to page markers, malformed JSON and pages the model marks uncertain. It applies edits locally, removes the JSON footer from the document, then reruns page/text/symbol and KaTeX checks. Invalid results use the existing split/single-page retry policy, which can still incur additional calls. The entire response shares the conversion profile's explicit generation limit; a truncated footer is not accepted.

Each chunk records the check method/version, checked page numbers, exact applied edits and SHA-256 of the final chunk Markdown. Matching checkpoints skip model calls; modified Markdown, changed self-check settings or missing records cannot reuse a previous check. Opening an existing cache does not trigger self-checking or upload its pages; use **Reconvert** to apply v3. Existing v2 checkpoint jobs retain their original settings and do not silently acquire the new self-check behavior.

The source badge reports `Self-check X/Y` pages and its tooltip gives the edit count. **Self-check is the original model's own assertion, not independent verification**. The same model can repeat a misreading, and a zero-edit result does not establish mathematical equivalence. This mode reduces review overhead; independent visual review remains a separate potential improvement.

Invalid, empty, truncated or timed-out batches are split recursively. Validation feedback tells the next attempt which page/symbol/decoration failed. A failing single page gets one further attempt, then fails visibly. HTTP 429 and 500/502/503/504 use bounded exponential backoff and honor `Retry-After`; cooldowns longer than 60 seconds stop with a retry-later error. Authentication errors and other permanent HTTP failures stop immediately. HTTP error bodies are not copied into job errors.

Completed chunks are atomically checkpointed. Jobs record a credential-free settings snapshot and SHA-256 of the source PDF. The exact byte snapshot that was hashed is also rendered, avoiding a second read of a file that could change during conversion. Keys are resolved from preferences at request time. Compatible staged chunks are revalidated before reuse. All workers settle before cleanup or a terminal state, and cancellation stops further requests and chunk commits.

Opening a session or re-adding a source may read a ready cache or recover saved chunks, but never starts a new vision API transcription. Startup may continue an active job that was already explicitly requested before shutdown. A retry of failed forced reconversion resumes its staging directory while the previous ready cache remains readable.

## Conversion process inspector

**View conversion process** is a local viewer in the owning Zotero panel. It remains available for pending, active, completed, failed and cancelled sources. Opening it or changing pages does not submit an API request. Explicit Stop and Retry use the shared conversion manager and window ownership rules.

Progress counts validated pages across concurrent workers, including a short final chunk; rendering and streamed drafts do not increase that count. A fully validated document remains at 99% while the cache is being installed, and reaches 100% only after a successful cache commit. Each chunk and each actual HTTP attempt has its own state and elapsed time. Requests and timeline metadata survive recovery, while live text stays in memory and is discarded after completion. The inspector labels locally estimated input tokens separately from provider-reported usage; unknown request usage remains unknown. Failed output and retries still count when the provider reports their usage. There is no price estimate because endpoint tariffs are not part of the conversion settings.

With **Live conversion preview** enabled (default for new jobs), the original request asks for SSE and final usage. Normal content is updated as it arrives; dedicated reasoning fields and the structured self-check footer are excluded from the document preview. Drafts use plain text until the complete response and program checks pass. The viewer then offers sanitized rendered Markdown or source text, alongside the exact cached JPEG that was sent and the page-local old/new self-check fragments. Model self-check and program validation are separately labeled. Without cached page images, the viewer offers the original PDF instead. Existing caches without request records remain readable and do not invent a history.

The transport accepts an ordinary JSON reply to the same streaming request without resubmitting it. An endpoint that rejects streaming fails visibly; disable the setting and explicitly retry. The stream setting does not invalidate validated chunks. Truncated SSE, missing normal termination, malformed frames, cancellation and the explicit 8 MiB response limit cannot produce a validated chunk.

A cache-stage failure may resume a finalized self-checked checkpoint without rendering or API calls. This path verifies the source PDF digest, compatible conversion settings, trusted per-chunk self-check records and Markdown digests, page markers, math syntax and the complete merged-document contract. Altered checkpoints fail visibly and require Reconvert. Incomplete checkpoints follow the existing chunk recovery path. Opening the inspector never initiates this recovery.

## Cache contract

Vision output uses the same v3 document layout and stable `libraryID:attachmentKey` identity as the existing tools:

```text
documents/<libraryID>-<attachmentKey>/
  document.md
  manifest.json
  chunks/<index-padded-to-four-digits>.md
  attachments/pages/page-<page>.jpg  # optional
```

The manifest records `converter: vision`, the page/chunk plan, source digest, safe conversion settings, quality-gate version and reported API usage for the current run. Every merged chunk, including a single-chunk document, has a `chatpdf-chunk` marker and page heading. Chunk bodies, character counts, contiguous page ranges and merged-document line ranges must agree before installation. Page images can be inspected with the existing image tools.

Output is written into job staging. Only a complete validated document replaces the canonical cache through the existing atomic directory swap. A failed conversion or cancellation preserves an older ready document. Fresh conversion does not inherit stale MinerU assets.

The bridge accepts `options.engine: "vision"` or `"mineru"`. Vision settings normally come from preferences; legacy calls specifying MinerU `model_version` keep the MinerU engine. Public job status identifies the engine and model without returning the endpoint or credentials.

## Data sent to services and accuracy limits

Vision conversion sends every rendered page image, including cover sheets and metadata, to the selected model endpoint. MinerU conversion sends PDF bytes to MinerU. API keys stay in Zotero preferences; the registry, manifest and bridge status do not contain them. Page images are cached locally only when enabled.

The gates detect structural failures, gross omissions, substantial loss of repeated Greek symbols or decorations, and formula syntax errors. They do not prove accurate OCR, mathematical equivalence, figure fidelity or table values. The symbol check does not establish accent placement, individual coefficients or full equation equality. Scanned pages have weaker omission detection, and a syntactically valid equation can still have incorrect symbols. Review representative pages against the original PDF before relying on converted research content. Native runtime verification and provider transcription verification are recorded separately in [the validation record](pdf-vision-validation.md).
