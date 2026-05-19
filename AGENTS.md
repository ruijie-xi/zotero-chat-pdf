# AGENTS.md - Project Guide for AI Assistants

## Project Summary

ChatPDF is a Zotero 7 plugin that lets users chat with research papers through OpenAI-compatible LLM APIs. PDFs are converted to Markdown with the MinerU cloud API, cached locally, and exposed to the LLM through agent tools.

- GitHub: `ruijie-xi/zotero-chat-pdf`
- Addon ID: `chatpdf@zotero-plugin`
- Addon ref / namespace: `chatpdf`
- Preference prefix: `extensions.zotero.chatpdf`
- Current release line: `0.5.x`

## Tech Stack

- TypeScript bundled by esbuild through `zotero-plugin-scaffold`
- Build target is configured in `zotero-plugin.config.ts` (`firefox140` at the time of writing)
- Raw DOM UI only; no React or frontend framework
- Zotero privileged APIs: `ItemPaneManager`, `MenuManager`, `PreferencePanes`, `IOUtils`, `PathUtils`, `Zotero.Prefs`
- Markdown rendering: `marked`, KaTeX, and XHTML-safe post-processing
- Chat input: TipTap / ProseMirror with XHTML namespace patching

## Build And Release

```bash
npm install
npm run build
npm start
npm run release -- patch --yes
npm run release -- minor --yes
```

- Production build output: `.scaffold/build/chat-pdf.xpi`
- Release workflow: `npm run release -- <patch|minor|major> --yes` updates package files, creates a commit and tag, and pushes. Tags `v*` trigger `.github/workflows/release.yml`.
- `npx tsc --noEmit` is not currently the authoritative check because the repo has Zotero/Firefox ambient type gaps. Prefer `npm run build`.
- Do not commit personal/local files such as `.claude/settings.local.json`.

## Architecture

Core files:

- `src/hooks.ts`: startup/shutdown; registers preferences, context menu, and panel injection.
- `src/modules/chat-panel.ts`: persistent side panel, toolbar, resizing, drag-and-drop, source/session coordination.
- `src/modules/panel-state.ts`: mutable singleton state for session, input editor, streaming, abort controllers, and background streams.
- `src/modules/send-handler.ts`: send orchestration, agent call lifecycle, streaming UI updates, autosave.
- `src/modules/agent-loop.ts`: tool-calling loop, tool execution, streamed final answer, accumulated token usage.
- `src/modules/llm-client.ts`: OpenAI-compatible chat completion client, SSE parsing, tool call accumulation, provider-specific thinking support.
- `src/modules/tools.ts`: `list_sources`, `read_document`, `web_search`, `web_fetch`.
- `src/modules/source-chips.ts`: source chip rendering, MinerU conversion entry point, source removal.
- `src/modules/message-renderer.ts`: message bubbles, reasoning/tool iteration blocks, copy buttons, usage display.
- `src/modules/chat-session.ts`: session sources, message history, agent prompt construction, serialization.
- `src/modules/chat-history.ts`: JSON session persistence under `~/.chatpdf-cache/history/`.
- `src/modules/mineru-client.ts`: MinerU upload/poll/download/extract flow.
- `src/modules/markdown-renderer.ts`: Markdown to XHTML-safe HTML.
- `src/modules/preference-script.ts`: preferences pane interactivity, model profiles, LLM test panel.

## Current LLM Flow

Chat is agent-only. The old classic full-context chat path was removed from the UI flow.

1. `handleSend()` calls `session.buildAgentMessages(userText)` before `addUserMessage()` so the current user message is not double-counted.
2. `runAgentLoop()` calls `chatWithTools()` with tool definitions unless it is forcing a final text answer.
3. Tool calls are executed by `executeTool()` in `tools.ts`.
4. Each step can render reasoning and tool results as iteration blocks.
5. Final content streams into the assistant bubble and is saved with token usage.

Important LLM details:

