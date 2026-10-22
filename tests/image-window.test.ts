import { describe, expect, it } from "vitest";
import { AgentContext, ContextMessage } from "../src/modules/agent-context";
import { inlineImageBytes, OFFLOADED_IMAGE_TEXT, planImageOffload } from "../src/modules/image-window";

const policy = { triggerBytes: 200, targetBytes: 100 };
const page = (number: number, bytes = 60): ContextMessage => ({ role: "user", content: [
  { type: "text", text: `source=1:ABC12345 page=${number}; effective DPI=600; region=0,0,0.5,0.25` },
  { type: "image_url", image_url: { url: `data:image/jpeg;base64,${String(number).repeat(bytes)}`, detail: "high" } },
] });
const initial: ContextMessage[] = [{ role: "system", content: "stable policy" }, { role: "user", content: "Read the equations." }];
const imageUrls = (context: AgentContext) => context.messages.flatMap(m => Array.isArray(m.content)
  ? m.content.flatMap(p => p.type === "image_url" ? [p.image_url.url] : []) : []);

describe("one-way image history window", () => {
  it("offloads a batch of oldest delivered images and then preserves the exact prefix", () => {
    const context = AgentContext.create([...initial, page(1), page(2), page(3)], "model", 1);
    context.markImagesDelivered();
    context.append({ role: "assistant", content: "Equation 1 has a squared denominator." });
    const receipt = context.storeResult("Edit completed once", "change_zotero_library", []);
    receipt.mutating = true;
    context.append({ role: "tool", content: receipt.content, resultId: receipt.id });
    context.append(page(4));
    const original = structuredClone(context.data.events);
    expect(context.offloadImages(false, policy)).toMatchObject({ imageCount: 3, beforeBytes: 240, afterBytes: 60, reason: "watermark" });
    expect(context.messages.slice(0, 2)).toEqual(initial);
    expect(context.data.events.slice(0, original.length)).toEqual(original);
    expect(context.data.results[0]).toEqual(receipt);
    expect(context.messages[2].content).toEqual([
      (page(1).content as any[])[0], { type: "text", text: OFFLOADED_IMAGE_TEXT },
    ]);
    expect(imageUrls(context)).toEqual([(page(4).content as any[])[1].image_url.url]);
    const prefix = JSON.stringify(context.messages);
    context.markImagesDelivered(); context.append(page(5));
    expect(context.offloadImages(false, policy)).toBeUndefined();
    expect(JSON.stringify(context.messages.slice(0, -1))).toBe(prefix);
    expect(context.data.imageOffloads).toHaveLength(1);
  });

  it("never offloads a fresh image batch, even when it alone exceeds the watermark", () => {
    const context = AgentContext.create([...initial, page(1, 300)], "model", 1);
    const original = structuredClone(context.messages);
    expect(context.offloadImages(false, policy)).toBeUndefined();
    expect(context.offloadImages(true, policy)).toBeUndefined();
    expect(context.messages).toEqual(original);
    expect(context.data.imageOffloads).toBeUndefined();
  });

  it("protects new evidence while allowing the remaining request to exceed the target", () => {
    const context = AgentContext.create([...initial, page(1)], "model", 1);
    context.markImagesDelivered(); context.append(page(2, 300));
    expect(context.offloadImages(false, policy)).toMatchObject({ imageCount: 1, beforeBytes: 360, afterBytes: 300 });
    expect(context.offloadImages(false, policy)).toBeUndefined();
    expect(imageUrls(context)).toEqual([(page(2, 300).content as any[])[1].image_url.url]);
  });

  it("halves old image payload on 413 below the normal trigger and strictly progresses", () => {
    const context = AgentContext.create([...initial, page(1), page(2)], "model", 1);
    context.markImagesDelivered();
    expect(context.offloadImages(false, policy)).toBeUndefined();
    expect(context.offloadImages(true, policy)).toMatchObject({ imageCount: 1, afterBytes: 60, targetBytes: 60, reason: "http-413" });
    expect(context.offloadImages(true, policy)).toMatchObject({ imageCount: 1, afterBytes: 0 });
    expect(context.offloadImages(true, policy)).toBeUndefined();
  });

  it("treats a reread as new evidence without rehydrating or changing old placeholders", () => {
    const context = AgentContext.create([...initial, page(1)], "model", 1);
    context.markImagesDelivered(); context.offloadImages(true, policy);
    const prefix = structuredClone(context.messages);
    context.append(page(1));
    expect(context.offloadImages(true, policy)).toBeUndefined();
    expect(context.messages.slice(0, -1)).toEqual(prefix);
    expect(imageUrls(context)).toHaveLength(1);
  });

  it("preserves fully offloaded prefixes after persistence without storing any binary data", () => {
    const context = AgentContext.create([...initial, page(1)], "model", 1);
    context.markImagesDelivered(); context.offloadImages(true, policy);
    const saved = context.toJSON();
    expect(saved.requiresRebuild).not.toBe(true);
    expect(JSON.stringify(saved)).not.toContain("data:image");
    expect(AgentContext.restore(saved)?.messages).toEqual(context.messages);
    expect(AgentContext.restore(saved)?.offloadImages(true, policy)).toBeUndefined();
  });

  it("retains delivery identity for a tail copied by normal context compaction", () => {
    const context = AgentContext.create([...initial, page(1)], "model", 1);
    context.markImagesDelivered();
    const tail = context.messages.at(-1)!;
    context.compact("Prior analysis", initial[1], undefined, [tail]);
    expect(context.offloadImages(true, policy)?.imageCount).toBe(1);
    expect(context.messages[1].content).toContain("Prior analysis");
  });

  it("counts encoded payloads exactly and ignores short remote references", () => {
    expect(inlineImageBytes("data:image/jpeg;base64,AA==")).toBe(4);
    expect(inlineImageBytes("https://example.com/page.jpg")).toBe(0);
    const remote: ContextMessage = { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/page.jpg" } }] };
    expect(planImageOffload([remote], new Set([0]), true, policy)).toBeUndefined();
  });
});
