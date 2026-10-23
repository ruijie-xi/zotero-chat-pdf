import { afterEach, describe, expect, it, vi } from "vitest";
import { findChatMatches, installChatFind } from "../src/modules/chat-find";
import { h } from "../src/utils/dom";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture() {
  const messages = h(document, "div", { id: "chatpdf-messages", tabindex: "0" });
  const actions = h(document, "div");
  const editor = h(document, "textarea") as HTMLTextAreaElement;
  const root = h(document, "div", {}, actions, messages, editor);
  const outside = h(document, "input");
  document.body.append(root, outside);
  const add = (text: string, className = "chatpdf-live-content") => {
    const content = h(document, "div", { className }, text);
    messages.append(content);
    return content;
  };
  const key = (target: HTMLElement, value: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const install = () => {
    dispose = installChatFind(root, messages, actions);
    const input = root.querySelector<HTMLInputElement>(".chatpdf-find-input")!;
    const bar = root.querySelector<HTMLElement>(".chatpdf-find-bar")!;
    const count = () => root.querySelector(".chatpdf-find-count")!.textContent;
    const search = (query: string) => { input.value = query; input.dispatchEvent(new Event("input")); };
    return { input, bar, count, search };
  };
  return { root, messages, editor, outside, add, key, install };
}

describe("chat text matching", () => {
  it("finds Chinese, literal regex characters and case-insensitive text across inline markup", () => {
    const { messages, add } = fixture();
    const body = add("中文 ");
    const bold = h(document, "strong", {}, "Finite");
    const link = h(document, "a", { href: "https://example.invalid" }, "element");
    body.append(bold, " ", link, " [a+b] 中文");
    expect(findChatMatches(messages, "中文").map(range => range.toString())).toEqual(["中文", "中文"]);
    const matches = findChatMatches(messages, "finite element");
    expect(matches).toHaveLength(1);
    expect(matches[0].toString()).toBe("Finite element");
    expect(findChatMatches(messages, "[a+b]")[0].toString()).toBe("[a+b]");
    expect(body.querySelector("a")).toBe(link);
    expect(body.querySelector("strong")).toBe(bold);
  });

  it("preserves Unicode offsets and separates blocks and messages", () => {
    const { messages, add } = fixture();
    add("İ 😀 MATCH");
    const body = add("");
    body.append(h(document, "p", {}, "alpha"), h(document, "p", {}, "beta"));
    add("gamma");
    expect(findChatMatches(messages, "match")[0].toString()).toBe("MATCH");
    expect(findChatMatches(messages, "alphabeta")).toHaveLength(0);
    expect(findChatMatches(messages, "alpha beta")).toHaveLength(1);
    expect(findChatMatches(messages, "beta gamma")).toHaveLength(0);
    expect(findChatMatches(messages, "   ")).toHaveLength(0);
  });

  it("excludes controls, drafts and duplicate accessible math text", () => {
    const { messages, add, editor } = fixture();
    const body = add("needle");
    body.append(h(document, "button", {}, "needle"), h(document, "span", { className: "katex-mathml" }, "needle"), h(document, "span", { hidden: "hidden" }, "needle"));
    add("needle", "chatpdf-msg-footer");
    add("needle", "chatpdf-message-user").append(h(document, "textarea", {}, "needle"));
    editor.value = "needle";
    expect(findChatMatches(messages, "needle")).toHaveLength(2);
  });
});

describe("chat find controls", () => {
  it("scopes Ctrl/Cmd+F to the panel and navigates without submitting, with focus restored on Esc", () => {
    const f = fixture();
    f.add("same SAME same");
    const { input, bar, search, count } = f.install();
    f.editor.focus();
    expect(f.key(f.outside, "f", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(bar.hidden).toBe(true);
    expect(f.key(f.editor, "f", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    search("same");
    expect(count()).toBe("1 / 3");
    const submit = vi.fn();
    f.root.addEventListener("keydown", submit);
    expect(f.key(input, "Enter").defaultPrevented).toBe(true);
    expect(count()).toBe("2 / 3");
    f.key(input, "Enter", { shiftKey: true });
    f.key(input, "Enter", { shiftKey: true });
    expect(count()).toBe("3 / 3");
    expect(submit).not.toHaveBeenCalled();
    f.key(input, "Escape");
    expect(bar.hidden).toBe(true);
    expect(document.activeElement).toBe(f.editor);
    f.key(f.editor, "f", { metaKey: true });
    expect(bar.hidden).toBe(false);
    expect(input.selectionEnd).toBe(input.value.length);
    search("absent");
    expect(count()).toBe("0 / 0");
    expect(f.root.querySelector<HTMLButtonElement>(".chatpdf-find-button")!.disabled).toBe(true);
  });

  it("does not claim IME confirmation or composing shortcut events", () => {
    const f = fixture();
    f.add("hit hit");
    const { bar, input, search, count } = f.install();
    f.key(f.editor, "f", { ctrlKey: true, isComposing: true });
    expect(bar.hidden).toBe(true);
    f.key(f.editor, "f", { ctrlKey: true });
    search("hit");
    expect(f.key(input, "Enter", { isComposing: true }).defaultPrevented).toBe(false);
    expect(f.key(input, "Enter", { keyCode: 229 }).defaultPrevented).toBe(false);
    expect(count()).toBe("1 / 2");
  });

  it.each([false, true])("excludes reasoning and tools even when expanded=%s, without changing disclosures", expanded => {
    const f = fixture();
    f.add("shared", "chatpdf-message-user");
    f.add("shared", "chatpdf-iteration-content");
    f.add("shared");
    const reasoning = h(document, "div", { className: "chatpdf-reasoning-block" }, h(document, "button", { className: "chatpdf-reasoning-toggle" }), h(document, "div", { className: "chatpdf-reasoning-content" }, "excluded content shared"));
    const details = h(document, "details", {}, h(document, "div", { className: "chatpdf-tool-result" }, "excluded content shared"), h(document, "div", { className: "chatpdf-tool-args" }, "tool arguments only")) as HTMLDetailsElement;
    const tool = h(document, "div", { className: "chatpdf-tool-block" }, h(document, "button", { className: "chatpdf-tool-toggle" }), details);
    reasoning.classList.toggle("chatpdf-reasoning-expanded", expanded);
    tool.classList.toggle("chatpdf-tool-block-expanded", expanded);
    details.open = expanded;
    f.messages.append(reasoning, tool);
    const { input, search, count } = f.install();
    f.key(f.editor, "f", { ctrlKey: true });
    search("shared");
    expect(count()).toBe("1 / 3");
    f.key(input, "Enter");
    expect(count()).toBe("2 / 3");
    search("excluded content");
    expect(count()).toBe("0 / 0");
    search("tool arguments only");
    expect(count()).toBe("0 / 0");
    expect(reasoning.classList.contains("chatpdf-reasoning-expanded")).toBe(expanded);
    expect(tool.classList.contains("chatpdf-tool-block-expanded")).toBe(expanded);
    expect(details.open).toBe(expanded);
  });

  it("refreshes streamed/replaced messages without scrolling and clears state when history opens or panel unloads", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.add("hit");
    const { bar, search, count } = f.install();
    f.key(f.editor, "f", { ctrlKey: true });
    search("hit");
    f.messages.scrollTop = 42;
    f.add("new hit");
    await vi.advanceTimersByTimeAsync(150);
    expect(count()).toBe("1 / 2");
    expect(f.messages.scrollTop).toBe(42);
    f.messages.replaceChildren();
    await vi.advanceTimersByTimeAsync(150);
    expect(count()).toBe("0 / 0");
    f.messages.style.display = "none";
    await vi.advanceTimersByTimeAsync(0);
    expect(bar.hidden).toBe(true);
    expect(f.key(f.editor, "f", { ctrlKey: true }).defaultPrevented).toBe(false);
    f.messages.style.display = "";
    dispose!();
    dispose = undefined;
    expect(f.root.querySelector(".chatpdf-find-bar")).toBeNull();
    expect(f.key(f.editor, "f", { ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it("uses CSS highlights without altering text nodes or the user's selection", () => {
    const registry = new Map();
    class Highlight extends Set<Range> {
      priority = 0;
      constructor(...ranges: Range[]) { super(ranges); }
    }
    vi.stubGlobal("CSS", { highlights: registry });
    vi.stubGlobal("Highlight", Highlight);
    const f = fixture();
    const body = f.add("hit hit");
    const original = body.firstChild;
    const selection = window.getSelection()!;
    const selected = document.createRange();
    selected.selectNodeContents(f.outside);
    const { input, search } = f.install();
    f.key(f.editor, "f", { ctrlKey: true });
    selection.removeAllRanges();
    selection.addRange(selected);
    search("hit");
    expect(registry.get("chatpdf-find-all").size).toBe(2);
    expect(registry.get("chatpdf-find-current").priority).toBe(1);
    expect(body.firstChild).toBe(original);
    expect(selection.getRangeAt(0)).toBe(selected);
    f.key(input, "Escape");
    expect(registry.size).toBe(0);
  });
});
