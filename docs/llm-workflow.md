# ChatPDF LLM Workflow — Developer Reference

## Architecture Overview

```
User types message
       │
       ▼
  chat-panel.ts          (UI layer — captures input, renders streaming output)
       │
       ▼
  chat-session.ts        (Session layer — builds the message array with system prompt)
       │
       ▼
  llm-client.ts          (API layer — sends OpenAI-compatible HTTP request, handles SSE streaming)
       │
       ▼
  OpenAI-compatible API  (default: DeepSeek)
```

There are two separate external APIs used by the plugin:
- **MinerU API** (`mineru-client.ts`) — converts PDF files to Markdown text
- **LLM API** (`llm-client.ts`) — chat completion using the converted Markdown as context

---

## Step-by-Step Workflow

### 1. PDF → Markdown Conversion (before any chat happens)

When a source paper is added and the user clicks "Convert" (or "Convert all"):

1. `chat-panel.ts:convertSource()` is called
2. It reads the PDF file from disk via `IOUtils.read(pdfPath)`
3. It calls `mineru-client.ts:convertPdf()` which:
   - **Uploads** the PDF to MinerU's cloud API (`PUT` to a presigned URL)
   - **Polls** `GET /api/v4/extract-results/batch/{batch_id}` every 3 seconds (timeout: 6 min)
   - **Downloads** the result ZIP when state is `"done"`
   - **Extracts** the `.md` file from the ZIP using `nsIZipReader`
4. The resulting Markdown string is cached locally via `md-cache.ts` at `~/.chatpdf-cache/{attachmentKey}.md`
5. The source's status becomes `"ready"` and its `.markdown` field is populated

**Result:** Each PDF source becomes a plain Markdown string stored in `session.sources`.

### 2. User Sends a Message

When the user presses Enter or clicks Send, `chat-panel.ts:handleSend()` runs:

```
handleSend(root)
  ├── 1. Read and clear the textarea
  ├── 2. Append user message bubble to the UI
  ├── 3. session.buildMessages(userText)     ← builds the full message array
  ├── 4. session.addUserMessage(userText)     ← adds to history AFTER building
  ├── 5. Create assistant bubble with thinking animation
  ├── 6. llmChat(messages, streamCallback)   ← calls the LLM API
  ├── 7. Stream chunks into the bubble (80ms throttle)
  ├── 8. session.addAssistantMessage(fullResponse)
  ├── 9. refreshSourceChips()                ← update context usage indicators
  └── 10. autoSaveSession()                  ← persist to disk
```

**Important ordering:** `buildMessages()` is called BEFORE `addUserMessage()`. This is because `buildMessages()` includes the current user message in its output. If we added to history first, the message would appear twice (once from history, once as the new message).

### 3. Message Array Construction — `session.buildMessages(userMessage)`

This is the core of how context is assembled for the LLM. It returns a `ChatMessage[]` array.

#### 3a. System Prompt (`buildSystemPrompt()`)

The system prompt is always the **first message** in the array (role: `"system"`).

**If no sources are ready (no PDFs converted):**
```
You are a helpful research assistant. The user has not added any PDF documents yet.
Ask them to add documents to chat about. Always reply in the same language the user uses.
```

**If sources are ready (one or more PDFs converted):**
```
You are a helpful research assistant. Answer questions based on the following document(s).
Cite specific sections when possible. If the answer is not in the documents, say so.

IMPORTANT formatting rules:
- Always reply in the same language the user uses. If the user writes in Chinese, reply in Chinese. If in English, reply in English.
- Use standard Markdown for formatting (headings, lists, bold, code blocks, etc.).
- For mathematical expressions, use LaTeX syntax with dollar sign delimiters: $...$ for inline math and $$...$$ for display math.
  For example: The equation $E = mc^2$ or a display formula:
  $$\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}$$

--- BEGIN DOCUMENT: {Paper Title 1} ---
{Markdown content of paper 1 — possibly truncated}
--- END DOCUMENT: {Paper Title 1} ---

--- BEGIN DOCUMENT: {Paper Title 2} ---
{Markdown content of paper 2 — possibly truncated}
--- END DOCUMENT: {Paper Title 2} ---
```

**Document truncation (`maxDocumentChars` budget):**

The `buildSystemPrompt()` method enforces a character budget for document content:

