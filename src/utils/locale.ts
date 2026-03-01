import { config } from "../../package.json";

export function initLocale() {
  const l10n = new (
    typeof Localization === "undefined"
      ? ztoolkit.getGlobal("Localization")
      : Localization
  )([`${config.addonRef}-addon.ftl`], true);
  addon.data.locale = { current: l10n };
}

export function getString(key: string, args?: Record<string, string>): string {
  if (!addon.data.locale?.current) {
    return key;
  }
  const flatArgs: Record<string, string> = args || {};
  return (
    addon.data.locale.current.formatValueSync(key, flatArgs) ?? key
  );
}
