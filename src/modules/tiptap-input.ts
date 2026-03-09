/**
 * TipTap-based chat input editor for Zotero's XHTML panels.
 *
 * Problem: TipTap/ProseMirror uses document.createElement() internally, which
 * creates namespace-less elements in XHTML documents — they don't render.
 * Solution: Patch document.createElement to route through createElementNS with
 * the XHTML namespace while the editor is active.
 *
 * ProseMirror handles Backspace/Delete/Enter with preventDefault(), and we add
 * custom arrow key handlers + key isolation to prevent Zotero's XUL <key>
 * interception.
 */

import { Editor, Extension } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import Mention from "@tiptap/extension-mention";
import Placeholder from "@tiptap/extension-placeholder";
import History from "@tiptap/extension-history";
import { Plugin, PluginKey } from "@tiptap/pm/state";

const XHTML_NS = "http://www.w3.org/1999/xhtml";

export interface SourceChip {
  key: string;
  title: string;
}

export interface ChatInputEditor {
  /** The DOM element to mount into the UI. */
  element: HTMLElement;
  /** Get plain text content (mentions become @KEY). */
  getText(): string;
  /** Get list of mentioned source keys. */
  getMentionKeys(): string[];
  /** Clear the editor. */
  clear(): void;
  /** Set text content (for edit-and-resend). */
  setText(text: string): void;
  /** Insert a mention chip for a source. */
  insertMention(source: SourceChip): void;
  /** Check if a mention chip for a key already exists. */
  hasMention(key: string): boolean;
  /** Disable/enable editing. */
  setEditable(editable: boolean): void;
  /** Focus the editor. */
  focus(): void;
  /** Destroy the editor instance. */
  destroy(): void;
}

/**
 * Patch document.createElement to use XHTML namespace.
 * Returns a restore function to undo the patch.
 */
function patchCreateElement(doc: Document): () => void {
  const original = doc.createElement.bind(doc);
  (doc as any).createElement = function (
    tagName: string,
    options?: ElementCreationOptions,
  ) {
    // Route through createElementNS with XHTML namespace
    const el = doc.createElementNS(XHTML_NS, tagName);
    if (options?.is) {
      el.setAttribute("is", options.is);
    }
    return el;
  };
  return () => {
    doc.createElement = original;
  };
}

/**
 * Suppress ALL key events from propagating to Zotero's XUL layer.
 */
function createKeyIsolationPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey("keyIsolation"),
    props: {
      handleDOMEvents: {
        keydown(_view: any, event: Event) {
          event.stopPropagation();
          event.stopImmediatePropagation();
          return false; // let ProseMirror continue processing
        },
        keyup(_view: any, event: Event) {
          event.stopPropagation();
          event.stopImmediatePropagation();
          return false;
        },
        keypress(_view: any, event: Event) {
          event.stopPropagation();
          event.stopImmediatePropagation();
          return false;
        },
      },
    },
  });
}

/**
 * Handle arrow keys programmatically so ProseMirror calls preventDefault(),
 * preventing Zotero's XUL <key> interception.
 */
const KeyHandler = Extension.create({
  name: "keyHandler",

  addKeyboardShortcuts() {
    return {
      // Explicit Backspace/Delete handlers — ProseMirror's built-in bindings
      // may not fire reliably in Zotero's XHTML context with key isolation.
      Backspace: ({ editor }) => {
        return editor.commands.first(({ commands }) => [
          () => commands.undoInputRule(),
          () => commands.deleteSelection(),
          () => commands.joinBackward(),
          () => commands.selectNodeBackward(),
        ]);
      },
      Delete: ({ editor }) => {
        return editor.commands.first(({ commands }) => [
          () => commands.deleteSelection(),
          () => commands.joinForward(),
          () => commands.selectNodeForward(),
        ]);
      },

      ArrowLeft: ({ editor }) => {
        const { state, dispatch } = editor.view;
        const { selection } = state;
        const { $from } = selection;
        if (!selection.empty) {
          // @ts-expect-error ProseMirror types
          dispatch(state.tr.setSelection(state.selection.constructor.near(state.doc.resolve($from.pos))));
          return true;
        }
        if ($from.pos > 0) {
          // @ts-expect-error ProseMirror types
          dispatch(state.tr.setSelection(state.selection.constructor.near(state.doc.resolve($from.pos - 1), -1)));
          return true;
        }
        return true;
      },

      ArrowRight: ({ editor }) => {
        const { state, dispatch } = editor.view;
        const { selection } = state;
        const { $to } = selection;
        if (!selection.empty) {
          // @ts-expect-error ProseMirror types
          dispatch(state.tr.setSelection(state.selection.constructor.near(state.doc.resolve($to.pos))));
          return true;
        }
        if ($to.pos < state.doc.content.size) {
          // @ts-expect-error ProseMirror types
          dispatch(state.tr.setSelection(state.selection.constructor.near(state.doc.resolve($to.pos + 1), 1)));
          return true;
        }
        return true;
      },

      ArrowUp: ({ editor }) => {
        const { state, dispatch } = editor.view;
        const { $from } = state.selection;
        if ($from.pos > 1) {
          // @ts-expect-error ProseMirror types
          dispatch(state.tr.setSelection(state.selection.constructor.near(state.doc.resolve(1), 1)));
        }
        return true;
      },

      ArrowDown: ({ editor }) => {
        const { state, dispatch } = editor.view;
        const end = state.doc.content.size - 1;
        const { $to } = state.selection;
        if ($to.pos < end) {
          // @ts-expect-error ProseMirror types
          dispatch(state.tr.setSelection(state.selection.constructor.near(state.doc.resolve(end), -1)));
        }
        return true;
      },
    };
  },
});

