import { atomicWriteJson } from "../utils/atomic-storage";
import { SourceItem } from "./chat-session";
import { getPref } from "../utils/prefs";
import { convertPdfWithVision } from "./vision-client";
import { getVisionConversionConfig, sameVisionConfig, validateVisionConversionConfig, VisionConversionConfig } from "./vision-conversion-config";
import { validateConversionContract, ConvertedPdf, buildChunkPlan } from "./pdf-conversion";
import { VISION_QUALITY_GATE } from "./vision-quality";
import { parseVisionPages, checkVisionMath } from "./vision-quality";
import { SELF_CHECK_QUALITY_GATE } from "./vision-self-check";
import { applyConversionEvent, ConversionDetails, ConversionDetailEvent, conversionCounts, conversionDraftPage, emptyConversionDetails, interruptConversionRequests } from "./conversion-details";
import { sumTokenUsage, TokenUsage } from "./llm-client";
import { readImageFile, imageMime } from "./image-input";
import {
  convertPdf,
  getMineruTaskState,
  MineruConversionOptions,
  MineruRemoteTask,
  MINERU_LONG_PDF_CHUNK_SIZE,
  PdfChunkPlanItem,
  PdfChunkResult,
  ProgressCallback,
} from "./mineru-client";
import * as MDCache from "./md-cache";
import { createAbortController } from "./panel-state";
import { makeSourceId, sourceCacheKey } from "./source-identity";

export type ConversionState =
  | "pending" | "converting" | "recovering" | "ready"
  | "error" | "cancelled" | "interrupted" | "unknown";

export interface ConversionOptions {
  engine?: "mineru" | "vision";
  vision?: VisionConversionConfig;
  modelVersion?: "pipeline" | "vlm";
  language?: string;
  isOcr?: boolean;
  enableFormula?: boolean;
  enableTable?: boolean;
  mineruPollTimeoutSeconds?: number;
}

export interface ConversionRequest {
  key: string;
  libraryID: number;
  title?: string;
  parentItemKey?: string;
  force?: boolean;
  options?: ConversionOptions;
}

export interface ConversionStatus {
  jobId: string;
  state: ConversionState;
  documentId?: string;
  title: string;
  progress: string;
  error: string;
  stage: string;
  currentChunk?: number;
  totalChunks?: number;
  progressPercent?: number;
  createdAt: string;
  updatedAt: string;
  retryable: boolean;
  remoteMayContinue: boolean;
  options?: ConversionOptions;
  completedPages?: number;
  totalPages?: number;
  reusedPages?: number;
  requestCount?: number;
  activeRequests?: number;
  receivingRequests?: number;
  usage?: TokenUsage;
  runStartedAt?: number;
}

interface StoredJob {
  jobId: string;
  cacheKey: string;
  request: ConversionRequest;
  status: ConversionStatus;
  remoteTasks: Record<string, MineruRemoteTask>;
  completedChunks: number[];
  manifest?: MDCache.DocumentManifest;
  sourceDigest?: string;
  details?: ConversionDetails;
}

interface Job extends StoredJob {
  controller: ReturnType<typeof createAbortController>["controller"];
  completion: Promise<ConversionStatus>;
  resolve: (status: ConversionStatus) => void;
  resolved: boolean;
  listeners: Set<(status: ConversionStatus) => void>;
  owners: Set<string>;
  suspending: boolean;
  drafts: Map<number, { requestId: string; markdown: string }>;
}

const STATES = new Set<ConversionState>([
  "pending", "converting", "recovering", "ready", "error", "cancelled", "interrupted", "unknown",
]);
const TERMINAL = new Set<ConversionState>(["ready", "error", "cancelled", "interrupted"]);
const jobs = new Map<string, Job>();
const activeByCacheKey = new Map<string, Job>();
const startingByCacheKey = new Map<string, Promise<ConversionStatus | null>>();
let initialized = false;
let initializing: Promise<void> | null = null;
let persistQueue = Promise.resolve();

const nowIso = () => new Date().toISOString();
const SENSITIVE_LOCATION = /https?:\/\/|file:\/\/|(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]|(?:^|[^A-Za-z0-9])\\\\[^\\\s]+\\|(?:^|[^A-Za-z0-9])\/(?:Users|home|var|tmp|private|mnt|cache|data|opt|srv|Volumes)(?:\/|\b)/i;

export function sanitizeConversionStatus(status: ConversionStatus): ConversionStatus {
  const stage = status.stage || status.state || "unknown";
  const redact = (value: string, fallback: string) => SENSITIVE_LOCATION.test(value || "") ? fallback : value;
  return {
    ...status,
    progress: redact(status.progress, `Conversion stage: ${stage}; location details redacted`),
    error: redact(status.error, `Conversion failed during ${stage}; location details redacted`),
    options: status.options ? { ...status.options, vision: status.options.vision ? { ...status.options.vision, apiBase: "" } : undefined } : undefined,
  };
}

