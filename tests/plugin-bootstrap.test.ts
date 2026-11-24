import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

const bootstrap = readFileSync("addon/bootstrap.js", "utf8");
const rootURI = "file:///fixture/";
const invalidArg = 0x80070057;

it.each([true, false])("registers the renderer on hosts with dynamic content flags %s", async (supportsFlags) => {
  const attempts: string[][][] = [];
  const destruct = vi.fn();
  const registerChrome = (_manifest: unknown, entries: string[][]) => {
    attempts.push(entries.map(entry => [...entry]));
    if (!supportsFlags && entries.some(entry => entry.includes("contentaccessible=yes"))) {
      throw Object.assign(new Error("Unsupported content flag"), { result: invalidArg });
    }
    return { destruct };
  };
  const hooks = { onStartup: vi.fn(), onShutdown: vi.fn() };
  const zotero = { __addonInstance__: { hooks } };
  const loadSubScript = vi.fn();
  const lifecycle = runInNewContext(bootstrap + "\n({ startup, shutdown })", {
    Components: {
      classes: { "@mozilla.org/addons/addon-manager-startup;1": { getService: () => ({ registerChrome }) } },
      interfaces: {},
      results: { NS_ERROR_INVALID_ARG: invalidArg },
    },
    Services: { io: { newURI: (uri: string) => uri }, scriptloader: { loadSubScript } },
    Zotero: zotero,
    APP_SHUTDOWN: 2,
  });

  await lifecycle.startup({ rootURI }, 3);
  const renderer = ["content", "chatpdf-visual", rootURI + "content/visual/"];
  const entries = [
    ["content", "__addonRef__", rootURI + "content/"],
    [...renderer, "contentaccessible=yes"],
    ["locale", "__addonRef__", "en-US", rootURI + "locale/en-US/"],
  ];
  expect(attempts).toEqual(supportsFlags ? [entries] : [entries, [entries[0], renderer, entries[2]]]);
  expect(loadSubScript.mock.calls[0][1].Zotero).toBe(zotero);
  expect(hooks.onStartup).toHaveBeenCalledOnce();
  await lifecycle.shutdown({}, 4);
  expect(hooks.onShutdown).toHaveBeenCalledOnce();
  expect(destruct).toHaveBeenCalledOnce();
});
