import { beforeEach, expect, it, vi } from "vitest";
import { renderLibraryPreview, summarizeChanges } from "../src/modules/library-change-preview";
import type { LibraryChangeSet } from "../src/modules/library-changes";
const snapshot = (kind: "item" | "collection", key: string, data: any) => ({ kind, key, libraryID: 1, title: "Paper", data });
const plan = (changes: LibraryChangeSet["changes"]): LibraryChangeSet => ({ id: "test", status: "preview", changes });
beforeEach(() => {
  Object.assign(Zotero, { Collections: { getByLibraryAndKey: (_lib: number, key: string) => ({ name: ({ FROM: "From collection", TO: "To collection", KEEP: "Other collection" } as any)[key] || key }) } });
  Object.assign(Zotero.Libraries, { get: () => ({ name: "My library" }) });
  vi.mocked(Zotero.Items.getByLibraryAndKey).mockReturnValue({ getField: () => "Parent paper" } as any);
});
it("renders collection deletion and undo as removal and restoration with the original location", () => {
  const batch = plan([{ before: snapshot("collection", "EMPTY001", { name: "Empty shell", parentKey: "FROM" }), after: null }]);
  expect(summarizeChanges(batch)[0]).toMatchObject({ category: "remove" });
  expect(renderLibraryPreview(document, batch).textContent).toContain("Empty shell");
  expect(summarizeChanges(batch)[0].details.join(" ")).toContain("From collection");
  expect(summarizeChanges(batch, true)[0]).toMatchObject({ category: "add" });
});
it("groups tags and collection membership and names the memberships preserved by a move", () => {
  const review = renderLibraryPreview(document, plan([{ before: snapshot("item", "ITEM0001", { tags: [{ tag: "old" }], collections: ["FROM", "KEEP"] }),
    after: snapshot("item", "ITEM0001", { tags: [{ tag: "new" }], collections: ["TO", "KEEP"] }) }]));
  expect([...review.querySelectorAll("section")].map(section => section.dataset.category)).toEqual(["edit", "move"]);
  expect(review.textContent).toContain("From collection"); expect(review.textContent).toContain("To collection"); expect(review.textContent).toContain("Other collection");
  expect(review.querySelector("pre")).toBeNull(); expect(review.textContent).not.toContain('"tags"');
});
it("shows sanitized full before/after notes inside optional readable details", () => {
  const review = renderLibraryPreview(document, plan([{ before: snapshot("item", "NOTE0001", { parentKey: "ITEM0001", note: "<p>Old content</p>" }),
    after: snapshot("item", "NOTE0001", { parentKey: "ITEM0001", note: '<p>New content<script>unsafe()</script></p>' }) }]));
  const notes = [...review.querySelectorAll(".chatpdf-library-note-content")];
  expect(notes.map(note => note.textContent)).toEqual(["Old content", "New content"]);
  expect(review.querySelector("script")).toBeNull(); expect(review.querySelector("details")?.open).toBe(false);
});
it("labels standalone notes without attempting an invalid parent lookup", () => {
  const review = renderLibraryPreview(document, plan([{ before: snapshot("item", "NOTE0001", { parentKey: false, note: "<p>Old</p>" }),
    after: snapshot("item", "NOTE0001", { parentKey: false, note: "<p>New</p>" }) }]));
  expect(review.textContent).toMatch(/Standalone note|独立笔记/);
  expect(Zotero.Items.getByLibraryAndKey).not.toHaveBeenCalledWith(1, false);
});
it("reverses creation and edits for undo and names new parent collections from the same plan", () => {
  const batch = plan([{ before: null, after: snapshot("collection", "NEW", { name: "New parent", parentKey: null }) },
    { before: null, after: snapshot("collection", "CHILD", { name: "Child", parentKey: "NEW" }) }]);
  expect(summarizeChanges(batch)[1].details.join(" ")).toContain("New parent");
  expect(summarizeChanges(batch, true).every(entry => entry.category === "remove")).toBe(true);
  const edit = plan([{ before: snapshot("item", "NOTE", { parentKey: "PAPER", note_chars: 10 }), after: snapshot("item", "NOTE", { parentKey: "PAPER", note_chars: 20 }) }]);
  expect(summarizeChanges(edit, true)[0].details.join(" ")).toContain("20 → 10");
});
