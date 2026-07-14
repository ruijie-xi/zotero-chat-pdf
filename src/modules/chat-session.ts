import { ChatMessage, MessageSource, IterationRecord, TokenUsage } from "./llm-client";
import { getPref } from "../utils/prefs";
import { SavedSession } from "./chat-history";
import { makeSourceId, parseSourceId, sourceCacheKey } from "./source-identity";

export interface ToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  durationMs: number;
}

export { IterationRecord } from "./llm-client";

export const DEFAULT_SYSTEM_PROMPT_EN =
  "You are a helpful research assistant. Answer questions based on the following document(s). " +
  "Cite specific sections when possible. If the answer is not in the documents, say so.\n\n" +
  "IMPORTANT formatting rules:\n" +
  "- Always reply in the same language the user uses.\n" +
  "- Use standard Markdown for formatting (headings, lists, bold, code blocks, etc.).\n" +
  "- For mathematical expressions, use LaTeX syntax with dollar sign delimiters: $...$ for inline math and $$...$$ for display math.\n" +
  "  For example: The equation $E = mc^2$ or a display formula:\n" +
  "  $$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$\n";

export const DEFAULT_SYSTEM_PROMPT_CN =
  "你是一个专业的学术研究助手。请根据以下提供的文档内容回答用户的问题。" +
  "尽可能引用文档中的具体章节。如果答案不在文档中，请明确说明。\n\n" +
  "重要的格式规则：\n" +
  "- 始终使用与用户相同的语言回复。\n" +
  "- 使用标准 Markdown 格式（标题、列表、粗体、代码块等）。\n" +
  "- 数学公式请使用 LaTeX 语法，用美元符号分隔：$...$ 表示行内公式，$$...$$ 表示独立公式。\n" +
  "  例如：方程 $E = mc^2$，或独立公式：\n" +
  "  $$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$\n";

export const DEFAULT_NO_DOCS_PROMPT_EN =
  "You are a helpful research assistant. The user has not added any PDF documents yet. Ask them to add documents to chat about. Always reply in the same language the user uses.";

export const DEFAULT_NO_DOCS_PROMPT_CN =
  "你是一个专业的学术研究助手。用户尚未添加任何PDF文档。请提示他们添加文档以开始对话。始终使用与用户相同的语言回复。";

export interface SourceItem {
  id: string; // Stable library-qualified source identity
  key: string; // Zotero attachment key
  libraryID?: number;
  cacheKey: string;
  title: string; // Paper/item title
  parentKey?: string; // Zotero parent bibliographic item key
  markdown?: string; // Loaded markdown content
  status: "pending" | "converting" | "ready" | "error";
  errorMessage?: string;
  contextRatio?: number; // 0-1, how much of the document is included after truncation
}

export class ChatSession {
  id: string;
  title: string = "";
  titleSource: "auto" | "llm" | "user" = "auto";
  createdAt: number;
  updatedAt: number;
  private history: ChatMessage[] = [];
  private sources: Map<string, SourceItem> = new Map();

  constructor() {
    this.id = crypto.randomUUID?.() ?? Zotero.Utilities.randomString(32);
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
  }

  addSource(key: string, title: string, parentKey?: string, libraryID?: number): SourceItem {
    const id = makeSourceId(key, libraryID);
    if (this.sources.has(id)) {
      return this.sources.get(id)!;
    }
    const item: SourceItem = {
      id,
      key,
      libraryID,
      cacheKey: sourceCacheKey({ key, libraryID }),
      title,
      status: "pending",
    };
    if (parentKey) item.parentKey = parentKey;
    this.sources.set(id, item);
    this.updatedAt = Date.now();
    return item;
  }

  removeSource(identifier: string, libraryID?: number): void {
    const source = this.getSource(identifier, libraryID);
    if (source) this.sources.delete(source.id);
    this.updatedAt = Date.now();
  }

  getSource(identifier: string, libraryID?: number): SourceItem | undefined {
    const parsed = parseSourceId(identifier, libraryID);
    const exact = this.sources.get(makeSourceId(parsed.key, parsed.libraryID));
    if (exact) return exact;
    const matches = this.getSources().filter((source) => source.key === parsed.key);
    return matches.length === 1 ? matches[0] : undefined;
  }

