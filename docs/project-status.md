# Project status and MCP compatibility

Audit, implementation and daily installation date: 2026-10-20. This records the implementation and its tested companion, not a published release.

## Current design

- ChatPDF is a Zotero 7-10 plugin, currently on the 0.9.5 package version. Runtime acceptance here used Zotero 10.0.6; this does not certify every supported Zotero version.
- PDF-to-Markdown conversion, MinerU, the vision transcription/self-check workflow, conversion jobs, preferences and runtime Markdown document caches are removed. Existing user caches and credentials are not deleted.
- A vision-capable chat model reads original PDF page images. Local PDF.js text or a fresh Zotero index is used for search and navigation. Native chat rejects unsupported/unknown visual capability until configured appropriately.
- OCR and a dedicated scanned-document workflow are deferred. [OCR research](local-ocr-options.md) records PaddleOCR-VL-1.6 size, formula benchmark interpretation and hosted-service limits. No OCR dependency, model download or public OCR request was added.
- Native chat and Zotero MCP share the same registry, argument validation and executor inside Zotero. All **23 tools are enabled by default**, with individual settings that govern both callers. See [the tool inventory and channel contract](shared-tools.md).

## Implemented compatibility boundary

The companion source repository is `D:\Myfiles\Codes\zotero-mcp`. It now forwards standard MCP calls to ChatPDF's exact protocol 2 endpoint, `POST /chatpdf/v2`. It no longer reads conversion manifests/Markdown caches or implements Zotero document/library searches separately. Native chat works without the MCP process.

Names, descriptions and JSON schemas match between native chat and external MCP. Results include complete text and original page images as standard MCP image content. Each external session has an independent source set and result history. Tool enablement does not grant write authority: captured scope, read-only permissions, trusted batch approval, transactions and conflict checks remain enforced in Zotero.

The external host must use a model that accepts image tool results. ChatPDF can validate the native chat model's capability configuration; an MCP server cannot inspect or enforce the external host's model choice.

The old protocol 1 and old research/connector tool contracts are deliberately retired. `research` and `connector` CLI arguments are aliases for the same live tool catalog. A host restricted to the old two-tool `search`/`fetch` contract needs a separate integration.

## Verification

| Check | Result |
| --- | --- |
| ChatPDF `npm run verify` | TypeScript, ESLint, 44 test files / 329 tests, production XPI build passed |
| Companion MCP | Ruff and 26 tests passed, including dynamic discovery, schemas, complete text/images, disabled calls, request cancellation and incompatible bridges |
| Isolated Zotero native agent | Text-only model rejected; local text search and page navigation passed; page 2 delivered to the mock vision model; renderer disposed |
| Real stdio MCP SDK → protocol 2 → isolated Zotero | 23 schemas matched the native request; original JPEG bytes exactly matched native delivery (292,777 bytes) |
| Live settings and scope | Disabling `web_fetch` reduced both catalogs to 22; stale MCP call rejected; second MCP session could not read the first session's document |
| Live edit permissions and cancellation | Read-only write rejected; an explicit MCP cancellation notification removed the pending trusted review; fixture tags remained unchanged |
| Daily Zotero installation | Active on Zotero 10.0.6; installed XPI checksum and all 77 bundled source files matched the tested workspace |
| Fresh stdio MCP SDK → daily Zotero | Protocol 2, all 23 tools enabled, exact schema parity and matching installed source snapshot |

The isolated test used newly generated PDF fixtures, separate profile/data/cache directories, a dummy local model key and a dedicated loopback port. It did not copy credentials or operate on the daily library. Its cache contained `history`, `pdf-pages` and `pdf-text`, with no conversion/document cache directory. Ignored evidence is under `.scaffold/shared-tools-smoke/`; the latest successful run is `run-1792485069609`.

These tests validate transport, shared behavior, authorization, actual PDF.js rasterization and the daily installation. They do not measure mathematical reading accuracy, public OCR quality, authenticated LLM behavior, or acceptance in a newly opened Codex agent session.

## Installed versus workspace state

Before installation, the daily Zotero answered the old v1 bridge with vision/MinerU conversion capabilities, even though its package version was also 0.9.5. On 2026-10-20, the existing XPI was backed up, Zotero was closed normally, and the verified new XPI was installed into the existing daily profile. Zotero was then restarted and verified through protocol 2 and a fresh standard MCP SDK connection.

The matching companion source is in `D:\Myfiles\Codes\zotero-mcp` and is used by its existing editable Python installation. No explicitly configured old bridge URL was present, so global MCP configuration did not need modification. Existing MCP client processes were not restarted; reconnect them to load the updated Python modules and refresh the tool list. Package version alone is insufficient; protocol 2 and the shared live catalog identify this implementation.

The installed XPI SHA-256 is `66202a91d13ef3e2a4e1489efedb54ebaf63f85e03c4aded3753bcd7f2c2b8d1`; its source snapshot SHA-256 is `c95e6ca93027377ea8267b0d1d95946adcb4aaac8a10653c3d745e57be1ceb78`. Ignored installation evidence is under `.scaffold/shared-tools-install/`, and the previous XPI is `.scaffold/install-backups/chatpdf-before-shared-tools-20261020-175227.xpi`. The generated installable package remains `.scaffold/build/chat-pdf.xpi`.

This is a local installation without a tag, push or published release. The older [simplification plan](minimal-self-contained-chatpdf-mcp-plan.md) is historical and does not define the current tool or cache architecture.
