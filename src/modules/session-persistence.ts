import { getPanelState } from "./panel-state";
import { chatWithTools, getLLMSettings, type ChatMessage } from "./llm-client";
import { resolveModelCapabilities } from "./model-capabilities";
import { loadTokenizer, TokenCounter } from "./token-accounting";
import { ContextBudget } from "./context-budget";
import { logGenerationResult } from "./debug-log";
import { updateUsageBar } from "./usage-view";
import * as ChatHistory from "./chat-history";

/** Auto-save the current session to disk. */
export async function autoSaveSession(root: HTMLElement, force = false): Promise<void> {
  const { session } = getPanelState(root);
  if (!force && !session.hasMessages() && session.getSources().length === 0) return;
  try {
    await ChatHistory.saveSession(session.toSavedSession());
  } catch (err: any) {
    Zotero.debug(`[ChatPDF] autoSaveSession error: ${err.message}`);
  }
}


/** Generate an LLM-based title for a session. */
export async function generateTitle(targetSession: import("./chat-session").ChatSession, root: HTMLElement): Promise<void> {
  const panelState = getPanelState(root);
  const hasUserTitle = () => targetSession.titleSource === "user";
  if (hasUserTitle()) return;
  const history = targetSession.getHistory();
  if (history.length < 2) return;

  const firstUser = history.find(m => m.role === "user");
  const firstAssistant = history.find(m => m.role === "assistant");
  if (!firstUser || !firstAssistant) return;

  try {
    const titleMessages: ChatMessage[] = [
      {
        role: "system",
        content: "Generate a concise, specific title for this conversation. Detect the language of the user's message and reply in that same language. Reply with ONLY the title text \u2014 no quotes, no punctuation at the end, maximum 50 characters.",
      },
      {
        role: "user",
        content: `User: ${firstUser.content.slice(0, 300)}\n\nAssistant: ${firstAssistant.content.slice(0, 300)}`,
      },
    ];

    const settings = { ...getLLMSettings(), sessionId: targetSession.id };
    const capabilities = await resolveModelCapabilities(settings);
    const budget = new ContextBudget(capabilities, new TokenCounter(await loadTokenizer(), settings, capabilities));
    budget.assertFits(titleMessages);
    const titleResult = await chatWithTools(titleMessages, undefined, undefined, undefined, undefined, true, { settings, maxTokens: budget.outputLimit() });
    void logGenerationResult("title", settings.model, budget.requestMetadata(), budget.count(titleMessages), titleResult);
    const title = titleResult.finishReason === "length" ? "" : titleResult.content.trim().slice(0, 50);
    targetSession.addAuxiliaryUsage(titleResult.usage);
    if (!title && !titleResult.usage) return;

    if (title && !hasUserTitle()) {
      targetSession.title = title;
      targetSession.titleSource = "llm";
    }
    await ChatHistory.saveSession(targetSession.toSavedSession());
    if (root.isConnected && panelState.session === targetSession) {
      updateUsageBar(root, targetSession.getTokenUsage());
    }
    if (title) Zotero.debug(`[ChatPDF] Generated title: "${title}"`);

    if (root.isConnected && panelState.showingHistory) {
      const { loadHistoryList } = await import("./history-view");
      for (const win of Zotero.getMainWindows()) {
        const root = (win as any).document?.querySelector("#chatpdf-root") as HTMLElement | null;
        if (root) loadHistoryList(root);
      }
    }
  } catch (err: any) {
    Zotero.debug(`[ChatPDF] generateTitle failed: ${err.message}`);
  }
}
