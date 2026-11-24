var chromeHandle;

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  var visualContent = ["content", "chatpdf-visual", rootURI + "content/visual/", "contentaccessible=yes"];
  var locations = [
    ["content", "__addonRef__", rootURI + "content/"],
    visualContent,
    ["locale", "__addonRef__", "en-US", rootURI + "locale/en-US/"],
  ];
  try {
    chromeHandle = aomStartup.registerChrome(manifestURI, locations);
  } catch (error) {
    if (error.result !== Components.results.NS_ERROR_INVALID_ARG) throw error;
    // Zotero 7's Gecko 115 rejects flags on dynamic content entries.
    visualContent.pop();
    chromeHandle = aomStartup.registerChrome(manifestURI, locations);
  }

  const ctx = { rootURI, Zotero };
  ctx._globalThis = ctx;

  Services.scriptloader.loadSubScript(
    `${rootURI}/content/scripts/__addonRef__.js`,
    ctx,
  );
  await Zotero.__addonInstance__.hooks.onStartup();
}

async function onMainWindowLoad({ window }, reason) {
  await Zotero.__addonInstance__?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, reason) {
  await Zotero.__addonInstance__?.hooks.onMainWindowUnload(window);
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }
  await Zotero.__addonInstance__?.hooks.onShutdown();
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

async function uninstall(data, reason) {}
