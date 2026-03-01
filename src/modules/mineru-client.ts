import { getPref } from "../utils/prefs";

const MINERU_API_BASE = "https://mineru.net";
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 360000; // 6 minutes

export type ProgressCallback = (
  status: "uploading" | "processing" | "downloading" | "done" | "error",
  message: string,
) => void;

interface BatchApplyResponse {
  batch_id: string;
  file_urls: { url: string; method: string }[];
}

interface ExtractResult {
  state: string;
  err_msg?: string;
  full_zip_url?: string;
  md_url?: string;
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

  // Step 2: Get upload URL via batch apply
  onProgress?.("uploading", "Requesting upload URL...");
  const applyRes = await fetch(`${MINERU_API_BASE}/api/v4/file-urls/batch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      enable_formula: true,
      language: "en",
      layout_model: "doclayout_yolo",
      enable_table: true,
      files: [
        {
          name: PathUtils.filename(pdfPath),
          is_ocr: false,
        },
      ],
    }),
  });

  if (!applyRes.ok) {
    const text = await applyRes.text();
    throw new Error(`MinerU batch apply failed (${applyRes.status}): ${text}`);
  }

  const applyData = (await applyRes.json()) as {
    code: number;
    msg: string;
    data: BatchApplyResponse;
  };

  if (applyData.code !== 0) {
    throw new Error(`MinerU batch apply error: ${applyData.msg}`);
  }

  const { batch_id, file_urls } = applyData.data;
  const uploadInfo = file_urls[0];

  // Step 3: Upload PDF bytes
  onProgress?.("uploading", "Uploading PDF...");
  const uploadRes = await fetch(uploadInfo.url, {
    method: uploadInfo.method,
    body: pdfBytes,
    headers: {
      "Content-Type": "application/pdf",
    },
  });

  if (!uploadRes.ok) {
    throw new Error(`PDF upload failed (${uploadRes.status})`);
  }

  // Step 4: Poll for results
  onProgress?.("processing", "Converting PDF to Markdown...");
  const startTime = Date.now();

  while (true) {
    if (Date.now() - startTime > POLL_TIMEOUT_MS) {
      throw new Error("MinerU conversion timed out after 6 minutes");
    }

    await new Promise((resolve) =>
      _globalThis.setTimeout(resolve, POLL_INTERVAL_MS),
    );

    const pollRes = await fetch(
      `${MINERU_API_BASE}/api/v4/extract-results/batch/${batch_id}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!pollRes.ok) {
      continue;
    }

    const pollData = (await pollRes.json()) as {
      code: number;
      msg: string;
      data: BatchResultResponse;
    };

    if (pollData.code !== 0) {
      continue;
    }

    const result = pollData.data.extract_result[0];

    if (result.state === "done") {
      const mdUrl = result.md_url;
      if (!mdUrl) {
        throw new Error("Conversion completed but no markdown URL returned");
      }

      // Step 5: Download markdown
      onProgress?.("downloading", "Downloading Markdown...");
      const mdRes = await fetch(mdUrl);
      if (!mdRes.ok) {
        throw new Error(`Failed to download markdown (${mdRes.status})`);
      }
      const markdown = await mdRes.text();
      onProgress?.("done", "Conversion complete");
      return markdown;
    } else if (result.state === "failed") {
      throw new Error(
        `MinerU conversion failed: ${result.err_msg || "unknown error"}`,
      );
    }

    onProgress?.("processing", `Converting... (${result.state})`);
  }
}
