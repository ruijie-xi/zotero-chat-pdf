/* Isolated PDF.js realm: no reader tabs or external rendering binaries. */
window.chatpdfRendererReady = (async () => {
  const base = "resource://zotero/reader/pdf/";
  let pdfjs;
  try {
    pdfjs = await import(`${base}build/pdf.mjs`);
    pdfjs.GlobalWorkerOptions.workerSrc = `${base}build/pdf.worker.mjs`;
  } catch {
    // Zotero 7 ships the classic PDF.js build.
    await new Promise((resolve, reject) => {
      const script = document.createElementNS("http://www.w3.org/1999/xhtml", "script");
      script.src = `${base}build/pdf.js`;
      script.onload = resolve;
      script.onerror = () => reject(new Error("Zotero PDF.js is unavailable"));
      document.head.append(script);
    });
    pdfjs = window.pdfjsLib;
    pdfjs.GlobalWorkerOptions.workerSrc = `${base}build/pdf.worker.js`;
  }
  let task;
  let pdf;
  let rendering;
  return {
    async open(bytes) {
      task = pdfjs.getDocument({ data: new Uint8Array(bytes),
        cMapUrl: `${base}web/cmaps/`, cMapPacked: true,
        standardFontDataUrl: `${base}web/standard_fonts/`,
        wasmUrl: `${base}web/wasm/`, isEvalSupported: false });
      // Password prompts belong to the reader, not a background conversion.
      const protectedDocument = new Promise((_resolve, reject) => {
        task.onPassword = () => reject(new Error("Password-protected PDFs must be unlocked before conversion"));
      });
      pdf = await Promise.race([task.promise, protectedDocument]);
      return pdf.numPages;
    },
    async render(pageNumber, dpi) {
      const page = await pdf.getPage(pageNumber);
      const original = page.getViewport({ scale: dpi / 72 });
      // Explicit raster safety limit: 16 megapixels, at most 8192 per side.
      const factor = Math.min(1, 8192 / original.width, 8192 / original.height,
        Math.sqrt(16000000 / (original.width * original.height)));
      const viewport = page.getViewport({ scale: dpi / 72 * factor });
      const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      try {
        // Off-screen rasterization must not wait for animation frames in a
        // hidden/minimized Zotero window. PDF.js print intent uses task scheduling.
        rendering = page.render({ canvasContext: canvas.getContext("2d"), viewport, background: "white", intent: "print" });
        await rendering.promise;
        const text = await page.getTextContent().catch(() => ({ items: [] }));
        return { page: pageNumber, dataUrl: canvas.toDataURL("image/jpeg", 0.85),
          text: text.items.map(item => item.str || "").join(" "),
          width: canvas.width, height: canvas.height, effectiveDpi: dpi * factor };
      } finally {
        rendering = null;
        canvas.width = canvas.height = 0;
        page.cleanup();
      }
    },
    async text(pageNumber) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const labels = await pdf.getPageLabels();
        return { page: pageNumber, pageLabel: labels?.[pageNumber - 1] || undefined,
          text: content.items.map(item => (item.str || "") + (item.hasEOL ? "\n" : " ")).join("").trim() };
      } finally { page.cleanup(); }
    },
    async close() {
      rendering?.cancel();
      await task?.destroy();
    },
  };
})();
// The host awaits this promise; attach a handler immediately to avoid an
// unhandled rejection when initialization fails before the host sees it.
window.chatpdfRendererReady.catch(() => {});
