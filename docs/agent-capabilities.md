# Agent capabilities and execution guarantees

The agent chooses its own tools and order. The harness supplies representations, reliable execution, scoped authorization and receipts. There is no mandatory discovery-to-conversion workflow, comparison engine, classification-rule engine or new long-task feature.

## Discovery and document evidence

`search_zotero_library` searches metadata. `search_pdf_text` also discovers unconverted PDFs using local text, preferring a fresh, complete Zotero full-text index and otherwise extracting text through the bundled PDF.js. It never converts PDFs, invokes an LLM or adds all matches to the session. Library, collection (optionally recursive), tag and year filters are available. The explicit defaults are 20 hits, 25 inspected documents and 240-character snippet windows per call. Overlapping windows are merged. Each response reports inspected coverage and a continuation cursor; it does not claim that uninspected files had no matches. Missing files, extraction failures and documents with no extractable text remain distinguishable.

`get_document_status` reports available representations and conversion status. `read_pdf_text` reads page-mapped text without conversion; `read_pdf_page` delivers visual evidence without converting a whole PDF. Markdown/chunk tools retain their existing functions. Text can lose formulas and layout; accepted conversion does not prove scientific accuracy. PDF page numbers and printed page labels are separate. Zotero's flat index does not provide page locations, and none are invented.

`get_zotero_item` defaults to complete public stored metadata: bibliographic fields such as DOI/URL/journal/volume/issue/pages/abstract/Extra, structured creator roles, tag types, relation identifiers, dates, collection keys and ancestry, child-note metadata and attachment availability. Inspecting a child preserves its exact identity and also returns its parent. Linked local paths and repeated child-note bodies are excluded from metadata; complete note/document readers provide content. `detail=summary` preserves compact discovery output. Details are requested on demand, do not add session sources, and are independent of PDF TurnScope. Search and collection lists remain compact rather than repeating full records in every call.

Local text and rendered pages are atomically cached by library-qualified attachment identity and file revision. Changed files invalidate the local caches. Known source digests prevent stale Markdown being read as the current PDF; `convert_session_source(force=true)` explicitly replaces it. A missing source file or a legacy manifest cannot establish freshness and is reported as unknown. Conversion tools reuse ready caches. `wait_for_conversion` observes an existing job without model polling and updates a still-authorized session source when it completes.

PDF text/page/status/wait tools enforce the existing SessionLibrary and TurnScope. Discovery is library-wide and does not silently enlarge the session. An explicit source-addition tool remains available. Library lookups never fall back from a specified library or resolve an ambiguous bare item key.

## Collections, tags and notes

`change_zotero_library` provides preview, apply, list and undo modes. Supported actions create/rename/reparent collections, delete empty collections; add/remove/move collection memberships; add/remove/rename tags on selected top-level items; and create/update bibliographic child notes. Moves remove only the specified original membership. Existing automatic tag types and unrelated memberships are preserved. New notes render Markdown through the existing sanitizer. `read_zotero_notes` defaults to complete readable text, retaining citation targets; `format=html` returns exact stored HTML. Explicit inclusive line ranges are optional. Full-note revisions are independent of the requested range; note updates require that revision to prevent overwriting intervening edits.

`delete_empty_collection` requires a library-qualified collection key and the same review/edit scope as other writes. It rejects collections with any remaining items or child collections, including trashed contents. A container with zero direct items is not necessarily empty. Related membership moves, child reparentings and deletion of the resulting empty shells can share one transaction and receipt. The planner checks the final batch state; execution reloads Zotero's public child data immediately before deletion to avoid using caches that update only after commit. Deletions run after updates, with children before parents; undo restores parents before children and memberships, preserving the original collection key, name and parent. Later edits and reused keys block unsafe undo. This operation uses Zotero collection erasure; recovery is through the ChatPDF receipt's Undo, not a promise of Zotero trash recovery.

Use `mode=apply` directly for an authorized batch. Review mode already displays the concrete preview before any writes, so an additional preview/apply tool round trip is optional. Group related actions and verify the resulting structure once per batch rather than reading back every unchanged collection. Collection changes reload each open local collection tree after commit, restore its selected row where available and release selection-event suppression. A display discrepancy alone is not evidence of a sync failure and does not justify moving collections out and back to manufacture new edits.

`search_zotero_notes` searches child and standalone note bodies locally. Library, collection (optionally recursive), exact parent/note and tag filters are available. Child notes use their parent's collection membership. Defaults are 20 hits, 100 inspected notes and 240-character snippet windows; results include coverage and a continuation cursor. Edits refresh cached text and invalidate affected cursors. Search does not add sources or invoke a model. Note reading is library-wide evidence, independent of PDF TurnScope. Exact note keys are qualified by library ID. Collection enumeration includes empty descendants, so a newly created empty subcollection can be found by name immediately.

