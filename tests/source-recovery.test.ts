import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ state: {} as any }));
vi.mock("../src/modules/conversion-manager", () => ({
  conversionRequestFromSource: (source: any) => ({ key: source.key, libraryID: source.libraryID }),
  recoverConversion: vi.fn(),
  startConversion: vi.fn(),
  releaseConversion: vi.fn(),
  subscribeConversion: vi.fn(() => () => undefined),
  waitForConversion: vi.fn(),
}));
vi.mock("../src/modules/md-cache", () => ({ read: vi.fn(async () => "Recovered Markdown"), readManifest: vi.fn(async () => null) }));
vi.mock("../src/modules/chat-history", () => ({ saveSession: vi.fn(async () => undefined) }));
vi.mock("../src/modules/zotero-items", () => ({ openPdfForSourceKey: vi.fn() }));
vi.mock("../src/modules/panel-state", () => ({
  getPanelState: () => mocks.state,
  createAbortController: () => {
    const controller = new AbortController();
    return { controller, signal: controller.signal };
  },
}));

import { ChatSession } from "../src/modules/chat-session";
import { convertSource, recoverSource, refreshSourceChips } from "../src/modules/source-chips";
import { recoverConversion, startConversion, waitForConversion } from "../src/modules/conversion-manager";
import { saveSession } from "../src/modules/chat-history";
import { readManifest } from "../src/modules/md-cache";

describe("source recovery UI", () => {
  let root: HTMLElement;
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '<div id="chatpdf-root"><div id="chatpdf-source-chips"></div></div>';
    root = document.querySelector("#chatpdf-root")!;
    mocks.state = { session: new ChatSession(), windowId: "test", win: window, conversionAbortControllers: new Map(), chatInput: null };
    vi.mocked(recoverConversion).mockResolvedValue({ jobId: "saved-job" } as any);
    vi.mocked(startConversion).mockResolvedValue({ jobId: "saved-job" } as any);
    vi.mocked(waitForConversion).mockResolvedValue({ state: "ready" } as any);
    vi.mocked(readManifest).mockResolvedValue(null);
  });

  it("readding a source recovers Markdown, refreshes the chip, and persists Ready", async () => {
    const source = mocks.state.session.addSource("PDF", "Paper", undefined, 1);
    recoverSource(source, root);
    await vi.waitFor(() => expect(source.status).toBe("ready"));
    expect(source.markdown).toBe("Recovered Markdown");
    expect(root.textContent).toContain("chars");
    expect(startConversion).not.toHaveBeenCalled();
    expect(saveSession).toHaveBeenCalledWith(expect.objectContaining({
      sources: [expect.objectContaining({ status: "ready" })],
    }));
  });
  it("shows model self-check scope from the committed cache without claiming independent review", async () => {
    vi.mocked(readManifest).mockResolvedValue({ converter: "vision", pageCount: 1, chunks: [{ selfCheck: {
      method: "same-response", version: 1, pages: [1], editsApplied: 0, edits: [], markdownDigest: "0".repeat(64),
    } }] } as any);
    const source = mocks.state.session.addSource("PDFCHECK", "Checked paper", undefined, 1);
    await convertSource(source, undefined, undefined, mocks.state, mocks.state.session);
    refreshSourceChips(root);
    expect(root.textContent).toContain("Self-check 1/1");
    expect(root.querySelector('[title*="not independent verification"]')).not.toBeNull();
    expect(source.selfCheck).toEqual({ pagesChecked: 1, pagesTotal: 1, editsApplied: 0 });
  });

  it("an unknown source remains pending without starting a new conversion", async () => {
    vi.mocked(recoverConversion).mockResolvedValue(null);
    const source = mocks.state.session.addSource("NEW", "New paper", undefined, 1);
    await convertSource(source, undefined, undefined, mocks.state, mocks.state.session, true);
    expect(source.status).toBe("pending");
    expect(startConversion).not.toHaveBeenCalled();
    expect(saveSession).not.toHaveBeenCalled();
  });

  it("an error chip exposes Retry and uses explicit conversion recovery", async () => {
    const source = mocks.state.session.addSource("FAILED", "Failed paper", undefined, 1);
    mocks.state.session.setSourceStatus(source.id, "error", "Timed out");
    refreshSourceChips(root);
    const retry = [...root.querySelectorAll("button")].find(button => button.textContent === "Retry");
    expect(retry).toBeDefined();
    retry!.click();
    await vi.waitFor(() => expect(source.status).toBe("ready"));
    expect(startConversion).toHaveBeenCalledOnce();
  });

  it("late results cannot mark a removed and readded source Ready", async () => {
    const completion = Promise.withResolvers<any>();
    vi.mocked(waitForConversion).mockReturnValue(completion.promise);
    const session = mocks.state.session;
    const old = session.addSource("REMOVED", "Paper", undefined, 1);
    const recovering = convertSource(old, undefined, undefined, mocks.state, session, true);
    await vi.waitFor(() => expect(waitForConversion).toHaveBeenCalledOnce());
    session.removeSource(old.id);
    const replacement = session.addSource("REMOVED", "Paper", undefined, 1);
    completion.resolve({ state: "ready" });
    await recovering;
    expect(replacement.status).toBe("pending");
    expect(saveSession).not.toHaveBeenCalled();
  });
});
