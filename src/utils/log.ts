export function error(module: string, msg: string, err?: Error): void {
  const stack = err?.stack ? `\n${err.stack}` : "";
  Zotero.debug(`[ChatPDF/${module}] ERROR: ${msg}${err ? `: ${err.message}` : ""}${stack}`);
}
