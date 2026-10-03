# ChatPDF for Zotero

[English](README.md)

ChatPDF 是一款支持 Zotero 7–10 的插件，让你可以通过兼容 OpenAI 接口的大语言模型阅读和讨论研究论文。它在 Zotero 中提供常驻聊天面板，通过视觉模型或 MinerU 转换 PDF，并让助手使用 Zotero 文库中的论文完成研究任务。

![Zotero 中的 ChatPDF 侧边面板](docs/images/chatpdf-zotero-panel.png)

## 项目定位

ChatPDF 主要为个人使用而开发，并按当前状态分享。由于 Zotero 版本、操作系统、模型服务商、网络/代理设置和个人研究工作流各不相同，本插件可能无法在所有环境中做到完美兼容。

项目源码可供调整。你可以使用 AI coding agents 协助检查错误，并针对自己的环境和工作流微调 ChatPDF，例如适配模型服务、界面行为、转换设置或自定义工具。建议用版本控制保存修改、提前备份缓存，并先在隔离的 Zotero profile 中测试，再用于日常文库。

## 主要功能

- 不离开 Zotero，即可与一篇或多篇 PDF 对话。
- 在对话中搜索 Zotero 文库或记得的标注内容，并添加相关论文。
- 对长 PDF 进行可续跑的分块转换，并在本地保留提取出的图片。
- 流式显示 Markdown、LaTeX、推理过程、工具活动和 token 用量。
- 每个 Zotero 窗口拥有独立的会话、来源列表和后台任务。
- 可选的公共网页搜索与正文抓取。
- 在本地缓存中保存转换结果和聊天历史。
- 与本地 MCP 客户端共享同一份 Markdown，不创建第二套索引或缓存。

## 使用要求

- Zotero 7、8、9 或 10.0。
- 用于 PDF 转换的视觉模型；选择 MinerU 引擎时才需要 MinerU API Token。
- 兼容 OpenAI Chat Completions 接口的模型服务 API Key。

## 安装

