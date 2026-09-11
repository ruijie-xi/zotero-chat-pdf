export interface ToolResultCandidate {
  toolName: string;
  result: string;
}

export interface PreparedToolResult {
  content: string;
  contextDelivery: "complete" | "omitted";
  contextMessage?: string;
}

function retryGuidance(toolName: string): string {
  switch (toolName) {
    case "search_document":
      return "Retry with a narrower query, a smaller max_results value, or fewer context_lines.";
    case "read_document":
      return "Retry with a narrower start_line/end_line range, or use page-based chunks.";
    case "web_fetch":
      return "Retry with a smaller max_bytes value or fetch a more specific page.";
    case "search_zotero_library":
    case "search_zotero_annotations":
    case "list_zotero_collections":
    case "list_collection_items":
      return "Retry with a more specific filter and a smaller max_results value.";
    default:
      return "Retry with narrower arguments or a smaller explicit result limit.";
  }
}

function omissionMessage(
  candidate: ToolResultCandidate,
  reason: string,
): string {
  return "[ChatPDF context protection]\n" +
    `${candidate.toolName} produced ${candidate.result.length} characters, ${reason}. ` +
    "The complete result was retained in the session tool history but was not inserted into the model context. " +
    retryGuidance(candidate.toolName);
}

/**
 * Keep full tool results for persistence/UI, while explicitly withholding a
 * result from model context when it would consume an unsafe share of the
 * configured context. Nothing is silently truncated.
 */
export function prepareToolResultsForContext(
  candidates: ToolResultCandidate[],
  currentContextChars: number,
  configuredContextMaxChars: number,
): PreparedToolResult[] {
  const contextMax = Number.isFinite(configuredContextMaxChars)
    ? Math.max(20_000, configuredContextMaxChars)
    : 240_000;
  const reserve = Math.min(32_000, Math.max(4_000, Math.floor(contextMax * 0.15)));
  const remaining = Math.max(0, contextMax - Math.max(0, currentContextChars) - reserve);
  const singleLimit = Math.min(80_000, Math.max(8_000, Math.floor(contextMax * 0.35)));
  const batchLimit = Math.min(120_000, Math.floor(contextMax * 0.5), remaining);
  let deliveredChars = 0;

  return candidates.map((candidate) => {
    let contextMessage: string | undefined;
    if (candidate.result.length > singleLimit) {
      contextMessage = omissionMessage(
        candidate,
        `which exceeds the per-result context limit of ${singleLimit} characters`,
      );
    } else if (deliveredChars + candidate.result.length > batchLimit) {
      contextMessage = omissionMessage(
        candidate,
        `which would exceed the remaining batch context budget of ${Math.max(0, batchLimit - deliveredChars)} characters`,
      );
    }

    if (contextMessage) {
      deliveredChars += contextMessage.length;
      return { content: contextMessage, contextDelivery: "omitted", contextMessage };
    }

    deliveredChars += candidate.result.length;
    return { content: candidate.result, contextDelivery: "complete" };
  });
}
