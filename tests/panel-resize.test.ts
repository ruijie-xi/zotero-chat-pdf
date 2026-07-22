import { describe, expect, it } from "vitest";
import {
  clampPanelWidth,
  normalizePreferredPanelWidth,
  panelWidthAfterDrag,
  relaxHostWidthConstraints,
} from "../src/modules/panel-resize";

describe("panel resize", () => {
  it("does not impose a proportional maximum", () => {
    expect(clampPanelWidth(900, 1000, 5)).toBe(900);
    expect(clampPanelWidth(1200, 1000, 5)).toBe(995);
  });

  it("keeps the normal minimum when space permits and degrades in a narrow host", () => {
    expect(clampPanelWidth(100, 1000, 5)).toBe(280);
    expect(clampPanelWidth(280, 240, 5)).toBe(235);
  });

  it("calculates drag width for panels on either side of the handle", () => {
    expect(panelWidthAfterDrag(350, 700, 600, true)).toBe(450);
    expect(panelWidthAfterDrag(350, 300, 400, false)).toBe(450);
  });

  it("normalizes only valid stored preferences", () => {
    expect(normalizePreferredPanelWidth("640")).toBe(640);
    expect(normalizePreferredPanelWidth(279)).toBeNull();
    expect(normalizePreferredPanelWidth("not a number")).toBeNull();
  });

  it("relaxes only in-flow host panes and restores their inline constraints", () => {
    document.body.innerHTML = `
      <div id="layout">
        <div id="overlay" style="position: absolute; min-width: 900px;"></div>
        <div id="content" style="min-width: 500px; flex-shrink: 0;"></div>
        <div id="zotero-context-splitter"></div>
        <div id="handle"></div>
        <div id="panel"></div>
      </div>
    `;
    const layout = document.querySelector("#layout")!;
    const content = document.querySelector("#content") as HTMLElement;
    const overlay = document.querySelector("#overlay") as HTMLElement;
    const handle = document.querySelector("#handle") as HTMLElement;
    const panel = document.querySelector("#panel") as HTMLElement;

    const restore = relaxHostWidthConstraints(layout, panel, handle);
    expect(content.style.minWidth).toBe("0px");
    expect(content.style.flexShrink).toBe("1");
    expect(overlay.style.minWidth).toBe("900px");

    restore();
    expect(content.style.minWidth).toBe("500px");
    expect(content.style.flexShrink).toBe("0");
  });
});
