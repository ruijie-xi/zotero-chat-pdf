import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeTool,
  getToolDefinitions,
  getToolMetadata,
  ToolExecutionContext,
} from "../src/modules/tools";

function makePaper(key: string, title: string, author: string, year: string) {
  return {
    id: Number(key.replace(/\D/g, "")) || 1,
    key,
    libraryID: 1,
    deleted: false,
    dateModified: `${year}-01-01 00:00:00`,
    isAnnotation: vi.fn(() => false),
    isRegularItem: vi.fn(() => true),
    getAttachments: vi.fn(() => [] as number[]),
    getField: vi.fn((field: string) => {
      if (field === "title") return title;
      if (field === "date") return year;
      return "";
    }),
    getCreators: vi.fn(() => [{ firstName: author.split(" ")[0], lastName: author.split(" ")[1] }]),
  } as any;
}

function makeAttachment(id: number, key: string, parentItem: any) {
  return {
    id,
    key,
    libraryID: 1,
    deleted: false,
    parentItem,
    isAnnotation: vi.fn(() => false),
    isRegularItem: vi.fn(() => false),
    getAnnotations: vi.fn(() => [] as any[]),
    getField: vi.fn(() => ""),
  } as any;
}

function makeAnnotation(options: {
  key: string;
  attachment: any;
  text?: string;
  comment?: string;
  type?: string;
  tags?: string[];
  modified?: string;
  deleted?: boolean;
}) {
  return {
    id: Number(options.key.replace(/\D/g, "")) || 100,
    key: options.key,
    libraryID: 1,
    deleted: options.deleted || false,
    parentItem: options.attachment,
    topLevelItem: options.attachment.parentItem,
    dateModified: options.modified || "2026-01-01 00:00:00",
    annotationType: options.type || "highlight",
    annotationText: options.text || "",
    annotationComment: options.comment || "",
    annotationColor: "#ffd400",
    annotationPageLabel: "12",
    isAnnotation: vi.fn(() => true),
    isRegularItem: vi.fn(() => false),
    getField: vi.fn(() => ""),
    getTags: vi.fn(() => (options.tags || []).map((tag) => ({ tag }))),
  } as any;
}

function toolContext(): ToolExecutionContext {
  return {
    session: {} as any,
    requestId: "annotation-test",
    windowId: "window-1",
    turnScope: new Set(),
  };
}

describe("Zotero annotation agent tool", () => {
  let paperOne: any;
  let paperTwo: any;
  let attachmentOne: any;
  let attachmentTwo: any;
  let annotationOne: any;
  let annotationTwo: any;

  beforeEach(() => {
    paperOne = makePaper("PAPER1", "Structure-Preserving Plasma Methods", "Ada Lovelace", "2024");
    paperTwo = makePaper("PAPER2", "Finite Element Exterior Calculus", "Emmy Noether", "2022");
    attachmentOne = makeAttachment(11, "PDF1", paperOne);
    attachmentTwo = makeAttachment(22, "PDF2", paperTwo);
    annotationOne = makeAnnotation({
      key: "ANN1",
      attachment: attachmentOne,
      text: "magnetic helicity is preserved by the discrete flow",
      comment: "Compare this invariant with the MHD proof",
      tags: ["topology"],
      modified: "2026-07-20 10:00:00",
    });
    annotationTwo = makeAnnotation({
      key: "ANN2",
      attachment: attachmentTwo,
      text: "the commuting projection controls the approximation error",
      type: "underline",
      modified: "2026-07-19 10:00:00",
    });
    attachmentOne.getAnnotations.mockReturnValue([annotationOne]);
    attachmentTwo.getAnnotations.mockReturnValue([annotationTwo]);
    paperOne.getAttachments.mockReturnValue([attachmentOne.id]);
    paperTwo.getAttachments.mockReturnValue([attachmentTwo.id]);

    const allItems = [paperOne, attachmentOne, annotationOne, paperTwo, attachmentTwo, annotationTwo];
    (Zotero.Libraries.getAll as any).mockReturnValue([{ libraryID: 1 }]);
    (Zotero.Items as any).getAll = vi.fn(async () => allItems);
    (Zotero.Items as any).get = vi.fn((id: number) => allItems.find((item) => item.id === id) || null);
    (Zotero.Items.getByLibraryAndKey as any).mockImplementation((_libraryID: number, key: string) => (
      allItems.find((item) => item.key === key) || null
    ));
  });

  it("registers a read-only tool whose query is optional", () => {
    const definition = getToolDefinitions({ enableWebTools: false })
      .find((tool) => tool.function.name === "search_zotero_annotations");

    expect(definition).toBeDefined();
    expect(definition?.function.parameters.required).toEqual([]);
    expect(getToolMetadata("search_zotero_annotations")).toEqual({
      readOnly: true,
      mutatesSession: false,
      network: false,
      costly: false,
    });
  });

  it("lists annotations with their annotation, attachment, and paper identities", async () => {
    const result = await executeTool("search_zotero_annotations", {}, toolContext());

    expect(result).toContain("Zotero annotations (2 total)");
    expect(result).toContain("Structure-Preserving Plasma Methods");
    expect(result).toContain("annotation_key: ANN1");
    expect(result).toContain("attachment_key: PDF1");
    expect(result).toContain("item_key: PAPER1");
    expect(result).toContain("highlighted_text: magnetic helicity is preserved");
    expect((Zotero.Items as any).getAll).toHaveBeenCalledWith(1, false, false);
  });

  it("searches highlight text and returns the corresponding paper", async () => {
    const result = await executeTool(
      "search_zotero_annotations",
      { query: "commuting projection" },
      toolContext(),
    );

    expect(result).toContain('Zotero annotation results for "commuting projection" (1 total)');
    expect(result).toContain("Finite Element Exterior Calculus");
    expect(result).toContain("annotation_key: ANN2");
    expect(result).not.toContain("annotation_key: ANN1");
  });

  it("can restrict listing to one bibliographic item and annotation type", async () => {
    const result = await executeTool(
      "search_zotero_annotations",
      { item_key: "PAPER1", library_id: 1, annotation_type: "highlight" },
      toolContext(),
    );

    expect(result).toContain("annotation_key: ANN1");
    expect(result).not.toContain("annotation_key: ANN2");
    expect(attachmentOne.getAnnotations).toHaveBeenCalledWith(false);
  });

  it("reports an unknown item key instead of silently returning an empty list", async () => {
    const result = await executeTool(
      "search_zotero_annotations",
      { item_key: "MISSING", library_id: 1 },
      toolContext(),
    );

    expect(result).toContain('Error: Zotero item "MISSING" was not found.');
  });
});
