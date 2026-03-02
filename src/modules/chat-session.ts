import { ChatMessage } from "./llm-client";
import { getPref } from "../utils/prefs";

export interface SourceItem {
  key: string; // Zotero attachment key
  title: string; // Paper/item title
  markdown?: string; // Loaded markdown content
  status: "pending" | "converting" | "ready" | "error";
  errorMessage?: string;
}

export class ChatSession {
  private history: ChatMessage[] = [];
  private sources: Map<string, SourceItem> = new Map();

  addSource(key: string, title: string): SourceItem {
    if (this.sources.has(key)) {
      return this.sources.get(key)!;
    }
    const item: SourceItem = { key, title, status: "pending" };
    this.sources.set(key, item);
    return item;
  }

  removeSource(key: string): void {
    this.sources.delete(key);
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

  addUserMessage(content: string): void {
    this.history.push({ role: "user", content });
  }

  addAssistantMessage(content: string): void {
    this.history.push({ role: "assistant", content });
  }

  clearHistory(): void {
    this.history = [];
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
      return "You are a helpful research assistant. The user has not added any PDF documents yet. Ask them to add documents to chat about.";
    }

    let prompt =
      "You are a helpful research assistant. Answer questions based on the following document(s). " +
      "Cite specific sections when possible. If the answer is not in the documents, say so.\n\n";

    for (const source of readySources) {
      prompt += `--- BEGIN DOCUMENT: ${source.title} ---\n`;
      prompt += source.markdown!;
      prompt += `\n--- END DOCUMENT: ${source.title} ---\n\n`;
    }

    Zotero.debug(`[ChatPDF] System prompt length: ${prompt.length} chars, includes ${readySources.length} documents`);
    return prompt;
  }
}
