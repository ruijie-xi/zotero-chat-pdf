import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";
import { writeSourceSnapshot } from "./scripts/build-source-snapshot.mjs";
import { verifyVisualAssets } from "./scripts/verify-visual-assets.mjs";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  xpiName: pkg.config.xpiName,
  xpiDownloadLink: pkg.config.xpiDownloadLink,
  updateURL: pkg.config.updateURL,

  build: {
    hooks: { "build:bundle": async (...args) => { await verifyVisualAssets(); await writeSourceSnapshot(...args); } },
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      description: pkg.description,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/visual/host.ts", "src/visual/sandbox.ts"],
        entryNames: "[name]",
        bundle: true,
        target: "firefox140",
        outdir: ".scaffold/build/addon/content/visual/scripts",
      },
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox140",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
      {
        entryPoints: ["src/modules/preference-script.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox140",
        outfile: `.scaffold/build/addon/content/scripts/preferences.js`,
      },
    ],
  },
});
