import { throwIfConversionAborted } from "./pdf-conversion";

function bounded<T>(operation: Promise<T>, milliseconds: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => finish(Object.assign(new Error("Conversion aborted by user"), { name: "AbortError" }));
    const timer = setTimeout(() => finish(new Error("PDF renderer operation timed out")), milliseconds);
    const finish = (error?: unknown, value?: T) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value!);
    };
    signal?.addEventListener("abort", abort, { once: true });
    operation.then(value => finish(undefined, value), error => finish(error));
    if (signal?.aborted) abort();
  });
}

export interface RenderedPdfPage {
  page: number;
  dataUrl: string;
  text: string;
  width: number;
  height: number;
  effectiveDpi: number;
}

export interface PdfRenderer {
  pageCount: number;
  render(page: number, dpi: number): Promise<RenderedPdfPage>;
  close(): Promise<void>;
}

/** Run the bundled Zotero PDF.js in a private, disposable DOM realm. */
export async function openPdfRenderer(pdfPath: string, signal?: AbortSignal, pdfData?: Uint8Array): Promise<PdfRenderer> {
  throwIfConversionAborted(signal);
  const win = Zotero.getMainWindow();
  // Zotero's chrome window uses a XUL browser for content documents. An HTML
  // iframe in the main XUL tree does not create a usable renderer docshell.
  const frame = win.document.createElementNS("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", "browser") as any;
  frame.setAttribute("class", "chatpdf-pdf-renderer");
  frame.setAttribute("type", "content");
  frame.setAttribute("style", "position:fixed;width:1px;height:1px;visibility:hidden;pointer-events:none;");
  let api: any;
  const abort = () => { void api?.close().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = () => finish(Object.assign(new Error("Conversion aborted by user"), { name: "AbortError" }));
      const check = () => {
        const realm = frame.contentWindow?.wrappedJSObject || frame.contentWindow;
        if (realm?.chatpdfRendererReady) finish();
      };
      const poll = win.setInterval(check, 50);
      const timer = setTimeout(() => finish(new Error("PDF renderer initialization timed out")), 30_000);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", fail);
        win.clearInterval(poll);
        if (error) reject(error);
        else resolve();
      };
      signal?.addEventListener("abort", fail, { once: true });
      frame.addEventListener("error", () => finish(new Error("Could not load PDF renderer")), { once: true });
      win.document.documentElement!.append(frame);
      // Enable JavaScript only for this private, trusted local renderer.
      if (frame.browsingContext) frame.browsingContext.allowJavascript = true;
      frame.setAttribute("src", "chrome://chatpdf/content/pdf-renderer.html");
      check();
      if (signal?.aborted) finish(Object.assign(new Error("Conversion aborted by user"), { name: "AbortError" }));
    });
    throwIfConversionAborted(signal);
    const realm = (frame.contentWindow as any)?.wrappedJSObject || frame.contentWindow;
    api = await bounded(realm.chatpdfRendererReady, 30_000, signal);
    if (!api) throw new Error("PDF renderer initialization failed");
    const bytes = pdfData || await IOUtils.read(pdfPath);
    throwIfConversionAborted(signal);
    const pageCount = await bounded<number>(api.open(bytes), 60_000, signal);
    throwIfConversionAborted(signal);
    return {
      pageCount,
      render: async (page, dpi) => {
        throwIfConversionAborted(signal);
        try { return await bounded<RenderedPdfPage>(api.render(page, dpi), 60_000, signal); }
        catch (error) { throwIfConversionAborted(signal); throw error; }
      },
      close: async () => {
        signal?.removeEventListener("abort", abort);
        try { await bounded(api.close(), 5000); } finally { frame.remove(); }
      },
    };
  } catch (error) {
    signal?.removeEventListener("abort", abort);
    if (api) await bounded(api.close(), 5000).catch(() => {});
    frame.remove();
    throwIfConversionAborted(signal);
    throw error;
  }
}
