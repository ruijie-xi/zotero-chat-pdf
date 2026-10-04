import type { LibraryChangeSet } from "./library-changes";
import { h } from "../utils/dom";
import { uiText } from "../utils/ui-text";
import { sanitizeHtml } from "./markdown-renderer";
import { noteText } from "./zotero-notes";

type Category = "add" | "edit" | "remove" | "move";
interface Entry { category: Category; title: string; details: string[]; identity: string; note?: { before?: string; after?: string }; }
export function summarizeChanges(plan: LibraryChangeSet, undo = false): Entry[] {
  const entries: Entry[] = [];
  const collectionName = (libraryID: number, key: string | null, after: boolean): string => {
    if (!key) return (Zotero.Libraries as any).get?.(libraryID)?.name || uiText("Library root", "文献库顶层");
    const change = plan.changes.find(item => {
      const target = item.after || item.before!;
      return target.kind === "collection" && target.libraryID === libraryID && target.key === key;
    });
    const snapshot = after !== undo ? change?.after : change?.before;
    return snapshot?.data.name || (Zotero.Collections as any).getByLibraryAndKey?.(libraryID, key)?.name || key;
  };
  const parentName = (libraryID: number, key: string) => {
    if (!key) return uiText("Standalone note", "独立笔记");
    const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
    return String(item && item.getField("title") || key);
  };
  for (const change of plan.changes) {
    const before = undo ? change.after : change.before, after = undo ? change.before : change.after;
    const target = after || before!, lib = target.libraryID;
    const identity = `${lib}:${target.key}`;
    const note = typeof target.data.note === "string" || typeof target.data.note_chars === "number";
    const title = target.kind === "collection" ? String(target.data.name) : target.title;
    const add = (category: Category, title: string, details: string[], note?: Entry["note"]) => entries.push({ category, title, details, identity, note });
    if (!before || !after) {
      const creating = !!after;
      const type = target.kind === "collection" ? uiText("collection", "集合") : uiText("note", "笔记");
      add(creating ? "add" : "remove", uiText(`${creating ? "Create" : "Delete"} ${type}: ${title}`, `${creating ? "新增" : "删除"}${type}：${title}`),
        [target.kind === "collection" ? uiText(`Location: ${collectionName(lib, target.data.parentKey, creating)}`, `位置：${collectionName(lib, target.data.parentKey, creating)}`)
          : uiText(`Paper: ${parentName(lib, target.data.parentKey)}`, `所属文献：${parentName(lib, target.data.parentKey)}`),
        ...(typeof target.data.note_chars === "number" ? [uiText(`Note content: ${target.data.note_chars} characters`, `笔记内容：${target.data.note_chars} 字符`)] : [])],
        typeof target.data.note === "string" ? creating ? { after: target.data.note } : { before: target.data.note } : undefined);
      continue;
    }
    if (target.kind === "collection") {
      if (before.data.name !== after.data.name) add("edit", uiText("Rename collection", "重命名集合"), [`${before.data.name} → ${after.data.name}`]);
      if (before.data.parentKey !== after.data.parentKey) add("move", uiText(`Move collection: ${title}`, `移动集合：${title}`),
        [`${collectionName(lib, before.data.parentKey, false)} → ${collectionName(lib, after.data.parentKey, true)}`]);
    } else if (note) {
      add("edit", uiText(`Edit note: ${title}`, `编辑笔记：${title}`), [uiText(`Paper: ${parentName(lib, target.data.parentKey)}`, `所属文献：${parentName(lib, target.data.parentKey)}`),
        ...(typeof target.data.note_chars === "number" ? [uiText(`Content: ${before.data.note_chars} → ${after.data.note_chars} characters`, `笔记内容：${before.data.note_chars} → ${after.data.note_chars} 字符`)] : [])],
      typeof target.data.note === "string" ? { before: before.data.note, after: after.data.note } : undefined);
    } else {
      const oldTags = before.data.tags.map((tag: any) => tag.tag), newTags = after.data.tags.map((tag: any) => tag.tag);
      const removed = oldTags.filter((tag: string) => !newTags.includes(tag)), added = newTags.filter((tag: string) => !oldTags.includes(tag));
      if (removed.length && added.length) add("edit", uiText(`Replace tags: ${title}`, `调整标签：${title}`), [uiText(`Remove: ${removed.join(", ")}`, `移除：${removed.join("、")}`), uiText(`Add: ${added.join(", ")}`, `新增：${added.join("、")}`)]);
      else {
        if (added.length) add("add", uiText(`Add tags: ${title}`, `添加标签：${title}`), [added.join(uiText(", ", "、"))]);
        if (removed.length) add("remove", uiText(`Remove tags: ${title}`, `移除标签：${title}`), [removed.join(uiText(", ", "、"))]);
      }
      const from = before.data.collections.filter((key: string) => !after.data.collections.includes(key));
      const to = after.data.collections.filter((key: string) => !before.data.collections.includes(key));
      const names = (keys: string[], after: boolean) => keys.map(key => collectionName(lib, key, after)).join(uiText(", ", "、"));
      if (from.length || to.length) {
        const kept = before.data.collections.filter((key: string) => after.data.collections.includes(key));
        add(from.length && to.length ? "move" : to.length ? "add" : "remove", uiText(`Change collection membership: ${title}`, `${from.length && to.length ? "移动条目" : to.length ? "加入集合" : "从集合移除"}：${title}`),
          [...(from.length ? [uiText(`From: ${names(from, false)}`, `移出：${names(from, false)}`)] : []), ...(to.length ? [uiText(`To: ${names(to, true)}`, `加入：${names(to, true)}`)] : []),
            ...(kept.length ? [uiText(`Keep: ${names(kept, true)}`, `保留归属：${names(kept, true)}`)] : [])]);
      }
    }
  }
  return entries;
}