The permission menu above the chat editor defaults to batch review. Other modes are read-only, selected items, current collection with descendants, or current library. Preferences points users to this chat control. The UI selection is captured when sending and cannot be widened by tool arguments, source text or later selection changes. Each actual library's editing permission is checked. Revoking the mode is honored. Batch review groups add/edit/remove/move operations with readable target names, preserved memberships and optional sanitized full-note before/after content; it requires a trusted user click. Completed receipts use the same categories and keep raw JSON inside optional Technical details. Cancellation removes the pending review. The tool schema does not change with permissions, and display formatting does not rewrite stored or model-facing tool results.

The current turn's access description explicitly supersedes older turn permissions and assistant claims. Library mode authorizes all items and collections in its library ID; selection arrays are omitted because they are not allowlists in this mode. Selected-item and collection modes expose only their actual respective key lists. Review and read-only modes have explicit meanings without unrelated selection data. Old provider messages remain immutable; a permission change appends the new description rather than rewriting history. Zotero editability, cross-library checks, readonly revocation and transactional conflicts remain enforced.

Preflight rejects invalid identities, missing targets, collection cycles and unauthorized edits. A batch uses a Zotero transaction and rechecks target state before mutation. The atomically persisted journal stores before/after values and operation receipts. Applying a completed receipt does not perform the operation again. `operation_id` allows reuse across calls; previews return a `change_id` that can be applied without re-planning. A prepared receipt after a persistence failure is never blindly replayed. Receipts returning to the model summarize changed fields; note bodies are available through the note reader rather than duplicated in every receipt.

Undo rechecks actual after-state, preserves later user edits by reporting conflicts, and runs in a transaction. Collections created by a batch can be removed on undo only while empty. An Undo button is included in completed mutation tool blocks, including restored history. No general item deletion, attachment movement, arbitrary code or cross-library migration is exposed.

## Citations and context cache reuse

Page text and visual evidence return Zotero page links. Converted reads return source identity, digest and line/chunk/page ranges. These links open the corresponding PDF page. Chunk ranges are not presented as exact single-page equation locations.

All new context surfaces consider prefix-cache reuse:

| Surface | Cache behavior |
| --- | --- |
| System prompt | Static capabilities, no current sources, clock, job state or permissions |
| Tool definitions | Fixed names, schemas and order; no per-turn tool hiding |
| Source and edit scope | Appended only to the current user message |
| Provider history | Existing messages, raw tool arguments and results remain immutable |
| Search/read results | Explicit pagination and ranges; reuse already-inspected evidence; deterministic ordering |
| Note search/read | Fixed schemas; revision-aware local text cache; text or HTML returned once, not duplicated |
| Permission/review UI | No context injection on menu interaction; readable cards do not mutate provider history |
| Conversion progress | Live UI; model receives requested snapshots or a terminal wait result |
| Mutation receipts | Compact structured field changes, stable operation identity, no repeated note bodies |
| Local caches | Avoid repeated extraction/rasterization; file revision invalidates stale evidence |
| Usage | Provider-reported hits/misses remain the measurement; unknown fields are not fabricated |

Local cache reuse and identical request prefixes do not guarantee provider-side hits. Model, endpoint, account or explicit system/tool configuration changes can affect provider caching. Compaction and binary image restoration retain their existing explicit behavior. Complete tool results remain stored; the context manager uses visible result references and exact paging when a result exceeds the model's capacity, rather than silently truncating it.

Upgrading from a build without these tools changes the system/tool fingerprint once. An existing chat may reconstruct its working context on its first post-upgrade request; subsequent compatible requests append to the new prefix. This transition should not be described as preserving the previous build's provider cache entries.

## Manual acceptance checks

Install the current `.scaffold/build/chat-pdf.xpi` and open a new chat. A text-bearing PDF that has never been converted can be used directly; page images require a vision-capable chat model. Example requests:

- "Find papers in my library mentioning Hamiltonian systems, including unconverted PDFs. Show the inspected coverage and the most relevant passages."
- "Read page 2 of this unconverted PDF, inspect its formula visually, and cite that page."
- "Create a child collection under this collection, move these selected items from A to B while preserving other memberships, and add the tag `to-read`."
- "Write a note on this paper with the passages we inspected and page links."
- "Search my notes for Hamiltonian systems, including standalone notes, then read the relevant notes with their citation links."
- "Undo the library changes from your last operation."

The default edit mode shows one batch review before writing. Cancel it to check that the original state is preserved. For automatic editing, select an explicit item/collection/library scope in the chat window; choosing read-only must prevent subsequent writes. The tool block's Undo button can reverse completed changes. Intervening user edits should produce a conflict rather than overwrite them. Source chips keep their original 3px spacing and compact single-line layout. Process opens the conversion inspector; right-click or More exposes reconversion and source removal. Progress updates retain the same primary buttons. Private PDF frames use print scheduling, which does not depend on animation frames; PDFs with print-specific optional content/annotations can render differently from display intent. To examine prefix caching, compare provider-reported hit/miss usage across compatible follow-up turns; local mock usage cannot establish a provider's real hit rate.