function normalizeOptions(options?: ConversionOptions): ConversionOptions {
  const engine = options?.engine || (options?.modelVersion ? "mineru" : getPref("pdfConversionEngine") === "mineru" ? "mineru" : "vision");
  if (engine !== "vision" && engine !== "mineru") throw new Error("PDF conversion engine must be vision or mineru");
  return {
    engine,
    vision: engine === "vision" ? validateVisionConversionConfig(options?.vision || getVisionConversionConfig()) : undefined,
    modelVersion: options?.modelVersion || "pipeline",
    language: options?.language,
    isOcr: options?.isOcr ?? false,
    enableFormula: options?.enableFormula ?? true,
    enableTable: options?.enableTable ?? true,
    mineruPollTimeoutSeconds: options?.mineruPollTimeoutSeconds,
  };
}

function mineruOptions(options?: ConversionOptions): MineruConversionOptions {
  const value = normalizeOptions(options);
  return {
    modelVersion: value.modelVersion,
    language: value.language,
    isOcr: value.isOcr,
    enableFormula: value.enableFormula,
    enableTable: value.enableTable,
    pollTimeoutSeconds: value.mineruPollTimeoutSeconds,
  };
}

const snapshot = (job: Job) => sanitizeConversionStatus({ ...job.status,
  ...(job.details?.pageCount ? { ...conversionCounts(job.details), totalPages: job.details.pageCount,
    requestCount: job.details.requests.length, usage: job.manifest?.conversionUsage,
    activeRequests: job.details.requests.filter(request => request.state === "waiting" || request.state === "receiving").length,
    receivingRequests: job.details.requests.filter(request => request.state === "receiving").length,
    progressPercent: job.status.state === "ready" ? 100 : job.status.stage === "commit" ? 99
      : Math.min(99, 99 * conversionCounts(job.details).completedPages / job.details.pageCount) } : {}),
});
const stored = (job: Job): StoredJob => ({
  jobId: job.jobId,
  cacheKey: job.cacheKey,
  request: job.request,
  status: snapshot(job),
  remoteTasks: { ...job.remoteTasks },
  completedChunks: [...job.completedChunks],
  manifest: job.manifest,
  sourceDigest: job.sourceDigest,
  details: job.details ? JSON.parse(JSON.stringify(job.details)) : undefined,
});

function persist(): Promise<void> {
  const value = { version: 1, jobs: [...jobs.values()].map(stored) };
  persistQueue = persistQueue.catch(() => {}).then(() => atomicWriteJson(MDCache.getConversionRegistryPath(), value))
    .catch((error: any) => Zotero.debug(`[ChatPDF] Failed to persist conversions: ${error?.message || error}`));
  return persistQueue;
}

function update(job: Job, patch: Partial<ConversionStatus>): void {
  Object.assign(job.status, patch, { updatedAt: nowIso() });
  const value = snapshot(job);
  for (const listener of job.listeners) listener(value);
}

async function complete(job: Job, patch: Partial<ConversionStatus>): Promise<void> {
  if (patch.state === "ready") job.drafts.clear();
  if (job.details) {
    for (const chunk of job.details.chunks) {
      if (chunk.stage !== "ready") chunk.stage = patch.state === "cancelled" ? "cancelled" : "error";
    }
    applyConversionEvent(job.details, { type: "message", message: patch.state === "ready" ? "Complete document installed in cache" : String(patch.error || patch.progress || patch.state) });
  }
  update(job, patch);
  activeByCacheKey.delete(job.cacheKey);
  job.owners.clear();
  await persist();
  if (!job.resolved) {
    job.resolved = true;
    job.resolve(snapshot(job));
  }
}

function createJob(request: ConversionRequest, cacheKey: string, jobId?: string): Job {
  let resolve!: (status: ConversionStatus) => void;
  const completion = new Promise<ConversionStatus>((done) => { resolve = done; });
  const id = jobId || crypto.randomUUID?.() || `conversion-${Date.now()}-${Zotero.Utilities.randomString(12)}`;
  const createdAt = nowIso();
  return {
    jobId: id,
    cacheKey,
    request,
    remoteTasks: {},
    completedChunks: [],
    controller: createAbortController().controller,
    completion,
    resolve,
    resolved: false,
    listeners: new Set(),
    owners: new Set(),
    suspending: false,
    drafts: new Map(),
    details: emptyConversionDetails(),
    status: {
      jobId: id,
      state: "pending",
      documentId: makeSourceId(request.key, request.libraryID),
      title: request.title || request.key,
      progress: "Queued",
      error: "",
      stage: "queued",
      createdAt,
      updatedAt: createdAt,
      retryable: false,
      runStartedAt: Date.now(),
      remoteMayContinue: false,
      options: normalizeOptions(request.options),
    },
  };
}

function restoreJob(value: StoredJob): Job {
  // Registry v1 jobs created before engine selection always belong to MinerU.
  const request = { ...value.request, options: normalizeOptions({ ...value.request.options, engine: value.request.options?.engine || "mineru" }) };
  const job = createJob(request, value.cacheKey, value.jobId);
  job.status = sanitizeConversionStatus({ ...value.status, options: request.options });
  job.remoteTasks = { ...(value.remoteTasks || {}) };
  job.completedChunks = [...(value.completedChunks || [])];
  job.manifest = value.manifest;
  job.details = value.details?.version === 1 && Array.isArray(value.details.chunks) && Array.isArray(value.details.requests)
    && Array.isArray(value.details.events) && Array.isArray(value.details.renderedPages) ? value.details : value.manifest?.conversionDetails || emptyConversionDetails();
  interruptConversionRequests(job.details);
  if (job.manifest && !job.details.chunks.length) {
    job.details.pageCount = job.manifest.pageCount;
    job.details.chunks = job.manifest.chunks.map(chunk => ({ index: chunk.index, startPage: chunk.startPage, endPage: chunk.endPage,
      stage: chunk.status === "ready" ? "ready" : "queued", editsApplied: chunk.selfCheck?.editsApplied }));
    applyConversionEvent(job.details, { type: "message", message: "Loaded saved page ranges from the manifest; earlier request history is shown only if recorded" });
  }
  job.sourceDigest = value.sourceDigest;
  if (TERMINAL.has(job.status.state)) {
    job.resolved = true;
    job.resolve(snapshot(job));
  } else {
    job.owners.add("recovery");
  }
  return job;
}