  getSources(): SourceItem[] {
    return Array.from(this.sources.values());
  }

  resolveTurnScope(requestedIds: string[]): Set<string> {
    const requested = requestedIds
      .map((identifier) => this.getSource(identifier)?.id)
      .filter((id): id is string => !!id);
    return new Set(requested.length > 0 ? requested : this.getSources().map((source) => source.id));
  }

  snapshotSources(scope: Set<string>): MessageSource[] {
    return this.getSources()
      .filter((source) => scope.has(source.id))
      .map((source) => ({
        id: source.id,
        key: source.key,
        libraryID: source.libraryID,
        title: source.title,
        parentKey: source.parentKey,
      }));
  }

  setSourceReady(identifier: string, markdown: string): void {
    const item = this.getSource(identifier);
    if (item) {
      item.markdown = markdown;
      item.status = "ready";
      item.errorMessage = undefined;
      this.updatedAt = Date.now();
    }
  }

  setSourceStatus(
    identifier: string,
    status: SourceItem["status"],
    errorMessage?: string,
  ): void {
    const item = this.getSource(identifier);
    if (item) {
      item.status = status;
      item.errorMessage = errorMessage;
      this.updatedAt = Date.now();
    }
  }

  getHistory(): ChatMessage[] {
    return [...this.history];
  }

  hasMessages(): boolean {
    return this.history.length > 0;
  }

  addUserMessage(content: string, sources?: MessageSource[]): void {
    const msg: ChatMessage = { role: "user", content, timestamp: Date.now() };
    if (sources?.length) msg.sources = sources;
    this.history.push(msg);
    if (!this.title) {
      this.title = content.slice(0, 50).replace(/\n/g, " ");
    }
    this.updatedAt = Date.now();
  }

  addAssistantMessage(content: string, reasoning?: string, modelLabel?: string, toolHistory?: ToolCallRecord[], iterations?: IterationRecord[], usage?: TokenUsage, status: ChatMessage["status"] = "complete", errorMessage?: string): void {
    const msg: ChatMessage = { role: "assistant", content, timestamp: Date.now() };
    if (reasoning) msg.reasoning = reasoning;
    if (modelLabel) msg.modelLabel = modelLabel;
    if (toolHistory?.length) msg.toolHistory = toolHistory;
    if (iterations?.length) msg.iterations = iterations;
    if (usage) msg.usage = usage;
    msg.status = status;
    if (errorMessage) msg.errorMessage = errorMessage;
    this.history.push(msg);
    this.updatedAt = Date.now();
  }

  /**
   * Collect all unique parent item keys referenced across sources and message sources.
   * For sources without a stored parentKey, attempts a live Zotero lookup so that
   * sessions created before the feature (or with missing parentKey) are still indexed.
   */
  getAllReferencedParentKeys(): string[] {
    const keys = new Set<string>();

    const resolve = (attachmentKey: string, libraryID?: number): string | undefined => {
      // Look up the Zotero item for this attachment key and return its parent's key.
      const libraries = libraryID !== undefined
        ? [{ libraryID }]
        : (Zotero as any).Libraries.getAll();
      for (const lib of libraries) {
        try {
          const att = (Zotero as any).Items.getByLibraryAndKey(lib.libraryID, attachmentKey);
          if (!att) continue;
          if (att.isRegularItem?.()) return att.key;
          if (att.parentItem?.key) return att.parentItem.key;
        } catch { continue; }
      }
      return undefined;
    };

    for (const s of this.sources.values()) {
      if (s.parentKey) {
        keys.add(s.parentKey);
      } else {
        const resolved = resolve(s.key, s.libraryID);
        if (resolved) { s.parentKey = resolved; keys.add(resolved); }
      }
    }
    for (const msg of this.history) {
      if (msg.sources) {
        for (const s of msg.sources) {
          if (s.parentKey) {
            keys.add(s.parentKey);
          } else {
            const resolved = resolve(s.key, s.libraryID);
            if (resolved) keys.add(resolved);
          }
        }
      }
    }
    return Array.from(keys);
  }

