import { throwIfAborted } from "../utils/abort";
import { withStorageLock } from "../utils/atomic-storage";
import { sanitizeVisualSvg } from "./visual-sanitize";
import type { VisualInput, VisualOutput, VisualVersion } from "./visual-model";

export interface VisualRenderer {
  render(input: VisualInput): Promise<VisualOutput>;
  close(): void;
}
function deadline<T>(operation: Promise<T>, signal?: AbortSignal, timeout = 75000): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => finish(Object.assign(new Error("Visual rendering cancelled."), { name: "AbortError" }));
    const timer = setTimeout(() => finish(new Error("Visual renderer timed out.")), timeout);
    const finish = (error?: unknown, result?: T) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); if (error) reject(error); else resolve(result!); };
    signal?.addEventListener("abort", abort, { once: true });
    operation.then(result => finish(undefined, result), error => finish(error));
    if (signal?.aborted) abort();
  });
}
const fontCache = new Map<string, string>();
export async function visualFontCSS(svg: string): Promise<string> {
  const names = [...new Set([...svg.matchAll(/\b(?:cm|msam|msbm|eufm|eufb|eusm|eusb|lasy|rsfs)[a-z]*\d+\b/g)].map(m => m[0]))];
  let css = "";
  for (const name of names) {
    if (!fontCache.has(name)) {
      const response = await fetch(`chrome://chatpdf-visual/content/vendor/tikzjax/fonts/${name}.ttf`);
      if (!response.ok) throw new Error(`Bundled TeX font unavailable: ${name}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      fontCache.set(name, `@font-face{font-family:${name};src:url(data:font/ttf;base64,${Zotero.getMainWindow().btoa(binary)})}`);
    }
    css += fontCache.get(name);
  }
  return css;
}
async function openVisualRenderer(doc: Document, signal?: AbortSignal): Promise<VisualRenderer> {
  throwIfAborted(signal);
  const win = doc.defaultView!;
  const frame = doc.createElementNS("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", "browser") as any;
  frame.setAttribute("type", "content");
  frame.setAttribute("class", "chatpdf-visual-browser");
  frame.setAttribute("style", "position:fixed;left:-10000px;top:0;width:900px;height:600px;pointer-events:none;");
  let api: any;
  let closed = false;
  const close = () => { if (closed) return; closed = true; signal?.removeEventListener("abort", close); win.removeEventListener("unload", close); try { api?.close(); } finally { frame.remove(); } };
  signal?.addEventListener("abort", close, { once: true });
  win.addEventListener("unload", close, { once: true });
  try {
    doc.documentElement!.append(frame);
    if (frame.browsingContext) frame.browsingContext.allowJavascript = true;
    frame.setAttribute("src", "chrome://chatpdf-visual/content/host.html");
    const ready = new Promise<any>((resolve, reject) => {
      const poll = win.setInterval(() => {
        if (closed) { win.clearInterval(poll); reject(new Error("Visual renderer closed.")); return; }
        const realm = frame.contentWindow?.wrappedJSObject || frame.contentWindow;
        if (realm?.chatpdfVisualReady) { win.clearInterval(poll); resolve(realm.chatpdfVisualReady); }
      }, 30);
      win.setTimeout(() => { win.clearInterval(poll); reject(new Error("Visual renderer could not initialize.")); }, 15000);
    });
    api = await deadline(ready, signal, 20000);
    return {
      close,
      async render(input) {
        throwIfAborted(signal);
        let source = input.source;
        const kind = input.kind;
        if (kind === "svg") source = sanitizeVisualSvg(source, doc);
        try {
          let result = await deadline<VisualOutput>(api.render(JSON.stringify({ kind, source })), signal);
          if (result.svg) {
            result.svg = sanitizeVisualSvg(result.svg, doc);
            if (kind === "tikz") result = await deadline<VisualOutput>(api.render(JSON.stringify({ kind: "svg", source: result.svg, fontCSS: await visualFontCSS(result.svg) })), signal);
          }
          throwIfAborted(signal);
          return JSON.parse(JSON.stringify(result));
        } catch (error) { close(); throwIfAborted(signal); throw error; }
      },
    };
  } catch (error) { close(); throwIfAborted(signal); throw error; }
}
export async function renderVisual(input: VisualInput | VisualVersion, signal?: AbortSignal): Promise<VisualOutput> {
  throwIfAborted(signal);
  if (input.kind === "snapshot") {
    if (!input.png?.startsWith("data:image/png;base64,")) throw new Error("This archived visual has no saved image. Ask the model to redraw it as SVG, Mermaid or TikZ.");
    return { png: input.png, svg: input.svg ? sanitizeVisualSvg(input.svg, Zotero.getMainWindow().document) : undefined, width: input.width, height: input.height, diagnostics: ["Saved static snapshot of a former interactive visual; no code was executed."] };
  }
  const drawing: VisualInput = { ...input, kind: input.kind };
  const run = async () => {
    throwIfAborted(signal);
    const renderer = await openVisualRenderer(Zotero.getMainWindow().document, signal);
    try { return await renderer.render(drawing); } finally { renderer.close(); }
  };
  // TeX allocates a 2500-page WASM memory; never compile two in parallel.
  return input.kind === "tikz" ? withStorageLock("visual-tikz", run) : run();
}
