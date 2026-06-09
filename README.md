# ChatPDF for Zotero

ChatPDF is a Zotero 7 plugin for talking with research papers through OpenAI-compatible LLM APIs. It converts PDFs to Markdown with the MinerU cloud API, stores the converted document and its extracted assets locally, and gives the model a small set of tools for reading the sources it actually needs.

The current chat flow is agent-based. Instead of blindly sending every PDF in full, ChatPDF exposes session sources through tools such as `list_sources`, `read_document`, `search_document`, `list_document_chunks`, and `read_document_chunk`. Optional web tools can also be enabled when a question needs context outside the attached papers.

## Highlights

- Chat with Zotero PDF attachments from a persistent side panel.
- Add multiple papers to one session and keep them available across turns.
- Convert PDFs through MinerU and cache Markdown under the local ChatPDF cache directory.
- Preserve MinerU result assets, including extracted images, beside each converted document.
- Convert long PDFs in page-range chunks with cached chunk reuse.
- Let the agent inspect, search, and read targeted document sections.
- Stream assistant answers and preserve background streams while switching sessions.
- Save chat history locally and resume previous conversations.
- Show reasoning or thinking output from compatible providers.
- Save model profiles for multiple LLM providers.
- Render Markdown and LaTeX math with KaTeX.
- Optionally enable web search and web fetch tools.
- Receive add-on updates through Zotero's update mechanism.

## Requirements

- Zotero 7.
- A MinerU API token from the MinerU API management page.
- An API key for an OpenAI-compatible chat completion provider.

## Installation

