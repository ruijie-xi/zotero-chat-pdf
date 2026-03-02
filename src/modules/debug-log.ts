import { getPref } from "../utils/prefs";
import { ChatMessage } from "./llm-client";

function getCacheDir(): string {
  const custom = getPref("cacheDir");
  if (custom) return custom;
  const home = Services.dirsvc.get("Home", Components.interfaces.nsIFile).path;
  return PathUtils.join(home, ".chatpdf-cache");
}

function getLogDir(): string {
  return PathUtils.join(getCacheDir(), "debug-logs");
}

async function ensureLogDir(): Promise<void> {
  const dir = getLogDir();
  if (!(await IOUtils.exists(dir))) {
    await IOUtils.makeDirectory(dir, { createAncestors: true });
  }
}

function timestamp(): string {
  const d = new Date();
  return d.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** Log the full request sent to the LLM, with truncated document content for readability. */
export async function logLLMRequest(messages: ChatMessage[], model: string): Promise<void> {
  try {
    await ensureLogDir();

    const summary: any[] = messages.map((m) => {
      const entry: any = { role: m.role, contentLength: m.content.length };
      if (m.role === "system") {
        // Truncate document bodies in system prompt for readability
        const lines = m.content.split("\n");
        const truncated: string[] = [];
        let inDoc = false;
        for (const line of lines) {
          if (line.startsWith("--- BEGIN DOCUMENT:")) {
            inDoc = true;
            truncated.push(line);
            truncated.push("  [... document content truncated in log ...]");
          } else if (line.startsWith("--- END DOCUMENT:")) {
            inDoc = false;
            truncated.push(line);
          } else if (!inDoc) {
            truncated.push(line);
          }
        }
        entry.contentPreview = truncated.join("\n");
        entry.fullContentLength = m.content.length;
      } else {
        entry.content = m.content;
      }
      return entry;
    });

    const logData = {
      timestamp: new Date().toISOString(),
      model,
      messageCount: messages.length,
      totalChars: messages.reduce((sum, m) => sum + m.content.length, 0),
      messages: summary,
    };

    const filename = `req-${timestamp()}.json`;
    const path = PathUtils.join(getLogDir(), filename);
    const encoder = new TextEncoder();
    await IOUtils.write(path, encoder.encode(JSON.stringify(logData, null, 2)));
    Zotero.debug(`[ChatPDF] Debug log saved: ${path}`);
  } catch (err: any) {
    Zotero.debug(`[ChatPDF] Failed to write debug log: ${err.message}`);
  }
}

/** Log the full LLM response. */
export async function logLLMResponse(response: string, reasoning?: string): Promise<void> {
  try {
    await ensureLogDir();

    const logData: any = {
      timestamp: new Date().toISOString(),
      responseLength: response.length,
      response,
    };
    if (reasoning) {
      logData.reasoningLength = reasoning.length;
      logData.reasoning = reasoning;
    }

    const filename = `res-${timestamp()}.json`;
    const path = PathUtils.join(getLogDir(), filename);
    const encoder = new TextEncoder();
    await IOUtils.write(path, encoder.encode(JSON.stringify(logData, null, 2)));
  } catch (err: any) {
    Zotero.debug(`[ChatPDF] Failed to write response log: ${err.message}`);
  }
}
