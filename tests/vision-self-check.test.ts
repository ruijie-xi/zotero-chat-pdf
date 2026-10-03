import { describe, expect, it } from "vitest";
import { parseSelfCheckedMarkdown, reusableSelfCheck, SELF_CHECK_MARKER } from "../src/modules/vision-self-check";

const document = "<!-- chatpdf-page:9 -->\nText before.\n$$X=\\Omega^\\flat(DH)$$\nText after.\n<!-- chatpdf-page:10 -->\nSecond page.";
const response = (edits: unknown[], extra = {}) => `${document}\n${SELF_CHECK_MARKER}\n${JSON.stringify({ edits, ...extra })}`;

describe("same-response model self-check", () => {
  it("strips an empty structured check without changing the transcription", () => {
    const result = parseSelfCheckedMarkdown(response([]), [9, 10]);
    expect(result.markdown).toBe(document);
    expect(result.check).toMatchObject({ method: "same-response", pages: [9, 10], editsApplied: 0, edits: [] });
  });
  it("applies only a unique local correction and records its exact before/after", () => {
    const edit = { page: 9, old: "\\Omega^\\flat", new: "\\Omega^\\sharp" };
    const result = parseSelfCheckedMarkdown(response([edit]), [9, 10]);
    expect(result.markdown).toBe(document.replace(edit.old, edit.new));
    expect(result.check.edits).toEqual([edit]);
    expect(result.check.editsApplied).toBe(1);
  });
  it("applies disjoint patches against original offsets and allows deleting a header", () => {
    const result = parseSelfCheckedMarkdown(response([
      { page: 9, old: "Text before.\n", new: "" },
      { page: 10, old: "Second page.", new: "Second page corrected." },
    ]), [9, 10]);
    expect(result.markdown).not.toContain("Text before.");
    expect(result.markdown).toContain("Second page corrected.");
  });
  it("rejects missing/duplicate footer, invalid schema, unknown pages and guessed content", () => {
    expect(() => parseSelfCheckedMarkdown(document, [9, 10])).toThrow("missing");
    expect(() => parseSelfCheckedMarkdown(`${response([])}\n${SELF_CHECK_MARKER}`, [9, 10])).toThrow("duplicated");
    expect(() => parseSelfCheckedMarkdown(`${document}\n${SELF_CHECK_MARKER}\n{}`, [9, 10])).toThrow("schema");
    expect(() => parseSelfCheckedMarkdown(response([{ page: 11, old: "Text", new: "Changed" }]), [9, 10])).toThrow("invalid local edit");
    expect(() => parseSelfCheckedMarkdown(response([], { uncertain: [9] }), [9, 10])).toThrow("could not verify");
    expect(() => parseSelfCheckedMarkdown(response([], { fullDocument: "replacement" }), [9, 10])).toThrow("schema");
  });
  it("rejects ambiguous anchors, missing anchors, overlapping edits and marker injection", () => {
    for (const edits of [
      [{ page: 9, old: "Text", new: "Changed" }],
      [{ page: 9, old: "Not present", new: "Changed" }],
      [{ page: 9, old: "Text before.", new: "One" }, { page: 9, old: "before.", new: "Two" }],
      [{ page: 9, old: "Text before.", new: "<!-- chatpdf-page:11 -->" }],
    ]) expect(() => parseSelfCheckedMarkdown(response(edits), [9, 10])).toThrow();
  });
  it("requires matching pages and Markdown digest before reusing a saved check", () => {
    const check = { ...parseSelfCheckedMarkdown(response([]), [9, 10]).check, markdownDigest: "digest" };
    expect(reusableSelfCheck(check, [9, 10], "digest")).toBe(true);
    expect(reusableSelfCheck(check, [9, 10], "modified")).toBe(false);
    expect(reusableSelfCheck(check, [9], "digest")).toBe(false);
    expect(reusableSelfCheck(undefined, [9, 10], "digest")).toBe(false);
  });
});
