# ChatPDF for Zotero

[简体中文](README.zh-CN.md)

ChatPDF is a Zotero 7–10 add-on for reading and discussing research papers with an OpenAI-compatible language model. It adds a persistent chat panel to Zotero, lets a vision-capable chat model read original PDF pages, and lets the assistant work with papers in your Zotero library.

![ChatPDF side panel in Zotero](docs/images/chatpdf-zotero-panel.png)

## Project Scope

ChatPDF is developed primarily for personal use and is shared as-is. Zotero versions, operating systems, model providers, network/proxy setups, and individual research workflows vary, so the add-on may not work perfectly in every environment.

The source code is available for adaptation. You can use AI coding agents to help inspect errors and fine-tune ChatPDF for your own environment and workflow—for example, provider compatibility, interface behavior, page-reading behavior, or custom tools. Keep custom changes in version control, back up the cache, and test them with an isolated Zotero profile before using them with your daily library.

## Agent capabilities update

The agent searches local PDF text to locate evidence, then reads original page images with the chat model. No PDF-to-Markdown conversion or separate OCR API key is required. Search responses report inspected coverage and continuation cursors; unextractable or unavailable files remain explicit.

The chat window's library permission menu enables batch collection, subcollection, tag and bibliographic note changes, including deletion of empty collections. Moving all contents out and deleting the empty shell can share one batch; Undo restores the collection and memberships. Batch review is the default; reviews and completed receipts group readable changes with Undo. Child and standalone notes can be searched and read without PDF conversion. Source chips show direct PDF reading and provide a right-click/More menu to open or remove a source. The agent chooses tools and their order while the harness enforces scope, transactions and conflict detection. Stable system instructions/tool schemas and immutable provider history support context prefix reuse. See [Agent capabilities](docs/agent-capabilities.md).

## Features

- Chat with one or more Zotero PDFs without leaving Zotero.
- Search your Zotero library or remembered annotation text and add relevant papers from the conversation.
- Search PDF text locally and read relevant original pages, including formulas, figures and tables.
- Stream answers with Markdown, LaTeX, reasoning, tool activity, and token usage.
- Keep separate chat sessions, source lists, and background work in each Zotero window.
- Optionally search and fetch public web pages.
- Cache extracted text, rendered pages and chat history locally.
- Expose the same tools to external agents through the companion Zotero MCP.

## Requirements

- Zotero 7, 8, 9, or 10.0.
- A vision-capable chat model accepting OpenAI-compatible `image_url` content and tool calls.
- An API key for an OpenAI-compatible chat-completions service.

## Installation

