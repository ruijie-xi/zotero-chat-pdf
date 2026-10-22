import { getPanelState } from "./panel-state";
import { addZoteroItemToSession } from "./zotero-items";
import { refreshSourceChips } from "./source-chips";
import { autoSaveSession } from "./session-persistence";
import type { SourceItem } from "./chat-session";

export async function addItemToSession(item: Zotero.Item, target: Window | HTMLElement): Promise<void> {
  const state = getPanelState(target);
  const session = state.session;
  const added = await addZoteroItemToSession(item, session);
  if (state.session !== session || !added.sourceKey) return;
  const doc = (target as Window).document || (target as HTMLElement).ownerDocument;
  const root = doc?.querySelector("#chatpdf-root") as HTMLElement | null;
  if (root) { refreshSourceChips(root); await autoSaveSession(root); }
}

/** Insert an inline mention chip into the TipTap editor. */
export function insertInputChip(source: SourceItem, root: HTMLElement): void {
  getPanelState(root).chatInput?.insertMention({ key: source.id, title: source.title });
}