1. 从 [GitHub Releases](https://github.com/ruijie-xi/zotero-chat-pdf/releases) 下载 `chat-pdf.xpi`。
2. 在 Zotero 中打开 **工具 → 插件**。
3. 打开齿轮菜单，选择 **从文件安装插件…**。
4. 选择下载的 XPI，然后重启 Zotero。

首次安装仍需使用 XPI 文件。从下一个版本开始，Zotero 可通过 **工具 → 插件 → 齿轮 → 检查更新…** 发现后续 ChatPDF 版本；启用插件自动更新后也可自动安装。设置、已转换文档和聊天历史会继续保存在配置的缓存目录中。

## 配置

Windows/Linux 打开 **编辑 → 设置 → ChatPDF**；macOS 打开 **Zotero → 设置 → ChatPDF**。

至少需要配置：

| 设置 | 说明 |
| --- | --- |
| PDF conversion engine | 默认使用视觉模型，也可选择 MinerU。 |
| Conversion model profile | 可选择单独保存的视觉模型配置；留空使用当前聊天模型。 |
| MinerU API Token | 只在选择 MinerU 时需要。 |
| LLM Provider | DeepSeek、OpenCode Go 或 Custom（原有的 OpenAI 兼容配置）。 |
| LLM API Base URL | 兼容 OpenAI 接口的服务基础地址。 |
| LLM API Key | 模型服务的 Bearer Token。 |
| Model Name | 模型服务接受的模型标识。 |

默认 API 地址和模型指向 DeepSeek；已有设置和模型配置继续按 **Custom（自定义）** 加载。选择内置 provider 会填入对应地址和默认模型，provider 随模型配置一同保存。设置页面打开期间，各 provider 保留独立草稿，首次切换到另一服务时不会沿用原服务的密钥和 token 覆盖值。保存模型配置可在重启后继续使用。通过 **LLM API Test** 可检查当前接口和凭据。

**OpenCode Go** 使用 `https://opencode.ai/zen/go/v1` 和 Go API Key。建议的 DeepSeek 模型包括 `deepseek-v4.1-flash`、`deepseek-v4-pro` 和 `deepseek-v4-flash`，不加 `opencode-go/` 前缀。主对话、压缩和标题请求都会发送 ChatPDF 客户端标识及稳定的会话头；本地 token 计数使用显式的 DeepSeek V4 估算模式。已知 Go DeepSeek 型号在 `/models` 缺少容量时使用内置目录预设，接口元数据和手动覆盖优先；未知型号需要填写容量。[Go 面向编程 Agent](https://opencode.ai/docs/go/#where-can-i-use-it)，接入不代表服务方保证接受论文阅读用途。

其他可选设置包括每次请求页数、并发数、渲染 DPI、页图缓存、请求超时、MinerU 语言和超时、思考控制、Agent 最大迭代次数、上下文预算、缓存目录、系统提示词、调试日志级别和网络工具。配置 Brave Key 时使用 Brave Search；否则网页搜索回退到 DuckDuckGo。

## 快速开始

1. 右键 Zotero 条目并选择 **Add to ChatPDF**，或把条目/阅读器标签拖入面板。
2. 来源卡片提示需要转换时，执行 PDF 转换。
3. 输入问题并发送。助手可以检查文档章节、搜索 Zotero 文库，并在需要时添加或转换相关论文。

快捷键：

- **Enter**：发送。
- **Shift+Enter**：换行。
- **Ctrl+Enter**：先转换当前待处理来源，再发送。

在输入框中 mention 一个或多个来源，可把当前问题限制在这些论文中；不 mention 时，助手可以使用当前会话的全部来源。使用 **Stop** 可以取消回答或正在进行的转换。

## 长 PDF

大型 PDF 会按页码范围转换。已完成的范围会被缓存，因此中断后可以继续，而无需重复已经完成的工作。助手可以搜索转换后的文档并只读取相关分块，不必在每次请求中载入整篇论文。

视觉转换在 Zotero 内使用自带 PDF.js 渲染页图，将图片发送给所选视觉模型，并缓存通过校验的 Markdown 与可选页图。默认每次请求 4 页、2 路并发、150 DPI、180 秒超时，无需安装外部 PDF 工具。页面标记、文本与符号覆盖率、KaTeX 语法检查会拦截不完整输出，再带着校验反馈拆分重试；这些检查不能证明数学符号逐字正确。

**Retry** 复用兼容的已完成分块；**Reconvert** 用当前引擎重新转换，只有完整结果通过校验后才替换旧缓存。已有 MinerU 缓存可继续读取。MinerU 引擎仍保留上传、轮询、下载和解压阶段。详见 [PDF 转换说明](docs/pdf-vision-conversion.md)。

默认让转换模型在同一次响应末尾输出简短的结构化自检结果。插件只应用精确的定点修订，再重新校验，不另发审查请求，也不重复转写全文。`Self-check X/Y` 显示已自检页数。这属于原模型自检，不能代替独立复核；旧缓存需点击 **Reconvert** 才会采用。

点击 PDF 来源下的 **View conversion process**，可查看已校验页数、耗时、并发分块、请求记录、服务商报告的 token 用量，以及实际发送的页图、Markdown 和自检修改前后的片段。实时草稿来自原请求的流式响应，通过校验前会明确标记。查看详情不调用模型；接口拒绝流式请求时，可在设置中关闭 **Live conversion preview**。若只在缓存写入阶段失败，可校验并复用完整检查点，直接重试写入，无需重新渲染或调用模型。

## 本地 MCP 集成

ChatPDF 运行时会在 Zotero 本地服务器注册唯一的精确协议端点 `POST /chatpdf/v1`。本地 MCP 服务可以发现缓存目录和 Zotero 文库映射、读取 Zotero 当前选择、启动/列出/轮询/取消转换，并在 agent 重启后找回已知 job ID；Markdown、分块、manifest 和提取资源仍直接读取面板使用的同一缓存。

面板和 MCP 发起的转换按 `libraryID:attachmentKey` 全局去重。每个面板窗口和 bridge 持有独立 owner，单个面板不会取消其他使用者仍需要的转换；MCP 显式取消仍会终止整个任务。MCP 可以为每个任务选择 pipeline/VLM、语言、OCR、公式/表格提取和有界 MinerU 轮询超时。一个原子 conversion registry 只保存安全恢复点、chunk 进度、时间和错误，不保存 token 或签名上传 URL。Zotero 重启后，安全 checkpoint 会自动续跑；无法安全恢复的任务会明确进入可重试的 `interrupted`。

命中已有 ready 缓存时，ChatPDF 也会为旧 manifest 补充标准 document、Zotero 文库、附件和父论文身份。此过程不会调用 MinerU，也不会修改缓存 Markdown；因此 Zotero 暂时不可用时，后续纯缓存读取仍可保留这些关联。

新结果先写入每个 job 的 staging，只有 Markdown、manifest、chunks 和 assets 全部就绪后才替换标准文档目录。因此失败或强制重转时，旧 ready 文档仍然可读。本地取消会停止 ChatPDF 侧工作，并明确说明已被 MinerU 接受的远端任务是否仍可能继续。MinerU token 始终保留在 Zotero 偏好中，不会出现在 bridge 响应里。该 bridge 依赖 Zotero 的 loopback 服务，不是公网远程 API。

## 网络工具

网络工具默认关闭。启用后，助手可以搜索公共网页，并从 HTTP(S) 页面抓取可读文本。

出于安全考虑，ChatPDF 会阻止内嵌凭据、本机和私有/链路本地网络、不安全重定向、不支持的内容类型、超时请求和过大响应。被拦截的请求会明确报错，不会返回隐藏的部分内容。

## 数据与隐私

默认缓存目录是 `~/.chatpdf-cache/`，可在 ChatPDF 设置中修改。其中包括转换后的 Markdown 和资源、可续跑的转换信息、聊天历史以及可选调试日志。

- PDF 转换会把渲染后的页图发送到所选视觉模型服务商；选择 MinerU 时则发送 PDF 文件。只有请求转换时才会开始，启动时可以续跑此前已请求的活跃任务。
- 对话消息、相关文档内容和工具结果会发送到你配置的 LLM 服务商。
- 只有启用并实际使用网络工具时，查询和目标网页才会发送到搜索服务和对应网站。
- 调试日志默认只记录元数据；**Full** 模式可能包含提示词、论文正文、回答、推理和工具结果。
- API Key 保存在 Zotero 首选项中，请勿把它们放入截图或错误报告。

## 故障排查

**面板没有出现：**确认已在 **工具 → 插件** 中启用 ChatPDF，然后重启 Zotero。

**模型请求失败：**运行 **LLM API Test**，检查基础地址、Key、模型名称以及服务兼容性。

**PDF 转换失败：**根据错误中标明的阶段，检查所选引擎、转换模型的视觉能力与 Token 预算、API Key、网络/代理和超时设置。Retry 继续已保存的分块；修改 PDF 或转换模型后使用 Reconvert。MinerU 需要单独的 Token。

**无法读取来源：**确认来源已完成转换，并包含在当前问题 mention 的范围或当前会话中。

**网页搜索或抓取失败：**确认已启用网络工具。本机/私网目标和不安全响应会被有意拦截。

## 支持

- [报告问题](https://github.com/ruijie-xi/zotero-chat-pdf/issues)
- [更新日志（英文）](CHANGELOG.md)
