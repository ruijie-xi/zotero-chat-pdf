import { config } from "../package.json";
import { initLocale } from "./utils/locale";
import { registerChatSection, registerContextMenu } from "./modules/chat-panel";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  registerChatSection();
  registerContextMenu();

  await Promise.all(
    Zotero.getMainWindows().map((win: Window) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: Window) {
  // Insert FTL for main window localization
  const ftlUri = `chrome://${config.addonRef}/content/locale/${config.addonRef}-mainWindow.ftl`;
  try {
    (win as any).MozXULElement?.insertFTLIfNeeded?.(ftlUri);
  } catch {
    // FTL may already be inserted or method unavailable
  }
}

async function onMainWindowUnload(_win: Window) {
  // Cleanup if needed
}

async function onShutdown() {
  addon.data.alive = false;
  // Unregister section
  Zotero.ItemPaneManager.unregisterSection("chatpdf-section");
  ztoolkit.unregisterAll();
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};
