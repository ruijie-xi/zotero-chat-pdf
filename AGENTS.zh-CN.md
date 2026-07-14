# AGENTS.md - AI 助手项目指南

[English](AGENTS.md)

## 项目概述

ChatPDF 是一款支持 Zotero 7-9 的插件，通过兼容 OpenAI 的 LLM API 与研究论文对话。MinerU 将 PDF 转为 Markdown，插件在本地缓存结果，Agent 再通过工具访问文档和 Zotero 文库。

- GitHub：`ruijie-xi/zotero-chat-pdf`
- 插件 ID：`chatpdf@zotero-plugin`
- 命名空间：`chatpdf`
- 首选项前缀：`extensions.zotero.chatpdf`
- 当前发布线：`0.8.x`

## 运行时与技术栈

- TypeScript，由 `zotero-plugin-scaffold` 通过 esbuild 打包
- 构建目标配置在 `zotero-plugin.config.ts`（`firefox140`）
- 只使用原生 DOM UI；不要引入 React 或其他 UI 框架
- Zotero 特权 API，包括 `ItemPaneManager`、`MenuManager`、`PreferencePanes`、`IOUtils`、`PathUtils` 和 `Zotero.Prefs`
- Markdown 使用 `marked`、KaTeX、XHTML 后处理和 DOM 白名单清洗
- TipTap/ProseMirror 编辑器，并带 XHTML 命名空间补丁

插件运行在 Zotero 的 Firefox chrome 特权上下文，而不是 Node.js。运行时代码必须沿用现有 Zotero/Firefox 模式，不要使用 `fs`、`path`、`require` 或未经确认的浏览器专用 API。

## 构建、测试与发布

```bash
npm ci
npm run verify
npm audit --audit-level=low
npm start
npm run release -- patch --yes
```

`npm run verify` 依次执行类型检查、ESLint、Vitest 和生产构建。生产产物为 `.scaffold/build/chat-pdf.xpi`。

发布命令会更新包文件、创建提交和标签并推送；`v*` 标签触发 `.github/workflows/release.yml`。只有用户明确要求时，才可在干净工作树中发布。

## 架构

核心模块：

- `src/hooks.ts`：生命周期、首选项、菜单和窗口注入。
- `src/modules/chat-panel.ts`：侧边面板 DOM、缩放、拖放和 UI 协调。
- `src/modules/panel-state.ts`：每个 Zotero 窗口一个状态对象，包含会话、编辑器、流、中止控制器和清理。
- `src/modules/send-handler.ts`：TurnScope、发送生命周期、流式 UI、终态、自保存和标题。
- `src/modules/agent-loop.ts`：LLM/工具迭代、调度、回调和用量累计。
- `src/modules/llm-client.ts`：OpenAI 兼容请求、SSE、工具调用碎片和供应商思考字段。
- `src/modules/tools.ts`：工具定义、风险元数据、校验和分派。
- `src/modules/safe-web-client.ts`：公网 HTTP(S)、DNS/重定向校验、超时、MIME 和响应上限。
- `src/modules/chat-session.ts`：会话来源、逐轮来源范围、消息、提示词和序列化。
- `src/modules/chat-history.ts`：原子会话/索引持久化、恢复和删除 tombstone。
- `src/modules/source-identity.ts`：`libraryID:key` 来源身份和缓存键。
- `src/modules/source-chips.ts`：来源 UI 和用户拥有的 MinerU 转换生命周期。
- `src/modules/mineru-client.ts`：上传、轮询、ZIP 下载/解压、分块和阶段诊断。
- `src/modules/md-cache.ts`：原子 Markdown/分块/manifest 缓存。
- `src/modules/markdown-renderer.ts`：Markdown/KaTeX 转为清洗后的 XHTML 安全 HTML。
- `src/modules/debug-log.ts`：元数据/关闭/完整日志和保留期。

细节见 `docs/llm-workflow.zh-CN.md`。

## LLM 与工具规则

聊天只使用 Agent 流程。`handleSend()` 在加入当前用户消息前构造供应商消息，避免当前消息重复。

- 一次发送使用一个 `ToolExecutionContext` 贯穿 session、TurnScope、abort signal、request ID 和 window ID。
- 只读工具可以并行；若一个批次包含修改工具，整批按模型顺序串行。
- 中止异常必须终止本轮，不能转换为普通的模型可见工具错误。
- 当前工具结果保持完整，不要增加隐藏输出上限。调用者限制、网络硬上限、大小统计和上下文预算必须显式。
- 只对兼容端点保留 DeepSeek/Gemini 的思考和回传字段。

## 来源与会话规则

- `ChatSession.sources` 是持久的 SessionLibrary。
- 稳定来源身份为 `libraryID:attachmentKey`；裸 key 只有唯一时才有效。
- 编辑器来源 mention 定义 TurnScope；无 mention 时使用会话全部来源。
- 消息来源快照只用于历史显示，不是会话恢复权威。
- 文档工具必须执行 TurnScope 权限检查。
- 移除来源时必须中止该窗口拥有的转换。
- 失败和取消的助手轮次是持久化终态。
- 清空必须保存空会话；删除不能被迟到的后台保存复活。

## 首选项

默认值在 `addon/prefs.js`，类型在 `typings/prefs.d.ts`，UI 在 `addon/content/preferences.xhtml`，标签在 `addon/locale/en-US/preferences.ftl`。新增或修改首选项时必须同步四处。

| 键 | 类型 | 默认值 |
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

## UI、安全与 I/O 规则

- 使用 `createElementNS()` 或现有 `h()` 辅助函数创建 XHTML 元素。
- 所有 `innerHTML` 内容都必须经过既有渲染/清洗路径。
- CSS 类名使用 `chatpdf-` 前缀和 Zotero 主题变量。
- 不要为了显示某个供应商响应而削弱 DOM 白名单。
- 网络工具必须通过 `SafeWebClient`；不能绕过私有地址、重定向、MIME、超时和响应大小检查。
- 持久目标使用 `IOUtils`、`PathUtils` 和 `atomicWrite()`；不要直接写会话、索引或缓存目标文件。
- 避免在模块加载阶段跨循环导入调用函数。

## 调试与验证

- 使用 `Zotero.debug("[ChatPDF] ...")` 或 `src/utils/log.ts` 的辅助函数。
- 调试文件位于 `<cacheDir>/debug-logs/`，默认只记录元数据。
- 首选项窗格包含脱敏的 LLM API 测试面板。
- 纯领域和安全逻辑变更必须补充或更新单元测试。
- 修改代码后运行 `npm run verify`。
- 本机存在 Zotero 时，优先使用隔离的 profile/data/cache 做真实面板烟雾测试；未经明确授权不得复制凭据。

## 文档与 Git 卫生

- 每份维护中的 Markdown 文档都必须有英文和简体中文版本，并相互链接。
- 不要把无关的用户改动混入提交。
- 不要提交 `.scaffold/`、本地环境/缓存/调试文件、凭据或临时产物。
- 除非用户明确要求，否则不要暂存、提交、打标签、推送或发布。
