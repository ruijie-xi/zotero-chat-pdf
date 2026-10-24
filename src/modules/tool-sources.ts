import type { ToolExecutionContext } from "./tools";
import { visualSourceIds } from "./visual-tools";

/** Shared provenance accounting, independent of transport/executor substitutions. */
export function toolResultSourceIds(name: string, args: Record<string, unknown>, context: ToolExecutionContext): string[] {
  if (["create_visual", "read_visual", "update_visual", "inspect_visual"].includes(name)) return visualSourceIds(args, context);
  const documentTools = new Set(["list_images", "read_image", "read_pdf_text", "read_pdf_page", "inspect_pdf_page", "locate_pdf_content", "get_document_status"]);
  if (name === "list_sources") return [...context.turnScope];
  if (!documentTools.has(name)) return [];
  const identifier = String(args.key || args.source_key || "");
  const source = identifier ? context.session.getSource(identifier) : undefined;
  return source ? [source.id] : [];
}