function parseStored(value: unknown): StoredJob | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const job = value as Partial<StoredJob>;
  const request = job.request as Partial<ConversionRequest> | undefined;
  const status = job.status as Partial<ConversionStatus> | undefined;
  if (typeof job.jobId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(job.jobId)) return null;
  if (typeof job.cacheKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(job.cacheKey)) return null;
  if (!request || typeof request.key !== "string" || !/^[A-Za-z0-9]+$/.test(request.key)
    || !Number.isInteger(request.libraryID) || Number(request.libraryID) <= 0) return null;
  if (!status || status.jobId !== job.jobId || !STATES.has(status.state as ConversionState) || status.state === "unknown") return null;
  if (typeof status.title !== "string" || typeof status.progress !== "string" || typeof status.error !== "string") return null;
  if (typeof status.stage !== "string" || typeof status.createdAt !== "string" || typeof status.updatedAt !== "string"
    || typeof status.retryable !== "boolean" || typeof status.remoteMayContinue !== "boolean") return null;
  return {
    jobId: job.jobId,
    cacheKey: job.cacheKey,
    request: job.request as ConversionRequest,
    status: job.status as ConversionStatus,
    remoteTasks: job.remoteTasks && typeof job.remoteTasks === "object" ? job.remoteTasks : {},
    completedChunks: Array.isArray(job.completedChunks)
      ? job.completedChunks.filter((value): value is number => Number.isInteger(value) && value > 0)
      : [],
    manifest: job.manifest,
    details: job.details,
    sourceDigest: typeof job.sourceDigest === "string" ? job.sourceDigest : undefined,
  };
}

async function readRegistry(): Promise<unknown[]> {
  const path = MDCache.getConversionRegistryPath();
  if (!await IOUtils.exists(path)) return [];
  try {
    const value = JSON.parse(new TextDecoder().decode(await IOUtils.read(path)));
    return value?.version === 1 && Array.isArray(value.jobs) ? value.jobs : [];
  } catch (error: any) {
    Zotero.debug(`[ChatPDF] Ignoring invalid conversion registry: ${error?.message || error}`);
    return [];
  }
}

function findAttachment(request: ConversionRequest): Zotero.Item {
  const item = Zotero.Items.getByLibraryAndKey(request.libraryID, request.key);
  if (!item || !item.isAttachment?.()) throw new Error(`Cannot find PDF attachment ${request.libraryID}:${request.key}`);
  return item;
}

function libraryFields(libraryID: number): Pick<MDCache.DocumentManifest, "libraryID" | "libraryType" | "libraryId"> {
  const library = Zotero.Libraries.get(libraryID) as any;
  const libraryType = library?.libraryType === "group" ? "group" : "user";
  const libraryId = libraryType === "group"
    ? Number(library?.groupID ?? library?.libraryID ?? libraryID)
    : Number((Zotero as any).Users?.getCurrentUserID?.() ?? 0);
  return { libraryID, libraryType, libraryId };
}

async function reusableChunks(cacheKey: string, legacyKey: string): Promise<Map<number, string>> {
  const output = new Map<number, string>();
  const manifest = await MDCache.readManifest(cacheKey, legacyKey);
  if (!manifest || manifest.version < 2) return output;
  if (manifest.chunks.length > 1 && manifest.chunkSize !== MINERU_LONG_PDF_CHUNK_SIZE) return output;
  for (const chunk of manifest.chunks) {
    if (chunk.status !== "ready") continue;
    try {
      output.set(chunk.index, await MDCache.readChunk(cacheKey, chunk.index, legacyKey));
    } catch (error: any) {
      Zotero.debug(`[ChatPDF] Failed to reuse chunk ${chunk.index}: ${error?.message || error}`);
    }
  }
  return output;
}

function makeManifest(
  job: Job,
  title: string,
  pageCount: number,
  chunkSize: number,
  plan: PdfChunkPlanItem[],
  cached: Map<number, string>,
): MDCache.DocumentManifest {
  return {
    version: 3,
    key: job.request.key,
    documentId: job.status.documentId,
    ...libraryFields(job.request.libraryID),
    attachmentKey: job.request.key,
    parentItemKey: job.request.parentItemKey,
    converter: job.request.options?.engine || "mineru",
    conversionConfig: job.request.options?.vision,
    sourceDigest: job.sourceDigest,
    conversionJobId: job.jobId,
    qualityGate: job.request.options?.engine === "vision"
      ? job.request.options.vision?.selfCheck ? SELF_CHECK_QUALITY_GATE : VISION_QUALITY_GATE : undefined,
    title,
    pageCount,
    chunkSize,
    updatedAt: Date.now(),
    chunks: plan.map((chunk) => ({
      ...chunk,
      status: cached.has(chunk.index) ? "ready" : "pending",
      charCount: cached.get(chunk.index)?.length,
    })),
  };
}

