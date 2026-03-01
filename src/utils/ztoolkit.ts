import { ZoteroToolkit } from "zotero-plugin-toolkit";
import { config } from "../../package.json";

export function createZToolkit() {
  const _ztoolkit = new ZoteroToolkit();
  initZToolkit(_ztoolkit);
  return _ztoolkit;
}

function initZToolkit(_ztoolkit: ZoteroToolkit) {
  const env = __env__;
  _ztoolkit.basicOptions.log.prefix = `[${config.addonName}]`;
  _ztoolkit.basicOptions.log.disableConsole = env === "production";
  _ztoolkit.log(`${config.addonName} ztoolkit initialized`);
}
