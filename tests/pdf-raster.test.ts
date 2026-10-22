import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync("addon/content/scripts/pdf-renderer.js", "utf8")
  .replace('await import(`${base}build/pdf.mjs`)', "mockPdfjs");

async function fixture() {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
    render: vi.fn((_options: any) => ({ promise: Promise.resolve(), cancel: vi.fn() })), cleanup: vi.fn(),
  };
  const canvas = { width: 0, height: 0, getContext: () => ({}), toDataURL: vi.fn(() => "data:image/jpeg;base64,AA==") };
  const win: any = {};
  runInNewContext(source, { window: win, Uint8Array,
    document: { createElementNS: () => canvas },
    mockPdfjs: { GlobalWorkerOptions: {}, getDocument: () => ({
      promise: Promise.resolve({ numPages: 1, getPage: async () => page }), destroy: async () => {},
    }) },
  });
  const api = await win.chatpdfRendererReady;
  await api.open(new Uint8Array());
  return { api, page, canvas };
}

describe("PDF.js raster coordinates and resolution", () => {
  it("keeps full pages at 300 DPI and directly rasterizes a 600 DPI crop", async () => {
    const { api, page, canvas } = await fixture();
    const full = await api.render(1, 300);
    expect(full).toMatchObject({ width: 2550, effectiveDpi: 300 });
    expect(Math.abs(full.height - 3300)).toBeLessThanOrEqual(1);
    const region = { x: 0.5, y: 0.25, width: 0.5, height: 0.25 };
    const crop = await api.render(1, 600, JSON.stringify(region));
    expect(crop).toMatchObject({ width: 2550, effectiveDpi: 600, region });
    expect(Math.abs(crop.height - 1650)).toBeLessThanOrEqual(1);
    const options = page.render.mock.calls[1][0];
    expect(options.intent).toBe("print");
    expect(options.transform.slice(0, 4)).toEqual([1, 0, 0, 1]);
    expect(options.transform[4]).toBeCloseTo(-2550);
    expect(options.transform[5]).toBeCloseTo(-1650);
    expect(canvas.toDataURL).toHaveBeenLastCalledWith("image/jpeg", 0.95);
    expect(canvas.width).toBe(0); expect(canvas.height).toBe(0);
    await api.close();
  });
  it("reports a reduced effective DPI for oversized full-page rasters", async () => {
    const { api } = await fixture();
    const result = await api.render(1, 600);
    expect(result.effectiveDpi).toBeLessThan(600);
    expect(result.width * result.height).toBeLessThan(16010000);
    await api.close();
  });
});
