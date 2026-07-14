# AGENTS.md - Project Guide for AI Assistants

[简体中文](AGENTS.zh-CN.md)

## Project Summary

ChatPDF is a Zotero 7-9 plugin for chatting with research papers through OpenAI-compatible LLM APIs. MinerU converts PDFs to Markdown, the plugin caches results locally, and an agent accesses documents and the Zotero library through tools.

- GitHub: `ruijie-xi/zotero-chat-pdf`
- Add-on ID: `chatpdf@zotero-plugin`
- Namespace: `chatpdf`
- Preference prefix: `extensions.zotero.chatpdf`
- Current release line: `0.8.x`

## Runtime and Stack

- TypeScript bundled by esbuild through `zotero-plugin-scaffold`
- Build target configured in `zotero-plugin.config.ts` (`firefox140`)
- Raw DOM UI only; do not introduce React or another UI framework
- Zotero privileged APIs including `ItemPaneManager`, `MenuManager`, `PreferencePanes`, `IOUtils`, `PathUtils`, and `Zotero.Prefs`
- Markdown rendering with `marked`, KaTeX, XHTML post-processing, and a DOM allowlist sanitizer
- TipTap/ProseMirror editor with XHTML namespace patching

The add-on runs in Zotero's Firefox chrome context, not Node.js. Runtime code must use existing Zotero/Firefox patterns instead of `fs`, `path`, `require`, or unchecked browser-only APIs.

## Build, Test, and Release

```bash
npm ci
npm run verify
npm audit --audit-level=low
npm start
npm run release -- patch --yes
```

`npm run verify` runs type checking, ESLint, Vitest, and the production build. Production output is `.scaffold/build/chat-pdf.xpi`.

The release command updates package files, creates a commit/tag, and pushes. Tags matching `v*` trigger `.github/workflows/release.yml`. Run a release only from a clean tree and only when explicitly requested.

## Architecture

Core modules:

- `src/hooks.ts`: lifecycle, preferences, menus, and window injection.
- `src/modules/chat-panel.ts`: side-panel DOM, resizing, drag/drop, and UI coordination.
- `src/modules/panel-state.ts`: one state object per Zotero window, including session, editor, streams, abort controllers, and cleanup.
- `src/modules/send-handler.ts`: TurnScope resolution, send lifecycle, streaming UI, terminal states, autosave, and titles.
- `src/modules/agent-loop.ts`: LLM/tool iterations, scheduling, callbacks, and accumulated usage.
- `src/modules/llm-client.ts`: OpenAI-compatible requests, SSE parsing, tool-call accumulation, and provider thinking fields.
- `src/modules/tools.ts`: tool definitions, risk metadata, validation, and dispatch.
- `src/modules/safe-web-client.ts`: public HTTP(S), DNS/redirect validation, timeout, MIME, and response limits.
- `src/modules/chat-session.ts`: session sources, per-turn source scope, messages, prompt construction, and serialization.
- `src/modules/chat-history.ts`: atomic session/index persistence, recovery, and deletion tombstones.
- `src/modules/source-identity.ts`: `libraryID:key` source identity and cache keys.
- `src/modules/source-chips.ts`: source UI and user-owned MinerU conversion lifecycle.
- `src/modules/mineru-client.ts`: upload, polling, ZIP download/extraction, chunking, and stage diagnostics.
- `src/modules/md-cache.ts`: atomic Markdown/chunk/manifest cache.
- `src/modules/markdown-renderer.ts`: Markdown/KaTeX to sanitized XHTML-safe HTML.
- `src/modules/debug-log.ts`: metadata/off/full logging and retention.

See `docs/llm-workflow.md` for details.

## LLM and Tool Rules

Chat is agent-only. `handleSend()` builds provider messages before adding the current user message, so the current message is not duplicated.

- One `ToolExecutionContext` carries session, TurnScope, abort signal, request ID, and window ID through a send.
- Read-only tools may run concurrently. If a batch contains a mutating tool, execute the whole batch serially in model order.
- Abort errors must terminate the turn; do not convert them into ordinary model-visible tool errors.
- Keep current tool results complete. Do not add hidden output caps. Make any caller limits, network hard limits, size accounting, and context budgets explicit.
- Preserve provider-specific DeepSeek and Gemini thinking/replay fields only for compatible endpoints.

## Source and Session Rules

- `ChatSession.sources` is the persistent SessionLibrary.
- Stable source identity is `libraryID:attachmentKey`; a bare key is valid only when unique.
- Editor source mentions define TurnScope. With no mentions, the turn uses all session sources.
- Message source snapshots are historical display data, not session restoration authority.
- Document tools must enforce TurnScope.
- Removing a source must abort any conversion owned by that window.
- Failed and cancelled assistant turns are persisted terminal states.
- Clear must persist an empty session; deletion must not be undone by late background saves.

## Preferences

Preference defaults live in `addon/prefs.js`, types in `typings/prefs.d.ts`, UI in `addon/content/preferences.xhtml`, and labels in `addon/locale/en-US/preferences.ftl`. Update all four surfaces together.

| Key | Type | Default |
| --- | --- | --- |
| `mineruToken` | string | `""` |
| `mineruLanguage` | string | `ch` |
| `mineruTimeoutMinutes` | number | `15` |
| `llmApiBase` | string | `https://api.deepseek.com/v1` |
| `llmApiKey` | string | `""` |
| `llmModel` | string | `deepseek-chat` |
| `llmThinkingMode` | string | `default` |
| `llmThinkEffort` | string | `default` |
| `cacheDir` | string | `""` |
| `systemPrompt` | string | `""` |
| `modelProfiles` | string | `[]` |
| `activeProfile` | string | `""` |
| `agentMaxIterations` | number | `10` |
| `contextMaxChars` | number | `240000` |
| `enableWebTools` | boolean | `false` |
| `braveSearchApiKey` | string | `""` |
| `debugLogMode` | string | `metadata` |
| `debugLogRetentionDays` | number | `7` |

## UI, Security, and I/O Rules

- Create XHTML elements with `createElementNS()` or the existing `h()` helper.
- All `innerHTML` content must pass the established rendering/sanitization path.
- Use the `chatpdf-` class prefix and Zotero theme variables.
- Do not weaken the DOM allowlist to make one provider response render.
- Web tools must go through `SafeWebClient`; do not bypass private-address, redirect, MIME, timeout, or response-size checks.
- Use `IOUtils`, `PathUtils`, and `atomicWrite()` for persistent targets. Do not write session/index/cache targets directly.
- Avoid module-load calls across circular imports.

## Debugging and Verification

- Use `Zotero.debug("[ChatPDF] ...")` or helpers in `src/utils/log.ts`.
- Debug files live under `<cacheDir>/debug-logs/`; metadata-only is the default.
- The preferences pane has a sanitized LLM API test panel.
- Add or update unit tests for pure domain/security logic.
- After any code change, run `npm run verify`.
- When Zotero is installed, prefer a real panel smoke test with isolated profile/data/cache directories. Never copy credentials into that profile unless explicitly authorized.

## Documentation and Git Hygiene

- Every maintained Markdown document must have an English and a Simplified Chinese counterpart with cross-links.
- Keep unrelated user changes out of any commit.
- Do not commit `.scaffold/`, local environment/cache/debug files, credentials, or scratch artifacts.
- Do not stage, commit, tag, push, or release unless the user asks.
