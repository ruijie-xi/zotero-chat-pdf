import { config } from "../../package.json";

const PREFS_PREFIX = config.prefsPrefix;

export function getPref<K extends keyof _ZoteroTypes.Prefs["PluginPrefsMap"]>(
  key: K,
): _ZoteroTypes.Prefs["PluginPrefsMap"][K] {
  return Zotero.Prefs.get(
    `${PREFS_PREFIX}.${key}`,
    true,
  ) as _ZoteroTypes.Prefs["PluginPrefsMap"][K];
}

export function setPref<K extends keyof _ZoteroTypes.Prefs["PluginPrefsMap"]>(
  key: K,
  value: _ZoteroTypes.Prefs["PluginPrefsMap"][K],
) {
  return Zotero.Prefs.set(`${PREFS_PREFIX}.${key}`, value, true);
}
