import packageJson from "../../package.json";
import { getCacheDir } from "../utils/cache-dir";
import {
  cancelConversion, ConversionOptions, ConversionRequest, ConversionState, ConversionStatus,
  getConversion, listConversions, sanitizeConversionStatus, startConversion,
} from "./conversion-manager";
import { makeSourceId } from "./source-identity";
import { getPdfAttachment, getSelectedZoteroItems } from "./zotero-items";

type ServerResponse = [number, string, string];
const PATH = "/chatpdf/v1";
const PROTOCOL_VERSION = 1;

const json = (status: number, body: unknown): ServerResponse => [status, "application/json", JSON.stringify(body)];
const success = (result: unknown) => json(200, { protocol_version: PROTOCOL_VERSION, ok: true, result });
const failure = (status: number, code: string, message: string, retryable = false) => json(status, {
  protocol_version: PROTOCOL_VERSION, ok: false, error: { code, message, retryable },
});

const libraryType = (library: any): "user" | "group" => library?.libraryType === "group" ? "group" : "user";

function publicLibraryId(library: any): number {
  return libraryType(library) === "group"
    ? Number(library?.groupID ?? library?.libraryID)
    : Number((Zotero as any).Users?.getCurrentUserID?.() ?? 0);
}

function canonicalItemId(item: Zotero.Item): string {
  const library = Zotero.Libraries.get(item.libraryID) as any;
  return `${libraryType(library)}:${publicLibraryId(library)}:${item.key}`;
}

function matchingItems(identifier: string): Zotero.Item[] {
  const value = identifier.replace(/^item:/, "").trim();
  const libraries = Zotero.Libraries.getAll() as any[];
  const canonical = /^(user|group):(\d+):([A-Za-z0-9]+)$/.exec(value);
  if (canonical) return libraries
    .filter((library) => libraryType(library) === canonical[1] && publicLibraryId(library) === Number(canonical[2]))
    .map((library) => Zotero.Items.getByLibraryAndKey(library.libraryID, canonical[3]))
    .filter((item): item is Zotero.Item => !!item);
  const qualified = /^(\d+):([A-Za-z0-9]+)$/.exec(value);
  if (qualified) {
    const item = Zotero.Items.getByLibraryAndKey(Number(qualified[1]), qualified[2]);
    return item ? [item] : [];
  }
  if (!/^[A-Za-z0-9]+$/.test(value)) return [];
  return libraries.map((library) => Zotero.Items.getByLibraryAndKey(library.libraryID, value))
    .filter((item): item is Zotero.Item => !!item);
}

function parseOptions(value: unknown): ConversionOptions | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("options must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.model_version !== undefined && raw.model_version !== "pipeline" && raw.model_version !== "vlm") {
    throw new Error("options.model_version must be pipeline or vlm");
  }
  if (raw.language !== undefined && (typeof raw.language !== "string" || !raw.language.trim() || raw.language.length > 32)) {
    throw new Error("options.language must be a non-empty string of at most 32 characters");
  }
  for (const key of ["is_ocr", "enable_formula", "enable_table"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") throw new Error(`options.${key} must be boolean`);
  }
  const timeout = raw.mineru_poll_timeout_seconds;
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 60 || timeout > 3600)) {
    throw new Error("options.mineru_poll_timeout_seconds must be an integer between 60 and 3600");
  }
  return {
    modelVersion: raw.model_version as "pipeline" | "vlm" | undefined,
    language: typeof raw.language === "string" ? raw.language.trim() : undefined,
    isOcr: raw.is_ocr as boolean | undefined,
    enableFormula: raw.enable_formula as boolean | undefined,
    enableTable: raw.enable_table as boolean | undefined,
    mineruPollTimeoutSeconds: timeout as number | undefined,
  };
}

export function resolveConversionRequest(
  itemId: string, force = false, options?: ConversionOptions,
): ConversionRequest {
  if (!itemId || typeof itemId !== "string") throw new Error("item_id is required");
  const matches = matchingItems(itemId);
  if (matches.length === 0) throw new Error(`Zotero item not found: ${itemId}`);
  if (matches.length > 1) throw new Error(`Zotero key is ambiguous across libraries: ${itemId}`);
  const attachment = getPdfAttachment(matches[0]);
  if (!attachment) throw new Error(`Zotero item has no PDF attachment: ${itemId}`);
  const parent = (attachment as any).parentItem as Zotero.Item | undefined;
  return {
    key: attachment.key, libraryID: attachment.libraryID,
    title: String(parent?.getField("title") || attachment.getField("title") || attachment.key),
    parentItemKey: parent?.key, force, options,
  };
}