  clearHistory(): void {
    this.history = [];
    this.updatedAt = Date.now();
  }

  /** Remove all messages from the given index onwards (inclusive). */
  truncateHistoryAt(index: number): void {
    if (index >= 0 && index < this.history.length) {
      this.history.splice(index);
      this.updatedAt = Date.now();
    }
  }

  getHistoryLength(): number {
    return this.history.length;
  }

  toSavedSession(): SavedSession {
    const sources = this.getSources();
    return {
      schemaVersion: 2,
      id: this.id,
      title: this.title,
      titleSource: this.titleSource,
      sourceKeys: sources.map((s) => s.key),
      sourceTitles: sources.map((s) => s.title),
      sourceParentKeys: sources.map((s) => s.parentKey || ""),
      referencedParentKeys: this.getAllReferencedParentKeys(),
      sources: sources.map((source) => ({
        id: source.id,
        key: source.key,
        libraryID: source.libraryID,
        cacheKey: source.cacheKey,
        title: source.title,
        parentKey: source.parentKey,
        status: source.status === "converting" ? "pending" : source.status,
        errorMessage: source.errorMessage,
      })),
      messages: this.history.map((m) => {
        const saved: SavedSession["messages"][number] = { role: m.role, content: m.content };
        if (m.reasoning) saved.reasoning = m.reasoning;
        if (m.timestamp) saved.timestamp = m.timestamp;
        if (m.sources?.length) saved.sources = m.sources;
        if (m.modelLabel) saved.modelLabel = m.modelLabel;
        if (m.toolHistory?.length) saved.toolHistory = m.toolHistory;
        if (m.iterations?.length) saved.iterations = m.iterations;
        if (m.usage) saved.usage = m.usage;
        if (m.status) saved.status = m.status;
        if (m.errorMessage) saved.errorMessage = m.errorMessage;
        return saved;
      }),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  static fromSavedSession(data: SavedSession): ChatSession {
    const session = new ChatSession();
    session.id = data.id;
    session.title = data.title;
    session.titleSource = data.titleSource || "auto";
    session.createdAt = data.createdAt;

    // Restore messages (including per-message sources and timestamps)
    for (const msg of data.messages) {
      if (msg.role === "user") {
        const m: ChatMessage = { role: "user", content: msg.content };
        if (msg.timestamp) m.timestamp = msg.timestamp;
        if (msg.sources?.length) {
          m.sources = msg.sources.map((source) => ({
            ...source,
            id: source.id || makeSourceId(source.key, source.libraryID),
          }));
        }
        session.history.push(m);
      } else if (msg.role === "assistant") {
        const m: ChatMessage = { role: "assistant", content: msg.content };
        if (msg.reasoning) m.reasoning = msg.reasoning;
        if (msg.timestamp) m.timestamp = msg.timestamp;
        if ((msg as any).modelLabel) m.modelLabel = (msg as any).modelLabel;
        if ((msg as any).toolHistory?.length) m.toolHistory = (msg as any).toolHistory;
        // Restore iterations (new format) or convert from legacy toolHistory
        if ((msg as any).iterations?.length) {
          m.iterations = (msg as any).iterations;
        } else if ((msg as any).toolHistory?.length) {
          // Backward compat: wrap legacy toolHistory into a single iteration
          m.iterations = [{ toolCalls: (msg as any).toolHistory }];
        }
        if ((msg as any).usage) m.usage = (msg as any).usage;
        if (msg.status) m.status = msg.status;
        if (msg.errorMessage) m.errorMessage = msg.errorMessage;
        session.history.push(m);
      }
    }

    // Session-level sources are authoritative. Per-message sources are immutable
    // turn snapshots and must never replace the current session working set.
    if (data.sources?.length) {
      for (const saved of data.sources) {
        const source = session.addSource(saved.key, saved.title, saved.parentKey, saved.libraryID);
        source.status = saved.status === "converting" ? "pending" : saved.status;
        source.errorMessage = saved.errorMessage;
      }
    } else {
      for (let i = 0; i < (data.sourceKeys || []).length; i++) {
        const parentKey = data.sourceParentKeys?.[i] || undefined;
        session.addSource(data.sourceKeys[i], data.sourceTitles[i] || "Untitled", parentKey);
      }
    }

    // Restore updatedAt AFTER addSource loop (which sets updatedAt = Date.now())
    session.updatedAt = data.updatedAt;
    return session;
  }

  buildMessages(userMessage: string): ChatMessage[] {
    const maxChars = Number.POSITIVE_INFINITY;
    const systemPrompt = this.buildSystemPrompt();

    Zotero.debug(`[ChatPDF] buildMessages: systemPrompt=${systemPrompt.length} chars, userMsg=${userMessage.length} chars, maxChars=${maxChars}, historyLen=${this.history.length}`);

    if (systemPrompt.length + userMessage.length > maxChars) {
      Zotero.debug(`[ChatPDF] WARNING: System prompt + user message is very large (${systemPrompt.length + userMessage.length} chars).`);
    }

    const recentHistory = this.truncateHistory(systemPrompt.length, userMessage.length, maxChars,
      (msg) => ({ role: msg.role, content: msg.content }));

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...recentHistory,
      { role: "user", content: userMessage },
    ];

    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    Zotero.debug(`[ChatPDF] Final message array: ${messages.length} messages, ${totalChars} total chars`);
    for (const m of messages) {
      Zotero.debug(`[ChatPDF]   [${m.role}] ${m.content.length} chars — "${m.content.slice(0, 60).replace(/\n/g, "\\n")}..."`);
    }

    return messages;
  }

  /**
   * Shared truncation logic: iterate history backwards, keeping recent messages
   * that fit within the char budget. transformFn maps a ChatMessage to a simplified
   * { role, content } or null to skip.
   */
  private truncateHistory(
    systemLen: number,
    userLen: number,
    maxChars: number,
    transformFn: (msg: ChatMessage) => { role: string; content: string } | null,
  ): ChatMessage[] {
    let totalChars = systemLen + userLen;
    const recentHistory: ChatMessage[] = [];
    let droppedCount = 0;

    for (let i = this.history.length - 1; i >= 0; i--) {
      const msg = this.history[i];
      const transformed = transformFn(msg);
      if (!transformed) continue;

      if (totalChars + transformed.content.length > maxChars) {
        droppedCount = i + 1;
        break;
      }
      totalChars += transformed.content.length;
      recentHistory.unshift(transformed as ChatMessage);
    }

    if (droppedCount > 0) {
      Zotero.debug(`[ChatPDF] Context truncation: dropped ${droppedCount} oldest history messages to fit within ${maxChars} chars`);
    }

    return recentHistory;
  }

  private buildSystemPrompt(): string {
    const allSources = Array.from(this.sources.values());
    const readySources = allSources.filter(
      (s) => s.status === "ready" && s.markdown,
    );

    Zotero.debug(`[ChatPDF] buildSystemPrompt: ${allSources.length} total sources, ${readySources.length} ready`);
    for (const s of allSources) {
      Zotero.debug(`[ChatPDF]   source "${s.title}" status=${s.status} hasMarkdown=${!!s.markdown} mdLen=${s.markdown?.length ?? 0}`);
    }

    if (readySources.length === 0) {
      const customPrompt = (getPref("systemPrompt") as string) || "";
      // Detect language from custom prompt, fall back to EN
      if (customPrompt) {
        return customPrompt.includes("用户") || customPrompt.includes("文档")
          ? DEFAULT_NO_DOCS_PROMPT_CN : DEFAULT_NO_DOCS_PROMPT_EN;
      }
      return DEFAULT_NO_DOCS_PROMPT_EN;
    }

    const maxDocChars = Number.POSITIVE_INFINITY;
    const customPrompt = (getPref("systemPrompt") as string) || "";
    const instructionText = (customPrompt || DEFAULT_SYSTEM_PROMPT_EN) + "\n\n";

    // Calculate budget for document content
    const docBudget = maxDocChars - instructionText.length;
    if (docBudget <= 0) {
      Zotero.debug(`[ChatPDF] WARNING: Instruction text (${instructionText.length}) leaves no room for document content.`);
      for (const source of readySources) {
        source.contextRatio = 0;
      }
      return instructionText;
    }

    // Calculate total raw size of all documents (including delimiters)
    const docSizes: { source: SourceItem; rawLen: number; delimLen: number }[] = [];
    let totalRawLen = 0;
    for (const source of readySources) {
      const delimLen = `--- BEGIN DOCUMENT: ${source.title} ---\n`.length
        + `\n--- END DOCUMENT: ${source.title} ---\n\n`.length;
      const rawLen = source.markdown!.length;
      docSizes.push({ source, rawLen, delimLen });
      totalRawLen += rawLen + delimLen;
    }

    let prompt = instructionText;

    if (totalRawLen <= docBudget) {
      // Everything fits — include all documents in full
      for (const { source } of docSizes) {
        source.contextRatio = 1.0;
        prompt += `--- BEGIN DOCUMENT: ${source.title} ---\n`;
        prompt += source.markdown!;
        prompt += `\n--- END DOCUMENT: ${source.title} ---\n\n`;
      }
    } else {
      // Need to truncate — distribute budget proportionally by raw markdown length
      // First subtract delimiter overhead from budget
      let delimTotal = 0;
      for (const d of docSizes) delimTotal += d.delimLen;
      const contentBudget = docBudget - delimTotal;

      if (contentBudget <= 0) {
        Zotero.debug(`[ChatPDF] WARNING: Document delimiter overhead (${delimTotal}) exceeds docBudget (${docBudget}). No document content included.`);
        for (const { source } of docSizes) {
          source.contextRatio = 0;
        }
        return instructionText;
      }

      // Proportional allocation based on raw markdown length
      const totalContentLen = docSizes.reduce((sum, d) => sum + d.rawLen, 0);

      for (const { source, rawLen } of docSizes) {
        const allocation = Math.floor(contentBudget * (rawLen / totalContentLen));
        let content: string;
        if (rawLen <= allocation) {
          content = source.markdown!;
          source.contextRatio = 1.0;
        } else {
          const truncMarker = `\n\n[... content truncated (${Math.round((allocation / rawLen) * 100)}% of original included) ...]`;
          const availableForContent = allocation - truncMarker.length;
          if (availableForContent <= 0) {
            content = truncMarker;
            source.contextRatio = 0;
          } else {
            content = source.markdown!.slice(0, availableForContent) + truncMarker;
            source.contextRatio = availableForContent / rawLen;
          }
        }
        prompt += `--- BEGIN DOCUMENT: ${source.title} ---\n`;
        prompt += content;
        prompt += `\n--- END DOCUMENT: ${source.title} ---\n\n`;
      }

      Zotero.debug(`[ChatPDF] Document truncation applied: budget=${docBudget}, totalRaw=${totalRawLen}`);
      for (const { source } of docSizes) {
        Zotero.debug(`[ChatPDF]   "${source.title}" contextRatio=${source.contextRatio?.toFixed(2)}`);
      }
    }

    Zotero.debug(`[ChatPDF] System prompt length: ${prompt.length} chars, includes ${readySources.length} documents`);
    return prompt;
  }

  buildAgentMessages(userMessage: string, turnScope?: Set<string>): ChatMessage[] {
    // Full tool outputs remain persisted and visible. Historical requests only
    // carry compact provenance so earlier multi-megabyte reads do not silently
    // overwhelm provider context windows.
    const configuredMax = Number(getPref("contextMaxChars") || 240_000);
    const maxChars = Number.isFinite(configuredMax) ? Math.max(20_000, configuredMax) : 240_000;
    const systemPrompt = this.buildAgentSystemPrompt(turnScope);

    Zotero.debug(`[ChatPDF] buildAgentMessages: systemPrompt=${systemPrompt.length} chars, userMsg=${userMessage.length} chars, maxChars=${maxChars}, historyLen=${this.history.length}`);

    const recentHistory = this.truncateHistory(systemPrompt.length, userMessage.length, maxChars,
      (msg) => {
        if (msg.role === "system") return null; // skip system messages
        if (msg.role !== "user" && msg.role !== "assistant") return null;

        // Preserve what was called without replaying every historical tool byte.
        let content = msg.content;
        if (msg.role === "assistant" && msg.iterations?.length) {
          const allToolCalls = msg.iterations.flatMap(it => it.toolCalls);
          if (allToolCalls.length > 0) {
            const summaryLines = allToolCalls.map(tc => {
              const argsStr = Object.keys(tc.args).length > 0
                ? `(${Object.entries(tc.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")})`
                : "";
              return `- ${tc.toolName}${argsStr}: ${tc.result.length} characters returned`;
            });
            content = `[Previous tool results:\n${summaryLines.join("\n")}\n]\n\n${content}`;
          }
        }
        return { role: msg.role, content };
      });

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...recentHistory,
      { role: "user", content: userMessage },
    ];

    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    Zotero.debug(`[ChatPDF] buildAgentMessages: final ${messages.length} messages, ~${totalChars} total chars`);
    return messages;
  }

