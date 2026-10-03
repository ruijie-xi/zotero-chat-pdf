import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openPdfRenderer } from "../src/modules/pdf-renderer";

const api = { open: vi.fn(async () => 2), render: vi.fn(async () => ({ page: 1, dataUrl: "data:image/jpeg;base64,AA==" })), close: vi.fn(async () => undefined) };
let ready: Promise<typeof api> | undefined;
beforeEach(() => {
  vi.clearAllMocks(); ready = Promise.resolve(api);
  vi.mocked(Zotero.getMainWindow).mockReturnValue(window as any);
  Object.assign(IOUtils, { read: vi.fn(async () => new Uint8Array([1, 2, 3])) });
  const create = document.createElementNS.bind(document);
  vi.spyOn(document, "createElementNS").mockImplementation(((namespace: string, name: string) => {
    const element = create(namespace, name);
    if (name === "browser") Object.defineProperty(element, "contentWindow", { value: { chatpdfRendererReady: ready } });
    return element;
  }) as typeof document.createElementNS);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); document.querySelectorAll(".chatpdf-pdf-renderer").forEach(el => el.remove()); });
describe("Zotero PDF renderer lifecycle", () => {
  it("initializes even when DOMContentLoaded was missed and disposes the XUL browser", async () => {
    const renderer = await openPdfRenderer("paper.pdf");
    expect(renderer.pageCount).toBe(2);
    expect(document.querySelector(".chatpdf-pdf-renderer")?.namespaceURI).toBe("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul");
    expect(api.open).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    await renderer.render(1, 150); await renderer.close();
    expect(api.close).toHaveBeenCalled(); expect(document.querySelector(".chatpdf-pdf-renderer")).toBeNull();
  });
  it("cancels initialization and removes the browser while the module is still loading", async () => {
    ready = new Promise(() => {});
    const controller = new AbortController();
    const pending = openPdfRenderer("paper.pdf", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(document.querySelector(".chatpdf-pdf-renderer")).toBeNull();
  });
  it("bounds a stalled module load and cleans up", async () => {
    vi.useFakeTimers(); ready = new Promise(() => {});
    const pending = openPdfRenderer("paper.pdf");
    const failure = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30000); await failure;
    expect(document.querySelector(".chatpdf-pdf-renderer")).toBeNull();
  });
});