function statusPayload(value: ConversionStatus): Record<string, unknown> {
  const status = sanitizeConversionStatus(value);
  return {
    job_id: status.jobId, state: status.state, document_id: status.documentId,
    title: status.title, progress: status.progress, error: status.error, stage: status.stage,
    current_chunk: status.currentChunk, total_chunks: status.totalChunks,
    progress_percent: status.progressPercent, created_at: status.createdAt, updated_at: status.updatedAt,
    retryable: status.retryable, remote_may_continue: status.remoteMayContinue,
    options: status.options && {
      model_version: status.options.modelVersion, language: status.options.language, is_ocr: status.options.isOcr,
      enable_formula: status.options.enableFormula, enable_table: status.options.enableTable,
      mineru_poll_timeout_seconds: status.options.mineruPollTimeoutSeconds,
    },
  };
}

function selection(): Record<string, unknown> {
  const seen = new Set<string>();
  const items = getSelectedZoteroItems().flatMap((value) => {
    const attachment = getPdfAttachment(value);
    const paper = value.isAttachment?.() ? ((value as any).parentItem || value) : value;
    const dedupe = `${paper.libraryID}:${paper.key}:${attachment?.key || ""}`;
    if (seen.has(dedupe)) return [];
    seen.add(dedupe);
    return [{
      item_id: canonicalItemId(paper), key: paper.key,
      title: String(paper.getField?.("title") || attachment?.getField?.("title") || paper.key),
      item_type: String((paper as any).itemType || paper.getField?.("itemType") || ""),
      attachment_key: attachment?.key, document_id: attachment ? makeSourceId(attachment.key, attachment.libraryID) : undefined,
    }];
  });
  return { returned: items.length, items };
}

function params(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("params must be an object");
  return value as Record<string, unknown>;
}

async function dispatch(op: string, rawParams: unknown): Promise<unknown> {
  const input = params(rawParams);
  if (op === "status") return {
    plugin_version: packageJson.version, manifest_version: 3, cache_dir: getCacheDir(),
    libraries: (Zotero.Libraries.getAll() as any[]).map((library) => ({
      internal_library_id: library.libraryID, library_type: libraryType(library),
      library_id: publicLibraryId(library), name: String(library.name || ""),
    })),
  };
  if (op === "selection.get") return selection();
  if (op === "conversion.start") {
    if (typeof input.item_id !== "string" || !input.item_id.trim()) throw new Error("item_id is required");
    if (input.force !== undefined && typeof input.force !== "boolean") throw new Error("force must be boolean");
    return statusPayload(await startConversion(
      resolveConversionRequest(input.item_id, input.force === true, parseOptions(input.options)),
      "bridge",
    ));
  }
  if (op === "conversion.get" || op === "conversion.cancel") {
    if (typeof input.job_id !== "string" || !input.job_id.trim()) throw new Error("job_id is required");
    return statusPayload(op === "conversion.cancel"
      ? await cancelConversion(input.job_id)
      : getConversion(input.job_id));
  }
  if (op === "conversion.list") {
    const state = input.state as ConversionState | undefined;
    if (state && !["pending", "converting", "recovering", "ready", "error", "cancelled", "interrupted"].includes(state)) {
      throw new Error("invalid conversion state");
    }
    const conversions = listConversions(state).map(statusPayload);
    return { returned: conversions.length, total: conversions.length, conversions, complete: true, total_is_exact: true };
  }
  throw new Error("unsupported operation");
}

class BridgeEndpoint {
  supportedMethods = ["POST"];
  supportedDataTypes = ["application/json"];

  async init(request: { data?: unknown }): Promise<ServerResponse> {
    const body = request.data;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return failure(400, "invalid_request", "Request body must be a JSON object");
    }
    const envelope = body as Record<string, unknown>;
    if (envelope.protocol_version !== PROTOCOL_VERSION) return failure(
      400, "protocol_mismatch", "Unsupported ChatPDF bridge protocol version",
    );
    if (typeof envelope.op !== "string" || !envelope.op) return failure(400, "invalid_request", "op is required");
    try {
      return success(await dispatch(envelope.op, envelope.params));
    } catch (error: any) {
      const message = String(error?.message || error);
      const safe = /https?:\/\/|file:\/\/|[A-Za-z]:[\\/]|\\\\/.test(message) ? "Bridge operation failed" : message;
      return failure(200, "request_failed", safe, false);
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
  const endpoints = (Zotero as any).Server?.Endpoints as Record<string, unknown> | undefined;
  if (endpoints && endpoints[PATH] === registered) delete endpoints[PATH];
  registered = undefined;
}
