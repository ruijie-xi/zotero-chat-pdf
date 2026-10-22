import { uiText } from "./ui-text";

/** Format token counts for display (e.g. 1500 -> "1.5K"). */
export function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

/** Format a timestamp as a relative date string (e.g. "Today 14:30", "Yesterday 09:15"). */
export function formatRelativeDate(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);
  const day = (value: Date) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  const diffDays = Math.round((day(now) - day(date)) / 86400000);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (diffDays === 0) return uiText(`Today ${time}`, `今天 ${time}`);
  if (diffDays === 1) return uiText(`Yesterday ${time}`, `昨天 ${time}`);
  if (diffDays > 1 && diffDays < 7) return uiText(`${diffDays} days ago ${time}`, `${diffDays} 天前 ${time}`);

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return uiText(`${months[date.getMonth()]} ${date.getDate()} ${time}`, `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`);
}

/** Format a message timestamp as hh:mm. */
export function formatMsgTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Format a tool call name + args into a human-readable status string. */
export function formatToolStatus(name: string, args: Record<string, unknown>, session: import("../modules/chat-session").ChatSession): string {
  if (name === "list_sources") return uiText("Listing sources…", "正在查看来源…");
  if (name === "read_pdf_page" || name === "inspect_pdf_page" || name === "read_pdf_text") {
    const key = args.key as string | undefined;
    const src = key ? session.getSource(key) : undefined;
    const title = src?.title || key || uiText("document", "文献");
    if (name === "read_pdf_page" || name === "inspect_pdf_page") {
      if (args.page) return uiText(`Reading "${title}" (page ${args.page}${args.region ? ", zoomed region" : ""})`, `正在阅读“${title}”第 ${args.page} 页${args.region ? "的放大区域" : ""}`);
      if (Array.isArray(args.pages)) return uiText(`Reading "${title}" (pages ${args.pages.join(", ")})`, `正在阅读“${title}”第 ${args.pages.join("、")} 页`);
      return uiText(`Reading "${title}" (from page ${args.start_page || 1}, up to ${args.count || 4} pages)`, `正在阅读“${title}”：从第 ${args.start_page || 1} 页起，最多 ${args.count || 4} 页`);
    }
    if (args.start_page) return uiText(`Locating text in "${title}" (pages ${args.start_page}\u2013${args.end_page || "end"})`, `正在定位“${title}”第 ${args.start_page}–${args.end_page || "末"} 页文字`);
    return uiText(`Reading "${title}"`, `正在阅读“${title}”`);
  }
  if (name === "web_search" || name === "search_pdf_text") return uiText(`Searching: "${args.query}"`, `正在搜索：“${args.query}”`);
  if (name === "web_fetch") return uiText(`Fetching ${args.url}`, `正在读取网页 ${args.url}`);
  return uiText(`Running ${name}…`, `正在执行 ${name}…`);
}

/** Format character counts for display (e.g. 1500 -> "2K", 1234567 -> "1.2M"). */
export function formatChars(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(0) + "K";
  return String(n);
}
