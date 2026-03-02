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

  try {
    await Zotero.PreferencePanes.register({
      pluginID: config.addonID,
      src: `chrome://${config.addonRef}/content/preferences.xhtml`,
      scripts: [`chrome://${config.addonRef}/content/scripts/preferences.js`],
      label: config.addonName,
    });
  } catch (e) {
    Zotero.log(`[${config.addonName}] Failed to register preferences: ${e}`, "error");
  }

  try {
    registerChatSection();
  } catch (e) {
    Zotero.log(`[${config.addonName}] Failed to register chat section: ${e}`, "error");
  }

  try {
    registerContextMenu();
  } catch (e) {
    Zotero.log(`[${config.addonName}] Failed to register context menu: ${e}`, "error");
  }

  await Promise.all(
    Zotero.getMainWindows().map((win: Window) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: Window) {
  // Insert FTL for main window localization
  try {
    (win as any).MozXULElement?.insertFTLIfNeeded?.(`${config.addonRef}-mainWindow.ftl`);
  } catch {
    // FTL may already be inserted or method unavailable
  }
}

async function onMainWindowUnload(_win: Window) {
  // Cleanup if needed
}

async function onShutdown() {
  addon.data.alive = false;
  try {
    Zotero.ItemPaneManager.unregisterSection("chatpdf-section");
  } catch { /* ignore */ }
  try {
    Zotero.MenuManager.unregisterMenu("chatpdf-item-menu");
  } catch { /* ignore */ }
  ztoolkit.unregisterAll();
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};
