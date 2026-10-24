const SVG_NS = "http://www.w3.org/2000/svg";
const tags = new Set("svg g defs title desc rect circle ellipse line polyline polygon path text tspan textPath marker clipPath mask linearGradient radialGradient stop use symbol".split(" "));
const attrs = new Set("id x y x1 x2 y1 y2 cx cy r rx ry width height viewBox preserveAspectRatio d points transform fill stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-miterlimit fill-rule clip-rule opacity fill-opacity stroke-opacity font-family font-size font-weight font-style text-anchor dominant-baseline alignment-baseline dx dy rotate textLength lengthAdjust marker-start marker-mid marker-end markerWidth markerHeight markerUnits refX refY orient gradientUnits gradientTransform offset stop-color stop-opacity clip-path clipPathUnits mask maskUnits maskContentUnits href startOffset".split(" "));
const styles = new Set("fill stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset fill-opacity stroke-opacity opacity font-family font-size font-weight font-style text-anchor dominant-baseline".split(" "));
function safeValue(value: string): boolean {
  return value.length <= 100_000 && !/[<>\\\x00-\x08]/.test(value) && !/(?:javascript|data|https?|file|chrome|resource)\s*:|@|expression\s*\(/i.test(value) && !/url\(/i.test(value.replace(/url\(\s*["']?#[\w.-]+["']?\s*\)/g, ""));
}
/** Dedicated SVG boundary. This never changes the ordinary Markdown allowlist. */
export function sanitizeVisualSvg(source: string, doc: Document): string {
  if (source.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error("SVG exceeds 2 million characters or declares entities.");
  const realm = doc.defaultView as any;
  const parsed = new realm.DOMParser().parseFromString(source, "image/svg+xml") as Document;
  if (parsed.querySelector("parsererror") || parsed.documentElement?.localName !== "svg") throw new Error("Invalid SVG document.");
  let count = 0;
  const visit = (element: Element, depth: number) => {
    if (++count > 10_000 || depth > 100) throw new Error("SVG exceeds 10000 elements or 100 levels.");
    if (element.namespaceURI !== SVG_NS || !tags.has(element.localName)) throw new Error(`SVG element is not supported: ${element.localName}`);
    for (const attribute of Array.from(element.attributes)) {
      const { name, value, localName, namespaceURI } = attribute;
      if (name === "xmlns" || name === "xmlns:xlink") continue;
      if (name === "style") {
        for (const declaration of value.split(";")) {
          if (!declaration.trim()) continue;
          const colon = declaration.indexOf(":");
          const property = declaration.slice(0, colon).trim();
          const content = declaration.slice(colon + 1).trim();
          if (!styles.has(property) || !safeValue(content)) throw new Error(`Unsupported SVG style: ${property}`);
          element.setAttribute(property, content);
        }
        element.removeAttribute(name);
      } else if (name === "class" || name.startsWith("aria-") || name.startsWith("data-") || name === "role") element.removeAttribute(name);
      else {
        if ((namespaceURI && namespaceURI !== "http://www.w3.org/1999/xlink") || !attrs.has(localName) || !safeValue(value)) throw new Error(`Unsafe or unsupported SVG attribute: ${name}`);
        if (localName === "href" && !/^#[\w.-]+$/.test(value)) throw new Error("SVG references must point to an internal #id.");
        if (localName === "id" && !/^[\w.-]+$/.test(value)) throw new Error("SVG ids must contain letters, numbers, dot, dash or underscore.");
      }
    }
    for (const child of Array.from(element.childNodes) as Node[]) {
      if (child.nodeType === 1) visit(child as Element, depth + 1);
      else if (child.nodeType !== 3) element.removeChild(child);
    }
  };
  visit(parsed.documentElement!, 0);
  const root = parsed.documentElement!;
  root.setAttribute("xmlns", SVG_NS);
  if (!root.hasAttribute("viewBox")) {
    const width = parseFloat(root.getAttribute("width") || "800");
    const height = parseFloat(root.getAttribute("height") || "480");
    if (!(width > 0 && height > 0 && width <= 10000 && height <= 10000)) throw new Error("Invalid SVG dimensions.");
    root.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }
  const box = root.getAttribute("viewBox")!.trim().split(/[ ,]+/).map(Number);
  if (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0 || box[2] > 10000 || box[3] > 10000) throw new Error("SVG viewBox must have finite dimensions up to 10000.");
  return new realm.XMLSerializer().serializeToString(root);
}
export function svgDataUrl(source: string): string { return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`; }
