import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, ".scaffold", "build");

function requestedVersion() {
  const index = process.argv.indexOf("--version");
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--version requires a value");
  }
  return value.replace(/^v/, "");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function renderTemplate(value, data) {
  return value.replace(/\{\{(version|xpiName)\}\}/g, (_match, key) => data[key]);
}

async function main() {
  const pkg = await readJson(resolve(root, "package.json"));
  const manifest = await readJson(resolve(dist, "addon", "manifest.json"));
  const updateManifest = await readJson(resolve(dist, "update.json"));
  const xpiPath = resolve(dist, `${pkg.config.xpiName}.xpi`);
  const xpi = await readFile(xpiPath);
  const expectedVersion = requestedVersion() || pkg.version;
  const templateData = { version: expectedVersion, xpiName: pkg.config.xpiName };
  const expectedDownloadLink = renderTemplate(pkg.config.xpiDownloadLink, templateData);

  assertEqual(pkg.version, expectedVersion, "package version");
  assertEqual(manifest.version, expectedVersion, "built manifest version");
  assertEqual(manifest.applications?.zotero?.id, pkg.config.addonID, "built manifest add-on ID");
  assertEqual(manifest.applications?.zotero?.update_url, pkg.config.updateURL, "built manifest update URL");

  const updates = updateManifest.addons?.[pkg.config.addonID]?.updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error(`update.json has no entries for ${pkg.config.addonID}`);
  }
  const update = updates.find((entry) => entry.version === expectedVersion);
  if (!update) {
    throw new Error(`update.json has no entry for version ${expectedVersion}`);
  }

  assertEqual(update.update_link, expectedDownloadLink, "update download link");
  const expectedHash = `sha512:${createHash("sha512").update(xpi).digest("hex")}`;
  assertEqual(update.update_hash, expectedHash, "update XPI hash");
  assertEqual(
    update.applications?.zotero?.strict_min_version,
    manifest.applications?.zotero?.strict_min_version,
    "minimum Zotero version",
  );
  assertEqual(
    update.applications?.zotero?.strict_max_version,
    manifest.applications?.zotero?.strict_max_version,
    "maximum Zotero version",
  );

  if (!pkg.config.updateURL.startsWith("https://") || !expectedDownloadLink.startsWith("https://")) {
    throw new Error("release manifest and XPI URLs must use HTTPS");
  }

  console.log(`Release artifacts verified for v${expectedVersion}`);
  console.log(`Update manifest: ${pkg.config.updateURL}`);
  console.log(`XPI: ${expectedDownloadLink}`);
  console.log(`Hash: ${expectedHash}`);
}

main().catch((error) => {
  console.error(`Release artifact verification failed: ${error.message}`);
  process.exitCode = 1;
});
