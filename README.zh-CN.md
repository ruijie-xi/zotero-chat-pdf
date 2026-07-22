# ChatPDF for Zotero

[English](README.md)

ChatPDF 是一款支持 Zotero 7–9 的插件，让你可以通过兼容 OpenAI 接口的大语言模型阅读和讨论研究论文。它在 Zotero 中提供常驻聊天面板，通过 MinerU 转换 PDF，并让助手使用 Zotero 文库中的论文完成研究任务。

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

## 使用要求

- Zotero 7、8 或 9。
- 用于 PDF 转换的 MinerU API Token。
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
| MinerU API Token | PDF 需要转换时使用。 |
| LLM API Base URL | 兼容 OpenAI 接口的服务基础地址。 |
| LLM API Key | 模型服务的 Bearer Token。 |
| Model Name | 模型服务接受的模型标识。 |

默认 API 地址和模型指向 DeepSeek。你可以保存多个模型配置，并通过 **LLM API Test** 检查当前接口和凭据。

其他可选设置包括 MinerU 语言和超时、思考控制、Agent 最大迭代次数、上下文预算、缓存目录、系统提示词、调试日志级别和网络工具。配置 Brave Key 时使用 Brave Search；否则网页搜索回退到 DuckDuckGo。

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

转换错误会标明失败阶段：上传准备、PDF 上传、结果轮询、结果下载或 ZIP 解压。重试时通常会从上次完成的位置继续。

## 网络工具

网络工具默认关闭。启用后，助手可以搜索公共网页，并从 HTTP(S) 页面抓取可读文本。

出于安全考虑，ChatPDF 会阻止内嵌凭据、本机和私有/链路本地网络、不安全重定向、不支持的内容类型、超时请求和过大响应。被拦截的请求会明确报错，不会返回隐藏的部分内容。

## 数据与隐私

默认缓存目录是 `~/.chatpdf-cache/`，可在 ChatPDF 设置中修改。其中包括转换后的 Markdown 和资源、可续跑的转换信息、聊天历史以及可选调试日志。

- 只有请求转换时，PDF 才会发送到 MinerU。
- 对话消息、相关文档内容和工具结果会发送到你配置的 LLM 服务商。
- 只有启用并实际使用网络工具时，查询和目标网页才会发送到搜索服务和对应网站。
- 调试日志默认只记录元数据；**Full** 模式可能包含提示词、论文正文、回答、推理和工具结果。
- API Key 保存在 Zotero 首选项中，请勿把它们放入截图或错误报告。

## 故障排查

**面板没有出现：**确认已在 **工具 → 插件** 中启用 ChatPDF，然后重启 Zotero。

**模型请求失败：**运行 **LLM API Test**，检查基础地址、Key、模型名称以及服务兼容性。

**PDF 转换失败：**根据错误中标明的阶段，检查 MinerU Token、网络/代理和超时设置，然后重试。

**无法读取来源：**确认来源已完成转换，并包含在当前问题 mention 的范围或当前会话中。

**网页搜索或抓取失败：**确认已启用网络工具。本机/私网目标和不安全响应会被有意拦截。

## 支持

- [报告问题](https://github.com/ruijie-xi/zotero-chat-pdf/issues)
- [更新日志](CHANGELOG.zh-CN.md) · [English](CHANGELOG.md)
