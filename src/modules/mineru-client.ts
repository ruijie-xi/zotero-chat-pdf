import { getPref } from "../utils/prefs";

const MINERU_API_BASE = "https://mineru.net";
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 360000; // 6 minutes

function log(...args: any[]) {
  Zotero.debug(`[ChatPDF/MinerU] ${args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")}`);
}

export type ProgressCallback = (
  status: "uploading" | "processing" | "downloading" | "done" | "error",
  message: string,
) => void;

interface BatchApplyResponse {
  batch_id: string;
  file_urls: string[];
}

interface ExtractResult {
  state: string;
  err_msg?: string;
  full_zip_url?: string;
}

interface BatchResultResponse {
  extract_result: ExtractResult[];
}

export async function convertPdf(
  pdfPath: string,
  onProgress?: ProgressCallback,
): Promise<string> {
  const token = getPref("mineruToken");
  if (!token) {
    throw new Error("MinerU API token not configured. Set it in ChatPDF preferences.");
  }

  // Step 1: Read PDF bytes
  onProgress?.("uploading", "Reading PDF file...");
  const pdfBytes = await IOUtils.read(pdfPath);
  log("Read PDF:", pdfPath, "size:", pdfBytes.length, "bytes");

  // Step 2: Get upload URL via batch apply
  onProgress?.("uploading", "Requesting upload URL...");
  const requestBody = {
    enable_formula: true,
    enable_table: true,
    language: "en",
    model_version: "pipeline",
    files: [
      {
        name: PathUtils.filename(pdfPath),
        is_ocr: false,
      },
    ],
  };
  log("Batch apply request:", requestBody);

  const applyRes = await fetch(`${MINERU_API_BASE}/api/v4/file-urls/batch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(requestBody),
  });

  const applyText = await applyRes.text();
  log("Batch apply response status:", applyRes.status, "body:", applyText);

  if (!applyRes.ok) {
    throw new Error(`MinerU batch apply failed (${applyRes.status}): ${applyText}`);
  }

  const applyData = JSON.parse(applyText) as {
    code: number;
    msg: string;
    data: BatchApplyResponse;
  };

  if (applyData.code !== 0) {
    throw new Error(`MinerU batch apply error (code ${applyData.code}): ${applyData.msg}`);
  }

  const { batch_id, file_urls } = applyData.data;
  const uploadUrl = file_urls[0];
  log("Got batch_id:", batch_id, "upload url:", uploadUrl?.substring(0, 80) + "...");

  // Step 3: Upload PDF bytes via PUT (as per MinerU docs)
  onProgress?.("uploading", "Uploading PDF...");
  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    body: pdfBytes,
  });

  log("Upload response status:", uploadRes.status);
  if (!uploadRes.ok) {
    const uploadErrText = await uploadRes.text();
    log("Upload error body:", uploadErrText);
    throw new Error(`PDF upload failed (${uploadRes.status}): ${uploadErrText}`);
  }

  // Step 4: Poll for results
  onProgress?.("processing", "Converting PDF to Markdown...");
  const startTime = Date.now();

  while (true) {
    if (Date.now() - startTime > POLL_TIMEOUT_MS) {
      throw new Error("MinerU conversion timed out after 6 minutes");
    }

    await Zotero.Promise.delay(POLL_INTERVAL_MS);

    const pollRes = await fetch(
      `${MINERU_API_BASE}/api/v4/extract-results/batch/${batch_id}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!pollRes.ok) {
      const pollErrText = await pollRes.text();
      log("Poll HTTP error:", pollRes.status, pollErrText);
      continue;
    }

    const pollText = await pollRes.text();
    log("Poll response body:", pollText);

    const pollData = JSON.parse(pollText) as {
      code: number;
      msg: string;
      data: BatchResultResponse;
    };

    if (pollData.code !== 0) {
      log("Poll non-zero code:", pollData.code, pollData.msg);
      continue;
    }

    const result = pollData.data.extract_result[0];
    log("Extract result state:", result.state, "err_msg:", result.err_msg, "full_zip_url:", result.full_zip_url?.substring(0, 60));

    if (result.state === "done") {
      const zipUrl = result.full_zip_url;
      if (!zipUrl) {
        log("ERROR: No download URL in done result");
        throw new Error("Conversion completed but no download URL returned");
      }

      // Step 5: Download ZIP and extract markdown
      onProgress?.("downloading", "Downloading results...");
      const zipRes = await fetch(zipUrl);
      if (!zipRes.ok) {
        log("ERROR: Failed to download ZIP:", zipRes.status);
        throw new Error(`Failed to download results (${zipRes.status})`);
      }

      const zipBytes = new Uint8Array(await zipRes.arrayBuffer());
      log("Downloaded ZIP size:", zipBytes.length, "bytes");
      const markdown = await extractMarkdownFromZip(zipBytes);
      log("Extracted markdown length:", markdown.length);
      onProgress?.("done", "Conversion complete");
      return markdown;
    } else if (result.state === "failed") {
      log("ERROR: Conversion failed:", result.err_msg);
      throw new Error(
        `MinerU conversion failed: ${result.err_msg || "unknown error"}`,
      );
    }

    onProgress?.("processing", `Converting... (${result.state})`);
  }
}