function markChunkReady(manifest: MDCache.DocumentManifest, chunk: PdfChunkResult): void {
  const item = manifest.chunks.find((value) => value.index === chunk.index);
  if (item) Object.assign(item, {
    status: "ready",
    charCount: chunk.markdown.length,
    assetCount: chunk.assetCount,
    selfCheck: chunk.selfCheck,
    errorMessage: undefined,
  });
  manifest.updatedAt = Date.now();
}

function addLineRanges(manifest: MDCache.DocumentManifest, markdown: string): void {
  const markers = [...markdown.matchAll(/^<!-- chatpdf-chunk:(\d+) pages:\d+-\d+ -->$/gm)];
  for (let index = 0; index < markers.length; index++) {
    const chunk = manifest.chunks.find((value) => value.index === Number(markers[index][1]));
    if (!chunk) continue;
    chunk.lineStart = markdown.slice(0, markers[index].index).split("\n").length;
    chunk.lineEnd = index + 1 < markers.length
      ? markdown.slice(0, markers[index + 1].index).split("\n").length - 1
      : markdown.split("\n").length;
  }
  manifest.updatedAt = Date.now();
}

function progressPatch(state: Parameters<ProgressCallback>[0], message: string): Partial<ConversionStatus> {
  const stage = state === "uploading" ? (message.includes("upload URL") ? "submit" : "upload")
    : state === "processing" ? "poll" : state === "downloading" ? "download"
      : state === "done" ? "commit" : "error";
  return { state: "converting", stage, progress: message };
}

/** Only a finalized, digest-bound self-checked checkpoint can bypass rendering/model work. */
async function readCommitRecovery(job: Job, staged: Map<number, string>): Promise<ConvertedPdf | undefined> {
  const saved = await MDCache.readFinalizedStaging(job.jobId);
  if (!saved) return undefined;
  const manifest = saved.manifest;
  if (manifest.sourceDigest !== job.sourceDigest || manifest.converter !== "vision"
    || !sameVisionConfig(manifest.conversionConfig, job.request.options?.vision)) throw new Error("Finished conversion checkpoint does not match the PDF or settings. Use Reconvert.");
  const plan = buildChunkPlan(manifest.pageCount, manifest.chunkSize);
  const chunks: PdfChunkResult[] = [];
  for (const item of plan) {
    const markdown = staged.get(item.index), meta = manifest.chunks.find(chunk => chunk.index === item.index);
    const trusted = job.manifest?.chunks.find(chunk => chunk.index === item.index)?.selfCheck;
    if (!markdown || !trusted || JSON.stringify(meta?.selfCheck) !== JSON.stringify(trusted)) throw new Error("Finished conversion checkpoint has incomplete self-check records. Use Reconvert.");
    const digest = await (Zotero.getMainWindow() as any).crypto.subtle.digest("SHA-256", new TextEncoder().encode(markdown));
    const hex = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
    if (hex !== trusted.markdownDigest) throw new Error("Finished conversion checkpoint changed after validation. Use Reconvert.");
    parseVisionPages(markdown, Array.from({ length: item.endPage - item.startPage + 1 }, (_, offset) => item.startPage + offset));
    checkVisionMath(markdown);
    chunks.push({ ...item, markdown, selfCheck: trusted, assetCount: meta?.assetCount });
  }
  const result = { markdown: saved.markdown, pageCount: manifest.pageCount, chunkSize: manifest.chunkSize, chunks,
    assetCount: chunks.reduce((sum, chunk) => sum + (chunk.assetCount || 0), 0) };
  validateConversionContract(result, manifest);
  job.manifest = manifest;
  job.details ||= emptyConversionDetails();
  if (!job.details.chunks.length) applyConversionEvent(job.details, { type: "plan", pageCount: manifest.pageCount, chunks: plan });
  for (const chunk of chunks) applyConversionEvent(job.details, { type: "chunk", chunk: chunk.index, stage: "ready", reused: true, editsApplied: chunk.selfCheck?.editsApplied });
  applyConversionEvent(job.details, { type: "message", message: "Validated finished checkpoint; retrying cache write without rendering or model requests" });
  return result;
}