1. Open the [GitHub Releases](https://github.com/ruijie-xi/zotero-chat-pdf/releases) page.
2. Download the latest `chat-pdf.xpi`.
3. In Zotero, open **Tools > Add-ons**.
4. Click the gear icon and choose **Install Add-on From File...**.
5. Select the downloaded `.xpi` and restart Zotero.

After installation, Zotero checks for ChatPDF updates automatically. New releases install on the next Zotero restart.

## Setup

Open **Edit > Settings > ChatPDF** on Windows/Linux or **Zotero > Settings > ChatPDF** on macOS.

### Required Settings

| Setting | Description |
| --- | --- |
| MinerU API Token | Token from MinerU API management. Used for PDF conversion. |
| LLM API Key | Bearer token for your OpenAI-compatible LLM provider. |

### LLM Settings

| Setting | Default | Description |
| --- | --- | --- |
| LLM API Base URL | `https://api.deepseek.com/v1` | OpenAI-compatible API base. ChatPDF sends requests to `/chat/completions`. |
| Model Name | `deepseek-chat` | Chat model identifier. |
| Thinking Mode | `default` | Provider-specific thinking control when supported. |
| Think Effort | `default` | Optional reasoning effort for compatible providers. |
| System Prompt | empty | Extra instructions appended to the built-in research assistant prompt. |
| Model Profiles | `[]` | Saved provider/model configurations. |
| Active Profile | empty | Currently selected saved profile. |

### Conversion And Tool Settings

| Setting | Default | Description |
| --- | --- | --- |
| Cache Directory | empty | Empty means `~/.chatpdf-cache`. Converted documents, assets, chunks, history, and debug logs live here. |
| Agent Max Iterations | `10` | Maximum tool loop iterations before forcing a final answer. |
| Enable Web Tools | `false` | Adds `web_search` and `web_fetch` to the agent tool set. |
| Brave Search API Key | empty | Optional Brave Search key. Without it, web search uses a fallback path. |

### Provider Examples

| Provider | API Base URL | Model Example | Notes |
| --- | --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | Default provider. |
| OpenAI | `https://api.openai.com/v1` | `gpt-4.1` | Use any chat model enabled for your API key. |
| Ollama | `http://localhost:11434/v1` | `llama3.1` | Local OpenAI-compatible server. |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4` | Multi-provider API gateway. |
| Gemini-compatible endpoints | provider-specific | provider-specific | ChatPDF detects Gemini-compatible URLs and sends Gemini thinking config instead of DeepSeek-only fields. |

## Usage

### Add Sources

- Select a Zotero item with a PDF attachment.
- Drag a Zotero item or reader tab into the source area.
- Right-click an item and choose **Add to ChatPDF**.
- Use source chips to convert, stop conversion, or remove a source from the current session.

### Convert PDFs

Click **Convert** on a source chip, or convert multiple pending sources from the source area. ChatPDF uploads the PDF to MinerU, polls until conversion finishes, downloads the result ZIP, and stores the converted output locally.

Each converted attachment gets its own cache folder:

```text
~/.chatpdf-cache/
  documents/
    <attachment-key>/
      document.md
      manifest.json
      chunks/
        0001.md
      attachments/
        full/
          images/
            ...
```

The exact layout depends on whether the PDF was converted as a single job or in long-document chunks. ChatPDF keeps older root-level `<key>.md` caches readable, but new conversions use the per-document folder layout.

### Ask Questions

Once sources are ready, type a question and send it. The agent normally calls `list_sources` first, then reads precise sections, chunks, or search results as needed. This is designed for grounded answers without stuffing every converted PDF into one prompt.

### Long PDFs

For PDFs above the long-document threshold, ChatPDF converts page ranges in smaller chunks. The agent can:

- list chunk page ranges,
- search the converted document,
- read a specific chunk,
- read exact line ranges from the merged Markdown.

This makes book-length PDFs and large reports more reliable to convert and easier for the model to navigate.

### Chat History

- Use **History** to open previous sessions.
- Use **New Chat** to start a fresh session.
- Session titles are generated after the first assistant response and can be edited.
- User messages keep snapshots of the active sources for historical display.

## How It Works

```text
Zotero PDF attachment
  -> MinerU upload URL request
  -> PDF upload
  -> MinerU polling
  -> result ZIP download
  -> Markdown and asset cache
  -> agent tool loop
  -> streamed final answer
```

Important runtime details:

- Zotero runs the plugin in a privileged Firefox chrome context, not Node.js.
- File I/O uses Zotero/Firefox APIs such as `IOUtils` and `PathUtils`.
- UI code is raw DOM/XHTML, not React.
- Markdown rendering is post-processed to be XHTML-safe for Zotero panels.
- MinerU result downloads depend on multiple hosts: `mineru.net`, `mineru.oss-cn-shanghai.aliyuncs.com`, and `cdn-mineru.openxlab.org.cn`.

## Development

### Build

```bash
npm install
npm.cmd run build
```

On Windows PowerShell, prefer `npm.cmd run build` if `npm.ps1` is blocked by the execution policy.

The production add-on is written to:

```text
.scaffold/build/chat-pdf.xpi
```

### Development Server

```bash
npm start
```

This launches Zotero with the plugin loaded and watches for source changes.

### Verification

Use the scaffold build as the authoritative project check:

```bash
npm.cmd run build
```

`npx tsc --noEmit` is not currently the primary check because Zotero/Firefox ambient type coverage has gaps in this repository.

### Release

The scaffold release command bumps version files, creates a commit and tag, and pushes:

```bash
npm.cmd run release -- patch --yes
npm.cmd run release -- minor --yes
```

Tags matching `v*` trigger `.github/workflows/release.yml`, which builds the `.xpi`, creates a GitHub release, and updates the add-on update manifest.

## Project Structure

```text
src/
  hooks.ts                    Startup and shutdown registration
  modules/
    chat-panel.ts             Persistent side panel and source/session coordination
    panel-state.ts            Mutable panel, stream, input, and session state
    send-handler.ts           Send lifecycle, streaming UI updates, and autosave
    agent-loop.ts             Tool-calling loop and final answer streaming
    llm-client.ts             OpenAI-compatible client, SSE parsing, and provider quirks
    tools.ts                  Document tools and optional web tools
    source-chips.ts           Source chip rendering and MinerU conversion entry point
    chat-session.ts           Session sources, messages, prompts, and serialization
    chat-history.ts           Local JSON session persistence
    mineru-client.ts          MinerU upload, polling, ZIP download, chunking, and asset extraction
    md-cache.ts               Converted document, chunk, manifest, and asset cache paths
    markdown-renderer.ts      Markdown, KaTeX, sanitization, and XHTML conversion
    preference-script.ts      Preferences pane behavior, profiles, and LLM test panel
addon/
  content/
    chatpdf.css               Chat panel and preference styles
    preferences.xhtml         Zotero preferences pane
  locale/en-US/
    preferences.ftl           Preference labels
  manifest.json               Zotero add-on manifest and host permissions
  prefs.js                    Default preferences
typings/
  prefs.d.ts                  Preference type declarations
```

## Troubleshooting

### MinerU Converts But Result Download Fails

MinerU conversion has several network stages. Upload and polling can succeed while the final ZIP download fails on the separate CDN host. Make sure Zotero and your system proxy/VPN can reach:

```text
https://mineru.net/*
https://mineru.oss-cn-shanghai.aliyuncs.com/*
https://cdn-mineru.openxlab.org.cn/*
```

If only the final stage fails, check the Zotero error console for the stage-specific ChatPDF/MinerU error and verify that your proxy rules include the CDN host.

### No Markdown Or Asset Cache Appears

Converted documents are stored under `documents/<attachment-key>/`. If a source has an old cache without a document folder, reconvert it to generate the current `document.md`, `manifest.json`, chunk files, and attachment assets.

## License

MIT