/**
 * Extract the markdown content from a MinerU result ZIP.
 * The ZIP contains files like: {filename}.md, {filename}_model.json, etc.
 * We need to find and read the .md file.
 */
async function extractMarkdownFromZip(zipBytes: Uint8Array): Promise<string> {
  // Write ZIP to a temp file, extract, and read the .md file
  const tempDir = PathUtils.join(PathUtils.tempDir, `chatpdf-${Date.now()}`);
  const tempZip = tempDir + ".zip";

  try {
    await IOUtils.write(tempZip, zipBytes);

    // Use Zotero's built-in ZIP extraction
    const zipReader = Components.classes[
      "@mozilla.org/libjar/zip-reader;1"
    ].createInstance(Components.interfaces.nsIZipReader);

    const zipFile = Components.classes[
      "@mozilla.org/file/local;1"
    ].createInstance(Components.interfaces.nsIFile);
    zipFile.initWithPath(tempZip);

    zipReader.open(zipFile);

    try {
      // Find the .md file in the ZIP
      const entries = zipReader.findEntries("*.md");
      let mdEntry: string | null = null;

      while (entries.hasMore()) {
        const entry = entries.getNext();
        // Pick the first .md file (skip _middle.md etc. if present)
        if (entry.endsWith(".md") && !entry.includes("_middle")) {
          mdEntry = entry;
          break;
        }
      }

      if (!mdEntry) {
        // Fallback: try any .md file
        const allEntries = zipReader.findEntries("*.md");
        if (allEntries.hasMore()) {
          mdEntry = allEntries.getNext();
        }
      }

      if (!mdEntry) {
        throw new Error("No markdown file found in conversion results");
      }

      // Read the markdown content from the ZIP
      const inputStream = zipReader.getInputStream(mdEntry);
      const scriptableStream = Components.classes[
        "@mozilla.org/scriptableinputstream;1"
      ].createInstance(Components.interfaces.nsIScriptableInputStream);
      scriptableStream.init(inputStream);

      const bytes = scriptableStream.readBytes(scriptableStream.available());
      scriptableStream.close();
      inputStream.close();

      // Decode UTF-8
      const decoder = new TextDecoder("utf-8");
      const uint8 = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) {
        uint8[i] = bytes.charCodeAt(i);
      }
      return decoder.decode(uint8);
    } finally {
      zipReader.close();
    }
  } finally {
    // Clean up temp file
    try {
      await IOUtils.remove(tempZip);
    } catch {
      // ignore cleanup errors
    }
  }
}