async function run(job: Job, recovering = false, resumeOnly = false): Promise<void> {
  try {
    update(job, {
      state: recovering ? "recovering" : "converting",
      runStartedAt: Date.now(),
      stage: "resolve_pdf",
      progress: recovering ? "Recovering saved PDF conversion work" : "Resolving PDF",
      error: "",
      retryable: false,
    });
    const attachment = findAttachment(job.request);
    const pdfPath = await attachment.getFilePathAsync();
    if (!pdfPath) throw new Error("PDF file not found on disk");
    if (job.controller.signal.aborted) throw Object.assign(new Error("Conversion aborted by user"), { name: "AbortError" });
    const title = job.request.title
      || String((attachment as any).parentItem?.getField?.("title") || attachment.getField("title") || job.request.key);
    update(job, { title });
    const vision = job.request.options?.engine === "vision";
    let pdfData: Uint8Array | undefined;
    if (vision) {
      pdfData = await IOUtils.read(pdfPath);
      const hash = await (Zotero.getMainWindow() as any).crypto.subtle.digest("SHA-256", pdfData);
      const digest = [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, "0")).join("");
      if (job.sourceDigest && job.sourceDigest !== digest) throw new Error("The PDF changed since conversion started. Use Reconvert to start fresh.");
      job.sourceDigest = digest;
      await persist();
    }
    const existing = await MDCache.readManifest(job.cacheKey, job.request.key);
    const canSeed = !job.request.force && (vision
      ? existing?.converter === "vision" && existing.sourceDigest === job.sourceDigest
        && sameVisionConfig(existing.conversionConfig, job.request.options?.vision)
      : !existing?.converter || existing.converter === "mineru");
    await MDCache.prepareConversionStaging(job.jobId, canSeed ? job.cacheKey : undefined, canSeed ? job.request.key : undefined);
    const staged = await MDCache.readStagedChunks(job.jobId, job.completedChunks);
    const cached = canSeed && !vision
      ? new Map([...(await reusableChunks(job.cacheKey, job.request.key)), ...staged]) : staged;
    const cachedSelfChecks = new Map((job.manifest?.chunks || []).flatMap(chunk => chunk.selfCheck ? [[chunk.index, chunk.selfCheck] as const] : []));
    const priorUsage = job.manifest?.conversionUsage;
    const observe = (event: ConversionDetailEvent) => {
      job.details ||= emptyConversionDetails();
      applyConversionEvent(job.details, event);
      update(job, {});
      if (event.type === "request" || event.type === "message" || event.type === "request-update" && event.patch.endedAt
        || event.type === "chunk" && event.stage === "ready") void persist();
    };
    const callbacks = {
      onRemoteTask: async (task: MineruRemoteTask) => {
        job.remoteTasks[task.taskKey] = task;
        update(job, {
          stage: task.state === "submitted" ? "submit" : task.state === "uploaded" ? "poll" : job.status.stage,
          remoteMayContinue: Object.values(job.remoteTasks).some((value) => value.state !== "done"),
        });
        await persist();
      },
      onPlan: async (pageCount: number, chunkSize: number, plan: PdfChunkPlanItem[]) => {
        job.manifest = makeManifest(job, title, pageCount, chunkSize, plan, cached);
        job.manifest.conversionUsage = priorUsage;
        observe({ type: "plan", pageCount, chunks: plan });
        update(job, {
          totalChunks: plan.length,
          currentChunk: job.completedChunks.length || undefined,
          progressPercent: 0,
        });
        await persist();
      },
      onChunkConverted: async (chunk: PdfChunkResult) => {
        await MDCache.writeStagedChunk(job.jobId, chunk.index, chunk.markdown);
        if (!job.completedChunks.includes(chunk.index)) job.completedChunks.push(chunk.index);
        job.completedChunks.sort((a, b) => a - b);
        if (job.manifest) markChunkReady(job.manifest, chunk);
        const total = job.status.totalChunks || 1;
        const completed = job.details?.chunks.filter(value => value.stage === "ready").length || 0;
        update(job, {
          currentChunk: chunk.index,
          progressPercent: Math.min(99, Math.round((vision ? completed : job.completedChunks.length) * 990 / total) / 10),
          progress: `Converted chunk ${job.completedChunks.length}/${total}`,
        });
        await persist();
      },
    };
    const finalized = vision && recovering && job.request.options?.vision?.selfCheck && job.manifest?.chunks.every(chunk => chunk.status === "ready")
      ? await readCommitRecovery(job, staged) : undefined;
    const result = finalized || (vision
      ? await convertPdfWithVision(pdfPath, (stage, message) => update(job, { state: "converting", stage, progress: message }), job.controller.signal, {
        ...callbacks, outputDir: MDCache.getConversionStagingDir(job.jobId),
        cachedChunks: cached, cachedSelfChecks, config: job.request.options!.vision!, sessionId: job.jobId, resumeOnly, pdfData,
        onDetail: observe,
        onPreview: (chunk, requestId, markdown) => { job.drafts.set(chunk, { requestId, markdown }); update(job, {}); },
        onUsage: usage => { if (job.manifest) job.manifest.conversionUsage = sumTokenUsage([priorUsage, usage].filter((value): value is TokenUsage => !!value)); },
      })
      : await convertPdf(pdfPath, (state, message) => update(job, progressPatch(state, message)), job.controller.signal, {
        ...callbacks, outputDir: MDCache.getConversionStagingDir(job.jobId), cachedChunks: cached, resumeOnly,
        mineru: mineruOptions(job.request.options), remoteTasks: new Map(Object.entries(job.remoteTasks)),
      }));
    if (job.controller.signal.aborted) throw Object.assign(new Error("Conversion aborted by user"), { name: "AbortError" });
    job.manifest ||= makeManifest(
      job,
      title,
      result.pageCount,
      result.chunkSize,
      result.chunks,
      new Map(result.chunks.map((chunk) => [chunk.index, chunk.markdown])),
    );
    for (const chunk of result.chunks) {
      markChunkReady(job.manifest, chunk);
      await MDCache.writeStagedChunk(job.jobId, chunk.index, chunk.markdown);
    }
    addLineRanges(job.manifest, result.markdown);
    if (vision) validateConversionContract(result, job.manifest);
    if (job.details) job.manifest.conversionDetails = JSON.parse(JSON.stringify(job.details));
    update(job, { stage: "commit", progress: "All pages validated; writing document to cache", progressPercent: 99 });
    await MDCache.finalizeStagedDocument(job.jobId, result.markdown, job.manifest);
    if (job.controller.signal.aborted) throw Object.assign(new Error("Conversion aborted by user"), { name: "AbortError" });
    await MDCache.commitStagedDocument(job.jobId, job.cacheKey);
    await complete(job, {
      state: "ready", stage: "ready", progress: "Ready", error: "",
      retryable: false, remoteMayContinue: false, progressPercent: 100, currentChunk: result.chunks.length,
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      if (job.suspending) {
        update(job, {
          state: "recovering", stage: "suspended",
          progress: "Paused for Zotero shutdown; recovery will resume on startup", retryable: true,
        });
        activeByCacheKey.delete(job.cacheKey);
        await persist();
      } else {
        await complete(job, {
          state: "cancelled", stage: "cancelled", progress: "Conversion stopped locally", error: "", retryable: true,
          remoteMayContinue: Object.values(job.remoteTasks).some((task) => task.state !== "done"),
        });
      }
      return;
    }
    const message = error?.message || String(error);
    Zotero.debug(`[ChatPDF] document conversion failed: ${message}\n${error?.stack || ""}`);
    await complete(job, {
      state: recovering ? "interrupted" : "error",
      stage: recovering ? "recovery_failed" : job.status.stage,
      progress: message,
      error: message,
      retryable: true,
      remoteMayContinue: Object.values(job.remoteTasks).some((task) => task.state !== "done"),
    });
  }
}

