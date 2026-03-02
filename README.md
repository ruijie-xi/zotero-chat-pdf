# ChatPDF - Zotero 7 Plugin

Chat with your PDFs using LLMs directly inside Zotero. PDFs are converted to Markdown via the MinerU API and cached locally. The converted text serves as context for LLM conversations. DeepSeek is the default provider, but any OpenAI-compatible API works (OpenAI, Claude proxy, Ollama, etc.).

## Features

- **PDF to Markdown conversion** via MinerU API with local caching
- **Streaming chat** with any OpenAI-compatible LLM
- **Multi-source sessions** — add multiple PDFs to a single conversation
- **Drag-and-drop** — drag Zotero items onto the chat panel to add them as sources
- **Right-click context menu** — "Add to ChatPDF" on any item with a PDF attachment
- **Item pane integration** — chat section appears in Zotero's item pane sidebar
- **Configurable** — swap LLM providers, models, and cache location from preferences

## Requirements

- Zotero 7
- A [MinerU](https://mineru.net) API token (for PDF-to-Markdown conversion)
- An API key for an OpenAI-compatible LLM service

## Installation

1. Download the latest `.xpi` file from the [Releases](https://github.com/user/zotero-chatpdf/releases) page.
2. In Zotero, go to **Tools → Add-ons**.
3. Click the gear icon and select **Install Add-on From File…**, then choose the `.xpi` file.

## Configuration

Open **Edit → Settings → ChatPDF** and fill in:

| Setting | Description | Default |
|---------|-------------|---------|
| MinerU API Token | Bearer token from [mineru.net](https://mineru.net) | — |
| LLM API Base URL | Base URL for the chat completions endpoint | `https://api.deepseek.com/v1` |
| LLM API Key | API key for your LLM provider | — |
| Model Name | Model identifier to use | `deepseek-chat` |
| Cache Directory | Where converted Markdown files are stored | `~/.chatpdf-cache` |
| Max Context Characters | Maximum characters sent to the LLM | `100000` |

### Provider examples

| Provider | API Base URL | Model |
|----------|-------------|-------|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| Ollama (local) | `http://localhost:11434/v1` | `llama3` |

## Usage

1. **Select an item** in Zotero that has a PDF attachment. The ChatPDF panel appears in the item pane sidebar.
2. The selected item is automatically added as a source. If its PDF hasn't been converted yet, click **Convert** next to it.
3. Once the status shows **Ready**, type a question in the text box and press **Enter** or click **Send**.
4. The LLM responds with streaming output based on the PDF content.

### Adding multiple sources

- **Drag and drop** items from the Zotero library onto the sources area.
- **Right-click** one or more items and select **Add to ChatPDF**.
- Use **Convert All** to batch-convert all unconverted sources.

### Managing a session

- Click **×** next to a source to remove it from the conversation.
- Click **Clear Chat** to reset the message history (sources are kept).

## Building from source

```bash
npm install
npm run build
```

The built plugin is output to `.scaffold/build/chat-pdf.xpi`.

For development with hot-reload:

```bash
npm start
```

## How it works

```
Select item → Check cache → [Not cached] → MinerU API converts PDF to Markdown → Cache locally
                           → [Cached]    → Load Markdown from disk

User sends question → Build system prompt with all ready source Markdown
                    → Send to LLM via OpenAI-compatible API
                    → Stream response into chat panel
```

Converted Markdown files are stored as `{zoteroAttachmentKey}.md` in the cache directory, outside of Zotero's data directory. Reconverting is never needed unless you clear the cache.

## License

MIT