1. `docBudget = maxDocumentChars - instructionText.length`
2. Delimiter overhead (BEGIN/END markers) is subtracted from the budget
3. The remaining content budget is distributed **proportionally** across sources by their raw markdown length
4. Documents that fit within their allocation are included in full (`contextRatio = 1.0`)
5. Documents that exceed their allocation are truncated with a marker:
   `[... content truncated (X% of original included) ...]`
6. Each source's `contextRatio` field (0–1) is set, and the UI displays this

**Key points about the system prompt:**
- All document content is embedded directly in the system prompt as plain text
- Documents are wrapped with `--- BEGIN DOCUMENT: {title} ---` / `--- END DOCUMENT: {title} ---` delimiters
- Only sources with `status === "ready"` AND a non-empty `.markdown` field are included
- The prompt instructs the LLM to respond in the user's language and use Markdown + LaTeX formatting
- Large documents are truncated to fit within `maxDocumentChars` rather than silently omitted

#### 3b. Conversation History (context window management)

After the system prompt, the method adds conversation history + the new user message:

```typescript
const allUserMessages = [...this.history, { role: "user", content: userMessage }];
let totalChars = systemPrompt.length;

// Work backwards to keep most recent messages
const recentMessages: ChatMessage[] = [];
for (let i = allUserMessages.length - 1; i >= 0; i--) {
  const msg = allUserMessages[i];
  if (totalChars + msg.content.length > maxChars) {
    break;
  }
  totalChars += msg.content.length;
  recentMessages.unshift(msg);
}
```

**How the truncation works:**
1. Start with `totalChars = systemPrompt.length` (already capped by `maxDocumentChars`)
2. Iterate through all messages **from newest to oldest**
3. Keep adding messages as long as `totalChars` stays under `maxDocumentChars` (default: 300,000)
4. Once a message would exceed the limit, **stop** — all older messages are dropped
5. The kept messages are re-ordered chronologically

**This means:**
- The system prompt (with truncated documents) is always included and counts toward the limit
- The most recent messages are always preserved
- Older conversation turns are silently dropped when the context gets too long
- Document truncation ensures there is always room for conversation history

#### 3c. Final Message Array Structure

```
[
  { role: "system",    content: "<system prompt with documents (possibly truncated)>" },
  { role: "user",      content: "<older user message (if fits)>" },
  { role: "assistant", content: "<older assistant reply (if fits)>" },
  ...
  { role: "user",      content: "<current user message>" }
]
```

### 4. LLM API Call — `llm-client.ts:chat()`

#### Configuration (from plugin preferences)

| Preference        | Default                         | Description                          |
|-------------------|---------------------------------|--------------------------------------|
| `llmApiBase`      | `https://api.deepseek.com/v1`  | Base URL of the API                  |
| `llmApiKey`       | (empty — required)              | Bearer token                         |
| `llmModel`        | `deepseek-chat`                 | Model identifier                     |
| `maxDocumentChars`| `300000`                        | Max chars for documents + context    |

#### HTTP Request

```
POST {llmApiBase}/chat/completions
Headers:
  Content-Type: application/json
  Authorization: Bearer {llmApiKey}

Body:
{
  "model": "{llmModel}",
  "messages": [ ...the message array from buildMessages()... ],
  "stream": true
}
```

**Notes:**
- The endpoint is always `/chat/completions` (OpenAI-compatible format)
- Trailing slashes on `llmApiBase` are stripped
- Streaming is enabled whenever a `StreamCallback` is provided (always true in the UI flow)
- **No other parameters** are sent — no `temperature`, `max_tokens`, `top_p`, etc. The model's defaults are used

#### Streaming (SSE)

When `stream: true`, the API returns Server-Sent Events:

```
data: {"choices":[{"delta":{"content":"Hello"}}]}
data: {"choices":[{"delta":{"content":" world"}}]}
data: [DONE]
```

The client:
1. Reads the response body as a stream via `res.body.getReader()`
2. Decodes chunks with `TextDecoder` using `{ stream: true }` for multi-byte safety
3. Splits on newlines, processes `data: ` prefixed lines
4. Extracts `choices[0].delta.content` from each JSON chunk
5. Calls `onStream(content, false)` for each chunk
6. Calls `onStream("", true)` when `[DONE]` is received
7. Returns the full accumulated text

**Non-streaming fallback:** If no callback is provided, a regular JSON response is read and `choices[0].message.content` is returned. (This path is not currently used by the UI.)