  private buildAgentSystemPrompt(turnScope?: Set<string>): string {
    const allSources = Array.from(this.sources.values());
    const sources = turnScope
      ? allSources.filter((source) => turnScope.has(source.id))
      : allSources;
    const customPrompt = (getPref("systemPrompt") as string) || "";

    const baseInstructions = customPrompt ||
      "You are a helpful research assistant. Use the available tools to read document content and answer questions accurately. " +
      "Always reply in the same language the user uses.\n\n" +
      "IMPORTANT formatting rules:\n" +
      "- Use standard Markdown for formatting (headings, lists, bold, code blocks, etc.).\n" +
      "- For mathematical expressions, use LaTeX syntax: $...$ for inline math and $$...$$ for display math.\n";

    const toolInstructions =
      "\n\nYou have access to tools to search Zotero and read documents:\n" +
      "1. Call `list_sources` first to see available documents and their structure (headings, line counts)\n" +
      "2. Call `read_document` with a key and optional line range to read specific content\n" +
      "3. For long documents, use `list_document_chunks`, `search_document`, and `read_document_chunk` to navigate page-based chunks\n" +
      "4. Use `search_zotero_library`, `get_zotero_item`, `list_zotero_collections`, `list_collection_items`, and `get_current_zotero_selection` to find relevant Zotero items when the user asks to find papers or when no useful session sources are available\n" +
      "5. You may use `add_zotero_item_to_session`, `convert_session_source`, or `add_and_convert_zotero_item` when Zotero items/PDFs are relevant and needed to answer; be careful with extreme bulk conversions and warn the user about cost/time when relevant\n" +
      "6. Use web tools (`web_search`, `web_fetch`) if enabled and relevant\n\n" +
      "Strategy:\n" +
      "- For specific questions: use list_sources to find relevant sections via headings, then read_document for those line ranges\n" +
      "- For books or very long PDFs: search first, then read only the matching chunks or line ranges\n" +
      "- For broad questions on short papers: read_document without line range can preview or read the document\n" +
      "- For library discovery: search Zotero metadata first, then add/convert relevant PDFs if needed; use judgment before converting broad sets, whole collections, folders, or many PDFs\n" +
      "- Cite the document title and section when answering\n";

    const sourceList = sources.length > 0
      ? `\n\nThis turn can access ${sources.length} document(s): ${sources.map(s => `"${s.title}" [${s.id}] (${s.status})`).join(", ")}`
      : "\n\nNo documents added yet. If the user asks about papers or documents, search the Zotero library for candidates before saying there are no documents in the chat.";

    const prompt = baseInstructions + toolInstructions + sourceList;
    Zotero.debug(`[ChatPDF] buildAgentSystemPrompt: ${prompt.length} chars, ${sources.length} sources`);
    return prompt;
  }
}
