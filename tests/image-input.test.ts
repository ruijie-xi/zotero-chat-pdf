import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSession } from "../src/modules/chat-session";
import { imageMime, importImage, listSourceImages, MAX_IMAGE_BYTES, readSourceImage, safeImagePath } from "../src/modules/image-input";
import { executeTool, getToolDefinitions, ToolExecutionContext } from "../src/modules/tools";
import { runAgentLoop } from "../src/modules/agent-loop";
import * as llm from "../src/modules/llm-client";
import { addZoteroItemToSession } from "../src/modules/zotero-items";

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...new Array(16).fill(0)]);
let files: Map<string, Uint8Array>;
let links: Set<string>;

beforeEach(() => {
  files = new Map();
  links = new Set();
  vi.mocked(Zotero.Prefs.get).mockImplementation((key) => key.endsWith("cacheDir") ? "/cache" : undefined);
  Object.assign(PathUtils, { filename: (p: string) => p.split("/").at(-1) });
  Object.assign(Zotero, { File: { pathToFile: (p: string) => ({ isSymlink: () => links.has(p) }) } });
  Object.assign(IOUtils, {
    exists: vi.fn(async (p: string) => files.has(p) || [...files.keys()].some(key => key.startsWith(`${p}/`))),
    makeDirectory: vi.fn(async () => {}),
    write: vi.fn(async (p: string, bytes: Uint8Array) => { files.set(p, bytes); return bytes.length; }),
    read: vi.fn(async (p: string) => {
      const bytes = files.get(p);
      if (!bytes) throw new Error("File missing");
      return bytes;
    }),
    stat: vi.fn(async (p: string) => {
      if (files.has(p)) return { type: "regular", size: files.get(p)!.length };
      if ([...files.keys()].some(key => key.startsWith(`${p}/`))) return { type: "directory" };
      throw new Error("File missing");
    }),
    getChildren: vi.fn(async (p: string) => [...new Set([...files.keys()].filter(key => key.startsWith(`${p}/`)).map(key => `${p}/${key.slice(p.length + 1).split("/")[0]}`))]),
  });
});

function context(session: ChatSession): ToolExecutionContext {
  return { session, turnScope: session.resolveTurnScope([]), requestId: "image-test", windowId: "test" };
}

