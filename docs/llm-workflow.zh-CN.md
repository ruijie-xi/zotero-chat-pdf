# ChatPDF LLM 与工具工作流

[English](llm-workflow.md)

本文说明 2026-07-14 架构修复后的 `0.8.0` 工作树。聊天只使用 Agent 流程。

## 运行时边界

ChatPDF 运行在 Zotero 的 Firefox 特权 chrome 上下文中，而不是 Node.js。

- UI 节点必须是合法的 XHTML 或 XUL。
- 本地 I/O 使用 `IOUtils` 和 `PathUtils`。
- 网络请求使用运行时 `fetch` 和代码中已有的 Zotero 专用回退路径。
- 运行时模块不能假设 Node 全局对象或模块可用。
- MinerU 与所配置的 OpenAI 兼容 LLM 供应商是两个相互独立的外部服务。

## 主要组件

| 组件 | 职责 |
| --- | --- |
| `hooks.ts` | 插件启动/关闭、首选项、菜单注册和窗口注入 |
| `chat-panel.ts` | 侧边面板 DOM、工具栏、缩放、拖放和会话/来源协调 |
| `panel-state.ts` | 每个 Zotero 窗口一个 `PanelState`：会话、编辑器、流、中止控制器、轮询和监听器 |
| `send-handler.ts` | 逐轮范围、发送生命周期、流式 UI、终态、自保存和标题生成 |
| `agent-loop.ts` | LLM/工具迭代、安全调度、回调和用量累计 |
| `llm-client.ts` | OpenAI 兼容请求、SSE 解析、工具碎片和供应商思考字段 |
| `tools.ts` | 工具 schema、风险元数据、校验、分派和结果规模说明 |
| `safe-web-client.ts` | 公网 HTTP(S) 校验、重定向检查、超时、MIME 和流式字节上限 |
| `chat-session.ts` | 会话资料库、TurnScope 消息、提示词、历史和 schema v2 序列化 |
| `chat-history.ts` | 原子会话/索引仓库、索引恢复和删除 tombstone |
| `source-identity.ts` | 文库限定的稳定来源 ID 和缓存键 |
| `source-chips.ts` | 来源 UI、用户发起的转换生命周期、停止、移除和延迟加载缓存 |
| `mineru-client.ts` | PDF 分块、上传、轮询、ZIP 下载/解压、进度和阶段错误 |
| `md-cache.ts` | 原子文档/分块/manifest 存储和旧缓存读取 |
| `markdown-renderer.ts` | Markdown/KaTeX 渲染、XHTML 转换和 DOM 白名单清洗 |
| `debug-log.ts` | 元数据/关闭/完整调试日志与保留期清理 |

## 来源模型

每个来源都有稳定 ID：

```text
<libraryID>:<attachmentKey>
```

只有旧的裸 attachment key 能唯一解析时才继续接受。缓存目录使用该稳定 ID 的文件系统安全版本；旧的根目录和裸 key 缓存仍可读取。

系统明确区分两个来源集合：

- **SessionLibrary**：当前聊天会话所附的全部来源。
- **TurnScope**：某一条用户消息授权 Agent 使用的来源。

编辑器同时返回可见文本和 mention ID。用户插入来源 mention 时，这些 ID 构成 TurnScope；没有 mention 时，TurnScope 默认为完整 SessionLibrary。待处理/转换中的拦截只检查本轮范围。

用户消息会保存来源快照，用于历史显示。重新加载会话时，SessionLibrary 始终从序列化的会话来源列表恢复，不使用最后一条消息快照代替。

## 发送生命周期

`handleSend(root)` 按以下顺序执行：

1. 取得当前窗口的 `PanelState`，读取编辑器文本和来源 mention。
2. 拒绝空输入并解析 TurnScope。
3. 只拦截 TurnScope 中处于 pending/converting 的来源。
4. 为这次发送创建 request ID 和唯一 `AbortController`。
5. 在添加当前用户消息前构造供应商消息，防止重复。
6. 将用户消息连同 TurnScope 快照加入会话并立即保存。
7. 注册后台流记录，把 Send 切换为 Stop。
8. 使用包含 session、TurnScope、signal、request ID 和 window ID 的 `ToolExecutionContext` 运行 Agent。
9. 当该会话仍在当前窗口显示时，流式渲染推理、工具迭代、正文和用量。
10. 保存 completed、failed 或 cancelled 助手终态。
11. 首次对话可另行在后台生成标题。
12. 恢复控件并释放流所有权。

切换会话不会取消后台回答。关闭窗口或禁用插件会中止该窗口拥有的任务，并销毁 TipTap 编辑器和监听器。

## 提示词与上下文预算

供应商消息顺序为：

```text
系统指令
先前用户/助手历史
当前用户消息
```

