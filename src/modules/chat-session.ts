import { ChatMessage, MessageSource } from "./llm-client";
import { getPref } from "../utils/prefs";
import { SavedSession } from "./chat-history";

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
  key: string; // Zotero attachment key
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

  addSource(key: string, title: string, parentKey?: string): SourceItem {
    if (this.sources.has(key)) {
      return this.sources.get(key)!;
    }
    const item: SourceItem = { key, title, status: "pending" };
    if (parentKey) item.parentKey = parentKey;
    this.sources.set(key, item);
    this.updatedAt = Date.now();
    return item;
  }

  removeSource(key: string): void {
    this.sources.delete(key);
    this.updatedAt = Date.now();
  }

  getSource(key: string): SourceItem | undefined {
    return this.sources.get(key);
  }

  getSources(): SourceItem[] {
    return Array.from(this.sources.values());
  }

  setSourceReady(key: string, markdown: string): void {
    const item = this.sources.get(key);
    if (item) {
      item.markdown = markdown;
      item.status = "ready";
    }
  }

  setSourceStatus(
    key: string,
    status: SourceItem["status"],
    errorMessage?: string,
  ): void {
    const item = this.sources.get(key);
    if (item) {
      item.status = status;
      item.errorMessage = errorMessage;
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

  addAssistantMessage(content: string, reasoning?: string, modelLabel?: string): void {
    const msg: ChatMessage = { role: "assistant", content, timestamp: Date.now() };
    if (reasoning) msg.reasoning = reasoning;
    if (modelLabel) msg.modelLabel = modelLabel;
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

    const resolve = (attachmentKey: string): string | undefined => {
      // Look up the Zotero item for this attachment key and return its parent's key.
      for (const lib of (Zotero as any).Libraries.getAll()) {
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
        const resolved = resolve(s.key);
        if (resolved) { s.parentKey = resolved; keys.add(resolved); }
      }
    }
    for (const msg of this.history) {
      if (msg.sources) {
        for (const s of msg.sources) {
          if (s.parentKey) {
            keys.add(s.parentKey);
          } else {
            const resolved = resolve(s.key);
            if (resolved) keys.add(resolved);
          }
        }
      }
    }
    return Array.from(keys);
  }

  clearHistory(): void {
    this.history = [];
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
      id: this.id,
      title: this.title,
      titleSource: this.titleSource,
      sourceKeys: sources.map((s) => s.key),
      sourceTitles: sources.map((s) => s.title),
      sourceParentKeys: sources.map((s) => s.parentKey || ""),
      referencedParentKeys: this.getAllReferencedParentKeys(),
      messages: this.history.map((m) => {
        const saved: { role: string; content: string; reasoning?: string; timestamp?: number; sources?: MessageSource[]; modelLabel?: string } = { role: m.role, content: m.content };
        if (m.reasoning) saved.reasoning = m.reasoning;
        if (m.timestamp) saved.timestamp = m.timestamp;
        if (m.sources?.length) saved.sources = m.sources;
        if (m.modelLabel) saved.modelLabel = m.modelLabel;
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
        if (msg.sources?.length) m.sources = msg.sources;
        session.history.push(m);
      } else if (msg.role === "assistant") {
        const m: ChatMessage = { role: "assistant", content: msg.content };
        if (msg.reasoning) m.reasoning = msg.reasoning;
        if (msg.timestamp) m.timestamp = msg.timestamp;
        if ((msg as any).modelLabel) m.modelLabel = (msg as any).modelLabel;
        session.history.push(m);
      }
    }

    // Restore session-level sources: prefer last user message's sources (most recent working set),
    // fall back to session-level sourceKeys for backward compat.
    const lastUserMsg = [...session.history].reverse().find(m => m.role === "user");
    if (lastUserMsg?.sources?.length) {
      for (const s of lastUserMsg.sources) {
        session.addSource(s.key, s.title, s.parentKey);
      }
    } else {
      for (let i = 0; i < data.sourceKeys.length; i++) {
        const parentKey = data.sourceParentKeys?.[i] || undefined;
        session.addSource(data.sourceKeys[i], data.sourceTitles[i] || "Untitled", parentKey);
      }
    }

    // Restore updatedAt AFTER addSource loop (which sets updatedAt = Date.now())
    session.updatedAt = data.updatedAt;
    return session;
  }

  buildMessages(userMessage: string): ChatMessage[] {
    const maxChars = getPref("maxDocumentChars") || 300000;
    const systemPrompt = this.buildSystemPrompt();

    // Start with system prompt + current user message (always included)
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
    ];
    const currentMsg: ChatMessage = { role: "user", content: userMessage };

    let totalChars = systemPrompt.length + userMessage.length;

    Zotero.debug(`[ChatPDF] buildMessages: systemPrompt=${systemPrompt.length} chars, userMsg=${userMessage.length} chars, maxChars=${maxChars}, historyLen=${this.history.length}`);

    if (systemPrompt.length + userMessage.length > maxChars) {
      Zotero.debug(`[ChatPDF] WARNING: System prompt (${systemPrompt.length}) + user message (${userMessage.length}) = ${systemPrompt.length + userMessage.length} chars exceeds maxDocumentChars (${maxChars}). No history will be included.`);
    }

    // Add history messages (oldest to newest), only older ones can be dropped
    // Work backwards through history to keep the most recent conversation
    const recentHistory: ChatMessage[] = [];
    let droppedCount = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const msg = this.history[i];
      if (totalChars + msg.content.length > maxChars) {
        droppedCount = i + 1;
        break;
      }
      totalChars += msg.content.length;
      // Strip reasoning from messages sent to the API — it's only for UI display
      recentHistory.unshift({ role: msg.role, content: msg.content });
    }

    if (droppedCount > 0) {
      Zotero.debug(`[ChatPDF] Context truncation: dropped ${droppedCount} oldest history messages to fit within ${maxChars} chars`);
    }

    // Assemble: system prompt → recent history → current user message
    messages.push(...recentHistory);
    messages.push(currentMsg);

    Zotero.debug(`[ChatPDF] Final message array: ${messages.length} messages, ${totalChars} total chars`);
    for (const m of messages) {
      Zotero.debug(`[ChatPDF]   [${m.role}] ${m.content.length} chars — "${m.content.slice(0, 60).replace(/\n/g, "\\n")}..."`);
    }

    return messages;
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

    const maxDocChars = getPref("maxDocumentChars") || 300000;
    const customPrompt = (getPref("systemPrompt") as string) || "";
    const instructionText = (customPrompt || DEFAULT_SYSTEM_PROMPT_EN) + "\n\n";

    // Calculate budget for document content
    const docBudget = maxDocChars - instructionText.length;
    if (docBudget <= 0) {
      Zotero.debug(`[ChatPDF] WARNING: Instruction text (${instructionText.length}) exceeds maxDocumentChars (${maxDocChars}). No documents included.`);
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
      for (const { source, rawLen } of docSizes) {
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
}
