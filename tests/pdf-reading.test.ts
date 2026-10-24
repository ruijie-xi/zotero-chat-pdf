import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/modules/pdf-text", () => ({
  readPdfPages: vi.fn(), readPdfText: vi.fn(), pdfTextStatus: vi.fn(), searchPdfText: vi.fn(),
}));
vi.mock("../src/modules/zotero-items", async original => ({
  ...await original<typeof import("../src/modules/zotero-items")>(), getItemByKey: vi.fn(),
}));
vi.mock("../src/modules/pdf-markdown", () => ({ readPdfMarkdown: vi.fn() }));
vi.mock("../src/modules/pdf-locations", () => ({ locatePdfContent: vi.fn(), resolvePdfCitationLocation: vi.fn() }));
import { locatePdfContent } from "../src/modules/pdf-locations";
import { readPdfMarkdown } from "../src/modules/pdf-markdown";
import { readPdfPages, readPdfText } from "../src/modules/pdf-text";
import { getItemByKey } from "../src/modules/zotero-items";
import { executeTool, toolResultSourceIds } from "../src/modules/tools";
import { getToolMetadata } from "../src/modules/tool-registry";
import { ChatSession } from "../src/modules/chat-session";

const attachment = { key: "PDF12345", libraryID: 1, isPDFAttachment: () => true } as any;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getItemByKey).mockReturnValue(attachment);
  Object.assign(Zotero.Libraries, { get: () => ({ libraryType: "user" }) });
  vi.mocked(readPdfPages).mockResolvedValue({ pages: [{ page: 2, pageCount: 10, dataUrl: "data:image/jpeg;base64,/9j/4A==",
    text: "", width: 2550, height: 3300, effectiveDpi: 300 }], pageCount: 10, nextPage: 3 });
});
function fixture() {
  const session = new ChatSession(), src = session.addSource("PDF12345", "Paper", undefined, 1);
  return { session, src, ctx: { session, turnScope: new Set([src.id]), requestId: "r", windowId: "w", deliverImage: vi.fn() } };
}
describe("original PDF reading tools", () => {
  it("exposes a local locator with scoped result memory and region citations", async () => {
    const { src, ctx } = fixture();
    expect(getToolMetadata("locate_pdf_content")).toMatchObject({ readOnly: true, network: false, costly: false });
    expect(toolResultSourceIds("locate_pdf_content", { key: src.id }, ctx)).toEqual([src.id]);
    vi.mocked(locatePdfContent).mockResolvedValueOnce({ revision: "a".repeat(64), matches: [{ pdf_page: 2,
      rects: [[10, 20, 30, 40]], region: { x: 0.1, y: 0.2, width: 0.2, height: 0.1 } }] } as any);
    const output = await executeTool("locate_pdf_content", { key: src.id, query: "Theorem", page: 2 }, { ...ctx, imageInputRejected: true });
    expect(output).toContain("chatpdf_rects"); expect(output).toContain("chatpdf_revision");
    expect(ctx.deliverImage).not.toHaveBeenCalled();
  });
  it("enforces locator scope, source revocation and disabled-tool settings", async () => {
    const { src, ctx, session } = fixture();
    ctx.turnScope.clear();
    expect(await executeTool("locate_pdf_content", { key: src.id, query: "energy" }, ctx)).toContain("outside this turn");
    expect(locatePdfContent).not.toHaveBeenCalled();
    ctx.turnScope.add(src.id);
    vi.mocked(Zotero.Prefs.get).mockImplementation(key => String(key).endsWith("disabledTools") ? '["locate_pdf_content"]' as never : undefined);
    expect(await executeTool("locate_pdf_content", { key: src.id, query: "energy" }, ctx)).toContain("disabled");
    expect(locatePdfContent).not.toHaveBeenCalled();
    vi.mocked(Zotero.Prefs.get).mockReturnValue(undefined);
    vi.mocked(locatePdfContent).mockImplementationOnce(async () => { session.removeSource(src.id); return {} as any; });
    await expect(executeTool("locate_pdf_content", { key: src.id, query: "energy" }, ctx)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("returns Markdown and citations without images, including when the chat model rejected images", async () => {
    const { src, ctx } = fixture();
    vi.mocked(readPdfMarkdown).mockResolvedValueOnce({ page_count: 10, next_page: 3, pages: [
      { pdf_page: 2, status: "transcribed", markdown: "Cached formula $a_b$", cache: "hit", delivery: "cache", duration_ms: 1 },
    ] });
    const output = await executeTool("read_pdf_page", { key: src.id, page: 2 }, { ...ctx, imageInputRejected: true });
    const result = JSON.parse(output.split("\n\n[Tool result metadata:")[0]);
    expect(result).toMatchObject({ representation: "page-markdown", pages: [{ pdf_page: 2, markdown: "Cached formula $a_b$" }] });
    expect(JSON.stringify(result.pages[0].citation)).toContain("page=2");
    expect(result.pages[0]).not.toHaveProperty("duration_ms");
    expect(ctx.deliverImage).not.toHaveBeenCalled(); expect(readPdfPages).not.toHaveBeenCalled();
  });
  it("revokes Markdown delivery after source removal during conversion", async () => {
    const { src, ctx, session } = fixture();
    vi.mocked(readPdfMarkdown).mockImplementationOnce(async () => { session.removeSource(src.id); return { page_count: 10, next_page: null, pages: [] }; });
    await expect(executeTool("read_pdf_page", { key: src.id, page: 2 }, ctx)).rejects.toMatchObject({ name: "AbortError" });
    expect(ctx.deliverImage).not.toHaveBeenCalled();
  });
  it("delivers an original page with an exact page citation and explicit dimensions", async () => {
    const { src, ctx } = fixture();
    const output = await executeTool("inspect_pdf_page", { key: src.id, page: 2 }, ctx);
    const result = JSON.parse(output.split("\n\n[Tool result metadata:")[0]);
    expect(readPdfPages).toHaveBeenCalledWith(attachment, { key: src.id, page: 2 }, undefined, true);
    expect(readPdfText).not.toHaveBeenCalled();
    expect(ctx.deliverImage).toHaveBeenCalledWith(expect.objectContaining({ sourceId: src.id, byteLength: 4,
      dataUrl: "data:image/jpeg;base64,/9j/4A==" }));
    expect(result).toMatchObject({ representation: "page-image", pdf_page: 2, page_count: 10, effective_dpi: 300 });
    expect(JSON.stringify(result.citation)).toContain("page=2");
    expect(JSON.stringify(result)).not.toContain("base64");
  });
  it("checks scope before any local read", async () => {
    const { src, ctx } = fixture(); ctx.turnScope.clear();
    expect(await executeTool("inspect_pdf_page", { key: src.id, page: 2 }, ctx)).toContain("outside this turn");
    expect(readPdfPages).not.toHaveBeenCalled(); expect(ctx.deliverImage).not.toHaveBeenCalled();
  });
  it("delivers a labelled batch in requested order and preserves crop evidence", async () => {
    const { src, ctx } = fixture();
    const region = { x: 0.1, y: 0.2, width: 0.6, height: 0.3 };
    const image = { pageCount: 10, dataUrl: "data:image/jpeg;base64,/9j/4A==", text: "", width: 2550, height: 3300, effectiveDpi: 300 };
    vi.mocked(readPdfPages).mockResolvedValueOnce({ pageCount: 10, nextPage: 5, pages: [{ ...image, page: 4 }, { ...image, page: 2 }] });
    const output = await executeTool("inspect_pdf_page", { key: src.id, pages: [4, 2] }, ctx);
    const result = JSON.parse(output.split("\n\n[Tool result metadata:")[0]);
    expect(result.pages.map((page: any) => page.pdf_page)).toEqual([4, 2]);
    expect(ctx.deliverImage.mock.calls.map(call => call[0].path)).toEqual(["pdf-page-4", "pdf-page-2"]);
    expect(ctx.deliverImage.mock.calls[0][0].label).toContain("PDF page 4");
    vi.mocked(readPdfPages).mockResolvedValueOnce({ pageCount: 10, nextPage: 3, pages: [{ ...image, page: 2, region, effectiveDpi: 600 }] });
    const crop = await executeTool("inspect_pdf_page", { key: src.id, page: 2, dpi: 600, region }, ctx);
    expect(crop).toContain('"representation":"page-region-image"');
    expect(ctx.deliverImage.mock.lastCall?.[0].label).toContain("cropped region");
  });
  it("does not deliver a page after its source is removed during rendering", async () => {
    const { src, ctx, session } = fixture();
    vi.mocked(readPdfPages).mockImplementationOnce(async () => { session.removeSource(src.id); return {} as any; });
    await expect(executeTool("inspect_pdf_page", { key: src.id, page: 2 }, ctx)).rejects.toMatchObject({ name: "AbortError" });
    expect(ctx.deliverImage).not.toHaveBeenCalled();
  });
  it("propagates cancellation after rendering without delivery", async () => {
    const { src, ctx } = fixture(), controller = new AbortController();
    vi.mocked(readPdfPages).mockImplementationOnce(async () => { controller.abort(); return {} as any; });
    await expect(executeTool("inspect_pdf_page", { key: src.id, page: 2 }, { ...ctx, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(ctx.deliverImage).not.toHaveBeenCalled();
  });
  it.each(["pending", "converting", "error"])("migrates legacy %s sources without resurrecting conversion jobs", status => {
    const { session } = fixture(), saved = session.toSavedSession();
    saved.schemaVersion = 4; saved.sources![0].status = status as any; saved.sources![0].errorMessage = "Old conversion failure";
    const restored = ChatSession.fromSavedSession(saved);
    expect(restored.getSources()[0]).toMatchObject({ status: "ready", errorMessage: undefined });
    expect(restored.toSavedSession().schemaVersion).toBe(6);
  });
});