async function pruneHistory(): Promise<void> {
  const now = Date.now();
  const terminal = [...jobs.values()].filter((job) => TERMINAL.has(job.status.state))
    .sort((a, b) => b.status.updatedAt.localeCompare(a.status.updatedAt));
  for (const [index, job] of terminal.entries()) {
    const age = now - Date.parse(job.status.updatedAt || job.status.createdAt);
    if (index < 1000 && Number.isFinite(age) && age <= 30 * 24 * 60 * 60 * 1000) continue;
    jobs.delete(job.jobId);
    await MDCache.removeConversionStaging(job.jobId);
  }
}

export async function initializeConversions(): Promise<void> {
  if (initialized) return;
  if (initializing) return initializing;
  initializing = (async () => {
    await MDCache.repairDocumentSwaps();
    for (const raw of await readRegistry()) {
      const value = parseStored(raw);
      if (!value) {
        Zotero.debug("[ChatPDF] Ignoring invalid conversion registry entry");
        continue;
      }
      try { jobs.set(value.jobId, restoreJob(value)); }
      catch (error: any) { Zotero.debug(`[ChatPDF] Ignoring invalid conversion job: ${error?.message || error}`); }
    }
    await pruneHistory();
    initialized = true;
    for (const job of [...jobs.values()].sort((a, b) => b.status.updatedAt.localeCompare(a.status.updatedAt))) {
      if (TERMINAL.has(job.status.state)) continue;
      if (activeByCacheKey.has(job.cacheKey)) {
        await complete(job, {
          state: "interrupted", stage: "recovery_failed", progress: "Superseded recovery job",
          error: "Superseded recovery job", retryable: true,
        });
        continue;
      }
      job.controller = createAbortController().controller;
      activeByCacheKey.set(job.cacheKey, job);
      void run(job, true);
    }
    await persist();
  })().finally(() => { initializing = null; });
  return initializing;
}

function compatibleOptions(previous: ConversionRequest, request: ConversionRequest): boolean {
  const a = normalizeOptions(previous.options);
  const b = normalizeOptions(request.options);
  return a.engine === b.engine && (a.engine !== "vision" || sameVisionConfig(a.vision, b.vision)) && a.modelVersion === b.modelVersion && a.language === b.language && a.isOcr === b.isOcr
    && a.enableFormula === b.enableFormula && a.enableTable === b.enableTable;
}

async function findResumableJob(request: ConversionRequest, cacheKey: string, signal?: AbortSignal): Promise<Job | undefined> {
  const candidates = [...jobs.values()].filter(job => job.cacheKey === cacheKey
    && TERMINAL.has(job.status.state) && compatibleOptions(job.request, request)
    && (job.request.options?.engine === "vision"
      ? job.status.state !== "ready" && (job.completedChunks.length > 0 || !!job.details?.requests.length)
      : Object.values(job.remoteTasks).some(task => task.state !== "submitted")))
    .sort((a, b) => b.status.updatedAt.localeCompare(a.status.updatedAt));
  let pending: Job | undefined;
  let firstError: unknown;
  for (const job of candidates) {
    try {
      if (job.request.options?.engine === "vision") return job;
      const tasks = Object.values(job.remoteTasks).filter(task => task.state !== "submitted");
      const states = await Promise.all(tasks.map(task => getMineruTaskState(task, signal)));
      if (states.some(state => state === "failed")) continue;
      // A completed older upload takes priority over a newer queued duplicate.
      if (states.every(state => state === "done")) return job;
      pending ||= job;
    } catch (error: any) {
      if (error?.name === "AbortError") throw error;
      firstError ||= error;
      Zotero.debug(`[ChatPDF] Could not inspect saved MinerU task: ${error?.message || error}`);
    }
  }
  if (pending) return pending;
  // An unavailable status endpoint must not silently trigger another upload.
  if (firstError) throw firstError;
  return undefined;
}