- DeepSeek thinking controls are prefs: `llmThinkingMode` (`default`, `enabled`, `disabled`) and `llmThinkEffort` (`default`, `high`, `max`).
- Requests can send top-level `thinking` and `reasoning_effort`.
- Streaming requests include `stream_options: { include_usage: true }` so usage can be shown in chat.
- Gemini-compatible endpoints are detected and use `extra_body.google.thinking_config.include_thoughts`; do not blindly send DeepSeek-specific fields to Gemini.
- Token usage appears both in the footer usage bar and on assistant messages when the API returns usage.

## Preferences

Defaults live in `addon/prefs.js`; types live in `typings/prefs.d.ts`; UI lives in `addon/content/preferences.xhtml`; labels live in `addon/locale/en-US/preferences.ftl`.

Current preferences:

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `mineruToken` | string | `""` | MinerU API token |
| `llmApiBase` | string | `https://api.deepseek.com/v1` | LLM API base |
| `llmApiKey` | string | `""` | LLM bearer token |
| `llmModel` | string | `deepseek-chat` | Model name |
| `llmThinkingMode` | string | `default` | DeepSeek thinking mode |
| `llmThinkEffort` | string | `default` | DeepSeek reasoning effort |
| `cacheDir` | string | `""` | Custom cache dir; empty means `~/.chatpdf-cache/` |
| `systemPrompt` | string | `""` | Custom assistant instructions |
| `modelProfiles` | string | `[]` | Saved LLM profile JSON |
| `activeProfile` | string | `""` | Active profile name |
| `agentMaxIterations` | number | `10` | Max tool loop iterations |
| `enableWebTools` | boolean | `false` | Enable web tools |
| `braveSearchApiKey` | string | `""` | Brave Search key; fallback behavior is in `tools.ts` |

When adding a preference, update all four surfaces: `addon/prefs.js`, `typings/prefs.d.ts`, `addon/content/preferences.xhtml`, and `addon/locale/en-US/preferences.ftl`.

## UI And XHTML Rules

- Zotero panels are XHTML. Create elements with `doc.createElementNS("http://www.w3.org/1999/xhtml", tag)` or the `h()` helper.
- Any `innerHTML` assigned inside Zotero UI must be valid XHTML. Use `renderMarkdown()` / `toXhtml()` for Markdown output.
- CSS classes should use the `chatpdf-` prefix.
- Use Zotero theme variables such as `var(--fill-primary)` and `var(--color-accent)`.
- Do not introduce a framework; keep UI changes in raw DOM modules.
- Avoid calling functions from circularly imported modules at module load time.

## File I/O And Runtime Rules

- This runs in Zotero's Firefox chrome context, not Node.js.
- Use `IOUtils`, `PathUtils`, `fetch`, `Components.*`, and `Services.*`.
- Do not use `fs`, `path`, `require`, or browser APIs that are unavailable in Zotero without checking existing patterns.
- Caches live under `getCacheDir()` in `src/utils/cache-dir.ts`.

## Source And Session Model

- `ChatSession.sources` is a session-level source map.
- Source chips show the current session sources and support conversion, stopping conversion, and removal.
- User messages can save source snapshots in `msg.sources` for historical display.
- `list_sources` and `read_document` operate on session sources.
- Removing a source should also consider active conversion abort controllers in `panel-state.ts`.

## Debugging And Verification

- Use `Zotero.debug("[ChatPDF] ...")` or helpers in `src/utils/log.ts`.
- LLM request/response debug files are written by `debug-log.ts` under `~/.chatpdf-cache/debug-logs/`.
- The preferences pane has an LLM API test panel that prints sanitized request and response details.
- After code changes, run `npm run build`.
- Because Zotero itself is not usually available in automation, reason through startup, UI event, persistence, and background streaming flows before finishing.

## Git Hygiene

- Keep unrelated dirty files out of commits.
- Do not commit `.scaffold/build/`, `.claude/settings.local.json`, local cache files, API keys, or scratch TODO edits unless explicitly requested.
- If release is requested, use `npm run release -- <level> --yes` from a clean tree, then restore any intentionally preserved local dirt afterward.