已转换 PDF 不会嵌入系统提示词；模型通过工具读取。

当前轮工具结果会完整返回并保存在助手迭代记录中。旧的助手迭代进入后续提示词时，完整工具正文会替换为来源记录，其中包含工具名、结果大小以及稳定的 request/call 标识。这样既不对工具结果做隐藏截断，也避免提示词随历史无限放大。

`contextMaxChars` 默认 240,000。若总字符数超过预算，提示词构造会在调用供应商前给出明确的本地错误。

## Agent 循环与工具调度

`runAgentLoop()` 读取 `agentMaxIterations`，调用模型并重复执行，直到得到最终文本或达到迭代上限。

每个工具调用批次都会：

- 解析并校验参数；
- 使用工具元数据标记只读、修改会话、联网和高成本操作；
- 纯只读批次可以并行；
- 只要包含修改操作，整批就按模型给出的顺序串行；
- 工具消息按原始调用顺序追加；
- 中止异常离开工具层并结束本轮，而不是变成发给模型的错误字符串。

供应商回传会在存在时保留 DeepSeek `reasoning_content` 和 Gemini thought-signature 字段。

## 工具族

### 文档工具

- `list_sources`
- `read_document`
- `list_document_chunks`
- `read_document_chunk`
- `search_document`

这些工具接受稳定来源 ID，并拒绝 TurnScope 之外的来源。全文读取和搜索会显示准确字符数和粗略 token 估算。

### Zotero 工具

- `search_zotero_library`
- `search_zotero_annotations`
- `get_zotero_item`
- `list_zotero_collections`
- `list_collection_items`
- `get_current_zotero_selection`
- `add_zotero_item_to_session`
- `convert_session_source`
- `add_and_convert_zotero_item`

查找 schema 支持 `library_id`。`search_zotero_annotations` 在省略 `query` 时列出标注；提供查询时搜索高亮正文、批注、标签及对应论文元数据，并返回 annotation、附件和论文条目的 key。列表/搜索工具不施加隐藏结果上限；调用者可选限制仍是显式参数。

### 网络工具

启用后，`web_search` 优先使用已配置的 Brave，否则使用 DuckDuckGo HTML 回退。`web_fetch` 经过 `SafeWebClient`：

1. 只接受 HTTP(S) URL；
2. 拒绝凭据、localhost、回环、私网、link-local、组播、保留地址和云元数据地址；
3. 请求前检查 DNS 结果；
4. 手工处理重定向，并重新验证每个目标；
5. 设置请求超时和重定向次数；
6. 只接受受支持的文本 MIME；
7. 流式读取正文，常规上限 5 MiB，硬上限 25 MiB。

过大或不安全的响应会明确失败，绝不会静默截短。

## 取消

请求信号贯穿：

- 流式和非流式 LLM 请求；
- 所有 Agent 工具处理器；
- 安全网络请求和正文读取；
- MinerU 上传 URL、PDF 上传、轮询 delay、结果下载和解压；
- 这些操作之后的会话修改和 UI 回调。

直接点击来源卡片发起的转换拥有独立控制器，由该卡片和窗口负责；移除来源会中止该控制器。

## MinerU 转换与缓存

可配置默认值为语言 `ch`、超时 15 分钟。120 页以内 PDF 使用单个任务；更长 PDF 使用可续跑的 25 页分块。每个成功分块都会在下一块开始前保存。

```text
<cacheDir>/
  documents/<library-qualified-cache-key>/
    document.md
    manifest.json
    chunks/<index>.md
    attachments/full/...
    attachments/chunk-<index>/...
  history/
  debug-logs/
```

文档、分块、manifest、会话和历史索引都使用临时文件加原子替换。错误保留阶段信息，因此可以区分上传、轮询、ZIP 下载和解压失败。

## 渲染与调试隐私

助手 Markdown 由 `marked` 解析，数学公式通过 KaTeX 占位符渲染，HTML 再规范化为 XHTML。进入 `innerHTML` 前，DOM 白名单会删除禁止元素、事件/style 属性、危险协议、命名空间攻击面和特权本地图片 URL。

调试日志模式：

- `metadata`（默认）：记录 request/session 关联、大小、模型、耗时、状态和用量，不记录提示词/回答正文；
- `off`：不写请求文件；
- `full`：显式诊断模式，可能包含敏感的提示词、回答、推理和工具结果。

旧日志按 `debugLogRetentionDays` 清理，默认保留 7 天。

## 验证

运行完整本地门禁：

```bash
npm run verify
npm audit --audit-level=low
```

隔离 Zotero 烟雾测试用于验证临时插件安装和真实面板行为，不访问用户日常 profile 或凭据。供应商和 MinerU 网络行为仍需要用户明确授权的带凭据测试。
