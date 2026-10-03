import { describe, expect, it } from "vitest";
import { applyConversionEvent, conversionCounts, conversionDraftPage, conversionRequestSummary, conversionReportedUsage, emptyConversionDetails, safeConversionMessage, interruptConversionRequests } from "../src/modules/conversion-details";

describe("conversion diagnostics", () => {
  it("counts split and retry requests without treating each initial chunk as a retry", () => {
    const details = emptyConversionDetails();
    for (const [id, chunk, state, error] of [["one", 1, "rejected", "PDF model self-check is missing"], ["two", 2, "accepted", ""], ["three", 1, "accepted", ""], ["four", 1, "accepted", ""]] as const) {
      details.requests.push({ id, chunk, state, error, pages: [chunk], startedAt: 1, estimatedInputTokens: 20, imageBytes: 10 });
    }
    expect(conversionRequestSummary(details)).toEqual({ additionalRequests: 2, rejectedRequests: 1, requestIssue: "self-check" });
  });
  it("preserves missing usage as unknown and includes usage from rejected attempts", () => {
    const details = emptyConversionDetails();
    expect(conversionReportedUsage(details)).toBeUndefined();
    details.requests.push({ id: "one", chunk: 1, pages: [1], startedAt: 1, state: "rejected", estimatedInputTokens: 20, imageBytes: 10, usage: { prompt_tokens: 40 } });
    expect(conversionReportedUsage(details)).toEqual({ prompt_tokens: 40 });
    details.requests[0].usage = { prompt_tokens: 40, completion_tokens: 10 };
    expect(conversionReportedUsage(details)).toEqual({ prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 });
  });
  it("marks restored live requests interrupted without inventing usage or end time", () => {
    const details = emptyConversionDetails();
    applyConversionEvent(details, { type: "request", request: { id: "one", chunk: 1, pages: [1], startedAt: 1, state: "receiving", imageBytes: 10, estimatedInputTokens: 20 } });
    interruptConversionRequests(details);
    expect(details.requests[0]).toMatchObject({ state: "interrupted" });
    expect(details.requests[0].endedAt).toBeUndefined(); expect(details.requests[0].usage).toBeUndefined();
  });
  it("counts validated pages independently of rendering, completion order, and plan size", () => {
    const details = emptyConversionDetails();
    applyConversionEvent(details, { type: "plan", pageCount: 5, chunks: [{ index: 1, startPage: 1, endPage: 4 }, { index: 2, startPage: 5, endPage: 5 }] });
    applyConversionEvent(details, { type: "rendered", page: 5 }); applyConversionEvent(details, { type: "rendered", page: 5 });
    applyConversionEvent(details, { type: "chunk", chunk: 2, stage: "ready", reused: true }, 10);
    expect(conversionCounts(details)).toEqual({ completedPages: 1, reusedPages: 1, renderedPages: 1 });
    applyConversionEvent(details, { type: "chunk", chunk: 1, stage: "receiving" });
    expect(conversionCounts(details).completedPages).toBe(1);
    applyConversionEvent(details, { type: "chunk", chunk: 1, stage: "ready" }, 20);
    expect(conversionCounts(details).completedPages).toBe(5);
    expect(details.chunks[1].endedAt).toBe(10);
  });
  it("keeps cumulative request history across recovery and sanitizes failures and usage", () => {
    const details = emptyConversionDetails();
    applyConversionEvent(details, { type: "request", request: { id: "one", chunk: 1, pages: [1], startedAt: 1, state: "waiting", imageBytes: 10, estimatedInputTokens: 20 } });
    applyConversionEvent(details, { type: "request-update", id: "one", patch: { state: "error", endedAt: 2, error: 'Cannot read C:\\Private\\paper.pdf (NS_ERROR_FILE_ACCESS_DENIED)', usage: { prompt_tokens: 10, secret: "private" } as any } });
    applyConversionEvent(details, { type: "plan", pageCount: 1, chunks: [{ index: 1, startPage: 1, endPage: 1 }] });
    expect(details.requests).toHaveLength(1);
    expect(JSON.stringify(details)).not.toContain("Private"); expect(JSON.stringify(details)).not.toContain("secret");
    expect(details.requests[0].error).toContain("NS_ERROR_FILE_ACCESS_DENIED");
    expect(safeConversionMessage("Failed at https://host.test/key")).not.toContain("host.test");
  });
  it("shows only the selected page and excludes audit and partial control markers", () => {
    const text = "<!-- chatpdf-page:1 -->\nFirst\n<!-- chatpdf-page:2 -->\nSecond\n<!-- chatpdf-self-check:v1 -->\n{\"edits\":[]}";
    expect(conversionDraftPage(text, 1)).toBe("First"); expect(conversionDraftPage(text, 2)).toBe("Second");
    expect(conversionDraftPage("<!-- chatpdf-page:1 -->\nbody\n<!-- chatpdf-sel", 1)).toBe("body");
    expect(conversionDraftPage(text, 3)).toBe("");
  });
});
