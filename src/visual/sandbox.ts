import mermaid from "mermaid";
import { sanitizeVisualSvg } from "../modules/visual-sanitize";

const token = (window as any).visualToken;
const surface = document.getElementById("visual")!;
let worker: Worker | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let workerUrl: string | undefined;
let channel: MessagePort | undefined;
const send = (value: any) => channel?.postMessage({ token, ...value });
function stop(): void { if (timer) clearTimeout(timer); worker?.terminate(); worker = undefined; if (workerUrl) URL.revokeObjectURL(workerUrl); workerUrl = undefined; }
function startWorker(source: string): Worker {
  stop();
  workerUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  worker = new Worker(workerUrl);
  return worker;
}
async function raster(svg: string): Promise<{ png: string; width: number; height: number }> {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const scale = Math.min(3, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d")!;
  context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { png: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
}
function tikz(source: string, assets: { script: string; wasm: ArrayBuffer; core: ArrayBuffer }): Promise<string> {
  return new Promise((resolve, reject) => {
    // The upstream browser bundle operates on a tiny worker DOM shim. TeX and
    // decompression are terminable and never share the Zotero UI thread.
    const shim = `self.window=self;self.document={currentScript:{},getElementsByTagName:()=>[{getAttribute:()=> 'text/tikz',childNodes:[{nodeValue:${JSON.stringify(source)}}],parentNode:{replaceChild:n=>postMessage({svg:n.innerHTML,attrs:n.attrs})}}],createElement:()=>({style:{},attrs:{},innerHTML:'',getElementsByTagName(){return this.innerHTML.includes('<svg')?[{setAttribute:(k,v)=>this.attrs[k]=v}]:[];}})};
self.onerror=(message)=>{postMessage({error:String(message)});return true;};self.onunhandledrejection=e=>postMessage({error:String(e.reason)});
self.onmessage=async event=>{const {wasm,core}=event.data;self.fetch=async url=>{if(String(url).endsWith('/3f69afb974a1e83f66a36f7618f88a38c254034b.wasm'))return new Response(wasm);if(String(url).endsWith('/b565ab0b474e8e557d954694b7379a57db669ac9.gz'))return new Response(core);throw Error('Network disabled');};
`;
    const instance = startWorker(shim + assets.script + "\nawait self.onload();};");
    timer = setTimeout(() => { stop(); reject(new Error("TikZ compilation exceeded 60 seconds.")); }, 60000);
    instance.onerror = e => { e.preventDefault(); stop(); reject(new Error(e.message)); };
    instance.onmessage = e => {
      stop();
      if (e.data.error) { reject(new Error(e.data.error)); return; }
      try {
        const parsed = new DOMParser().parseFromString(e.data.svg, "text/html");
        const svg = parsed.querySelector("svg");
        if (!svg) throw new Error("TikZ did not produce an SVG element.");
        for (const node of [svg, ...Array.from(svg.querySelectorAll("[style]"))]) {
          const style = (node as SVGElement).style;
          for (const name of ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "opacity", "font-family", "font-size", "font-weight", "font-style", "text-anchor"]) {
            const value = style.getPropertyValue(name); if (value) node.setAttribute(name, value);
          }
          node.removeAttribute("style");
        }
        for (const [name, value] of Object.entries(e.data.attrs || {})) svg.setAttribute(name, String(value));
        resolve(new XMLSerializer().serializeToString(svg));
      } catch (error) { reject(error); }
    };
    instance.postMessage({ wasm: assets.wasm, core: assets.core });
  });
}
async function render(request: any): Promise<any> {
  stop();
  surface.replaceChildren();
  if (!["svg", "mermaid", "tikz"].includes(request.kind)) throw new Error("Only static SVG, Mermaid and TikZ images are supported.");
  let svg = request.source;
  if (request.kind === "mermaid") {
    if (/%%\s*\{|^\s*---/m.test(svg)) throw new Error("Mermaid configuration directives are disabled; supply only the diagram.");
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", maxTextSize: 256000, maxEdges: 1000, flowchart: { htmlLabels: false }, htmlLabels: false });
    const result = await mermaid.render("diagram", svg, surface);
    // Mermaid's strict output still has styles. Resolve those inside this
    // unprivileged frame, then export only supported presentation attributes.
    surface.innerHTML = result.svg;
    const element = surface.querySelector("svg")!;
    // Decorative Mermaid shadows are outside our portable shape subset.
    for (const filter of Array.from(element.querySelectorAll("filter"))) filter.remove();
    for (const node of Array.from(element.querySelectorAll("*"))) {
      if (node.localName === "style") continue;
      const style = getComputedStyle(node);
      for (const name of ["fill", "stroke", "stroke-width", "stroke-dasharray", "opacity", "font-family", "font-size", "font-weight", "text-anchor"]) node.setAttribute(name, style.getPropertyValue(name));
      node.removeAttribute("style");
      node.removeAttribute("filter");
    }
    for (const style of Array.from(element.querySelectorAll("style"))) style.remove();
    element.removeAttribute("style");
    svg = new XMLSerializer().serializeToString(element);
  } else if (request.kind === "tikz") svg = await tikz(svg, request.assets);
  svg = sanitizeVisualSvg(svg, document);
  // Font CSS is trusted, locally bundled, data-only and added after validation.
  const displaySvg = request.fontCSS ? svg.replace(/(<svg\b[^>]*>)/, `$1<style>${request.fontCSS}</style>`) : svg;
  surface.replaceChildren();
  const img = new Image(); img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(displaySvg)}`; surface.append(img);
  return { svg, ...await raster(displaySvg), diagnostics: ["Rendered locally in an opaque-origin sandbox."] };
}
window.addEventListener("message", event => {
  if (channel || event.data?.token !== token || event.data.type !== "connect" || !event.ports[0]) return;
  channel = event.ports[0];
  channel.onmessage = async message => {
    if (message.data?.token !== token || !message.data.request) return;
    try { send({ id: message.data.id, result: await render(message.data.request) }); }
    catch (error) { stop(); send({ id: message.data.id, error: String(error) }); }
  };
  send({ type: "ready" });
});