### 5. Streaming Render — back in `chat-panel.ts`

The stream callback in `handleSend()` throttles rendering to every 80ms:

```typescript
const fullResponse = await llmChat(messages, (chunk, done) => {
  if (!done) {
    fullText += chunk;
    if (!renderTimer) {
      renderTimer = win.setTimeout(() => {
        renderTimer = null;
        setBubbleHtml(fullText);  // re-render entire accumulated text
        messagesEl.scrollTop = messagesEl.scrollHeight;  // auto-scroll
      }, 80);
    }
  } else {
    // Final render
    clearTimeout(renderTimer);
    setBubbleHtml(fullText);
  }
});
```

The `setBubbleHtml()` function calls `renderMarkdown()` which:
1. Extracts `$$...$$` and `$...$` math blocks, renders them to HTML via KaTeX
2. Renders the remaining text as GFM Markdown via `marked`
3. Re-inserts the KaTeX HTML
4. Sanitizes (strips `<script>`, `on*` handlers, `javascript:` URLs)
5. Converts HTML5 void elements to XHTML self-closing form (`<br>` → `<br/>`)

If rendering throws (e.g. malformed XHTML), it falls back to `bubble.textContent = text`.

### 6. After the Response

1. `session.addAssistantMessage(fullResponse)` — stores in history
2. `refreshSourceChips(root)` — updates context usage indicators on source chips
3. `autoSaveSession()` — persists the session to `~/.chatpdf-cache/history/{id}.json`
4. UI is re-enabled (textarea + send button)

---

## Data Flow Diagram

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Zotero PDF  │────▶│  MinerU API  │────▶│  MD Cache    │
│  (on disk)   │     │  (cloud)     │     │  (~/.cache/) │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                 │
                                    session.sources[key].markdown
                                                 │
┌─────────────┐     ┌──────────────┐     ┌──────▼──────┐
│  User Input  │────▶│ ChatSession  │────▶│  LLM API    │
│  (textarea)  │     │ buildMessages│     │  (DeepSeek) │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                 │
                                          SSE stream
                                                 │
                                         ┌───────▼──────┐
                                         │ renderMarkdown│
                                         │ (marked+katex)│
                                         └───────┬──────┘
                                                 │
                                         ┌───────▼──────┐
                                         │  Chat bubble  │
                                         │  (innerHTML)  │
                                         └──────────────┘
```

---

## Configuration Reference

All preferences are stored under the plugin's pref prefix (accessed via `getPref(key)`):

| Key               | Type   | Default                        | Used by          |
|-------------------|--------|--------------------------------|------------------|
| `mineruToken`     | string | `""`                           | mineru-client.ts |
| `llmApiBase`      | string | `"https://api.deepseek.com/v1"`| llm-client.ts    |
| `llmApiKey`       | string | `""`                           | llm-client.ts    |
| `llmModel`        | string | `"deepseek-chat"`              | llm-client.ts    |
| `cacheDir`        | string | `""` (→ `~/.chatpdf-cache/`)   | md-cache.ts      |
| `maxDocumentChars`| number | `300000`                       | chat-session.ts  |
| `systemPrompt`    | string | `""`                           | chat-session.ts  |

---

## API Compatibility

The LLM client uses the **OpenAI Chat Completions** format. Any API that implements this interface will work:
- OpenAI (`https://api.openai.com/v1`)
- DeepSeek (`https://api.deepseek.com/v1`) — default
- Ollama (`http://localhost:11434/v1`)
- OpenRouter, Together, Groq, Azure OpenAI, etc.

Just change `llmApiBase`, `llmApiKey`, and `llmModel` in preferences.

---

## Potential Improvement Areas

1. **No token counting** — context truncation uses raw character count, not tokens. A 300K char limit is ~75-150K tokens depending on language. Could use a tokenizer for accuracy.
2. **No parameters exposed** — temperature, max_tokens, top_p, etc. are not configurable. The model's defaults are used.
3. **Entire documents in system prompt** — every API call re-sends all document text. For very large documents, this is expensive. RAG (retrieval-augmented generation) with chunking + embeddings would reduce cost.
4. **No error retry** — if the API call fails, the error is shown once and the user must retry manually.
5. **No abort/cancel** — once a request starts streaming, there's no way to cancel it from the UI.
6. **Single system prompt** — all documents go into one system message. Some models handle multiple system messages or different prompt structures better.
