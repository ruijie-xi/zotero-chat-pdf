import { describe, expect, it } from "vitest";
import {
  clampPanelWidth,
  controlHostContentWidth,
  findPanelHost,
  normalizePreferredPanelWidth,
  panelWidthAfterDrag,
  recoverCorruptZoteroContextWidth,
} from "../src/modules/panel-resize";

describe("panel resize", () => {
  it("hosts the panel outside Zotero's complete app content", () => {
    document.body.innerHTML = `
      <hbox id="browser">
        <vbox id="appcontent">
          <hbox id="native-layout">
            <deck id="tabs-deck"></deck>
            <splitter id="zotero-context-splitter"></splitter>
            <box id="zotero-context-pane"></box>
          </hbox>
        </vbox>
      </hbox>
    `;
    const host = findPanelHost(document);
    expect(host?.layoutBox.id).toBe("browser");
    expect(host?.hostContent.id).toBe("appcontent");
    expect(host?.layoutBox.contains(document.querySelector("#zotero-context-pane"))).toBe(true);
  });

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

  it("sizes only the selected host content and restores its XUL and CSS constraints", () => {
    document.body.innerHTML = `
      <div id="layout">
        <div id="content" width="900" minwidth="570" style="min-width: 570px; width: 900px; flex: 0 0 auto; overflow: visible;">
          <div id="zotero-context-pane" style="min-width: 357px;"></div>
        </div>
      </div>
    `;
    const content = document.querySelector("#content") as HTMLElement;
    const contextPane = document.querySelector("#zotero-context-pane") as HTMLElement;

    const controller = controlHostContentWidth(content);
    controller.setWidth(524);
    expect(content.getAttribute("width")).toBe("524");
    expect(content.getAttribute("minwidth")).toBe("0");
    expect(content.getAttribute("flex")).toBe("0");
    expect(content.style.minWidth).toBe("0px");
    expect(content.style.width).toBe("524px");
    expect(content.style.maxWidth).toBe("524px");
    expect(content.style.flexBasis).toBe("524px");
    expect(content.style.flexGrow).toBe("0");
    expect(content.style.flexShrink).toBe("0");
    expect(content.style.overflow).toBe("hidden");
    expect(contextPane.style.minWidth).toBe("357px");

    controller.restore();
    expect(content.getAttribute("width")).toBe("900");
    expect(content.getAttribute("minwidth")).toBe("570");
    expect(content.hasAttribute("flex")).toBe(false);
    expect(content.style.minWidth).toBe("570px");
    expect(content.style.maxWidth).toBe("");
    expect(content.style.width).toBe("900px");
    expect(content.style.flexBasis).toBe("auto");
    expect(content.style.flexGrow).toBe("0");
    expect(content.style.flexShrink).toBe("0");
    expect(content.style.overflow).toBe("visible");
  });

  it("recovers only clearly corrupt Zotero context pane widths", () => {
    expect(recoverCorruptZoteroContextWidth("50009", 1036)).toBe(400);
    expect(recoverCorruptZoteroContextWidth("50009", 800)).toBe(357);
    expect(recoverCorruptZoteroContextWidth("500", 1036)).toBeNull();
    expect(recoverCorruptZoteroContextWidth("not a number", 1036)).toBeNull();
  });
});
