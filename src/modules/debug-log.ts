import { getCacheDir, ensureDir } from "../utils/cache-dir";
import { getPref } from "../utils/prefs";
import { atomicWriteJson } from "../utils/atomic-storage";
import { ChatMessage } from "./llm-client";

type DebugLogMode = "off" | "metadata" | "full";

function getLogDir(): string {
  return PathUtils.join(getCacheDir(), "debug-logs");
}

function mode(): DebugLogMode {
  const configured = String(getPref("debugLogMode") || "metadata");
  return configured === "off" || configured === "full" ? configured : "metadata";
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function prepareLogDir(): Promise<void> {
  await ensureDir(getLogDir());
  const retentionDays = Math.max(1, Number(getPref("debugLogRetentionDays") || 7));
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const children = await (IOUtils as any).getChildren?.(getLogDir()) || [];
  for (const path of children as string[]) {
    if (!/\b(?:req|res)-.*\.json$/i.test(path)) continue;
    try {
      const stat = await IOUtils.stat(path);
      if (Number((stat as any).lastModified || 0) < cutoff) await IOUtils.remove(path);
    } catch { /* best-effort retention cleanup */ }
  }
}

export async function logLLMRequest(messages: ChatMessage[], model: string): Promise<void> {
  const logMode = mode();
  if (logMode === "off") return;
  try {
    await prepareLogDir();
    const entries = messages.map((message) => ({
      role: message.role,
      contentLength: message.content.length,
      ...(logMode === "full" ? { content: message.content } : {}),
    }));
    await atomicWriteJson(PathUtils.join(getLogDir(), `req-${timestamp()}.json`), {
      timestamp: new Date().toISOString(),
      mode: logMode,
      model,
      messageCount: messages.length,
      totalChars: messages.reduce((sum, message) => sum + message.content.length, 0),
      messages: entries,
    });
  } catch (error: any) {
    Zotero.debug(`[ChatPDF] Failed to write request debug log: ${error.message}`);
  }
}

export async function logLLMResponse(response: string, reasoning?: string): Promise<void> {
  const logMode = mode();
  if (logMode === "off") return;
  try {
    await prepareLogDir();
    await atomicWriteJson(PathUtils.join(getLogDir(), `res-${timestamp()}.json`), {
      timestamp: new Date().toISOString(),
      mode: logMode,
      responseLength: response.length,
      reasoningLength: reasoning?.length || 0,
      ...(logMode === "full" ? { response, reasoning } : {}),
    });
  } catch (error: any) {
    Zotero.debug(`[ChatPDF] Failed to write response debug log: ${error.message}`);
  }
}
