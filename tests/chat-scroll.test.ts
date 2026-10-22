import { describe, expect, it } from "vitest";
import { preserveBottomScroll } from "../src/utils/dom";

describe("chat scroll position across layout changes", () => {
  it("keeps following a growing answer when the usage bar reduces the viewport", () => {
    const pane = { scrollTop: 400, scrollHeight: 600, clientHeight: 200 } as HTMLElement;
    preserveBottomScroll(pane, () => {
      Object.assign(pane, { scrollHeight: 1000, clientHeight: 120 });
    });
    expect(pane.scrollTop).toBe(1000);
  });

  it("preserves the position of someone reading earlier messages", () => {
    const pane = { scrollTop: 100, scrollHeight: 600, clientHeight: 200 } as HTMLElement;
    preserveBottomScroll(pane, () => {
      Object.assign(pane, { scrollHeight: 1000, clientHeight: 120 });
    });
    expect(pane.scrollTop).toBe(100);
  });
});
