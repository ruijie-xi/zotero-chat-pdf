import type { PdfRect, PdfRegion } from "./pdf-renderer";
import { validPdfRect, validPdfRegion } from "./pdf-location-geometry";
import { resolvePdfCitationLocation } from "./pdf-locations";

interface CitationTarget { rects?: PdfRect[]; region?: PdfRegion; revision?: string; }
export function pdfCitation(attachment: Zotero.Item, page?: number, target: CitationTarget = {}): string | null {
  if (!/^[A-Z0-9]{8}$/.test(attachment.key)) return null;
  const library = (Zotero.Libraries as any).get?.(attachment.libraryID);
  if (!library) return null;
  const groupID = library.groupID || (Zotero as any).Groups?.getByLibraryID?.(attachment.libraryID)?.id;
  const route = library.libraryType === "group" ? (groupID ? `groups/${groupID}` : null) : "library";
  if (!route) return null;
  if (page !== undefined && (!Number.isSafeInteger(page) || page < 1)) return null;
  const params = new URLSearchParams();
  if (page) params.set("page", String(page));
  if (page && target.rects?.length) params.set("chatpdf_rects", JSON.stringify(target.rects));
  else if (page && target.region) params.set("chatpdf_region", JSON.stringify(target.region));
  if (page && target.revision) params.set("chatpdf_revision", target.revision);
  return `zotero://open-pdf/${route}/items/${attachment.key}${params.size ? `?${params}` : ""}`;
}

export function parsePdfCitation(href: string) {
  const match = /^zotero:\/\/open-pdf\/(library|groups\/([1-9]\d*))\/items\/([A-Z0-9]{8})(?:\?([^#]*))?$/.exec(href);
  if (!match) throw new Error("Invalid PDF citation link.");
  const params = new URLSearchParams(match[4]);
  const allowed = new Set(["page", "chatpdf_rects", "chatpdf_region", "chatpdf_revision"]);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) throw new Error("Invalid PDF citation parameters.");
  const pageValue = params.get("page"), page = pageValue === null ? undefined : Number(pageValue);
  if (page !== undefined && (!/^[1-9]\d*$/.test(pageValue!) || !Number.isSafeInteger(page))) throw new Error("Invalid PDF page.");
  const rects = params.has("chatpdf_rects") ? JSON.parse(params.get("chatpdf_rects")!) as PdfRect[] : undefined;
  const region = params.has("chatpdf_region") ? JSON.parse(params.get("chatpdf_region")!) as PdfRegion : undefined;
  const revision = params.get("chatpdf_revision") || undefined;
  if ((rects !== undefined && (!Array.isArray(rects) || !rects.length || !rects.every(validPdfRect))) ||
    (region !== undefined && !validPdfRegion(region)) || (rects && region) ||
    ((rects || region || revision) && !page) || (revision && !/^[a-f0-9]{64}$/.test(revision))) throw new Error("Invalid PDF citation region.");
  return { groupID: match[2] ? Number(match[2]) : null, key: match[3], page, rects, region, revision };
}

export function installCitationLinks(root: HTMLElement): void {
  root.addEventListener("click", event => {
    const anchor = (event.target as Element)?.closest?.("a");
    const href = anchor?.getAttribute("href") || "";
    if (!/^zotero:\/\/open-pdf\//i.test(href)) return;
    // Leave standard annotation links to Zotero; handle only our extension and page links.
    if (href.includes("annotation=") && !href.includes("chatpdf_")) return;
    event.preventDefault();
    void (async () => {
      const citation = parsePdfCitation(href);
      const libraries = Zotero.Libraries.getAll() as any[];
      const library = citation.groupID === null ? libraries.find(lib => lib.libraryType === "user") :
        libraries.find(lib => lib.libraryType === "group" && Number(lib.groupID || (Zotero as any).Groups?.getByLibraryID?.(lib.libraryID)?.id) === citation.groupID);
      const item = library && Zotero.Items.getByLibraryAndKey(library.libraryID, citation.key);
      if (!item?.isPDFAttachment()) throw new Error("The cited PDF is not available in this library.");
      const location = citation.rects || citation.region ? await resolvePdfCitationLocation(item, citation.page!, citation) :
        citation.page ? { pageIndex: citation.page - 1 } : {};
      await (Zotero as any).Reader.open(item.id, location);
    })().catch((error: Error) => {
      Zotero.debug(`[ChatPDF] Citation open failed: ${error.message}`);
      Zotero.alert(Zotero.getMainWindow(), "ChatPDF", error.message);
    });
  });
}
