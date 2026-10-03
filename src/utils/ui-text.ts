/** Short dynamic UI strings follow Zotero's locale; static preference labels use Fluent. */
export function uiText(english: string, chinese: string): string {
  const locale = String((Zotero as any).locale || (globalThis as any).navigator?.language || "en");
  return /^zh(?:[-_]|$)/i.test(locale) ? chinese : english;
}
