import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/modules/pdf-text", () => ({
  readPdfPage: vi.fn(), readPdfText: vi.fn(), pdfTextStatus: vi.fn(), searchPdfText: vi.fn(),
}));
vi.mock("../src/modules/zotero-items", async original => ({
  ...await original<typeof import("../src/modules/zotero-items")>(), getItemByKey: vi.fn(),
}));
import { readPdfPage, readPdfText } from "../src/modules/pdf-text";
import { getItemByKey } from "../src/modules/zotero-items";
import { executeTool, getToolDefinitions } from "../src/modules/tools";
import { ChatSession } from "../src/modules/chat-session";

const attachment = { key: "PDF12345", libraryID: 1, isPDFAttachment: () => true } as any;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getItemByKey).mockReturnValue(attachment);
  Object.assign(Zotero.Libraries, { get: () => ({ libraryType: "user" }) });
  vi.mocked(readPdfPage).mockResolvedValue({ page: 2, pageCount: 10, dataUrl: "data:image/jpeg;base64,/9j/4A==",
    text: "", width: 2550, height: 3300, effectiveDpi: 300 });
});
function fixture() {
  const session = new ChatSession(), src = session.addSource("PDF12345", "Paper", undefined, 1);
  return { session, src, ctx: { session, turnScope: new Set([src.id]), requestId: "r", windowId: "w", deliverImage: vi.fn() } };
}
describe("original PDF reading tools", () => {
  it("exposes direct reading and removes all conversion and Markdown document tools", () => {
    const names = getToolDefinitions().map(tool => tool.function.name);
    expect(names).toContain("read_pdf_page"); expect(names).toContain("search_pdf_text");
    for (const name of ["convert_session_source", "add_and_convert_zotero_item", "wait_for_conversion",
      "read_document", "list_document_chunks", "read_document_chunk", "search_document"]) expect(names).not.toContain(name);
    const { session } = fixture();
    const prompt = String(session.buildAgentMessages("Explain")[0].content);
    expect(prompt).toContain("Read original PDF pages directly");
    expect(prompt).not.toContain("converted Markdown");
  });
  it("delivers an original page with an exact page citation and explicit dimensions", async () => {
    const { src, ctx } = fixture();
    const output = await executeTool("read_pdf_page", { key: src.id, page: 2 }, ctx);
    const result = JSON.parse(output.split("\n\n[Tool result metadata:")[0]);
    expect(readPdfPage).toHaveBeenCalledWith(attachment, 2, undefined, 300);
    expect(readPdfText).not.toHaveBeenCalled();
    expect(ctx.deliverImage).toHaveBeenCalledWith(expect.objectContaining({ sourceId: src.id, byteLength: 4,
      dataUrl: "data:image/jpeg;base64,/9j/4A==" }));
    expect(result).toMatchObject({ representation: "page-image", pdf_page: 2, page_count: 10, effective_dpi: 300 });
    expect(JSON.stringify(result.citation)).toContain("page=2");
    expect(JSON.stringify(result)).not.toContain("base64");
  });
  it("checks scope before any local read", async () => {
    const { src, ctx } = fixture(); ctx.turnScope.clear();
    expect(await executeTool("read_pdf_page", { key: src.id, page: 2 }, ctx)).toContain("outside this turn");
    expect(readPdfPage).not.toHaveBeenCalled(); expect(ctx.deliverImage).not.toHaveBeenCalled();
  });
  it("does not deliver a page after its source is removed during rendering", async () => {
    const { src, ctx, session } = fixture();
    vi.mocked(readPdfPage).mockImplementationOnce(async () => { session.removeSource(src.id); return {} as any; });
    expect(await executeTool("read_pdf_page", { key: src.id, page: 2 }, ctx)).toContain("outside this turn");
    expect(ctx.deliverImage).not.toHaveBeenCalled();
  });
  it("propagates cancellation after rendering without delivery", async () => {
    const { src, ctx } = fixture(), controller = new AbortController();
    vi.mocked(readPdfPage).mockImplementationOnce(async () => { controller.abort(); return {} as any; });
    await expect(executeTool("read_pdf_page", { key: src.id, page: 2 }, { ...ctx, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(ctx.deliverImage).not.toHaveBeenCalled();
  });
  it.each(["pending", "converting", "error"])("migrates legacy %s sources without resurrecting conversion jobs", status => {
    const { session } = fixture(), saved = session.toSavedSession();
    saved.schemaVersion = 4; saved.sources![0].status = status as any; saved.sources![0].errorMessage = "Old conversion failure";
    const restored = ChatSession.fromSavedSession(saved);
    expect(restored.getSources()[0]).toMatchObject({ status: "ready", errorMessage: undefined });
    expect(restored.toSavedSession().schemaVersion).toBe(5);
  });
});