async function startOrRecoverConversion(
  request: ConversionRequest, owner: string, resumeOnly: boolean, signal?: AbortSignal,
): Promise<ConversionStatus | null> {
  await initializeConversions();
  if (signal?.aborted) throw Object.assign(new Error("Conversion observer aborted"), { name: "AbortError" });
  const cacheKey = sourceCacheKey(request);
  const active = activeByCacheKey.get(cacheKey);
  if (active) {
    if (owner) active.owners.add(owner);
    return snapshot(active);
  }
  const documentId = makeSourceId(request.key, request.libraryID);
  const cachedExists = !request.force && await MDCache.has(cacheKey, request.key);
  const previous = request.force || (resumeOnly && cachedExists) ? undefined : await findResumableJob(request, cacheKey, signal);
  if (signal?.aborted) throw Object.assign(new Error("Conversion observer aborted"), { name: "AbortError" });
  if (cachedExists && !previous) {
    const manifest = await MDCache.readManifest(cacheKey, request.key);
    if (manifest) await MDCache.writeManifestForExistingDocument(cacheKey, request.key, {
      ...manifest,
      version: Math.max(3, manifest.version),
      documentId,
      ...libraryFields(request.libraryID),
      attachmentKey: request.key,
      parentItemKey: request.parentItemKey || manifest.parentItemKey,
    });
    // Reading an existing cache must not depend on the current conversion profile.
    const job = createJob({ ...request, options: { ...request.options, engine: "mineru" } }, cacheKey);
    job.status.options = { engine: manifest?.converter === "vision" || manifest?.converter === "deepseek-vision" ? "vision" : "mineru",
      vision: manifest?.conversionConfig };
    job.manifest = manifest || undefined;
    job.details = manifest?.conversionDetails || emptyConversionDetails();
    if (manifest && !job.details.chunks.length && manifest.chunks.length) {
      applyConversionEvent(job.details, { type: "plan", pageCount: manifest.pageCount, chunks: manifest.chunks });
      for (const chunk of manifest.chunks) applyConversionEvent(job.details, { type: "chunk", chunk: chunk.index,
        stage: chunk.status === "ready" ? "ready" : "queued", reused: true, editsApplied: chunk.selfCheck?.editsApplied });
    }
    jobs.set(job.jobId, job);
    await complete(job, { state: "ready", stage: "ready", progress: "Ready", progressPercent: 100 });
    return snapshot(job);
  }
  if (!previous && resumeOnly) return null;
  const normalized = { ...request, force: request.force || previous?.request.force, options: normalizeOptions(request.options) };
  // Re-arm the same job with a fresh controller and completion promise.
  const job = createJob(normalized, cacheKey, previous?.jobId);
  if (previous) {
    job.remoteTasks = { ...previous.remoteTasks };
    job.completedChunks = [...previous.completedChunks];
    job.manifest = previous.manifest;
    job.details = previous.details ? JSON.parse(JSON.stringify(previous.details)) : emptyConversionDetails();
    interruptConversionRequests(job.details!);
    job.sourceDigest = previous.sourceDigest;
    job.status.createdAt = previous.status.createdAt;
    job.status.state = "recovering";
    job.status.remoteMayContinue = previous.status.remoteMayContinue;
  }
  if (owner) job.owners.add(owner);
  jobs.set(job.jobId, job);
  activeByCacheKey.set(cacheKey, job);
  await persist();
  void run(job, !!previous, resumeOnly);
  return snapshot(job);
}

async function queueConversionStart(
  request: ConversionRequest, owner: string, resumeOnly: boolean, signal?: AbortSignal,
): Promise<ConversionStatus | null> {
  const key = sourceCacheKey(request);
  const previous = startingByCacheKey.get(key);
  const next = (previous || Promise.resolve(null)).catch(() => null)
    .then(() => startOrRecoverConversion(request, owner, resumeOnly, signal));
  startingByCacheKey.set(key, next);
  try {
    return await next;
  } finally {
    if (startingByCacheKey.get(key) === next) startingByCacheKey.delete(key);
  }
}

export async function startConversion(request: ConversionRequest, owner = "bridge"): Promise<ConversionStatus> {
  return (await queueConversionStart(request, owner, false))!;
}

/** Reattach an owner to cached or uploaded work; never submit a new PDF. */
export function recoverConversion(request: ConversionRequest, owner: string, signal?: AbortSignal): Promise<ConversionStatus | null> {
  return queueConversionStart(request, owner, true, signal);
}

export function getConversion(jobId: string): ConversionStatus {
  const job = jobs.get(jobId);
  return job ? snapshot(job) : {
    jobId,
    state: "unknown",
    title: "",
    progress: "",
    error: "Conversion job not found",
    stage: "unknown",
    createdAt: "",
    updatedAt: "",
    retryable: false,
    remoteMayContinue: false,
  };
}

