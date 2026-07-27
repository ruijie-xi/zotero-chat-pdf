import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/cache-dir", () => ({ getCacheDir: () => "D:/cache" }));
vi.mock("../src/modules/conversion-manager", () => ({
  startConversion: vi.fn(async () => ({
    jobId: "job-1", state: "converting", documentId: "1:ATT", title: "Paper", progress: "Uploading",
    error: "", stage: "upload", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z",
    retryable: false, remoteMayContinue: false,
  })),
  getConversion: vi.fn(() => ({
    jobId: "job-1", state: "ready", documentId: "1:ATT", title: "Paper", progress: "Ready",
    error: "", stage: "ready", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:01:00Z",
    retryable: false, remoteMayContinue: false,
  })),
  listConversions: vi.fn(() => []),
  sanitizeConversionStatus: vi.fn((status) => status),
  cancelConversion: vi.fn(async () => ({
    jobId: "job-1", state: "cancelled", documentId: "1:ATT", title: "Paper",
    progress: "Conversion stopped locally", error: "", stage: "cancelled",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:01:00Z",
    retryable: true, remoteMayContinue: false,
  })),
}));

import { registerChatPdfBridge, resolveConversionRequest, unregisterChatPdfBridge } from "../src/modules/chatpdf-bridge";
import { cancelConversion, listConversions, startConversion } from "../src/modules/conversion-manager";

function makeAttachment() {
  const parent = {
    key: "PAPER", libraryID: 1, itemType: "journalArticle", isAttachment: () => false,
    isRegularItem: () => true, getAttachments: () => [],
    getField: (field: string) => field === "title" ? "Paper title" : "",
  };
  return {
    key: "ATT", libraryID: 1, attachmentContentType: "application/pdf", isAttachment: () => true,
    isPDFAttachment: () => true,
    getField: () => "PDF", parentItem: parent,
  };
}

async function call(op: string, params: Record<string, unknown> = {}) {
  const Endpoint = (Zotero as any).Server.Endpoints["/chatpdf/v1"];
  const [status, , text] = await new Endpoint().init({ data: { protocol_version: 1, op, params } });
  return { status, body: JSON.parse(text) };
}

describe("ChatPDF exact-protocol bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(Zotero, { Server: { Endpoints: {} }, Users: { getCurrentUserID: () => 99 } });
    Object.assign(Zotero.Libraries, {
      getAll: vi.fn(() => [{ libraryID: 1, libraryType: "user", name: "My Library" }]),
      get: vi.fn(() => ({ libraryID: 1, libraryType: "user", name: "My Library" })),
    });
    Object.assign(Zotero.Items, { getByLibraryAndKey: vi.fn(() => makeAttachment()) });
  });

  it("resolves a library-qualified PDF without exposing preferences", () => {
    expect(resolveConversionRequest("user:99:ATT")).toEqual({
      key: "ATT", libraryID: 1, title: "Paper title", parentItemKey: "PAPER", force: false, options: undefined,
    });
  });

  it("registers one endpoint and validates the exact protocol", async () => {
    registerChatPdfBridge();
    expect(Object.keys((Zotero as any).Server.Endpoints)).toEqual(["/chatpdf/v1"]);
    const status = await call("status");
    expect(status.body).toMatchObject({
      protocol_version: 1,
      ok: true,
      result: { cache_dir: "D:/cache", manifest_version: 3, libraries: [{ internal_library_id: 1 }] },
    });
    expect(JSON.stringify(status.body)).not.toContain("token");

    const Endpoint = (Zotero as any).Server.Endpoints["/chatpdf/v1"];
    const [, , mismatchText] = await new Endpoint().init({ data: { protocol_version: 0, op: "status" } });
    expect(JSON.parse(mismatchText)).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });

    unregisterChatPdfBridge();
    expect(Object.keys((Zotero as any).Server.Endpoints)).toEqual([]);
  });

  it("preserves selection, options, list, get, and cancellation operations", async () => {
    const selected = makeAttachment();
    (Zotero.getMainWindows as any) = vi.fn(() => [{
      ZoteroPane: { getSelectedItems: () => [selected] }, Zotero_Tabs: { selectedID: "zotero-pane" },
    }]);
    vi.mocked(listConversions).mockReturnValue([{
      jobId: "job-1", state: "converting", documentId: "1:ATT", title: "Paper", progress: "Polling",
      error: "", stage: "poll", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:01:00Z",
      retryable: false, remoteMayContinue: true,
    }]);
    registerChatPdfBridge();

    expect((await call("selection.get")).body.result).toMatchObject({
      returned: 1, items: [{ item_id: "user:99:PAPER", attachment_key: "ATT", document_id: "1:ATT" }],
    });
    const started = await call("conversion.start", {
      item_id: "user:99:ATT",
      force: true,
      options: {
        model_version: "vlm", language: "en", is_ocr: false,
        enable_formula: true, enable_table: false, mineru_poll_timeout_seconds: 600,
      },
    });
    expect(started.body.result).toMatchObject({ job_id: "job-1", document_id: "1:ATT" });
    expect(startConversion).toHaveBeenCalledWith(expect.objectContaining({
      force: true,
      options: {
        modelVersion: "vlm", language: "en", isOcr: false,
        enableFormula: true, enableTable: false, mineruPollTimeoutSeconds: 600,
      },
    }), "bridge");
    expect((await call("conversion.get", { job_id: "job-1" })).body.result.state).toBe("ready");
    expect((await call("conversion.list")).body.result).toMatchObject({
      returned: 1, conversions: [{ job_id: "job-1" }],
    });
    expect((await call("conversion.cancel", { job_id: "job-1" })).body.result.state).toBe("cancelled");
    expect(cancelConversion).toHaveBeenCalledWith("job-1");
  });

  it("returns typed sanitized application errors", async () => {
    registerChatPdfBridge();
    const response = await call("conversion.start", { item_id: 123 });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: false, error: { code: "request_failed", retryable: false } });
    expect(startConversion).not.toHaveBeenCalled();
  });
});
