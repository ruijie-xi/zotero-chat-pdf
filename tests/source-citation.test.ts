import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/modules/pdf-locations", () => ({ resolvePdfCitationLocation: vi.fn() }));
import { resolvePdfCitationLocation } from "../src/modules/pdf-locations";
import { installCitationLinks, parsePdfCitation, pdfCitation } from "../src/modules/source-citation";

const item = { id: 7, key: "PDF12345", libraryID: 1, isPDFAttachment: () => true } as any;
const open = vi.fn(async () => {});
beforeEach(() => {
  vi.clearAllMocks(); document.body.innerHTML = "";
  Object.assign(Zotero, { Reader: { open }, alert: vi.fn() });
  Object.assign(Zotero.Libraries, { get: () => ({ libraryType: "user" }) });
  vi.mocked(Zotero.Libraries.getAll).mockReturnValue([{ libraryID: 1, libraryType: "user" }] as any);
  vi.mocked(Zotero.Items.getByLibraryAndKey).mockReturnValue(item);
  vi.mocked(resolvePdfCitationLocation).mockResolvedValue({ position: { pageIndex: 1, rects: [[10, 20, 30, 40]] } });
});
function click(href: string) {
  const root = document.createElement("div"), anchor = document.createElement("a"), span = document.createElement("span");
  anchor.setAttribute("href", href); anchor.append(span); root.append(anchor); document.body.append(root); installCitationLinks(root);
  span.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}
describe("PDF citation links", () => {
  it("round trips page, group, revision and multi-line region citations", () => {
    const rects: [number, number, number, number][] = [[10, 20, 30, 40], [10, 50, 60, 70]], revision = "a".repeat(64);
    expect(parsePdfCitation(pdfCitation(item, 2, { rects, revision })!)).toMatchObject({ key: item.key, page: 2, rects, revision });
    Object.assign(Zotero.Libraries, { get: () => ({ libraryType: "group", groupID: 42 }) });
    expect(parsePdfCitation(pdfCitation(item, 2)!)).toMatchObject({ groupID: 42, page: 2 });
  });
  it.each(["page=0", "page=NaN", "page=9007199254740992", "page=2&page=3", "page=2&extra=1",
    "page=2&chatpdf_rects=null", "page=2&chatpdf_rects=%5B%5B0,0,1e999,2%5D%5D", "page=2&chatpdf_region=%7B%7D",
    "chatpdf_rects=%5B%5B0,0,1,1%5D%5D", "page=2&chatpdf_revision=bad"])("rejects malformed parameters: %s", params => {
    expect(() => parsePdfCitation(`zotero://open-pdf/library/items/PDF12345?${params}`)).toThrow();
  });
  it("keeps page-only links fast and navigates nested link clicks to the returned position", async () => {
    click(pdfCitation(item, 2)!);
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(7, { pageIndex: 1 }));
    expect(resolvePdfCitationLocation).not.toHaveBeenCalled();
    click(pdfCitation(item, 2, { rects: [[10, 20, 30, 40]] })!);
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(7, { position: { pageIndex: 1, rects: [[10, 20, 30, 40]] } }));
  });
  it("reports stale links without jumping to incorrect coordinates", async () => {
    vi.mocked(resolvePdfCitationLocation).mockRejectedValueOnce(new Error("This PDF has changed."));
    click(pdfCitation(item, 2, { region: { x: 0, y: 0, width: 0.5, height: 0.5 } })!);
    await vi.waitFor(() => expect(Zotero.alert).toHaveBeenCalled());
    expect(open).not.toHaveBeenCalled();
  });
});
