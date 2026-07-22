import { describe, expect, it } from "vitest";
import { shouldRestoreChatInputFocus } from "../src/modules/send-handler";

describe("shouldRestoreChatInputFocus", () => {
  function buildFixture() {
    document.body.innerHTML = `
      <div id="chat-root">
        <div id="chat-input"><div contenteditable="true"></div></div>
        <button id="send">Send</button>
        <textarea id="message-editor"></textarea>
      </div>
      <input id="zotero-search">
    `;
    return {
      input: document.querySelector("#chat-input") as HTMLElement,
      send: document.querySelector("#send") as HTMLButtonElement,
      messageEditor: document.querySelector("#message-editor") as HTMLTextAreaElement,
      zoteroSearch: document.querySelector("#zotero-search") as HTMLInputElement,
    };
  }

  it("restores focus from neutral or chat-input targets", () => {
    const { input, send } = buildFixture();

    expect(shouldRestoreChatInputFocus(document, input, send)).toBe(true);
    send.focus();
    expect(shouldRestoreChatInputFocus(document, input, send)).toBe(true);
    (input.firstElementChild as HTMLElement).focus();
    expect(shouldRestoreChatInputFocus(document, input, send)).toBe(true);
  });

  it("does not steal focus from another editor or Zotero control", () => {
    const { input, send, messageEditor, zoteroSearch } = buildFixture();

    messageEditor.focus();
    expect(shouldRestoreChatInputFocus(document, input, send)).toBe(false);
    zoteroSearch.focus();
    expect(shouldRestoreChatInputFocus(document, input, send)).toBe(false);
  });
});