describe("image sources", () => {
  it("validates file contents rather than trusting filenames or MIME labels", () => {
    expect(imageMime(png)).toBe("image/png");
    expect(imageMime(Uint8Array.from([255, 216, 255, 224]))).toBe("image/jpeg");
    expect(imageMime(new TextEncoder().encode("RIFF1234WEBPVP8 "))).toBe("image/webp");
    expect(() => imageMime(new TextEncoder().encode("<svg><script>bad()</script></svg>"))).toThrow("Unsupported");
    expect(() => imageMime(new Uint8Array(MAX_IMAGE_BYTES + 1))).toThrow("10 MiB");
    expect(() => imageMime(new Uint8Array())).toThrow("non-empty");
  });

  it.each(["../secret.png", "/tmp/image.png", "C:/secret.png", "images/../../secret.png", "images\\secret.png", "https://example.org/a.png", "a//b.png", "a./b.png", "./a.png", "a\u0000.png"])("rejects unsafe path %s", path => {
    expect(() => safeImagePath(path)).toThrow("relative path");
  });

  it("atomically caches selected bytes and preserves image identity through history", async () => {
    const session = new ChatSession();
    const source = await importImage(session, png, "Screenshot.png");
    expect(IOUtils.write).toHaveBeenCalledWith(expect.any(String), png, expect.objectContaining({ tmpPath: expect.any(String), flush: true }));
    const restored = ChatSession.fromSavedSession(session.toSavedSession());
    const image = await readSourceImage(restored.getSource(source.id)!);
    expect(image.mime).toBe("image/png");
    expect(image.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(restored.getSource(source.id)).toMatchObject({ kind: "image", status: "ready" });
    expect(JSON.stringify(session.toSavedSession())).not.toContain("base64");
    session.removeSource(source.id);
    expect(ChatSession.fromSavedSession(session.toSavedSession()).getSources()).toHaveLength(0);
  });

  it("does not publish a source when its cache write fails", async () => {
    const session = new ChatSession();
    vi.mocked(IOUtils.write).mockRejectedValueOnce(new Error("Disk full"));
    await expect(importImage(session, png, "image.png")).rejects.toThrow("Disk full");
    expect(session.getSources()).toHaveLength(0);
  });

  it("does not publish a late image import after switching chats", async () => {
    const session = new ChatSession();
    await expect(importImage(session, png, "image.png", undefined, () => false)).rejects.toMatchObject({ name: "AbortError" });
    expect(session.getSources()).toHaveLength(0);
  });

  it("imports a Zotero image without MinerU and preserves library identity", async () => {
    files.set("/zotero/image.png", png);
    const attachment = { key: "IMAGE", libraryID: 4, parentItem: { key: "PAPER" },
      isAttachment: () => true, attachmentContentType: "image/png", getField: () => "Figure", getFilePathAsync: async () => "/zotero/image.png" };
    const session = new ChatSession();
    const result = await addZoteroItemToSession(attachment as unknown as Zotero.Item, session);
    expect(result.sourceKey).toBe("4:IMAGE");
    expect(session.getSource("4:IMAGE")).toMatchObject({ kind: "image", parentKey: "PAPER", status: "ready" });
  });

  it("lists nested PDF figures and blocks links outside its cache", async () => {
    const session = new ChatSession();
    const source = session.addSource("PDF", "Paper", undefined, 2);
    files.set("/cache/documents/2-PDF/assets/chunk-1/images/fig.png", png);
    files.set("/cache/documents/2-PDF/document.md", new Uint8Array([1]));
    expect(await listSourceImages(source)).toEqual(["assets/chunk-1/images/fig.png"]);
    expect((await readSourceImage(source, "assets/chunk-1/images/fig.png")).byteLength).toBe(png.length);
    links.add("/cache/documents/2-PDF/assets/chunk-1");
    expect(await listSourceImages(source)).toEqual([]);
    await expect(readSourceImage(source, "assets/chunk-1/images/fig.png")).rejects.toThrow("Linked");
  });

  it("enforces TurnScope before touching image bytes and handles missing files", async () => {
    const session = new ChatSession();
    const source = await importImage(session, png, "Image");
    const ctx = { ...context(session), turnScope: new Set<string>(), deliverImage: vi.fn() };
    expect(await executeTool("read_image", { key: source.id }, ctx)).toContain("outside this turn");
    expect(IOUtils.read).not.toHaveBeenCalled();
    expect(ctx.deliverImage).not.toHaveBeenCalled();
    files.clear();
    expect(await executeTool("read_image", { key: source.id }, { ...ctx, turnScope: session.resolveTurnScope([]) })).toContain("File missing");
  });

  it("propagates cancellation without turning it into an ordinary tool error", async () => {
    const session = new ChatSession();
    const source = await importImage(session, png, "Image");
    const controller = new AbortController();
    controller.abort();
    await expect(executeTool("read_image", { key: source.id }, { ...context(session), signal: controller.signal, deliverImage: vi.fn() })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("agent visual delivery", () => {
  it("terminates before sending a source removed after its tool completed", async () => {
    const session = new ChatSession();
    const source = await importImage(session, png, "Figure");
    const chat = vi.spyOn(llm, "chatWithTools").mockResolvedValueOnce({ content: "", tool_calls: [
      { id: "read-1", type: "function", function: { name: "read_image", arguments: JSON.stringify({ key: source.id }) } },
    ] });
    await expect(runAgentLoop(session.buildAgentMessages("Read"), getToolDefinitions(), session, {
      onToolCallEnd: () => session.removeSource(source.id),
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("sends images after all tool responses, keeps history textual, and supports rereading restored sources", async () => {
    const session = new ChatSession();
    const source = await importImage(session, png, "Figure");
    const chat = vi.spyOn(llm, "chatWithTools")
      .mockResolvedValueOnce({ content: "", tool_calls: [
        { id: "read-1", type: "function", function: { name: "read_image", arguments: JSON.stringify({ key: source.id }) } },
        { id: "list-2", type: "function", function: { name: "list_sources", arguments: "{}" } },
      ] })
      .mockImplementationOnce(async (messages) => {
        expect(messages.slice(-3).map(m => m.role)).toEqual(["tool", "tool", "user"]);
        const parts = messages.at(-1)!.content as llm.VisionContent;
        expect(parts[0]).toMatchObject({ type: "text", text: expect.stringContaining(source.id) });
        expect(parts[1]).toMatchObject({ type: "image_url", image_url: { url: expect.stringContaining("data:image/png;base64,"), detail: "auto" } });
        const body = llm.buildChatCompletionBody({ model: "vision", thinkingMode: "default", thinkEffort: "default" }, messages, { stream: true });
        expect(JSON.stringify(body)).toContain("image_url");
        return { content: "I can inspect the figure." };
      });
    const result = await runAgentLoop(session.buildAgentMessages("Read this image"), getToolDefinitions(), session);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.iterations[0].toolCalls[0].result).toContain("Image attached");
    expect(JSON.stringify(result)).not.toContain("base64,");
    session.addAssistantMessage(result.content, undefined, undefined, undefined, result.iterations);
    expect(JSON.stringify(session.toSavedSession())).not.toContain("data:image");
  });

  it("reports the aggregate byte limit for concurrent image tools without attaching excess bytes", async () => {
    const session = new ChatSession();
    const bytes = new Uint8Array(MAX_IMAGE_BYTES);
    bytes.set(png);
    const source = await importImage(session, bytes, "Large");
    vi.spyOn(llm, "chatWithTools")
      .mockResolvedValueOnce({ content: "", tool_calls: [1, 2, 3].map(i => ({ id: `read-${i}`, type: "function" as const,
        function: { name: "read_image", arguments: JSON.stringify({ key: source.id }) } })) })
      .mockImplementationOnce(async messages => {
        const images = (messages.at(-1)!.content as llm.VisionContent).filter(p => p.type === "image_url");
        expect(images).toHaveLength(2);
        expect(messages.filter(m => m.role === "tool").some(m => String(m.content).includes("20 MiB"))).toBe(true);
        return { content: "Limit reached" };
      });
    await runAgentLoop(session.buildAgentMessages("Read images"), getToolDefinitions(), session);
  });
});
