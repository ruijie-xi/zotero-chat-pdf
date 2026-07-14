import { describe, expect, it, vi } from "vitest";
import {
  assertPublicHttpUrl,
  assertPublicNetworkTarget,
  isPrivateIpAddress,
} from "../src/modules/safe-web-client";

describe("safe web client URL policy", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.1.1",
    "100.64.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])("blocks private address %s", (address) => {
    expect(isPrivateIpAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("allows public address %s", (address) => {
    expect(isPrivateIpAddress(address)).toBe(false);
  });

  it("allows public HTTPS URLs", () => {
    expect(assertPublicHttpUrl("https://example.com/paper").href).toBe("https://example.com/paper");
  });

  it.each([
    "file:///etc/passwd",
    "ftp://example.com/file",
    "http://localhost:3000",
    "http://service.local/path",
    "http://127.0.0.1/admin",
    "https://user:pass@example.com/",
  ])("rejects unsafe URL %s", (url) => {
    expect(() => assertPublicHttpUrl(url)).toThrow();
  });

  it("queries Firefox DNS results as nsIDNSAddrRecord", async () => {
    const services = (globalThis as any).Services;
    const components = (globalThis as any).Components;
    const previousDns = services.dns;
    const previousTm = services.tm;
    const previousInterfaces = components.interfaces;
    const previousIsSuccessCode = components.isSuccessCode;
    const nsIDNSAddrRecord = {};
    let nextAddress = 0;
    const addressRecord = {
      hasMore: vi.fn(() => nextAddress < 2),
      getNextAddrAsString: vi.fn(() => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"][nextAddress++]),
    };
    const baseRecord = {
      QueryInterface: vi.fn(() => addressRecord),
    };

    try {
      services.dns = {
        RESOLVE_TYPE_DEFAULT: 0,
        asyncResolve: vi.fn((_hostname, _type, _flags, _info, listener) => {
          listener.onLookupComplete(null, baseRecord, 0);
        }),
      };
      services.tm = { currentThread: {} };
      components.interfaces = { nsIDNSAddrRecord };
      components.isSuccessCode = vi.fn(() => true);

      await expect(assertPublicNetworkTarget("https://example.com/article")).resolves.toMatchObject({
        hostname: "example.com",
      });
      expect(baseRecord.QueryInterface).toHaveBeenCalledWith(nsIDNSAddrRecord);
      expect(addressRecord.getNextAddrAsString).toHaveBeenCalledTimes(2);
    } finally {
      services.dns = previousDns;
      services.tm = previousTm;
      components.interfaces = previousInterfaces;
      components.isSuccessCode = previousIsSuccessCode;
    }
  });
});
