import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatInput, type ChatInputEditor } from "../src/modules/tiptap-input";

describe("TipTap input key isolation", () => {
  let editor: ChatInputEditor | undefined;

  afterEach(() => {
    editor?.destroy();
    editor = undefined;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("keeps same-target editor handlers available while isolating Zotero ancestors", () => {
    editor = createChatInput(document, vi.fn(), vi.fn());
    document.body.appendChild(editor.element);

    const editingSurface = editor.element.querySelector(".ProseMirror");
    expect(editingSurface).toBeInstanceOf(HTMLElement);

    const sameTargetHandler = vi.fn();
    const ancestorHandler = vi.fn();
    editingSurface!.addEventListener("keydown", sameTargetHandler);
    document.body.addEventListener("keydown", ancestorHandler);

    const event = new KeyboardEvent("keydown", {
      key: "a",
      code: "KeyA",
      bubbles: true,
      cancelable: true,
    });
    editingSurface!.dispatchEvent(event);

    expect(sameTargetHandler).toHaveBeenCalledOnce();
    expect(ancestorHandler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it.each([
    ["ArrowLeft", false, "move", "left", "character"],
    ["ArrowRight", false, "move", "right", "character"],
    ["ArrowUp", false, "move", "backward", "line"],
    ["ArrowDown", false, "move", "forward", "line"],
    ["ArrowLeft", true, "extend", "left", "character"],
    ["ArrowRight", true, "extend", "right", "character"],
    ["ArrowUp", true, "extend", "backward", "line"],
    ["ArrowDown", true, "extend", "forward", "line"],
  ])(
    "handles %s (shift=%s) through Firefox's rendered selection",
    (key, shiftKey, alter, direction, granularity) => {
      editor = createChatInput(document, vi.fn(), vi.fn());
      document.body.appendChild(editor.element);
      editor.setText("abcd");

      const editingSurface = editor.element.querySelector(".ProseMirror") as HTMLElement;
      const textNode = editingSurface.querySelector("p")?.firstChild;
      expect(textNode?.nodeType).toBe(Node.TEXT_NODE);

      const selection = document.getSelection()!;
      const range = document.createRange();
      range.setStart(textNode!, 2);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);

      const modify = vi.fn();
      Object.defineProperty(selection, "modify", {
        configurable: true,
        value: modify,
      });

      const ancestorHandler = vi.fn();
      document.body.addEventListener("keydown", ancestorHandler);
      const event = new KeyboardEvent("keydown", {
        key,
        code: key,
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      editingSurface.dispatchEvent(event);

      expect(modify).toHaveBeenCalledWith(alter, direction, granularity);
      expect(event.defaultPrevented).toBe(true);
      expect(ancestorHandler).not.toHaveBeenCalled();
    },
  );

  it("inserts a source mention without scheduling an implicit focus", () => {
    editor = createChatInput(document, vi.fn(), vi.fn());
    const outside = document.createElement("button");
    document.body.append(outside, editor.element);
    outside.focus();

    const animationFrame = vi.spyOn(window, "requestAnimationFrame");

    editor.insertMention({ key: "1:SOURCE", title: "Source paper" });

    expect(editor.getMentionKeys()).toEqual(["1:SOURCE"]);
    expect(document.activeElement).toBe(outside);
    expect(animationFrame).not.toHaveBeenCalled();
  });

  it("restores native editing focus after an external insert", () => {
    editor = createChatInput(document, vi.fn(), vi.fn());
    document.body.appendChild(editor.element);
    editor.insertMention({ key: "1:SOURCE", title: "Source paper" });

    const editingSurface = editor.element.querySelector(".ProseMirror") as HTMLElement;
    editingSurface.focus();
    const blurHandler = vi.fn();
    const focusHandler = vi.fn();
    editingSurface.addEventListener("blur", blurHandler);
    editingSurface.addEventListener("focus", focusHandler);

    const timeouts: Array<() => void> = [];
    vi.spyOn(window, "setTimeout").mockImplementation((handler: TimerHandler) => {
      if (typeof handler === "function") timeouts.push(handler);
      return timeouts.length;
    });

    editor.restoreFocusAfterExternalInsert();
    expect(timeouts).toHaveLength(1);
    timeouts.shift()!();

    expect(blurHandler).toHaveBeenCalledOnce();
    expect(focusHandler).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(editingSurface);
    expect(editor.getMentionKeys()).toEqual(["1:SOURCE"]);
  });

  it("preserves a collapsed cursor while sibling panel DOM is updated", () => {
    editor = createChatInput(document, vi.fn(), vi.fn());
    const sibling = document.createElement("div");
    document.body.append(sibling, editor.element);
    editor.setText("abcdefghij");

    const editingSurface = editor.element.querySelector(".ProseMirror") as HTMLElement;
    const textNode = editingSurface.querySelector("p")?.firstChild;
    expect(textNode?.nodeType).toBe(Node.TEXT_NODE);
    editingSurface.focus();

    const selection = document.getSelection()!;
    selection.setBaseAndExtent(textNode!, 7, textNode!, 7);

    editor.preserveSelectionDuring(() => {
      sibling.textContent = "Converting...";
      selection.collapse(textNode!, 0);
    });

    expect(selection.anchorNode).toBe(textNode);
    expect(selection.anchorOffset).toBe(7);
    expect(selection.focusNode).toBe(textNode);
    expect(selection.focusOffset).toBe(7);
    expect(document.activeElement).toBe(editingSurface);
  });

  it("preserves selection direction while sibling panel DOM is updated", () => {
    editor = createChatInput(document, vi.fn(), vi.fn());
    document.body.appendChild(editor.element);
    editor.setText("abcdefghij");

    const editingSurface = editor.element.querySelector(".ProseMirror") as HTMLElement;
    const textNode = editingSurface.querySelector("p")?.firstChild;
    expect(textNode?.nodeType).toBe(Node.TEXT_NODE);
    editingSurface.focus();

    const selection = document.getSelection()!;
    selection.setBaseAndExtent(textNode!, 8, textNode!, 3);

    editor.preserveSelectionDuring(() => {
      selection.collapse(textNode!, 0);
    });

    expect(selection.anchorOffset).toBe(8);
    expect(selection.focusOffset).toBe(3);
  });
});
