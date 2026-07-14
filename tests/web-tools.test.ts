import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool, ToolExecutionContext } from "../src/modules/tools";

function installPublicDnsMock() {
  const services = (globalThis as any).Services;
  const components = (globalThis as any).Components;
  const nsIDNSAddrRecord = {};
  const queryInterface = vi.fn(() => {
    let returned = false;
    return {
      hasMore: () => !returned,
      getNextAddrAsString: () => {
        returned = true;
        return "93.184.216.34";
      },
    };
  });

  services.dns = {
    RESOLVE_TYPE_DEFAULT: 0,
    asyncResolve: vi.fn((_hostname, _type, _flags, _info, listener) => {
      listener.onLookupComplete(null, { QueryInterface: queryInterface }, 0);
    }),
  };
  services.tm = { currentThread: {} };
  components.interfaces = { nsIDNSAddrRecord };
  components.isSuccessCode = vi.fn(() => true);
  return { nsIDNSAddrRecord, queryInterface };
}

function toolContext(): ToolExecutionContext {
  return {
    session: {} as ToolExecutionContext["session"],
    requestId: "web-tool-test",
    windowId: "test-window",
    turnScope: new Set(),
  };
}

describe("web tools", () => {
  const services = (globalThis as any).Services;
  const components = (globalThis as any).Components;
  const prefsGet = (globalThis as any).Zotero.Prefs.get;
  let previousDns: unknown;
  let previousTm: unknown;
  let previousInterfaces: unknown;
  let previousIsSuccessCode: unknown;

  beforeEach(() => {
    previousDns = services.dns;
    previousTm = services.tm;
    previousInterfaces = components.interfaces;
    previousIsSuccessCode = components.isSuccessCode;
    prefsGet.mockReset();
  });

  afterEach(() => {
    services.dns = previousDns;
    services.tm = previousTm;
    components.interfaces = previousInterfaces;
    components.isSuccessCode = previousIsSuccessCode;
    prefsGet.mockReset();
    vi.unstubAllGlobals();
  });

  it("executes Brave web_search after reading Firefox DNS address records", async () => {
    const dns = installPublicDnsMock();
    prefsGet.mockImplementation((key: string) => key.endsWith(".braveSearchApiKey") ? "test-brave-key" : undefined);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      web: {
        results: [{
          title: "ChatPDF result",
          description: "A search result returned by Brave.",
          url: "https://example.com/result",
        }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeTool("web_search", { query: "ChatPDF" }, toolContext());

    expect(result).toContain("ChatPDF result");
    expect(result).toContain("https://example.com/result");
    expect(result).not.toContain("Error executing web_search");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://api.search.brave.com/res/v1/web/search?"),
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(dns.queryInterface).toHaveBeenCalledWith(dns.nsIDNSAddrRecord);
  });

  it("parses DuckDuckGo result markup as plain text", async () => {
    installPublicDnsMock();
    const fetchMock = vi.fn(async () => new Response(
      '<div class="result results_links"><a class="result__a" href="https://example.com/result">ChatPDF <strong>result</strong><img src="x" onerror="alert(1)"></a><a class="result__snippet">A <em>useful</em> snippet.</a></div>',
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeTool("web_search", { query: "ChatPDF" }, toolContext());

    expect(result).toContain("ChatPDF result");
    expect(result).toContain("A useful snippet.");
    expect(result).toContain("https://example.com/result");
    expect(result).not.toContain("<strong>");
    expect(result).not.toContain("onerror");
  });

  it("executes web_fetch and returns cleaned page text", async () => {
    const dns = installPublicDnsMock();
    const fetchMock = vi.fn(async () => new Response(
      "<!doctype html><html><body><h1>Example article</h1><script>hidden()</script><p>Useful text.</p></body></html>",
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeTool("web_fetch", { url: "https://example.com/article" }, toolContext());

    expect(result).toContain("Example article");
    expect(result).toContain("Useful text.");
    expect(result).not.toContain("hidden()");
    expect(result).not.toContain("Error executing web_fetch");
    expect(dns.queryInterface).toHaveBeenCalledWith(dns.nsIDNSAddrRecord);
  });
});
