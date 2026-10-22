import { getPanelState } from "./panel-state";
import { checkImageSize, importImage } from "./image-input";
import { autoSaveSession } from "./session-persistence";
import { addItemToSession, insertInputChip } from "./session-sources";
import { getChatAttachment, getItemFromZoteroUri } from "./zotero-items";
import { refreshSourceChips } from "./source-chips";
import { uiLabel } from "../utils/ui-text";

/** File picking, image paste and Zotero drops share the same source insertion path. */
export function installInputSources(root: HTMLElement, inputWrapper: HTMLElement, imagePicker: HTMLInputElement, imageStatus: HTMLElement): void {
  const state = getPanelState(root);
  imagePicker.addEventListener("change", () => {
    const files = Array.from(imagePicker.files || []);
    imagePicker.value = "";
    void addImageFiles(files);
  });
  async function addImageFiles(files: File[]): Promise<void> {
    const session = state.session;
    const errors: string[] = [];
    imageStatus.textContent = uiLabel("addingImages");
    for (const file of files) {
      try {
        checkImageSize(file.size);
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (state.session !== session) return;
        const source = await importImage(session, bytes, file.name || "Pasted image", undefined, () => state.session === session && root.isConnected);
        if (state.session !== session) return;
        insertInputChip(source, root);
      } catch (error: any) {
        errors.push(`${file.name || "Image"}: ${error.message}`);
      }
    }
    if (state.session !== session) return;
    refreshSourceChips(root);
    await autoSaveSession(root);
    imageStatus.textContent = errors.length ? errors.join("\n") : "";
    state.chatInput?.restoreFocusAfterExternalInsert();
  }

  inputWrapper.addEventListener("paste", (event: Event) => {
    const files = Array.from((event as ClipboardEvent).clipboardData?.files || []);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    void addImageFiles(files);
  }, true);


  // ---- Drag-and-drop ----
  inputWrapper.addEventListener("dragover", (e: Event) => {
    (e as DragEvent).preventDefault();
    inputWrapper.classList.add("chatpdf-drop-active");
  });
  inputWrapper.addEventListener("dragleave", (e: Event) => {
    const related = (e as MouseEvent).relatedTarget as Node | null;
    if (!related || !inputWrapper.contains(related)) {
      inputWrapper.classList.remove("chatpdf-drop-active");
    }
  });
  inputWrapper.addEventListener("drop", async (e: Event) => {
    const de = e as DragEvent;
    de.preventDefault();
    de.stopPropagation();
    inputWrapper.classList.remove("chatpdf-drop-active");
    const dt = de.dataTransfer;
    let handledDrop = false;

    const session = state.session;

    async function handleDroppedItem(item: Zotero.Item) {
      if (state.session !== session) return;
      await addItemToSession(item, root);
      if (state.session !== session) return;
      const pdf = getChatAttachment(item);
      const src = state.session.getSource(pdf?.key || "", Number((pdf as any)?.libraryID) || undefined);
      if (src) {
        insertInputChip(src, root);
        handledDrop = true;
      }
      refreshSourceChips(root);
    }

    try {
      if (dt?.files?.length && !dt.types.includes("zotero/item")) {
        await addImageFiles(Array.from(dt.files));
        return;
      }
      // 1. zotero/item
      const zoteroItemData = dt?.getData("zotero/item");
      if (zoteroItemData) {
        for (const id of zoteroItemData.split(",").map((s: string) => parseInt(s, 10))) {
          const droppedItem = Zotero.Items.get(id);
          if (droppedItem) await handleDroppedItem(droppedItem);
        }
        return;
      }

      // 2. zotero/tab
      const tabID = dt?.getData("zotero/tab");
      if (tabID) {
        try {
          const mainWin = Zotero.getMainWindow() as any;
          const reader = (Zotero as any).Reader?.getByTabID?.(tabID);
          if (reader?.itemID) {
            const item = Zotero.Items.get(reader.itemID);
            if (item) { await handleDroppedItem(item); return; }
          }
          const tab = mainWin.Zotero_Tabs?._tabs?.find((t: any) => t.id === tabID);
          const itemID = tab?.data?.itemID;
          if (itemID) {
            const item = Zotero.Items.get(itemID);
            if (item) { await handleDroppedItem(item); return; }
          }
        } catch (err) {
          Zotero.debug(`[ChatPDF] drop on input: zotero/tab error: ${err}`);
        }
      }

      // 3. URI-based fallbacks
      const uriCandidates: string[] = [];
      const mozUrl = dt?.getData("text/x-moz-url");
      if (mozUrl) uriCandidates.push(mozUrl.split("\n")[0].trim());
      const plainText = dt?.getData("text/plain");
      if (plainText) uriCandidates.push(plainText.trim());
      const uriList = dt?.getData("text/uri-list");
      if (uriList) {
        for (const line of uriList.split(/\r?\n/)) {
          const u = line.trim();
          if (u && !u.startsWith("#")) uriCandidates.push(u);
        }
      }
      for (const uri of uriCandidates) {
        const item = await getItemFromZoteroUri(uri);
        if (item) { await handleDroppedItem(item); return; }
      }

      // 4. Last resort: currently-open tab
      if (dt && Array.from(dt.types).length > 0) {
        try {
          const mainWin = Zotero.getMainWindow() as any;
          const selectedTabID = mainWin.Zotero_Tabs?.selectedID;
          if (selectedTabID && selectedTabID !== "zotero-pane") {
            const reader = (Zotero as any).Reader?.getByTabID?.(selectedTabID);
            if (reader?.itemID) {
              const item = Zotero.Items.get(reader.itemID);
              if (item) { await handleDroppedItem(item); return; }
            }
            const tab = mainWin.Zotero_Tabs?._tabs?.find((t: any) => t.id === selectedTabID);
            const itemID = tab?.data?.itemID;
            if (itemID) {
              const item = Zotero.Items.get(itemID);
              if (item) { await handleDroppedItem(item); return; }
            }
          }
        } catch (err) {
          Zotero.debug(`[ChatPDF] drop on input: last-resort error: ${err}`);
        }
      }
    } catch (error: any) {
      imageStatus.textContent = error.message;
    } finally {
      if (handledDrop && state.session === session) state.chatInput?.restoreFocusAfterExternalInsert();
    }
  }, true);


}
