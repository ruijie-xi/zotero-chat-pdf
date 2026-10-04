import { beforeEach, expect, it, vi } from "vitest";
import { ChatSession } from "../src/modules/chat-session";
const mocks = vi.hoisted(() => ({ state: null as any }));
vi.mock("../src/modules/panel-state", () => ({ getPanelState: () => mocks.state }));
vi.mock("../src/modules/conversion-inspector", () => ({ openConversionInspector: vi.fn(), conversionSummaryText: () => "", conversionProgressText: (status: any) => `Receiving ${status.completedPages}/19` }));
vi.mock("../src/modules/chat-history", () => ({ saveSession: vi.fn() }));
import { refreshSourceChips } from "../src/modules/source-chips";
import { openConversionInspector } from "../src/modules/conversion-inspector";
let root: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="chatpdf-root"><div id="chatpdf-source-chips"></div></div>';
  root = document.querySelector("#chatpdf-root")!;
  mocks.state = { session: new ChatSession(), windowId: "one", win: window, conversionAbortControllers: new Map(), chatInput: null };
});
const inspect = () => root.querySelector('[data-action="view-conversion"]')! as HTMLButtonElement;
it("retains a focused and pressed process button across streamed progress and completion", () => {
  const source = mocks.state.session.addSource("PDF", "Paper", undefined, 1);
  source.status = "converting"; source.conversionStatus = { completedPages: 0 } as any;
  refreshSourceChips(root);
  expect(inspect().closest(".chatpdf-source-chip")).not.toBeNull();
  expect(root.querySelector(".chatpdf-source-conversion-row")).toBeNull();
  const button = inspect(), observer = new MutationObserver(() => {});
  observer.observe(root, { childList: true, subtree: true });
  button.focus(); button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  for (let page = 1; page <= 19; page++) {
    source.conversionStatus = { completedPages: page } as any;
    refreshSourceChips(root);
    expect(inspect()).toBe(button); expect(button.isConnected).toBe(true); expect(document.activeElement).toBe(button);
  }
  source.status = "ready"; source.markdown = "complete"; refreshSourceChips(root);
  expect(inspect()).toBe(button);
  expect(observer.takeRecords().some(record => [...record.removedNodes].some(node => node === button || (node as Element).contains?.(button)))).toBe(false);
  observer.disconnect(); button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); button.click();
  expect(openConversionInspector).toHaveBeenCalledWith(root, source, expect.any(Function));
});
it("replaces the row for a removed and readded identity so its callback cannot use the old source", () => {
  const old = mocks.state.session.addSource("PDF", "Old", undefined, 1);
  refreshSourceChips(root); const previous = inspect();
  mocks.state.session.removeSource(old.id);
  const source = mocks.state.session.addSource("PDF", "New", undefined, 1);
  refreshSourceChips(root);
  expect(previous.isConnected).toBe(false);
  inspect().click(); expect(openConversionInspector).toHaveBeenCalledWith(root, source, expect.any(Function));
});
it("offers removal and reconversion in a keyboard-dismissable context menu without replacing the chip", () => {
  const source = mocks.state.session.addSource("PDF", "Paper", undefined, 1); source.status = "ready";
  refreshSourceChips(root);
  const chip = root.querySelector(".chatpdf-source-chip")!;
  chip.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const menu = root.querySelector(".chatpdf-source-menu")!;
  expect(menu.textContent).toMatch(/Reconvert|重新识别/);
  refreshSourceChips(root); expect(root.querySelector(".chatpdf-source-chip")).toBe(chip);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(menu.isConnected).toBe(false);
});
