// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSourceSnapshot } from "../scripts/build-source-snapshot.mjs";

let root: string | undefined;
afterEach(async () => { if (root) { await rm(root, { recursive: true }); root = undefined; } });
describe("source snapshot packaging", () => {
  it("includes exact project source with stable hashes and excludes private/vendor files", async () => {
    root = await mkdtemp(join(tmpdir(), "chatpdf-source-test-"));
    const inputs = {
      "src/main.ts": "const x = 1;\r\n", "addon/bootstrap.js": "startup();", "addon/content/preferences.xhtml": "<div />",
      "addon/content/katex.css": "vendor", "addon/content/tokenizers/data.json": "vendor", "addon/secret.env": "secret",
      "scripts/build-source-snapshot.mjs": "export {};", "package.json": "{}", "zotero-plugin.config.ts": "export {};",
      "docs/agent-capabilities.md": "Architecture", "docs/llm-workflow.md": "Workflow", ".env": "secret", "cache/req.json": "private",
    };
    for (const [path, content] of Object.entries(inputs)) {
      await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), content);
    }
    const snapshot = await createSourceSnapshot(root, "0.9.5", "build-one");
    expect(snapshot.files.map((file: any) => file.path)).toEqual([
      "addon/bootstrap.js", "addon/content/preferences.xhtml", "docs/agent-capabilities.md", "docs/llm-workflow.md",
      "package.json", "scripts/build-source-snapshot.mjs", "src/main.ts", "zotero-plugin.config.ts",
    ]);
    const file = snapshot.files.find((file: any) => file.path === "src/main.ts");
    const bytes = await readFile(join(root, "src/main.ts"));
    expect(file).toMatchObject({ content: inputs["src/main.ts"], line_count: 2, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    expect((await createSourceSnapshot(root, "0.9.5", "build-two")).snapshot_sha256).toBe(snapshot.snapshot_sha256);
    await writeFile(join(root, "src/main.ts"), "const x = 2;");
    expect((await createSourceSnapshot(root, "0.9.5", "build-one")).snapshot_sha256).not.toBe(snapshot.snapshot_sha256);
  });
});
