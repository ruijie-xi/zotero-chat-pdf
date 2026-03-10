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
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (now.toDateString() === date.toDateString()) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  if (diffDays < 7) return `${diffDays} days ago ${time}`;

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getMonth()]} ${date.getDate()} ${time}`;
}

/** Format a message timestamp as hh:mm. */
export function formatMsgTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Format a tool call name + args into a human-readable status string. */
export function formatToolStatus(name: string, args: Record<string, unknown>, session: import("../modules/chat-session").ChatSession): string {
  if (name === "list_sources") return "Listing sources...";
  if (name === "read_document") {
    const key = args.key as string | undefined;
    const src = key ? session.getSource(key) : undefined;
    const title = src?.title || key || "document";
    if (args.start_line) {
      return `Reading "${title}" (lines ${args.start_line}\u2013${args.end_line || "end"})`;
    }
    return `Reading "${title}"`;
  }
  if (name === "web_search") return `Searching: "${args.query}"`;
  if (name === "web_fetch") return `Fetching ${args.url}`;
  return `Calling ${name}...`;
}

/** Format character counts for display (e.g. 1500 -> "2K", 1234567 -> "1.2M"). */
export function formatChars(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(0) + "K";
  return String(n);
}
