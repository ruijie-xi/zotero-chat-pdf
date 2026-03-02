# ChatPDF for Zotero

Chat with your research papers using LLMs, directly inside Zotero 7.

PDFs are converted to Markdown via the [MinerU](https://mineru.net) API and cached locally. The full text is sent as context to any OpenAI-compatible LLM (DeepSeek, OpenAI, Ollama, etc.) for Q&A, summarization, and analysis.

## Features

- **Chat with PDFs** — ask questions, get answers grounded in your papers
- **Multi-source sessions** — add multiple papers to a single conversation
- **Chat history** — conversations are saved and can be resumed across sessions
- **Streaming responses** — see answers appear in real time
- **Thinking model support** — reasoning tokens from thinking models (e.g. DeepSeek R1) are shown in a collapsible block with a live timer
- **Edit and resend** — click the edit button on any user message to modify and resend it
- **Markdown & math** — responses are rendered with full Markdown and LaTeX math (KaTeX)
- **Smart document truncation** — large documents are proportionally truncated to fit the context limit, with clear UI indicators showing per-document size and total usage
- **Customizable system prompt** — edit the system prompt in preferences with built-in English/Chinese defaults
- **Drag-and-drop** — drag items from the library onto the sources area
- **Right-click menu** — "Add to ChatPDF" on any item with a PDF
- **Any LLM provider** — works with DeepSeek, OpenAI, Ollama, OpenRouter, and more
- **Auto-update** — get new versions automatically through Zotero's update mechanism

## Requirements

- **Zotero 7** (version 7.0 or later)
- A **MinerU API token** — sign up at [mineru.net](https://mineru.net) (free tier available)
- An **API key** for an OpenAI-compatible LLM service

## Installation

### From GitHub Releases (recommended)

1. Go to the [Releases](https://github.com/ruijie-xi/zotero-chat-pdf/releases) page.
2. Download the latest `chat-pdf.xpi` file.
3. In Zotero, go to **Tools > Add-ons**.
4. Click the gear icon and select **Install Add-on From File...**, then choose the downloaded `.xpi` file.
5. Restart Zotero.

### Auto-update

Once installed, Zotero will automatically check for new versions of ChatPDF. When an update is available, Zotero will download and install it on the next restart — no manual action needed.

## Setup

After installing, go to **Edit > Settings > ChatPDF** (or **Zotero > Settings > ChatPDF** on macOS) to configure:

### Required settings

| Setting | Description |
|---------|-------------|
| **MinerU API Token** | Your API token from [mineru.net](https://mineru.net). Needed to convert PDFs to text. |
| **LLM API Key** | API key for your LLM provider (DeepSeek, OpenAI, etc.). |

### Optional settings

| Setting | Default | Description |
|---------|---------|-------------|
| **LLM API Base URL** | `https://api.deepseek.com/v1` | Base URL of the LLM's chat completions endpoint. |
| **Model Name** | `deepseek-chat` | Model identifier to use for chat. |
| **Cache Directory** | `~/.chatpdf-cache` | Where converted Markdown files and chat history are stored. |
| **Max Document Characters** | `300000` | Maximum character budget for document content in the LLM system prompt. When total document text exceeds this limit, each document is proportionally truncated. Source chips show per-document size and a total usage summary. Older conversation messages are also dropped if context is full. |

### Provider examples

| Provider | API Base URL | Model | Notes |
|----------|-------------|-------|-------|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | Default. Good and cheap. |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` | |
| Ollama (local) | `http://localhost:11434/v1` | `llama3` | Free, runs locally. No API key needed (enter any value). |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4` | Aggregator for many models. |

## Usage

### Basic workflow

1. **Select a paper** in Zotero. The ChatPDF panel appears in the right sidebar.
2. The selected paper is automatically added as a source. Click **Convert** to extract its text (takes ~30s).
3. Once the source shows **Ready**, type a question and press **Enter**.
4. The LLM responds based on the paper's content, with streaming output.

### Managing sources

- **Drag and drop** items from the library onto the sources area to add more papers.
- **Right-click** items in the library and select **Add to ChatPDF**.
- Click **Convert all** to batch-convert all pending sources.
- Click **Remove** on a source chip to remove it from the conversation.

### Chat history

- Click **History** in the toolbar to view past conversations.
- Click any conversation to resume it.
- Click **New Chat** to start a fresh session (the current one is saved automatically).
- Conversations are auto-saved after each response.

### Tips

- Click the **expand** button (top-right of the section) for a full-height chat panel.
- Use **Clear chat** to reset the conversation while keeping the same sources.
- Hover over any assistant message and click **Copy** to copy the raw Markdown.
- Click the **edit** button on a user message to modify and resend it — the conversation rolls back to that point.
- Source chips show the character count of each document. If a document is truncated to fit the context limit, the chip turns orange with the included percentage.
- The LLM responds in the same language you use — write in Chinese and it replies in Chinese.

## How it works

```
PDF file  ──▶  MinerU API  ──▶  Markdown text  ──▶  Local cache
                                                         │
User question + document text + chat history  ──▶  LLM API  ──▶  Streamed response
```

1. **PDF conversion**: PDFs are uploaded to MinerU's cloud API, which extracts text, tables, and math into Markdown format. Results are cached locally so each PDF only needs to be converted once.
2. **Chat**: The full document text is embedded in the LLM's system prompt. Your question and conversation history are appended. The LLM responds based on the document content.
3. **Rendering**: Responses are rendered as Markdown with LaTeX math support (via KaTeX).

For a detailed technical reference, see [`docs/llm-workflow.md`](docs/llm-workflow.md).

## Development

### Building from source

```bash
git clone https://github.com/ruijie-xi/zotero-chat-pdf.git
cd zotero-chat-pdf
npm install
npm run build
```

The built plugin is at `.scaffold/build/chat-pdf.xpi`.

### Development with hot-reload

```bash
npm start
```

This launches Zotero with the plugin loaded and watches for file changes.

### Creating a release

Releases are automated via GitHub Actions. To publish a new version:

```bash
# Bump version and create a git tag
npm run release -- patch   # or: minor, major

# Push the tag to trigger the release workflow
git push origin --tags
```

The GitHub Actions workflow will:
1. Build the plugin
2. Create a GitHub Release with the `.xpi` file
3. Update the `update.json` manifest so existing users get the update automatically

### Project structure

```
src/
  modules/
    chat-panel.ts        UI — builds the chat interface, handles user interaction
    chat-session.ts      Session state — message history, sources, context building
    chat-history.ts      Persistence — saves/loads sessions to disk
    llm-client.ts        API client — OpenAI-compatible chat completions with SSE streaming
    mineru-client.ts     PDF conversion — uploads to MinerU, polls for results
    md-cache.ts          Cache layer — stores converted Markdown on disk
    markdown-renderer.ts Rendering — Markdown + KaTeX math to XHTML
addon/
  content/
    chatpdf.css          All styles for the chat panel
    icons/chat.svg       Plugin icon
  manifest.json          Zotero addon manifest
  prefs.js               Default preference values
```

## License

MIT