export function listConversions(state?: ConversionState): ConversionStatus[] {
  return [...jobs.values()].map(snapshot).filter((status) => !state || status.state === state)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** UI inspection is read-only and never starts a conversion or model request. */
export function latestConversionForDocument(documentId: string): ConversionStatus | undefined {
  return listConversions().filter(status => status.documentId === documentId)
    .sort((a, b) => Number(!TERMINAL.has(b.state)) - Number(!TERMINAL.has(a.state)) || b.updatedAt.localeCompare(a.updatedAt))[0];
}

export function getConversionDetails(jobId: string): ConversionDetails | undefined {
  const details = jobs.get(jobId)?.details;
  return details ? JSON.parse(JSON.stringify(details)) : undefined;
}

export interface ConversionPageView {
  markdown: string;
  validated: boolean;
  image?: string;
  edits: { page: number; old: string; new: string }[];
  selfChecked: boolean;
}

export function getConversionDraft(jobId: string, page: number): string {
  const job = jobs.get(jobId);
  const chunk = job?.details?.chunks.find(chunk => page >= chunk.startPage && page <= chunk.endPage);
  return chunk ? conversionDraftPage(job?.drafts.get(chunk.index)?.markdown || "", page) : "";
}

export async function readConversionPage(jobId: string, page: number, includeImage = true): Promise<ConversionPageView> {
  const job = jobs.get(jobId), manifest = job?.manifest;
  if (!job || !manifest || !Number.isSafeInteger(page) || page < 1 || page > manifest.pageCount) throw new Error("Conversion page is unavailable");
  const chunk = manifest.chunks.find(chunk => page >= chunk.startPage && page <= chunk.endPage);
  if (!chunk || !Number.isSafeInteger(chunk.index) || chunk.index < 1) throw new Error("Conversion chunk is unavailable");
  const stagedDir = MDCache.getConversionStagingDir(jobId);
  const staged = job.status.state !== "ready" && await IOUtils.exists(stagedDir);
  if (!staged) {
    const installed = await MDCache.readManifest(job.cacheKey, job.request.key);
    if (manifest.conversionJobId && installed?.conversionJobId !== manifest.conversionJobId) {
      return { markdown: "", validated: false, edits: [], selfChecked: false };
    }
  }
  const dir = staged ? stagedDir : MDCache.getDocDir(job.cacheKey);
  let markdown = "";
  if (chunk.status === "ready") {
    const body = staged ? (await MDCache.readStagedChunks(jobId, [chunk.index])).get(chunk.index)
      : await MDCache.readChunk(job.cacheKey, chunk.index, job.request.key);
    if (body) markdown = conversionDraftPage(body, page);
  }
  let image: string | undefined;
  if (includeImage) {
    const path = PathUtils.join(dir, "attachments", "pages", `page-${String(page).padStart(4, "0")}.jpg`);
    if (await IOUtils.exists(path)) {
      const root = PathUtils.parent(PathUtils.parent(MDCache.getConversionRegistryPath())!)!;
      for (let current = path; current !== root; current = PathUtils.parent(current)!) {
        if (!current || !current.startsWith(root + (root.includes("\\") ? "\\" : "/"))) throw new Error("Page image is outside the cache");
        if (Zotero.File.pathToFile(current).isSymlink()) throw new Error("Linked page image paths are not allowed");
      }
      const bytes = await readImageFile(path);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      image = `data:${imageMime(bytes)};base64,${(Zotero.getMainWindow() as any).btoa(binary)}`;
    }
  }
  return { markdown: markdown || getConversionDraft(jobId, page), validated: !!markdown, image,
    edits: chunk.selfCheck?.edits.filter(edit => edit.page === page) || [], selfChecked: !!chunk.selfCheck && !!markdown };
}

export function waitForConversion(jobId: string, signal?: AbortSignal): Promise<ConversionStatus> {
  const job = jobs.get(jobId);
  if (!job) return Promise.resolve(getConversion(jobId));
  if (!signal) return job.completion;
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("Conversion observer aborted"), { name: "AbortError" }));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    job.completion.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    });
  });
}

export function subscribeConversion(jobId: string, listener: (status: ConversionStatus) => void): () => void {
  const job = jobs.get(jobId);
  if (!job) return () => undefined;
  job.listeners.add(listener);
  listener(snapshot(job));
  return () => job.listeners.delete(listener);
}

export function releaseConversion(jobId: string, owner: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.owners.delete(owner);
  if (activeByCacheKey.get(job.cacheKey) === job && job.owners.size === 0) job.controller.abort();
}

export async function cancelConversion(jobId: string): Promise<ConversionStatus> {
  const job = jobs.get(jobId);
  if (!job || activeByCacheKey.get(job.cacheKey) !== job) return getConversion(jobId);
  job.controller.abort();
  return job.completion;
}

export async function suspendConversions(): Promise<void> {
  const active = [...activeByCacheKey.values()];
  for (const job of active) {
    job.suspending = true;
    update(job, {
      state: "recovering", stage: "suspended",
      progress: "Paused for Zotero shutdown; recovery will resume on startup", retryable: true,
    });
    job.controller.abort();
  }
  await persist();
}

export function conversionRequestFromSource(source: SourceItem): ConversionRequest {
  if (source.libraryID === undefined) throw new Error("Conversion requires a library-qualified source");
  return {
    key: source.key,
    libraryID: source.libraryID,
    title: source.title,
    parentItemKey: source.parentKey,
  };
}
