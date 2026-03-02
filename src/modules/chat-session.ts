import { ChatMessage } from "./llm-client";
import { getPref } from "../utils/prefs";
import { SavedSession } from "./chat-history";

export interface SourceItem {
  key: string; // Zotero attachment key
  title: string; // Paper/item title
  markdown?: string; // Loaded markdown content
  status: "pending" | "converting" | "ready" | "error";
  errorMessage?: string;
}

export class ChatSession {
  id: string;
  title: string = "";
  createdAt: number;
  updatedAt: number;
  private history: ChatMessage[] = [];
  private sources: Map<string, SourceItem> = new Map();

  constructor() {
    this.id = crypto.randomUUID?.() ?? Zotero.Utilities.randomString(32);
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
  }

  addSource(key: string, title: string): SourceItem {
    if (this.sources.has(key)) {
      return this.sources.get(key)!;
    }
    const item: SourceItem = { key, title, status: "pending" };
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

  addUserMessage(content: string): void {
    this.history.push({ role: "user", content });
    if (!this.title) {
      this.title = content.slice(0, 50).replace(/\n/g, " ");
    }
    this.updatedAt = Date.now();
  }

  addAssistantMessage(content: string): void {
    this.history.push({ role: "assistant", content });
    this.updatedAt = Date.now();
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
      sourceKeys: sources.map((s) => s.key),
      sourceTitles: sources.map((s) => s.title),
      messages: this.history.map((m) => ({ role: m.role, content: m.content })),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  static fromSavedSession(data: SavedSession): ChatSession {
    const session = new ChatSession();
    session.id = data.id;
    session.title = data.title;
    session.createdAt = data.createdAt;
    session.updatedAt = data.updatedAt;
    for (let i = 0; i < data.sourceKeys.length; i++) {
      session.addSource(data.sourceKeys[i], data.sourceTitles[i] || "Untitled");
    }
    for (const msg of data.messages) {
      if (msg.role === "user") {
        session.history.push({ role: "user", content: msg.content });
      } else if (msg.role === "assistant") {
        session.history.push({ role: "assistant", content: msg.content });
      }
    }
    return session;
  }

  buildMessages(userMessage: string): ChatMessage[] {
    const maxChars = getPref("maxContextChars") || 100000;
    const systemPrompt = this.buildSystemPrompt();

    // Start with system prompt
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
    ];

    // Add history + new message, truncating from the beginning if needed
    const allUserMessages = [...this.history, { role: "user" as const, content: userMessage }];
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

    messages.push(...recentMessages);
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
      return "You are a helpful research assistant. The user has not added any PDF documents yet. Ask them to add documents to chat about. Always reply in the same language the user uses.";
    }

    let prompt =
      "You are a helpful research assistant. Answer questions based on the following document(s). " +
      "Cite specific sections when possible. If the answer is not in the documents, say so.\n\n" +
      "IMPORTANT formatting rules:\n" +
      "- Always reply in the same language the user uses. If the user writes in Chinese, reply in Chinese. If in English, reply in English.\n" +
      "- Use standard Markdown for formatting (headings, lists, bold, code blocks, etc.).\n" +
      "- For mathematical expressions, use LaTeX syntax with dollar sign delimiters: $...$ for inline math and $$...$$ for display math.\n" +
      "  For example: The equation $E = mc^2$ or a display formula:\n" +
      "  $$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$\n\n";

    for (const source of readySources) {
      prompt += `--- BEGIN DOCUMENT: ${source.title} ---\n`;
      prompt += source.markdown!;
      prompt += `\n--- END DOCUMENT: ${source.title} ---\n\n`;
    }

    Zotero.debug(`[ChatPDF] System prompt length: ${prompt.length} chars, includes ${readySources.length} documents`);
    return prompt;
  }
}
