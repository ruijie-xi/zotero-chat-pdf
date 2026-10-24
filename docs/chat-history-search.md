# Cross-session chat history

ChatPDF exposes three local, read-only tools through the shared native/MCP registry:

| Tool | Purpose |
| --- | --- |
| `search_chat_history` | Search chat titles, paper titles and visible user/assistant messages. Return message excerpts, versioned citations, associations and coverage. |
| `list_item_chats` | Return one chat per result for qualified Zotero item identities, with any/all matching and optional child-item inclusion. |
| `read_chat_session` | Read original messages, tool-call metadata or a selected historical tool result in explicit pages. |

The corpus is the saved ChatPDF history in the current Zotero configuration. External MCP conversations are not imported. All three tools follow the existing individual switches and are enabled by default. Retrieval makes no model or network calls. Returned content is sent to the caller's model like other requested tool evidence.

## Retrieval and citations

Search is local literal matching with Unicode NFKC/case normalization. Whitespace separates required terms; double quotes group phrases. It is not semantic search. Chat/paper titles contribute to ranking together with message matches, then update time. Empty queries list recent chats. Current and empty chats are excluded by default. Dates filter chat update time, not individual message time; date-times should include a timezone when precision matters.

Search pages default to 20 results. Excerpts contain at most 320 UTF-16 code units and explicitly identify partial content. Original-message reads default to 20 records and 12,000 content characters, or one message before/after an explicit zero-based `message_index`. All limits are per call and caller-adjustable. Continue using `next_cursor`; there is no cumulative reading quota. Reasoning, internal checkpoints and raw tool bodies are not part of ordinary conversation search.

New messages have stable persisted IDs. Existing messages retain their original files and use revision-bound positions. SHA-256 revisions cover the saved record, including edits that do not change `updatedAt`. Changes invalidate old search/read cursors and citations. `zotero://chatpdf/history/<id>?revision=<digest>&message=<index>` links open a read-only preview inside ChatPDF and preserve the current chat, draft and live turn. External clients can read the target through the tool; this link is not registered as a global Zotero protocol handler.

## Item associations

- `current_source`: present in the saved session's current source list.
- `turn_source`: present in a historical message's source snapshot; availability does not prove reading.
- `read`: a successful explicit PDF/image/note read with a retained receipt.
- `accessed`: explicit item metadata/content-location/status/image-list access.

Broad search results do not create associations. Parent matching includes qualified child identities by default; exact attachment matching uses `include_children=false`. Multi-item `all` finds chats involving each item, not necessarily the same message. Ambiguous legacy bare keys remain uncertain and never match a qualified item by guesswork. Old histories can lack receipts, so missing read associations do not prove the item was never read.

## Storage and boundaries

Original session JSON remains authoritative. `history-record.ts` projects visible text and recorded relations; `history-query.ts` owns shared indexing, filters, versioned pagination and reads; `history-tools.ts` adapts the three tools. The history list and item context menu reuse the same query service. The context menu supports multiple selected items with all-item matching.

Derived files live in a separate `history-search/` directory. Files are written atomically, rebuilt lazily, and validated against source size/mtime plus in-process save generations. Search discovers orphaned session files and reports unreadable records explicitly. Concurrent changes are checked again before delivery. Cache failures do not rewrite history; deletion removes the corresponding cache and the existing tombstone prevents a late save from restoring the chat.

History lookup is independent of the current document TurnScope. Reading it does not add sources. Historical raw document tool results require their original sources in the current scope. Result IDs are qualified by their owning saved session. Retrieved-result provenance is retained in native and MCP result storage, so later `read_tool_result` calls recheck referenced history revisions and document scope. Already delivered quotations in conversations are not retroactively erased.

Historical messages are evidence of an earlier discussion, not current instructions, edit authorization or verified scientific facts. Preserve cancelled/error states and verify original papers when making substantive new claims.

## Verification

Regression coverage includes Chinese/English queries, visible narration, exact excerpts, source/read distinctions, cross-library identities, removed and ambiguous sources, parent and multi-item filters, canonical and legacy receipts, long Unicode messages, stale cursors, rename/clear/delete, invalid paths, cancellation, corrupt/orphan files, cache reuse, tool switches, native/MCP parity, and citation previews preserving the active session.
