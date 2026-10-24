import type { ToolExecutionContext } from "./tools";
import { validateVisualInput, type VisualInput, type VisualRef, type VisualVersion } from "./visual-model";
import { renderVisual } from "./visual-renderer";
import { throwIfAborted } from "../utils/abort";

export function visualSourceIds(args: Record<string, unknown>, context: ToolExecutionContext): string[] {
  if (Array.isArray(args.citations)) return [...new Set(args.citations.map((c: any) => String(c.source_id)))];
  if (typeof args.id === "string") {
    const v = args.version ? context.session.visuals.get({ id: args.id, version: Number(args.version) }) : context.session.visuals.latest(args.id);
    return v?.citations.map(c => c.sourceId) || [];
  }
  return [...new Set(context.session.visuals.list().flatMap(v => v.citations.map(c => c.sourceId)))];
}
function authorize(visual: Pick<VisualInput, "citations">, context: ToolExecutionContext): void {
  throwIfAborted(context.signal);
  for (const c of visual.citations) if (!context.turnScope.has(c.sourceId) || !context.session.getSource(c.sourceId)) throw new Error(`Visual citation is outside this turn's sources: ${c.sourceId}`);
}
function receipt(v: VisualVersion, includeSource = false) {
  const { id, version, title, kind, description, dataMode, citations, width, height, diagnostics } = v;
  return { type: "chatpdf_visual", id, version, title, kind, description, data_mode: dataMode, citations, width, height, diagnostics, ...(includeSource ? { source: v.source } : {}) };
}
export async function executeVisualTool(name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<string> {
  const library = context.session.visuals;
  const epoch = library.epoch;
  const callId = `${context.requestId}:${context.callId || context.requestId}`;
  const check = (v: Pick<VisualInput, "citations">) => { authorize(v, context); if (library.epoch !== epoch) throw Object.assign(new Error("Visual render revoked."), { name: "AbortError" }); };
  if (name === "create_visual" || name === "update_visual") {
    const old = library.byCall(callId);
    if (old) { check(old); context.deliverVisual?.(old); return JSON.stringify(receipt(old)); }
    const input: VisualInput = { title: String(args.title), kind: args.kind as VisualInput["kind"], source: String(args.source), description: String(args.description), dataMode: args.data_mode as VisualInput["dataMode"], citations: (args.citations as any[]).map(c => ({ sourceId: c.source_id, page: c.page, ...(c.label ? { label: c.label } : {}) })) };
    validateVisualInput(input); check(input);
    const expected = name === "update_visual" ? Number(args.expected_version) : 0;
    const id = name === "update_visual" ? String(args.id) : `vis-${crypto.randomUUID()}`;
    if ((library.latest(id)?.version || 0) !== expected) throw new Error("Visual version conflict. Read the latest version before updating.");
    if (expected) check(library.latest(id)!);
    const output = await renderVisual(input, context.signal);
    check(input);
    const visual = library.commit(input, output, id, expected, callId, epoch);
    context.session.updatedAt = Date.now();
    context.deliverVisual?.(visual);
    return JSON.stringify(receipt(visual));
  }
  if (!args.id && name === "read_visual") {
    const visuals = library.list().filter(v => v.citations.every(c => context.turnScope.has(c.sourceId) && context.session.getSource(c.sourceId)));
    return JSON.stringify({ visuals: visuals.map(v => receipt(v, !!args.include_source)) });
  }
  const ref: VisualRef = { id: String(args.id), version: args.version ? Number(args.version) : library.latest(String(args.id))?.version || 0 };
  const visual = library.get(ref);
  if (!visual) throw new Error("Visual version not found. Use read_visual to list this session's visuals.");
  check(visual);
  if (name === "read_visual") { context.deliverVisual?.(ref); return JSON.stringify(receipt(visual, !!args.include_source)); }
  if (args.preview && (context.imageInputRejected || !context.deliverImage)) throw new Error("Preview requires image input support. Use inspect_visual with preview=false for diagnostics.");
  const output = await renderVisual(visual, context.signal);
  check(visual);
  if (args.preview && output.png) context.deliverImage!({ sourceId: visual.citations[0]?.sourceId || "", path: `visuals/${ref.id}/v${ref.version}.png`, label: `${visual.title} (model-created ${visual.dataMode} diagram; not an original paper figure)`, dataUrl: output.png, mime: "image/png", byteLength: Math.floor(output.png.split(",")[1].length * 3 / 4) });
  context.deliverVisual?.(ref);
  return JSON.stringify({ ...receipt(visual), diagnostics: output.diagnostics, preview_delivered: !!args.preview && !!output.png });
}
