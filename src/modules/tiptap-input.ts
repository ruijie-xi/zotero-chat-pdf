/**
 * TipTap-based chat input editor for Zotero's XHTML panels.
 *
 * Problem: TipTap/ProseMirror uses document.createElement() internally, which
 * creates namespace-less elements in XHTML documents — they don't render.
 * Solution: Patch document.createElement to route through createElementNS with
 * the XHTML namespace while the editor is active.
 *
 * ProseMirror handles Backspace/Delete/Enter with preventDefault(), and key
 * isolation prevents Zotero's XUL <key> interception without replacing native
 * cursor navigation.
 */

import { Editor, Extension } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import Mention from "@tiptap/extension-mention";
import Placeholder from "@tiptap/extension-placeholder";
import History from "@tiptap/extension-history";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";

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
  /** Re-establish native editor focus after a browser-owned external interaction. */
  restoreFocusAfterExternalInsert(): void;
  /** Preserve the active DOM selection while sibling panel DOM is updated. */
  preserveSelectionDuring(update: () => void): void;
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
 * Keep editor key events from reaching Zotero's XUL layer without blocking
 * other handlers on the ProseMirror editing surface. Native cursor navigation
 * in Firefox relies on those same-target handlers.
 */
function createKeyIsolationPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey("keyIsolation"),
    props: {
      handleDOMEvents: {
        keydown(_view: any, event: Event) {
          const ke = event as KeyboardEvent;
          Zotero.debug(`[ChatPDF] TipTap keydown: key="${ke.key}" code="${ke.code}" ctrl=${ke.ctrlKey} shift=${ke.shiftKey} alt=${ke.altKey} meta=${ke.metaKey} defaultPrevented=${ke.defaultPrevented}`);
          event.stopPropagation();
          return false; // let ProseMirror continue processing
        },
        keyup(_view: any, event: Event) {
          event.stopPropagation();
          return false;
        },
        keypress(_view: any, event: Event) {
          event.stopPropagation();
          return false;
        },
        beforeinput(_view: any, event: Event) {
          const ie = event as InputEvent;
          Zotero.debug(`[ChatPDF] TipTap beforeinput: inputType="${ie.inputType}" data="${ie.data}" defaultPrevented=${ie.defaultPrevented}`);
          // Don't stop propagation for beforeinput — ProseMirror needs it
          return false;
        },
        input(_view: any, event: Event) {
          const ie = event as InputEvent;
          Zotero.debug(`[ChatPDF] TipTap input: inputType="${ie.inputType}" data="${ie.data}"`);
          return false;
        },
      },
    },
  });
}

type SelectionAlter = "move" | "extend";
type SelectionDirection = "left" | "right" | "backward" | "forward";
type SelectionGranularity = "character" | "line";

/**
 * Move the rendered DOM selection, then mirror it back into ProseMirror state.
 *
 * Firefox's normal arrow-key default action does not run for contenteditable
 * nodes in Zotero's chrome XHTML document. Selection.modify() still uses the
 * real rendered layout, so vertical movement preserves the visual column and
 * horizontal movement remains bidi-aware.
 */
function moveRenderedSelection(
  editor: Editor,
  alter: SelectionAlter,
  direction: SelectionDirection,
  granularity: SelectionGranularity,
): boolean {
  const { view } = editor;
  const ownerDocument = view.dom.ownerDocument;
  if (!ownerDocument) return false;
  const selection = ownerDocument.getSelection();
  if (
    !selection?.anchorNode
    || !selection.focusNode
    || !view.dom.contains(selection.anchorNode)
    || !view.dom.contains(selection.focusNode)
    || typeof selection.modify !== "function"
  ) {
    return false;
  }

  selection.modify(alter, direction, granularity);

  // Keep the model selection authoritative after using Firefox's layout-aware
  // DOM movement. Positions at atom/mention boundaries can be ambiguous, so
  // use opposite biases and let TextSelection.between choose valid text cursors.
  if (selection.anchorNode && selection.focusNode) {
    try {
      const anchor = view.posAtDOM(selection.anchorNode, selection.anchorOffset, -1);
      const head = view.posAtDOM(selection.focusNode, selection.focusOffset, 1);
      const next = TextSelection.between(
        view.state.doc.resolve(anchor),
        view.state.doc.resolve(head),
        head < anchor ? -1 : 1,
      );
      view.dispatch(view.state.tr.setSelection(next).scrollIntoView());
    } catch (error: any) {
      Zotero.debug(`[ChatPDF] TipTap arrow selection sync failed: ${error.message}`);
    }
  }

  return true;
}

