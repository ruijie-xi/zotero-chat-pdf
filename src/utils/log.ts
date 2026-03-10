/** Structured debug logging for ChatPDF modules. */
export function log(module: string, msg: string, ...args: unknown[]): void {
  const extra = args.length > 0 ? " " + args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ") : "";
  Zotero.debug(`[ChatPDF/${module}] ${msg}${extra}`);
}

export function warn(module: string, msg: string, ...args: unknown[]): void {
  const extra = args.length > 0 ? " " + args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ") : "";
  Zotero.debug(`[ChatPDF/${module}] WARNING: ${msg}${extra}`);
}

export function error(module: string, msg: string, err?: Error): void {
  const stack = err?.stack ? `\n${err.stack}` : "";
  Zotero.debug(`[ChatPDF/${module}] ERROR: ${msg}${err ? `: ${err.message}` : ""}${stack}`);
}
