export const DEFAULT_WEB_TIMEOUT_MS = 20_000;
export const DEFAULT_WEB_MAX_BYTES = 5 * 1024 * 1024;
export const HARD_WEB_MAX_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface SafeFetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  body?: string;
  allowedMimeTypes?: RegExp;
}

export interface SafeFetchResult {
  text: string;
  finalUrl: string;
  status: number;
  contentType: string;
  bytesRead: number;
}

function parseIPv4(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const values = parts.map(Number);
  return values.every((part) => part >= 0 && part <= 255) ? values : null;
}

export function isPrivateIpAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isPrivateIpAddress(mapped[1]);

  const ipv4 = parseIPv4(normalized);
  if (ipv4) {
    const [a, b] = ipv4;
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224;
  }

  if (!normalized.includes(":")) return false;
  return normalized === "::" || normalized === "::1" ||
    /^f[cd][0-9a-f]{2}:/.test(normalized) ||
    /^fe[89ab][0-9a-f]:/.test(normalized) ||
    /^ff[0-9a-f]{2}:/.test(normalized);
}

export function assertPublicHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs are allowed.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") || isPrivateIpAddress(hostname)) {
    throw new Error(`Blocked local or private network target: ${hostname || rawUrl}`);
  }
  if (url.username || url.password) {
    throw new Error("URLs containing embedded credentials are not allowed.");
  }
  return url;
}

async function resolveHostAddresses(hostname: string): Promise<string[]> {
  if (parseIPv4(hostname) || hostname.includes(":")) return [hostname];
  const dns = (Services as any).dns;
  if (!dns?.asyncResolve) throw new Error("DNS validation is unavailable; refusing network request.");

  return new Promise<string[]>((resolve, reject) => {
    const listener = {
      onLookupComplete(_request: unknown, record: any, status: number) {
        const success = typeof (Components as any).isSuccessCode === "function"
          ? (Components as any).isSuccessCode(status)
          : status === 0;
        if (!success) {
          reject(new Error(`DNS resolution failed for ${hostname} (status ${status})`));
          return;
        }

        const addresses: string[] = [];
        try {
          const addressRecordInterface = (Components as any).interfaces?.nsIDNSAddrRecord;
          const addressRecord = addressRecordInterface && typeof record?.QueryInterface === "function"
            ? record.QueryInterface(addressRecordInterface)
            : record;
          if (typeof addressRecord?.hasMore !== "function" ||
              typeof addressRecord?.getNextAddrAsString !== "function") {
            throw new Error("nsIDNSAddrRecord methods are unavailable");
          }
          while (addressRecord.hasMore()) {
            addresses.push(addressRecord.getNextAddrAsString());
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          reject(new Error(`Could not read DNS addresses for ${hostname}: ${detail}`));
          return;
        }
        resolve([...new Set(addresses)]);
      },
    };

    try {
      dns.asyncResolve(
        hostname,
        dns.RESOLVE_TYPE_DEFAULT ?? 0,
        0,
        null,
        listener,
        (Services as any).tm.currentThread,
        {},
      );
    } catch {
      try {
        dns.asyncResolve(hostname, 0, listener, (Services as any).tm.currentThread, {});
      } catch (error) {
        reject(error);
      }
    }
  });
}

export async function assertPublicNetworkTarget(rawUrl: string): Promise<URL> {
  const url = assertPublicHttpUrl(rawUrl);
  const addresses = await resolveHostAddresses(url.hostname);
  if (addresses.length === 0) throw new Error(`DNS resolution returned no addresses for ${url.hostname}`);
  if (addresses.some(isPrivateIpAddress)) {
    throw new Error(`Blocked hostname resolving to a private network address: ${url.hostname}`);
  }
  return url;
}

function createAbortScope(signal: AbortSignal | undefined, timeoutMs: number) {
  const Ctor = (typeof AbortController !== "undefined")
    ? AbortController
    : (Zotero.getMainWindow() as any).AbortController;
  const controller = new Ctor() as AbortController;
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs} ms`)), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", forwardAbort);
    },
  };
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<{ text: string; bytesRead: number }> {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    throw new Error(`Response is ${contentLength} bytes, above the visible ${maxBytes}-byte safety budget.`);
  }
  if (!response.body) return { text: "", bytesRead: 0 };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  while (true) {
    const { value, done } = await (reader as any).read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel(undefined);
      throw new Error(`Response exceeded the visible ${maxBytes}-byte safety budget; no truncated result was returned.`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, bytesRead };
}

export async function safeFetchText(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS);
  const maxBytes = Math.min(HARD_WEB_MAX_BYTES, Math.max(1, options.maxBytes ?? DEFAULT_WEB_MAX_BYTES));
  const allowedMime = options.allowedMimeTypes ?? /^(text\/|application\/(json|xml|xhtml\+xml))/i;
  const abortScope = createAbortScope(options.signal, timeoutMs);
  let current = await assertPublicNetworkTarget(rawUrl);

  try {
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
      const response = await fetch(current.href, {
        method: options.method || "GET",
        headers: options.headers,
        body: options.body,
        redirect: "manual",
        signal: abortScope.signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirectCount === MAX_REDIRECTS) throw new Error(`Too many redirects (>${MAX_REDIRECTS}).`);
        const location = response.headers.get("location");
        if (!location) throw new Error(`Redirect ${response.status} did not include a Location header.`);
        current = await assertPublicNetworkTarget(new URL(location, current.href).href);
        continue;
      }
      const contentType = response.headers.get("content-type")?.split(";")[0].trim() || "";
      if (contentType && !allowedMime.test(contentType)) {
        throw new Error(`Blocked response MIME type: ${contentType}`);
      }
      const { text, bytesRead } = await readBoundedBody(response, maxBytes);
      return { text, bytesRead, finalUrl: current.href, status: response.status, contentType };
    }
    throw new Error("Redirect handling failed.");
  } finally {
    abortScope.dispose();
  }
}
