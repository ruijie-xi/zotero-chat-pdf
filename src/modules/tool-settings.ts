import { getPref, setPref } from "../utils/prefs";

/** Missing preferences enable every tool, including newly introduced tools. */
export function disabledToolNames(): Set<string> {
  const raw = getPref("disabledTools");
  if (!raw) return new Set();
  const names: unknown = JSON.parse(raw);
  if (!Array.isArray(names) || names.some(name => typeof name !== "string")) {
    throw new Error("Invalid tool settings. Reset the tool switches in ChatPDF settings.");
  }
  return new Set(names);
}

export function isToolEnabled(name: string): boolean {
  return !disabledToolNames().has(name);
}

export function setToolEnabled(name: string, enabled: boolean): void {
  const names = disabledToolNames();
  if (enabled) names.delete(name);
  else names.add(name);
  setPref("disabledTools", JSON.stringify([...names].sort()));
}
