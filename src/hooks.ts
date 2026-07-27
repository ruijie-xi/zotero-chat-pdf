import { config } from "../package.json";
import { injectChatPanel, removeChatPanel, registerContextMenu, abortCurrentStream } from "./modules/chat-panel";
import { registerChatPdfBridge, unregisterChatPdfBridge } from "./modules/chatpdf-bridge";
import {
  initializeConversions,
  suspendConversions,
} from "./modules/conversion-manager";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

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
    registerContextMenu();
  } catch (e) {
    Zotero.log(`[${config.addonName}] Failed to register context menu: ${e}`, "error");
  }

  try {
    await initializeConversions();
    registerChatPdfBridge();
  } catch (e) {
    Zotero.log(`[${config.addonName}] Failed to register local bridge: ${e}`, "error");
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

  // Inject the persistent side panel
  try {
    injectChatPanel(win);
  } catch (e) {
    Zotero.debug(`[ChatPDF] Failed to inject chat panel: ${e}`);
  }
}

async function onMainWindowUnload(win: Window) {
  removeChatPanel(win);
}

async function onShutdown() {
  addon.data.alive = false;
  abortCurrentStream();
  await suspendConversions();
  unregisterChatPdfBridge();
  for (const win of Zotero.getMainWindows()) {
    removeChatPanel(win);
  }
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