/** Handle keys whose native editing behavior is unreliable in Zotero XHTML. */
const KeyHandler = Extension.create({
  name: "keyHandler",

  addKeyboardShortcuts() {
    return {
      // Explicit Backspace/Delete handlers — ProseMirror's built-in bindings
      // may not fire reliably in Zotero's XHTML context with key isolation.
      // We also handle single-character deletion explicitly since the browser's
      // native contenteditable `beforeinput` may not fire in Zotero's XHTML.
      Backspace: ({ editor }) => {
        const { state } = editor.view;
        const { selection } = state;
        const { $from, empty } = selection;
        Zotero.debug(`[ChatPDF] TipTap Backspace: pos=${$from.pos}, empty=${empty}, docSize=${state.doc.content.size}, parentType=${$from.parent.type.name}, parentSize=${$from.parent.content.size}, indexInParent=${$from.parentOffset}`);

        // Log surrounding node structure
        if ($from.pos > 0) {
          const before = state.doc.resolve($from.pos - 1);
          Zotero.debug(`[ChatPDF] TipTap Backspace: nodeBefore pos=${$from.pos - 1}, parent=${before.parent.type.name}, nodeAfter=${ $from.nodeBefore?.type.name ?? "null"}, nodeBeforeSize=${$from.nodeBefore?.nodeSize ?? "n/a"}`);
        }

        // Try structural commands first
        const structural = editor.commands.first(({ commands }) => [
          () => commands.undoInputRule(),
          () => commands.deleteSelection(),
          () => commands.joinBackward(),
          () => commands.selectNodeBackward(),
        ]);
        if (structural) {
          Zotero.debug("[ChatPDF] TipTap Backspace: handled by structural command");
          return true;
        }

        // Fallback: delete one character backward (native beforeinput may not work in XHTML)
        if (empty && $from.pos > 0) {
          // Check if the node before cursor is a mention — delete the whole mention
          const nodeBefore = $from.nodeBefore;
          if (nodeBefore && nodeBefore.type.name === "mention") {
            const from = $from.pos - nodeBefore.nodeSize;
            // Also check if there's a trigger "@" character right before the mention
            Zotero.debug(`[ChatPDF] TipTap Backspace: deleting mention node at ${from}-${$from.pos}`);
            editor.view.dispatch(state.tr.delete(from, $from.pos));
            return true;
          }
          Zotero.debug(`[ChatPDF] TipTap Backspace: fallback char delete at pos ${$from.pos}`);
          editor.view.dispatch(state.tr.delete($from.pos - 1, $from.pos));
          return true;
        }

        Zotero.debug("[ChatPDF] TipTap Backspace: nothing to delete");
        return true;
      },
      Delete: ({ editor }) => {
        const { state } = editor.view;
        const { selection } = state;
        const { $from, $to, empty } = selection;
        Zotero.debug(`[ChatPDF] TipTap Delete: pos=${$from.pos}, empty=${empty}, docSize=${state.doc.content.size}, parentType=${$from.parent.type.name}, indexInParent=${$from.parentOffset}`);

        // Log node after cursor
        if ($from.pos < state.doc.content.size) {
          Zotero.debug(`[ChatPDF] TipTap Delete: nodeAfter=${$from.nodeAfter?.type.name ?? "null"}, nodeAfterSize=${$from.nodeAfter?.nodeSize ?? "n/a"}`);
        }

        // Try structural commands first
        const structural = editor.commands.first(({ commands }) => [
          () => commands.deleteSelection(),
          () => commands.joinForward(),
          () => commands.selectNodeForward(),
        ]);
        if (structural) {
          Zotero.debug("[ChatPDF] TipTap Delete: handled by structural command");
          return true;
        }

        // Fallback: delete one character forward
        if (empty && $to.pos < state.doc.content.size) {
          const nodeAfter = $from.nodeAfter;
          if (nodeAfter && nodeAfter.type.name === "mention") {
            // Delete the entire mention node
            const to = $from.pos + nodeAfter.nodeSize;
            Zotero.debug(`[ChatPDF] TipTap Delete: deleting mention node at ${$from.pos}-${to}`);
            editor.view.dispatch(state.tr.delete($from.pos, to));
            return true;
          }
          Zotero.debug(`[ChatPDF] TipTap Delete: fallback char delete at pos ${$from.pos}`);
          editor.view.dispatch(state.tr.delete($from.pos, $from.pos + 1));
          return true;
        }

        Zotero.debug("[ChatPDF] TipTap Delete: nothing to delete");
        return true;
      },

      ArrowLeft: ({ editor }) => moveRenderedSelection(editor, "move", "left", "character"),
      ArrowRight: ({ editor }) => moveRenderedSelection(editor, "move", "right", "character"),
      ArrowUp: ({ editor }) => moveRenderedSelection(editor, "move", "backward", "line"),
      ArrowDown: ({ editor }) => moveRenderedSelection(editor, "move", "forward", "line"),
      "Shift-ArrowLeft": ({ editor }) => moveRenderedSelection(editor, "extend", "left", "character"),
      "Shift-ArrowRight": ({ editor }) => moveRenderedSelection(editor, "extend", "right", "character"),
      "Shift-ArrowUp": ({ editor }) => moveRenderedSelection(editor, "extend", "backward", "line"),
      "Shift-ArrowDown": ({ editor }) => moveRenderedSelection(editor, "extend", "forward", "line"),
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

  let externalFocusRequest = 0;

  return {
    element: container,

    getText(): string {
      let result = "";
      editor.state.doc.descendants((node) => {
        if (node.isText) {
          result += node.text;
        } else if (node.type.name === "mention") {
          result += `@${node.attrs.label || node.attrs.id}`;
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
        .insertContent([
          { type: "mention", attrs: { id: source.key, label: source.title } },
          { type: "text", text: " " },
        ])
        .run();
    },

    restoreFocusAfterExternalInsert(): void {
      const request = ++externalFocusRequest;
      const win = editor.view.dom.ownerDocument?.defaultView;
      const restore = () => {
        if (request !== externalFocusRequest || editor.isDestroyed || !editor.isEditable) return;

        // Firefox can leave a ProseMirror surface as document.activeElement after
        // native drag/drop while its editing focus remains inactive. A real
        // blur/focus cycle re-establishes the native editing context.
        editor.view.dom.blur();
        editor.view.focus();
      };

      if (!win) {
        restore();
        return;
      }

      // requestAnimationFrame can remain suspended in Zotero's main chrome
      // window, so defer through its event loop instead.
      win.setTimeout(restore, 0);
    },

    preserveSelectionDuring(update: () => void): void {
      const view = editor.view;
      const ownerDocument = view.dom.ownerDocument;
      const selection = ownerDocument?.getSelection();
      const anchorNode = selection?.anchorNode ?? null;
      const focusNode = selection?.focusNode ?? null;
      const shouldRestore = Boolean(
        selection
        && anchorNode
        && focusNode
        && ownerDocument?.activeElement === view.dom
        && view.dom.contains(anchorNode)
        && view.dom.contains(focusNode),
      );
      const anchorOffset = selection?.anchorOffset ?? 0;
      const focusOffset = selection?.focusOffset ?? 0;

      try {
        update();
      } finally {
        const canRestore = shouldRestore
          && !editor.isDestroyed
          && ownerDocument?.activeElement === view.dom
          && anchorNode
          && focusNode
          && view.dom.contains(anchorNode)
          && view.dom.contains(focusNode);
        if (canRestore) {
          try {
            selection!.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
          } catch (error: any) {
            Zotero.debug(`[ChatPDF] TipTap selection restore after panel update failed: ${error.message}`);
          }
        }
      }
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
      externalFocusRequest++;
      editor.destroy();
      restorePatch();
    },
  };
}
