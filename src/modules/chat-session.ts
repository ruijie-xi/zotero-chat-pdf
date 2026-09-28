import { DEFAULT_SYSTEM_PROMPT_EN, migrateDefaultPrompt } from "./prompts";
import { ChatMessage, ProviderMessage, Tool, MessageSource, IterationRecord, TokenUsage, sumTokenUsage, getLLMSettings, visibleAssistantText } from "./llm-client";
import { AgentContext, contextFingerprint } from "./agent-context";
import { getPref } from "../utils/prefs";
import { SavedSession } from "./chat-history";
import { makeSourceId, parseSourceId, sourceCacheKey } from "./source-identity";

export interface ToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  durationMs: number;
  contextDelivery?: "complete" | "omitted" | "paged";
  contextMessage?: string;
}

export { IterationRecord } from "./llm-client";

export interface SourceItem {
  kind?: "image";
  id: string; // Stable library-qualified source identity
  key: string; // Zotero attachment key
  libraryID?: number;
  cacheKey: string;
  title: string; // Paper/item title
  parentKey?: string; // Zotero parent bibliographic item key
  markdown?: string; // Loaded markdown content
  status: "pending" | "converting" | "ready" | "error";
  errorMessage?: string;
}

export class ChatSession {
  /** Working view estimate, separate from cumulative provider usage. Recomputed on send. */
  contextStats?: { inputTokens: number; inputLimit: number; source: string };
  id: string;
  title: string = "";
  titleSource: "auto" | "llm" | "user" = "auto";
  createdAt: number;
  updatedAt: number;
  private history: ChatMessage[] = [];
  private sources: Map<string, SourceItem> = new Map();
  private auxiliaryUsage?: TokenUsage;
  private agentContext?: AgentContext;

  getAgentContext(): AgentContext | undefined { return this.agentContext; }
  ensureAgentContext(messages: ProviderMessage[]): AgentContext {
    return this.agentContext ||= AgentContext.create(messages, "", this.history.length);
  }

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
    if (this.agentContext) this.agentContext.data.fingerprint = "";
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

  /** Sum provider-reported usage across every completed, cancelled, or failed turn in this session. */
  getTokenUsage(): TokenUsage | undefined {
    return sumTokenUsage([
      ...this.history.map((message) => message.usage),
      this.auxiliaryUsage,
    ]);
  }

  /** Record usage from a session-owned LLM call that is not an assistant message. */
  addAuxiliaryUsage(usage?: TokenUsage): void {
    if (!usage) return;
    this.auxiliaryUsage = sumTokenUsage([this.auxiliaryUsage, usage]);
    this.updatedAt = Date.now();
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

  addAssistantMessage(content: string, reasoning?: string, modelLabel?: string, iterations?: IterationRecord[], usage?: TokenUsage, status: ChatMessage["status"] = "complete", errorMessage?: string): void {
    const msg: ChatMessage = { role: "assistant", content, timestamp: Date.now() };
    if (reasoning) msg.reasoning = reasoning;
    if (modelLabel) msg.modelLabel = modelLabel;
    if (iterations?.length) msg.iterations = iterations;
    if (usage) msg.usage = usage;
    msg.status = status;
    if (errorMessage) msg.errorMessage = errorMessage;
    this.history.push(msg);
    this.updatedAt = Date.now();
    if (this.agentContext) {
      this.agentContext.recoverPending();
      if (status !== "complete" || this.agentContext.messages.at(-1)?.role !== "assistant") {
        this.agentContext.append({ role: "assistant", content: status === "complete" ? content : `[Turn ${status}] ${content}` });
      }
      this.agentContext.data.historyLength = this.history.length;
    }
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
    this.contextStats = undefined;
    this.history = [];
    this.agentContext = undefined;
    this.updatedAt = Date.now();
  }

  /** Remove all messages from the given index onwards (inclusive). */
  truncateHistoryAt(index: number): void {
    if (index >= 0 && index < this.history.length) {
      this.history.splice(index);
      this.agentContext = undefined;
      this.updatedAt = Date.now();
    }
  }

  getHistoryLength(): number {
    return this.history.length;
  }

  toSavedSession(): SavedSession {
    const sources = this.getSources();
    const savedSession: SavedSession = {
      schemaVersion: 4,
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
        kind: source.kind,
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
        if (m.iterations?.length) saved.iterations = m.iterations;
        if (m.usage) saved.usage = m.usage;
        if (m.status) saved.status = m.status;
        if (m.errorMessage) saved.errorMessage = m.errorMessage;
        return saved;
      }),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
    if (this.auxiliaryUsage) savedSession.auxiliaryUsage = this.auxiliaryUsage;
    if (this.agentContext) {
      savedSession.agentContext = this.agentContext.toJSON();
      // Result bodies are stored once; UI history is hydrated on restore.
      for (const message of savedSession.messages) {
        if (message.iterations) message.iterations = message.iterations.map(iteration => ({ ...iteration,
          toolCalls: iteration.toolCalls.map((call: IterationRecord["toolCalls"][number]) => ({ ...call,
            result: call.resultId ? "" : call.result,
          })),
        }));
      }
    }
    return savedSession;
  }

