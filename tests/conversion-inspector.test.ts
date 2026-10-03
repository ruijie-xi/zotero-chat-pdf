import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyConversionDetails } from "../src/modules/conversion-details";
import { ChatSession } from "../src/modules/chat-session";
import { openConversionInspector, conversionSummaryText } from "../src/modules/conversion-inspector";
const mocks = vi.hoisted(() => ({ state: null as any, status: null as any, details: null as any, draft: "", listener: null as any }));
vi.mock("../src/modules/panel-state", () => ({ getPanelState: () => mocks.state }));
vi.mock("../src/modules/zotero-items", () => ({ openPdfForSourceKey: vi.fn() }));
vi.mock("../src/modules/conversion-manager", () => ({
  latestConversionForDocument: () => mocks.status, getConversionDetails: () => mocks.details,
  getConversionDraft: () => mocks.draft, cancelConversion: vi.fn(),
  readConversionPage: vi.fn(), subscribeConversion: vi.fn((_id, listener) => { mocks.listener = listener; return vi.fn(); }),
}));
import { cancelConversion, readConversionPage } from "../src/modules/conversion-manager";
let root: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="chatpdf-root"></div>'; root = document.querySelector("#chatpdf-root")!;
  mocks.state = { session: new ChatSession(), windowId: "one", win: window, conversionInspectorCleanup: null };
  mocks.details = { ...emptyConversionDetails(), pageCount: 2, renderedPages: [1], chunks: [{ index: 1, startPage: 1, endPage: 2, stage: "receiving" }] };
  mocks.status = { jobId: "one", state: "converting", stage: "vision", totalPages: 2, completedPages: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), retryable: false };
  mocks.draft = "<!-- danger --><img src=x onerror=alert(1)>";
  vi.mocked(readConversionPage).mockResolvedValue({ markdown: mocks.draft, validated: false, edits: [], selfChecked: false, image: "data:image/jpeg;base64,/9j/2Q==" });
});
afterEach(() => mocks.state.conversionInspectorCleanup?.());
const button = (label: string) => [...root.querySelectorAll("button")].find(element => element.textContent === label)!;
describe("conversion process viewer", () => {
  it("summarizes additional requests and actual reported usage without inventing old request history", () => {
    expect(conversionSummaryText({ ...mocks.status, requestCount: 9, additionalRequests: 6, reusedPages: 4, requestIssue: "self-check", usage: { prompt_tokens: 200, completion_tokens: 100 } })).toContain("6 additional requests");
    expect(conversionSummaryText({ ...mocks.status, usage: { prompt_tokens: 200 } })).toContain("200/unknown");
    expect(conversionSummaryText({ ...mocks.status, state: "ready", requestCount: 0, options: { engine: "vision" } })).toContain("Request history unavailable");
  });
  it("keeps chunk navigation attached and clickable across frequent progress updates", async () => {
    mocks.details.chunks = [{ index: 1, startPage: 1, endPage: 1, stage: "receiving" }, { index: 2, startPage: 2, endPage: 2, stage: "queued" }];
    openConversionInspector(root, mocks.state.session.addSource("PDF", "Paper", undefined, 1));
    const chunk = root.querySelectorAll(".chatpdf-conversion-chunk")[1] as HTMLButtonElement;
    chunk.focus();
    for (let i = 0; i < 10; i++) { mocks.details.chunks[1].stage = i % 2 ? "receiving" : "validating"; mocks.listener(); }
    expect(root.querySelectorAll(".chatpdf-conversion-chunk")[1]).toBe(chunk);
    expect(document.activeElement).toBe(chunk);
    chunk.click(); await vi.waitFor(() => expect(readConversionPage).toHaveBeenCalledWith("one", 2, false));
  });
  it("opens pending sources without starting conversion and closes cleanly", () => {
    mocks.status = null;
    openConversionInspector(root, mocks.state.session.addSource("PDF", "Paper", undefined, 1));
    expect(root.textContent).toContain("does not start a model request");
    expect(readConversionPage).not.toHaveBeenCalled();
    button("Back to chat").click(); expect(root.querySelector("section")).toBeNull();
  });
  it("shows live unvalidated text safely beside the sent image, with explicit Stop", async () => {
    openConversionInspector(root, mocks.state.session.addSource("PDF", "Paper", undefined, 1));
    await vi.waitFor(() => expect(root.textContent).toContain("not yet validated"));
    expect(root.querySelector(".chatpdf-conversion-document img")).toBeNull();
    expect(root.querySelector(".chatpdf-conversion-image img")).not.toBeNull();
    expect(root.querySelector("progress")!.getAttribute("value")).not.toBe("100");
    button("Stop").click(); expect(cancelConversion).toHaveBeenCalledWith("one");
  });
  it("displays validated Markdown and exact self-check edits separately, and navigates pages", async () => {
    mocks.status = { ...mocks.status, state: "ready", stage: "ready", completedPages: 2 };
    vi.mocked(readConversionPage).mockResolvedValue({ markdown: "# Result\n$E=mc^2$", validated: true, selfChecked: true, edits: [{ page: 1, old: "mc^3", new: "mc^2" }] });
    openConversionInspector(root, mocks.state.session.addSource("PDF", "Paper", undefined, 1));
    await vi.waitFor(() => expect(root.querySelector(".chatpdf-conversion-document h1")).not.toBeNull());
    expect(root.textContent).toContain("Program checks passed"); expect(root.textContent).toContain("Model self-check: 1 edits");
    expect(root.querySelector(".chatpdf-conversion-old")!.textContent).toBe("mc^3");
    button("Show Markdown source").click(); expect(root.querySelector(".chatpdf-conversion-document pre")!.textContent).toContain("# Result");
    button("→").click(); await vi.waitFor(() => expect(readConversionPage).toHaveBeenCalledWith("one", 2, true));
    expect(root.querySelector("progress")!.getAttribute("value")).toBe("100");
  });
  it("discards an asynchronous page read after the viewer closes", async () => {
    let resolve!: (value: any) => void;
    vi.mocked(readConversionPage).mockReturnValue(new Promise(r => { resolve = r; }));
    openConversionInspector(root, mocks.state.session.addSource("PDF", "Paper", undefined, 1));
    button("Back to chat").click(); resolve({ markdown: "late text", validated: true, edits: [], selfChecked: false });
    await Promise.resolve(); expect(root.textContent).not.toContain("late text"); expect(cancelConversion).not.toHaveBeenCalled();
  });
});
