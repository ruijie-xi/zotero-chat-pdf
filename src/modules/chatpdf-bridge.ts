import packageJson from "../../package.json";
import { callChannelTool, cancelToolCall, closeToolSession, listChannelTools, resetToolChannel } from "./tool-channel";

type ServerResponse = [number, string, string];
const PATH = "/chatpdf/v2";
const PROTOCOL_VERSION = 2;
const json = (status: number, body: unknown): ServerResponse => [status, "application/json", JSON.stringify(body)];
const success = (result: unknown) => json(200, { protocol_version: PROTOCOL_VERSION, ok: true, result });
const failure = (status: number, code: string, message: string) => json(status, {
  protocol_version: PROTOCOL_VERSION, ok: false, error: { code, message, retryable: false },
});

async function dispatch(op: string, raw: unknown): Promise<unknown> {
  const params = raw === undefined ? {} : raw;
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("params must be an object");
  const values = params as Record<string, unknown>;
  switch (op) {
    case "status":
      return {
        plugin_version: packageJson.version,
        zotero_version: Zotero.version,
        capabilities: { shared_tools: true, pdf_page_reading: true, pdf_text_search: true, pdf_conversion: false, pdf_markdown_reading: true, pdf_page_inspection: true },
        enabled_tools: listChannelTools().tools.map(tool => tool.name),
      };
    case "tools.list": return listChannelTools();
    case "tools.call": return callChannelTool(values);
    case "tools.cancel": cancelToolCall(values.client_id, values.request_id); return { cancelled: true };
    case "session.close": closeToolSession(values.client_id); return { closed: true };
    default: throw new Error("unsupported operation");
  }
}

class BridgeEndpoint {
  supportedMethods = ["POST"];
  supportedDataTypes = ["application/json"];
  permitBookmarklet = false;

  async init(request: { data?: unknown; headers?: Record<string, string> }): Promise<ServerResponse> {
    if (Object.keys(request.headers || {}).some(key => key.toLowerCase() === "origin")) {
      return failure(403, "origin_not_allowed", "Browser-origin requests cannot call local tools");
    }
    const body = request.data;
    if (!body || typeof body !== "object" || Array.isArray(body)) return failure(400, "invalid_request", "Request body must be a JSON object");
    const envelope = body as Record<string, unknown>;
    if (envelope.protocol_version !== PROTOCOL_VERSION) return failure(400, "protocol_mismatch", "Install matching ChatPDF and Zotero MCP builds (tool protocol 2)");
    if (typeof envelope.op !== "string" || !envelope.op) return failure(400, "invalid_request", "op is required");
    try {
      return success(await dispatch(envelope.op, envelope.params));
    } catch (error: any) {
      const message = String(error?.message || error);
      const safe = /https?:\/\/|file:\/\/|[A-Za-z]:[\\/]|\\\\/.test(message) ? "Bridge operation failed" : message;
      return failure(200, error?.name === "AbortError" ? "cancelled" : "request_failed", safe);
    }
  }
}

let registered: unknown;
export function registerChatPdfBridge(): void {
  const endpoints = (Zotero as any).Server?.Endpoints as Record<string, unknown> | undefined;
  if (!endpoints) throw new Error("Zotero loopback server is unavailable");
  endpoints[PATH] = BridgeEndpoint;
  registered = BridgeEndpoint;
}

export function unregisterChatPdfBridge(): void {
  resetToolChannel();
  const endpoints = (Zotero as any).Server?.Endpoints as Record<string, unknown> | undefined;
  if (endpoints && endpoints[PATH] === registered) delete endpoints[PATH];
  registered = undefined;
}
