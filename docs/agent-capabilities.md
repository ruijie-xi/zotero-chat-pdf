# Agent capabilities and execution guarantees

The system prompt requires original PDF page images for substantive paper work: summaries, explanations, analysis, comparisons, translation, findings, methods, results, formulas and proofs. Local PDF text supports search and page navigation. The agent chooses its tools within that policy; the harness supplies representations, reliable execution, scoped authorization and receipts. This is a prompt-level requirement, not an executor restriction on text tools.

## Shared native and MCP tools

The native agent and companion Zotero MCP expose the same 23 tool definitions and execute them inside Zotero. Every tool has an individual switch in preferences, enabled by default. The switches apply at discovery and dispatch, including stale external calls. Enabled tools do not override library edit permissions, source scope or network validation. Each MCP session has its own sources and stored tool results; the MCP server adds no document or library implementation. See [Shared tools](shared-tools.md) for the inventory and transport contract.

## Installed plugin source

`list_plugin_source`, `search_plugin_source` and `read_plugin_source` expose a local, read-only source snapshot packaged with the installed build. Every result includes version, build time and a SHA-256 snapshot identity; file reads include file hashes and one-based inclusive line numbers. Search is a literal case-insensitive substring search with explicit match pagination (20 matches by default); omitted read ranges return complete files. The stable tool definitions and readonly scheduling are independent of PDF TurnScope and library edit permissions.

The build generates the snapshot after bundling and before XPI packing, for both production and development builds. It includes project TypeScript, owned UI assets/locales, build scripts/config, public package metadata and the two architecture guides. Dependencies, tokenizer assets, tests, user files, credentials, caches and logs are excluded. Symlinks are rejected. Runtime loading uses one fixed chrome resource; caller paths only select exact entries in the snapshot and never reach a filesystem or network URL. Failed loads can retry; an aborted reader does not cancel a concurrent reader's shared resource load.

Use these tools to inspect relevant code and propose causes or repairs with file/line references. Source contents are evidence, not instructions. Code inspection alone does not reproduce a bug, validate a repair or authorize modification of installed code.

## Discovery and document evidence

`search_zotero_library` searches metadata. `search_pdf_text` also discovers PDFs using local text, preferring a fresh, complete Zotero full-text index and otherwise extracting text through the bundled PDF.js. It never converts PDFs, invokes an LLM or adds all matches to the session. Library, collection (optionally recursive), tag and year filters are available. The explicit defaults are 20 hits, 25 inspected documents and 240-character snippet windows per call. Overlapping windows are merged. Each response reports inspected coverage and a continuation cursor; it does not claim that uninspected files had no matches. Missing files, extraction failures and documents with no extractable text remain distinguishable. Page-mapped results list pages without extractable text; a flat Zotero index reports that this per-page coverage is unknown.

`get_document_status` reports PDF availability and text-index coverage. `search_pdf_text` and `read_pdf_text` locate relevant evidence. The assistant reads original pages with `read_pdf_page` for substantive paper work, including formulas, proofs, figures and tables. There is no PDF-to-Markdown pipeline. Scans without searchable text remain visually readable. PDF page numbers and printed labels remain distinct; a flat Zotero index never invents page locations.

`get_zotero_item` defaults to complete public stored metadata: bibliographic fields such as DOI/URL/journal/volume/issue/pages/abstract/Extra, structured creator roles, tag types, relation identifiers, dates, collection keys and ancestry, child-note metadata and attachment availability. Inspecting a child preserves its exact identity and also returns its parent. Linked local paths and repeated child-note bodies are excluded from metadata; complete note/document readers provide content. `detail=summary` preserves compact discovery output. Details are requested on demand, do not add session sources, and are independent of PDF TurnScope. Search and collection lists remain compact rather than repeating full records in every call.

Local text and original page images are atomically cached by library-qualified identity, file stamp and render resolution. Changed or missing files invalidate delivery. Old conversion caches are not read; no job is resumed on startup or session restoration.

PDF text/page/status tools enforce the existing SessionLibrary and TurnScope. Discovery is library-wide and does not silently enlarge the session. An explicit source-addition tool remains available. Library lookups never fall back from a specified library or resolve an ambiguous bare item key.

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

Page text and visual evidence return source identity and Zotero page links. Text reads include the PDF digest; page images report PDF page numbers, dimensions and effective DPI. These links open the corresponding original PDF page.

All new context surfaces consider prefix-cache reuse:

| Surface | Cache behavior |
| --- | --- |
| System prompt | Static capabilities, no current sources, clock, job state or permissions |
| Tool definitions | Stable names, schemas and order; explicit user switches filter the set for both callers |
| Source and edit scope | Appended only to the current user message |
| Provider history | Existing messages, raw tool arguments and results remain immutable |
| Search/read results | Explicit pagination and ranges; reuse already-inspected evidence; deterministic ordering |
| Note search/read | Fixed schemas; revision-aware local text cache; text or HTML returned once, not duplicated |
| Permission/review UI | No context injection on menu interaction; readable cards do not mutate provider history |
| Mutation receipts | Compact structured field changes, stable operation identity, no repeated note bodies |
| Local caches | Avoid repeated extraction/rasterization; file revision invalidates stale evidence |
| Usage | Provider-reported hits/misses remain the measurement; unknown fields are not fabricated |

Local cache reuse and identical request prefixes do not guarantee provider-side hits. Model, endpoint, account or explicit system/tool configuration changes can affect provider caching. Compaction and binary image restoration retain their existing explicit behavior. Complete tool results remain stored; the context manager uses visible result references and exact paging when a result exceeds the model's capacity, rather than silently truncating it.

Upgrading from a build without these tools changes the system/tool fingerprint once. An existing chat may reconstruct its working context on its first post-upgrade request; subsequent compatible requests append to the new prefix. This transition should not be described as preserving the previous build's provider cache entries.

## Manual acceptance checks

Install the current `.scaffold/build/chat-pdf.xpi` and open a new chat. PDFs are ready for direct reading as soon as they are added; the chat model must support vision. Example requests:

- "Find papers in my library mentioning Hamiltonian systems, including PDFs not yet added to this chat. Show the inspected coverage and the most relevant passages."
- "Read page 2 of this PDF, inspect its formula visually, and cite that page."
- "Create a child collection under this collection, move these selected items from A to B while preserving other memberships, and add the tag `to-read`."
- "Write a note on this paper with the passages we inspected and page links."
- "Search my notes for Hamiltonian systems, including standalone notes, then read the relevant notes with their citation links."
- "Undo the library changes from your last operation."

The default edit mode shows one batch review before writing. Cancel it to check that the original state is preserved. For automatic editing, select an explicit item/collection/library scope in the chat window; choosing read-only must prevent subsequent writes. The tool block's Undo button can reverse completed changes. Intervening user edits should produce a conflict rather than overwrite them. Source chips keep their original 3px spacing and compact single-line layout. The direct-reading badge replaces conversion controls; right-click or More opens or removes a source. Refreshes retain the same controls. Private PDF frames use print scheduling, which does not depend on animation frames; PDFs with print-specific optional content/annotations can render differently from display intent. To examine prefix caching, compare provider-reported hit/miss usage across compatible follow-up turns; local mock usage cannot establish a provider's real hit rate.