/**
 * Create a TipTap chat input editor.
 */
export function createChatInput(
  doc: Document,
  onSubmit: () => void,
  onCtrlSubmit: () => void,
): ChatInputEditor {
  // Create container in XHTML namespace
  const container = doc.createElementNS(XHTML_NS, "div") as HTMLElement;
  container.id = "chatpdf-editable-input";
  container.className = "chatpdf-editable-input";

  // Ensure TipTap can find browser globals it expects.
  // Zotero's chrome context doesn't expose these as globals, but they're
  // available via doc.defaultView.
  const win = doc.defaultView! as any;
  const browserGlobals = ["window", "document", "navigator", "getComputedStyle",
    "requestAnimationFrame", "cancelAnimationFrame", "getSelection",
    "MutationObserver", "DOMParser", "Node", "NodeFilter", "HTMLElement",
    "Element", "Range", "Text", "Comment", "DocumentFragment"] as const;
  for (const name of browserGlobals) {
    if (typeof (globalThis as any)[name] === "undefined") {
      (globalThis as any)[name] = name === "document" ? doc : win[name];
    }
  }

  // Patch createElement so TipTap's internal DOM creation works in XHTML.
  // We keep the patch active because ProseMirror creates elements at runtime
  // (during typing, content updates, etc.), not just during initialization.
  const restorePatch = patchCreateElement(doc);

  Zotero.debug("[ChatPDF] TipTap: globals set, createElement patched, creating editor...");

  // Custom enter handling
  const EnterHandler = Extension.create({
    name: "enterHandler",
    addKeyboardShortcuts() {
      return {
        Enter: () => { onSubmit(); return true; },
        "Mod-Enter": () => { onCtrlSubmit(); return true; },
        "Shift-Enter": ({ editor: ed }) => {
          ed.commands.first(({ commands }) => [
            () => commands.newlineInCode(),
            () => commands.createParagraphNear(),
            () => commands.liftEmptyBlock(),
            () => commands.splitBlock(),
          ]);
          return true;
        },
      };
    },
  });

  // Mention extension for inline source chips
  const CustomMention = Mention.configure({
    HTMLAttributes: { class: "chatpdf-inline-chip" },
    renderHTML({ options, node }) {
      return [
        "span",
        { ...options.HTMLAttributes, "data-source-key": node.attrs.id },
        `${node.attrs.label ?? node.attrs.id}`,
      ];
    },
  });

  let editor: Editor;
  try {
    editor = new Editor({
      element: container,
      injectCSS: false,
      extensions: [
        Document,
        Paragraph,
        Text,
        History,
        Placeholder.configure({
          placeholder: "Ask about your documents... (drop PDFs here)",
        }),
        CustomMention,
        KeyHandler,
        EnterHandler,
        Extension.create({
          name: "keyIsolation",
          addProseMirrorPlugins() {
            return [createKeyIsolationPlugin()];
          },
        }),
      ],
      editorProps: {
        attributes: { style: "outline: none;" },
        handlePaste(view, event) {
          event.preventDefault();
          const text = event.clipboardData?.getData("text/plain") || "";
          if (text) {
            const { state, dispatch } = view;
            dispatch(state.tr.insertText(text));
          }
          return true;
        },
      },
      onUpdate() {
        const el = container.querySelector(".tiptap") as HTMLElement;
        if (el) {
          el.style.height = "auto";
          el.style.height = Math.min(el.scrollHeight, 120) + "px";
        }
      },
    });
    Zotero.debug("[ChatPDF] TipTap: editor created successfully");
  } catch (err: any) {
    Zotero.debug(`[ChatPDF] TipTap: editor creation FAILED: ${err.message}\n${err.stack}`);
    // Restore createElement if editor creation fails
    restorePatch();
    throw err;
  }

  return {
    element: container,

    getText(): string {
      let result = "";
      editor.state.doc.descendants((node) => {
        if (node.isText) {
          result += node.text;
        } else if (node.type.name === "mention") {
          result += `@${node.attrs.id}`;
        } else if (node.type.name === "paragraph" && result.length > 0 && !result.endsWith("\n")) {
          result += "\n";
        }
        return true;
      });
      return result.trim();
    },

    getMentionKeys(): string[] {
      const keys: string[] = [];
      editor.state.doc.descendants((node) => {
        if (node.type.name === "mention") {
          keys.push(node.attrs.id);
        }
        return true;
      });
      return keys;
    },

    clear(): void {
      editor.commands.clearContent();
      const el = container.querySelector(".tiptap") as HTMLElement;
      if (el) el.style.height = "auto";
    },

    setText(text: string): void {
      const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      editor.commands.setContent(`<p>${escaped}</p>`);
    },

    insertMention(source: SourceChip): void {
      if (this.hasMention(source.key)) return;
      editor
        .chain()
        .focus()
        .insertContent([
          { type: "mention", attrs: { id: source.key, label: source.title } },
          { type: "text", text: " " },
        ])
        .run();
    },

    hasMention(key: string): boolean {
      let found = false;
      editor.state.doc.descendants((node) => {
        if (node.type.name === "mention" && node.attrs.id === key) {
          found = true;
        }
        return !found;
      });
      return found;
    },

    setEditable(editable: boolean): void {
      editor.setEditable(editable);
      if (editable) {
        container.classList.remove("chatpdf-editable-disabled");
      } else {
        container.classList.add("chatpdf-editable-disabled");
      }
    },

    focus(): void {
      editor.commands.focus();
    },

    destroy(): void {
      editor.destroy();
      restorePatch();
    },
  };
}