export function renderLibraryPreview(doc: Document, plan: LibraryChangeSet, undo = false): HTMLElement {
  const root = h(doc, "div", { className: "chatpdf-library-preview" });
  const entries = summarizeChanges(plan, undo);
  const categories: Category[] = ["add", "edit", "remove", "move"];
  const titles = { add: uiText("Add", "新增"), edit: uiText("Edit", "编辑"), remove: uiText("Remove", "删除 / 移除"), move: uiText("Move", "移动") };
  for (const category of categories) {
    const group = entries.filter(entry => entry.category === category);
    if (!group.length) continue;
    const section = h(doc, "section", { className: `chatpdf-library-group chatpdf-library-group-${category}`, "data-category": category });
    section.append(h(doc, "strong", {}, `${titles[category]} · ${group.length}`));
    for (const entry of group) {
      const card = h(doc, "div", { className: "chatpdf-library-change", title: entry.identity });
      card.append(h(doc, "div", { className: "chatpdf-library-change-title" }, entry.title));
      for (const detail of entry.details) card.append(h(doc, "div", { className: "chatpdf-library-change-detail" }, detail));
      if (entry.note) {
        const details = h(doc, "details", { className: "chatpdf-library-note-diff" });
        details.append(h(doc, "summary", {}, uiText("Read note content / before and after", "查看笔记内容 / 修改前后")));
        for (const [label, html] of [[uiText("Before", "修改前"), entry.note.before], [uiText("After", "修改后"), entry.note.after]]) {
          if (html === undefined) continue;
          details.append(h(doc, "strong", {}, label!));
          const content = h(doc, "div", { className: "chatpdf-library-note-content" }); content.innerHTML = sanitizeHtml(html!); details.append(content);
        }
        const preview = noteText(entry.note.after ?? entry.note.before ?? "");
        card.append(h(doc, "div", { className: "chatpdf-library-note-excerpt" }, preview.length > 180 ? `${preview.slice(0, 180)}…` : preview), details);
      }
      section.append(card);
    }
    root.append(section);
  }
  if (!entries.length) root.append(h(doc, "div", {}, uiText("No effective changes", "没有实际修改")));
  return root;
}