1. Download `chat-pdf.xpi` from [GitHub Releases](https://github.com/ruijie-xi/zotero-chat-pdf/releases).
2. In Zotero, open **Tools → Add-ons**.
3. Open the gear menu and select **Install Add-on From File…**.
4. Choose the downloaded XPI and restart Zotero.

The first installation still uses the XPI file. Starting with the next release, Zotero can discover later ChatPDF versions through **Tools → Add-ons → Gear → Check for Updates…**, and can install them automatically when add-on updates are enabled. Your settings and chat history remain in the configured cache directory.

## Setup

Open **Edit → Settings → ChatPDF** on Windows/Linux or **Zotero → Settings → ChatPDF** on macOS.

At minimum, configure:

| Setting | Description |
| --- | --- |
| LLM Provider | DeepSeek, OpenCode Go, or Custom (the existing OpenAI-compatible configuration). |
| LLM API Base URL | Base URL for an OpenAI-compatible API. |
| LLM API Key | Bearer token for the model provider. |
| Model Name | A vision-capable model identifier accepted by the provider. |
| Vision inputs | Automatic endpoint metadata, or Confirmed when your provider supports images but omits that metadata. |

The default API base and model target DeepSeek; existing settings and profiles remain **Custom**. Built-in providers fill in their endpoint and a default model. Provider selection is saved with each model profile. Switching providers keeps separate drafts while the settings pane is open and does not carry credentials or token overrides to a new provider. Save profiles to retain those configurations across restarts. Use **LLM API Test** to check the current endpoint and credentials.

**OpenCode Go** uses `https://opencode.ai/zen/go/v1` and a Go API key. Suggested DeepSeek IDs include `deepseek-v4.1-flash`, `deepseek-v4-pro`, and `deepseek-v4-flash`, without the `opencode-go/` prefix. ChatPDF sends its own client identity and a stable conversation header on main and auxiliary requests. Local token counts use the explicit DeepSeek V4 estimate. Known Go DeepSeek models use bundled catalogue capacities when `/models` omits them; endpoint metadata and manual overrides take precedence. Unknown models require explicit limits. [Go is intended for coding agents](https://opencode.ai/docs/go/#where-can-i-use-it); this integration does not guarantee service acceptance for paper-reading traffic.

Optional settings include thinking controls, iteration limits, context/output budgets, a per-image token reserve, cache location, system prompt, debug logging and web tools. Search uses PDF.js or a fresh Zotero text index locally. Brave Search is used when configured; otherwise web search falls back to DuckDuckGo.

Preferences group models and chat behavior, with advanced settings collapsed. The same model handles conversation and page reading. Unknown or unsupported vision capability blocks a turn with a configuration message. Current fields take effect immediately; named profiles and system prompts have explicit save controls.

History searches chat and paper titles, supports durable pins and an empty-chat filter, and shows 50 entries at a time. Existing chat history remains available; old conversion states migrate to direct reading.

## Quick Start

1. Add a paper by right-clicking a Zotero item and choosing **Add to ChatPDF**, or drag an item or reader tab into the panel.
2. Confirm a vision-capable model is configured; the PDF source is immediately ready for direct reading.
3. Enter a question and send it. The assistant can search PDF text, inspect original pages, search the Zotero library, and add relevant papers when needed.

Keyboard shortcuts:

- **Enter**: send.
- **Shift+Enter**: insert a new line.
- **Ctrl+Enter**: send.

Mention one or more source chips in the editor to restrict a question to those papers. Without mentions, the assistant can use all sources in the current session. Use **Stop** to cancel an answer and its pending page reads.

## Reading and searching PDFs

The assistant uses local text for keyword discovery and page navigation, then calls `read_pdf_page` for substantive reading. Zotero's bundled PDF.js renders only requested pages, at 300 DPI by default, and the images are sent to the current chat model with high image detail. Each result includes its PDF page number, Zotero citation link, dimensions and effective DPI.

Page images and text are cached by attachment identity and file revision. Long papers can be searched before selecting pages. OCR and a dedicated scanned-document workflow are currently out of scope. Pages without a text layer can still be rendered, but keyword search reports the missing text; there is no OCR fallback. The [OCR research record](docs/local-ocr-options.md) is retained for reference only.

## Local MCP integration

ChatPDF's native agent and the companion [Zotero MCP](https://github.com/ruijie-xi/zotero-mcp) share one tool registry and executor inside Zotero. All 23 tools are enabled by default. **Settings → Available tools** controls each tool for both callers; disabled tools disappear from discovery and stale calls are rejected. Library writes still follow the chat window's permissions and trusted batch review.

The companion MCP server forwards discovery, arguments and text/images through `POST /chatpdf/v2` (exact protocol 2). It does not read Zotero databases, conversion caches or implement another search path. PDF page images are returned as MCP image content. Each MCP session has its own document sources and result history; use `add_zotero_item_to_session` before document reads.

Both repositories must use matching protocol 2 builds. Old v1 bridges and the former conversion/document MCP tool names are unsupported. Restart an external client to refresh tools cached by the host. This outbound integration does not make ChatPDF a client for arbitrary third-party MCP servers. See [Shared tools](docs/shared-tools.md) and [Project status](docs/project-status.md).

## Web Tools

Web search and fetch are individually enabled by default. When used, the assistant can search the public web and fetch readable text from HTTP(S) pages.

For safety, ChatPDF blocks embedded credentials, localhost, private/link-local networks, unsafe redirects, unsupported content types, timed-out requests, and oversized responses. A blocked request is reported as an error instead of returning partial content.

## Data and Privacy

The default cache directory is `~/.chatpdf-cache/`; you can change it in ChatPDF settings. It contains local PDF text, rendered page caches, standalone image inputs, chat history and optional debug logs.

- Requested page images are sent to the configured chat model. Adding a PDF or starting Zotero makes no transcription request. Local text extraction needs no OCR service key.
- Conversation messages, relevant document content, and tool results are sent to your configured LLM provider.
- Web queries and requested pages are sent to the selected search service and website only when web tools are enabled and used.
- Debug logging defaults to metadata only. **Full** logging can contain prompts, paper text, answers, reasoning, and tool results.
- API keys are stored in Zotero preferences. Do not include them in screenshots or bug reports.

## Troubleshooting

**The panel does not appear:** confirm that ChatPDF is enabled under **Tools → Add-ons**, then restart Zotero.

**The model request fails:** use **LLM API Test** and verify the base URL, key, model name, and provider compatibility.

**Page reading fails:** check local PDF availability, password protection, image support, per-image token reserve and context limits. A successful text-only API test does not prove image support. If `/models` omits input capabilities, select **Confirmed** only after checking that your exact model and endpoint accept images.

**A source cannot be read:** confirm that it is downloaded locally and included in the current question's source mentions or session.

**Web search or fetch fails:** verify that web tools are enabled. Private/local targets and unsafe responses are intentionally blocked.

## Support

- [Report a problem](https://github.com/ruijie-xi/zotero-chat-pdf/issues)
- [Release notes](CHANGELOG.md)
