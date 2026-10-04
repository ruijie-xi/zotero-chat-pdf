export function pdfCitation(attachment: Zotero.Item, page?: number): string | null {
  if (!/^[A-Z0-9]{8}$/.test(attachment.key)) return null;
  const library = (Zotero.Libraries as any).get?.(attachment.libraryID);
  if (!library) return null;
  const groupID = library.groupID || (Zotero as any).Groups?.getByLibraryID?.(attachment.libraryID)?.id;
  const route = library.libraryType === "group" ? (groupID ? `groups/${groupID}` : null) : "library";
  if (!route) return null;
  return `zotero://open-pdf/${route}/items/${attachment.key}${page ? `?page=${page}` : ""}`;
}

export function installCitationLinks(root: HTMLElement): void {
  root.addEventListener("click", event => {
    const anchor = (event.target as Element)?.closest?.("a");
    const href = anchor?.getAttribute("href") || "";
    const match = /^zotero:\/\/open-pdf\/(library|groups\/(\d+))\/items\/([A-Z0-9]{8})(?:\?page=([1-9]\d*))?$/.exec(href);
    if (!match) return;
    event.preventDefault();
    const libraries = Zotero.Libraries.getAll() as any[];
    const library = match[1] === "library" ? libraries.find(lib => lib.libraryType === "user") : libraries.find(lib => lib.libraryType === "group" && Number(lib.groupID || (Zotero as any).Groups?.getByLibraryID?.(lib.libraryID)?.id) === Number(match[2]));
    const item = library && Zotero.Items.getByLibraryAndKey(library.libraryID, match[3]);
    if (item?.isPDFAttachment()) void (Zotero as any).Reader.open(item.id, match[4] ? { pageIndex: Number(match[4]) - 1 } : {}).catch((error: any) => Zotero.debug(`[ChatPDF] Citation open failed: ${error.message}`));
  });
}
