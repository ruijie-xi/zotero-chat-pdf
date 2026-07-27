import { atomicWriteJson } from "../utils/atomic-storage";
import { SourceItem } from "./chat-session";
import {
  convertPdf,
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
}

interface StoredJob {
  jobId: string;
  cacheKey: string;
  request: ConversionRequest;
  status: ConversionStatus;
  remoteTasks: Record<string, MineruRemoteTask>;
  completedChunks: number[];
  manifest?: MDCache.DocumentManifest;
}

interface Job extends StoredJob {
  controller: ReturnType<typeof createAbortController>["controller"];
  completion: Promise<ConversionStatus>;
  resolve: (status: ConversionStatus) => void;
  resolved: boolean;
  listeners: Set<(status: ConversionStatus) => void>;
  owners: Set<string>;
  suspending: boolean;
}

const STATES = new Set<ConversionState>([
  "pending", "converting", "recovering", "ready", "error", "cancelled", "interrupted", "unknown",
]);
const TERMINAL = new Set<ConversionState>(["ready", "error", "cancelled", "interrupted"]);
const jobs = new Map<string, Job>();
const activeByCacheKey = new Map<string, Job>();
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
    options: status.options ? { ...status.options } : undefined,
  };
}

function normalizeOptions(options?: ConversionOptions): ConversionOptions {
  return {
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

const snapshot = (job: Job) => sanitizeConversionStatus(job.status);
const stored = (job: Job): StoredJob => ({
  jobId: job.jobId,
  cacheKey: job.cacheKey,
  request: job.request,
  status: snapshot(job),
  remoteTasks: { ...job.remoteTasks },
  completedChunks: [...job.completedChunks],
  manifest: job.manifest,
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
      remoteMayContinue: false,
      options: normalizeOptions(request.options),
    },
  };
}

function restoreJob(value: StoredJob): Job {
  const job = createJob(value.request, value.cacheKey, value.jobId);
  job.status = sanitizeConversionStatus({ ...value.status, options: normalizeOptions(value.request.options) });
  job.remoteTasks = { ...(value.remoteTasks || {}) };
  job.completedChunks = [...(value.completedChunks || [])];
  job.manifest = value.manifest;
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
    converter: "mineru",
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

async function run(job: Job, recovering = false): Promise<void> {
  try {
    update(job, {
      state: recovering ? "recovering" : "converting",
      stage: "resolve_pdf",
      progress: recovering ? "Recovering conversion after Zotero restart" : "Resolving PDF",
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
    await MDCache.prepareConversionStaging(
      job.jobId,
      job.request.force ? undefined : job.cacheKey,
      job.request.force ? undefined : job.request.key,
    );
    const staged = await MDCache.readStagedChunks(job.jobId, job.completedChunks);
    const cached = job.request.force
      ? staged
      : new Map([...(await reusableChunks(job.cacheKey, job.request.key)), ...staged]);
    const result = await convertPdf(pdfPath, (state, message) => update(job, progressPatch(state, message)), job.controller.signal, {
      outputDir: MDCache.getConversionStagingDir(job.jobId),
      cachedChunks: cached,
      mineru: mineruOptions(job.request.options),
      remoteTasks: new Map(Object.entries(job.remoteTasks)),
      onRemoteTask: async (task) => {
        job.remoteTasks[task.taskKey] = task;
        update(job, {
          stage: task.state === "submitted" ? "submit" : task.state === "uploaded" ? "poll" : job.status.stage,
          remoteMayContinue: Object.values(job.remoteTasks).some((value) => value.state !== "done"),
        });
        await persist();
      },
      onPlan: async (pageCount, chunkSize, plan) => {
        job.manifest = makeManifest(job, title, pageCount, chunkSize, plan, cached);
        update(job, {
          totalChunks: plan.length,
          currentChunk: job.completedChunks.length || undefined,
          progressPercent: plan.length ? Math.round(job.completedChunks.length * 1000 / plan.length) / 10 : 0,
        });
        await persist();
      },
      onChunkConverted: async (chunk) => {
        await MDCache.writeStagedChunk(job.jobId, chunk.index, chunk.markdown);
        if (!job.completedChunks.includes(chunk.index)) job.completedChunks.push(chunk.index);
        job.completedChunks.sort((a, b) => a - b);
        if (job.manifest) markChunkReady(job.manifest, chunk);
        const total = job.status.totalChunks || 1;
        update(job, {
          currentChunk: chunk.index,
          progressPercent: Math.min(100, Math.round(job.completedChunks.length * 1000 / total) / 10),
          progress: `Converted chunk ${job.completedChunks.length}/${total}`,
        });
        await persist();
      },
    });
    job.manifest ||= makeManifest(
      job,
      title,
      result.pageCount,
      result.chunkSize,
      result.chunks,
      new Map(result.chunks.map((chunk) => [chunk.index, chunk.markdown])),
    );
    addLineRanges(job.manifest, result.markdown);
    update(job, { stage: "commit", progress: "Committing converted document", progressPercent: 100 });
    await MDCache.finalizeStagedDocument(job.jobId, result.markdown, job.manifest);
    await MDCache.commitStagedDocument(job.jobId, job.cacheKey);
    await complete(job, {
      state: "ready", stage: "ready", progress: "Ready", error: "",
      retryable: false, remoteMayContinue: false, progressPercent: 100,
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
      jobs.set(value.jobId, restoreJob(value));
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

export async function startConversion(request: ConversionRequest, owner = "bridge"): Promise<ConversionStatus> {
  await initializeConversions();
  const cacheKey = sourceCacheKey(request);
  const active = activeByCacheKey.get(cacheKey);
  if (active) {
    if (owner) active.owners.add(owner);
    return snapshot(active);
  }
  const documentId = makeSourceId(request.key, request.libraryID);
  if (!request.force && await MDCache.has(cacheKey, request.key)) {
    const manifest = await MDCache.readManifest(cacheKey, request.key);
    if (manifest) await MDCache.writeManifestForExistingDocument(cacheKey, request.key, {
      ...manifest,
      version: Math.max(3, manifest.version),
      documentId,
      ...libraryFields(request.libraryID),
      attachmentKey: request.key,
      parentItemKey: request.parentItemKey || manifest.parentItemKey,
    });
    const job = createJob(request, cacheKey);
    jobs.set(job.jobId, job);
    await complete(job, { state: "ready", stage: "ready", progress: "Ready", progressPercent: 100 });
    return snapshot(job);
  }
  const normalized = { ...request, options: normalizeOptions(request.options) };
  const job = createJob(normalized, cacheKey);
  if (owner) job.owners.add(owner);
  jobs.set(job.jobId, job);
  activeByCacheKey.set(cacheKey, job);
  await persist();
  void run(job);
  return snapshot(job);
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