  static fromSavedSession(data: SavedSession): ChatSession {
    const session = new ChatSession();
    session.id = data.id;
    session.title = data.title;
    session.titleSource = data.titleSource || "auto";
    session.createdAt = data.createdAt;
    session.auxiliaryUsage = data.auxiliaryUsage;
    session.agentContext = data.agentContext ? AgentContext.restore(data.agentContext) : undefined;
    // Older v3 sessions archived narration in provider events but omitted it
    // from display iterations. Recover it by exact stored-result identity.
    const narrationByResult = new Map<string, string>();
    let narratedCalls: string[] = [];
    let narration = "";
    for (const event of session.agentContext?.data.events || []) {
      if (event.role === "assistant") {
        narratedCalls = event.tool_calls?.map(call => call.id) || [];
        narration = typeof event.content === "string" ? event.content : "";
      } else if (event.role === "tool" && event.resultId && event.tool_call_id && narratedCalls.includes(event.tool_call_id)) {
        narrationByResult.set(event.resultId, narration);
      }
    }

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
        // Restore iterations (new format) or convert from legacy toolHistory
        if ((msg as any).iterations?.length) {
          m.iterations = (msg as any).iterations.map((iteration: IterationRecord) => ({ ...iteration,
            content: iteration.content ?? narrationByResult.get(iteration.toolCalls[0]?.resultId || ""),
            toolCalls: iteration.toolCalls.map(call => ({ ...call, result: call.resultId && !call.result
              ? session.agentContext?.data.results.find(result => result.id === call.resultId)?.content || "[Stored result unavailable]"
              : call.result })),
          }));
        } else if ((msg as any).toolHistory?.length) {
          // Backward compat: wrap legacy toolHistory into a single iteration
          m.iterations = [{ reasoning: msg.reasoning, toolCalls: (msg as any).toolHistory }];
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
        source.kind = saved.kind === "image" ? "image" : undefined;
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

  buildAgentMessages(userMessage: string, turnScope?: Set<string>, tools: Tool[] = []): ProviderMessage[] {
    // Resume immutable provider blocks when compatible. Only legacy sessions or
    // explicit configuration changes need a visible-history reconstruction.
    const systemPrompt = this.buildAgentSystemPrompt();
    const currentScope = this.snapshotSources(
      turnScope || new Set(this.getSources().map((source) => source.id)),
    );
    const currentUserContent = this.buildAgentUserContent(userMessage, currentScope);
    const { apiBase, model, thinkingMode, thinkEffort } = getLLMSettings();
    const fingerprint = contextFingerprint({ apiBase, model, thinkingMode, thinkEffort, tools, systemPrompt });
    if (this.agentContext?.data.fingerprint === fingerprint &&
        !this.agentContext.data.requiresRebuild && this.agentContext.data.historyLength === this.history.length) {
      this.agentContext.recoverPending();
      this.agentContext.append({ role: "user", content: currentUserContent });
      this.agentContext.data.historyLength = this.history.length + 1;
      return this.agentContext.messages;
    }

    Zotero.debug(`[ChatPDF] buildAgentMessages: rebuilding working view; historyLen=${this.history.length}`);

    // Legacy/mismatched sessions retain every visible turn. The context manager
    // summarizes complete exchanges instead of silently dropping old requests.
    const recentHistory = this.history.map((msg): ChatMessage | null => {
        if (msg.role === "system") return null; // skip system messages
        if (msg.role !== "user" && msg.role !== "assistant") return null;

        if (msg.role === "user") {
          return {
            role: "user",
            content: this.buildAgentUserContent(msg.content, msg.sources || []),
          };
        }

        // Preserve what was called without replaying every historical tool byte.
        let content = visibleAssistantText(msg.content, msg.iterations);
        if (msg.iterations?.length) {
          const allToolCalls = msg.iterations.flatMap(it => it.toolCalls);
          if (allToolCalls.length > 0) {
            const summaryLines = allToolCalls.map(tc => {
              const argsStr = Object.keys(tc.args).length > 0
                ? `(${Object.entries(tc.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")})`
                : "";
              const delivery = tc.contextDelivery === "omitted"
                ? "; complete result retained in history but omitted from model context"
                : "";
              return `- ${tc.toolName}${argsStr}: ${tc.result.length} characters returned${delivery}`;
            });
            content = `[Previous tool results:\n${summaryLines.join("\n")}\n]\n\n${content}`;
          }
        }
        return { role: msg.role, content };
      }).filter((msg): msg is ChatMessage => msg !== null);

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...recentHistory,
      { role: "user", content: currentUserContent },
    ];

    Zotero.debug(`[ChatPDF] buildAgentMessages: final ${messages.length} messages`);
    if (this.agentContext) {
      if (this.agentContext.data.pending) {
        const pending = this.agentContext.data.pending;
        const receipts = JSON.stringify({ calls: pending.assistant.tool_calls, completed: pending.completed });
        this.agentContext.recoverPending();
        messages.splice(messages.length - 1, 0, { role: "assistant", content:
          `[Interrupted operations: ${receipts}. Completed receipts must not be repeated. Calls without receipts have unknown outcomes; inspect state before retrying.]` });
      }
      if (this.agentContext.data.checkpoints.length || this.agentContext.data.results.some(result => !result.delivered || result.mutating)) {
        messages.splice(messages.length - 1, 0, { role: "assistant", content: this.agentContext.checkpointContent(
          this.agentContext.data.checkpoints.at(-1)?.summary || "Working context reconstructed after a configuration change.") });
      }
      this.agentContext.data.active = [];
      this.agentContext.data.fingerprint = fingerprint;
      this.agentContext.data.historyLength = this.history.length + 1;
      this.agentContext.data.requiresRebuild = false;
      messages.forEach(message => this.agentContext!.append(message));
    } else {
      this.agentContext = AgentContext.create(messages, fingerprint, this.history.length + 1);
    }
    return this.agentContext.messages;
  }

  private buildAgentSystemPrompt(): string {
    const customPrompt = migrateDefaultPrompt((getPref("systemPrompt") as string) || "");

    const baseInstructions = customPrompt || DEFAULT_SYSTEM_PROMPT_EN;

    const toolInstructions =
      "\n\nYou have access to tools to search Zotero and read documents:\n" +
      "1. Call `list_sources` when starting work on a new source or when its structure is unknown; do not repeat it when recent context already provides the needed structure\n" +
      "2. Call `read_document` with a key and optional line range to read specific content\n" +
      "3. For long documents, use `list_document_chunks`, `search_document`, and `read_document_chunk` to navigate page-based chunks\n" +
      "4. Use `search_zotero_library`, `get_zotero_item`, `list_zotero_collections`, `list_collection_items`, and `get_current_zotero_selection` to find relevant Zotero items when the user asks to find papers or when no useful session sources are available\n" +
      "5. You may use `add_zotero_item_to_session`, `convert_session_source`, or `add_and_convert_zotero_item` when Zotero items/PDFs are relevant and needed to answer; be careful with extreme bulk conversions and warn the user about cost/time when relevant\n" +
      "6. Use web tools (`web_search`, `web_fetch`) if enabled and relevant\n\n" +
      "7. Use `list_images` to discover cached PDF figures and `read_image` to actually inspect an image. Standalone image sources need no conversion. Image paths and captions are not visual evidence. Images require a vision-capable model; never claim to see an image that was not delivered. Images from previous turns are not replayed: read them again when visual evidence is needed.\n\n" +
      "Strategy:\n" +
      "- For specific questions: use list_sources to find relevant sections via headings, then read_document for those line ranges\n" +
      "- For books or very long PDFs: search first, then read only the matching chunks or line ranges\n" +
      "- Start document searches with focused terms, about 10-20 max_results, and 1-3 context_lines; broaden only when the first pass is insufficient\n" +
      "- Avoid broad punctuation-only or very short formula searches when a distinctive phrase, symbol name, theorem number, or section is available\n" +
      "- Do not re-read an identical line range unless the prior answer/provenance is insufficient for the current question\n" +
      "- The harness automatically compacts older context when needed and continues the same task. There is no cumulative document reading allowance.\n" +
      "- If a result is paged, use read_tool_result with its result_id and next_start to retrieve exact content. A stored result is not yet inspected evidence. Continue reading as needed; do not ask the user to send another message just because context was compacted.\n" +
      "- For broad questions on short papers: read_document without line range can preview or read the document\n" +
      "- For library discovery: search Zotero metadata first, then add/convert relevant PDFs if needed; use judgment before converting broad sets, whole collections, folders, or many PDFs\n" +
      "- Cite the document title and section when answering\n";

    const prompt = baseInstructions + toolInstructions;
    Zotero.debug(`[ChatPDF] buildAgentSystemPrompt: stable source-independent prefix`);
    return prompt;
  }

  private buildAgentUserContent(userMessage: string, sources: MessageSource[]): string {
    const scope = sources.length > 0
      ? [
          `[ChatPDF turn source scope: ${sources.length} document(s)]`,
          ...sources.map((source) => `- "${source.title}" [${source.id}]`),
          "[/ChatPDF turn source scope]",
        ].join("\n")
      : "[ChatPDF turn source scope: no session documents]";
    return `${scope}\n\n${userMessage}`;
  }
}
