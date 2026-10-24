/** Session-owned, versioned learning visuals. No DOM or platform dependencies. */
export type VisualKind = "svg" | "mermaid" | "tikz";
export interface VisualCitation { sourceId: string; page: number; label?: string; }
export interface VisualInput {
  title: string;
  kind: VisualKind;
  source: string;
  description: string;
  dataMode: "illustrative" | "paper-data";
  citations: VisualCitation[];
}
export interface VisualRef { id: string; version: number; }
export interface VisualOutput { svg?: string; png?: string; diagnostics: string[]; width: number; height: number; }
/** snapshot is restore-only: old interactive visuals retain their saved image. */
export interface VisualVersion extends Omit<VisualInput, "kind">, VisualOutput, VisualRef { kind: VisualKind | "snapshot"; createdAt: number; callId: string; }
export interface VisualData { versions: VisualVersion[]; }
export const VISUAL_SOURCE_LIMIT = 256_000;
export function validateVisualInput(input: VisualInput): void {
  if (!input || !["svg", "mermaid", "tikz"].includes(input.kind)) throw new Error("Unsupported visual kind. Use svg, mermaid or tikz for static images.");
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200) throw new Error("Visual title must contain 1–200 characters.");
  if (typeof input.source !== "string" || !input.source.trim() || input.source.length > VISUAL_SOURCE_LIMIT) throw new Error(`Visual source must contain 1–${VISUAL_SOURCE_LIMIT} characters; it is never truncated.`);
  if (typeof input.description !== "string" || input.description.length > 4000) throw new Error("A description of at most 4000 characters is required.");
  if (!["illustrative", "paper-data"].includes(input.dataMode)) throw new Error("Declare illustrative or paper-data.");
  if (!Array.isArray(input.citations) || input.citations.length > 32 || input.citations.some(c => !c || typeof c.sourceId !== "string" || !Number.isSafeInteger(c.page) || c.page < 1 || (c.label !== undefined && (typeof c.label !== "string" || c.label.length > 200)))) throw new Error("Use at most 32 source/page citations with positive page numbers.");
  if (input.dataMode === "paper-data" && !input.citations.length) throw new Error("Paper data requires original-page citations.");
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
export class VisualLibrary {
  private data: VisualData = { versions: [] };
  /** Invalidate outstanding renders on clear, source removal and history editing. */
  epoch = 0;
  invalidate(): void { this.epoch++; }
  clear(): void { this.invalidate(); this.data = { versions: [] }; }
  list(): VisualVersion[] { return this.data.versions.filter(v => this.latest(v.id)?.version === v.version).map(clone); }
  versions(id: string): VisualVersion[] { return this.data.versions.filter(v => v.id === id).map(clone); }
  latest(id: string): VisualVersion | undefined { for (let i = this.data.versions.length - 1; i >= 0; i--) if (this.data.versions[i].id === id) return clone(this.data.versions[i]); return undefined; }
  get(ref: VisualRef): VisualVersion | undefined { const v = this.data.versions.find(v => v.id === ref.id && v.version === ref.version); return v ? clone(v) : undefined; }
  byCall(callId: string): VisualVersion | undefined { const v = this.data.versions.find(v => v.callId === callId); return v ? clone(v) : undefined; }
  commit(input: VisualInput, output: VisualOutput, id: string, expected: number, callId: string, epoch: number): VisualVersion {
    if (epoch !== this.epoch) throw Object.assign(new Error("Visual render was revoked by a session change."), { name: "AbortError" });
    const previous = this.byCall(callId);
    if (previous) return previous;
    validateVisualInput(input);
    if ((this.latest(id)?.version || 0) !== expected) throw new Error("Visual version conflict. Read the latest version before updating.");
    const version: VisualVersion = clone({ ...input, ...output, id, version: expected + 1, callId, createdAt: Date.now() });
    this.data.versions.push(version);
    return clone(version);
  }
  toJSON(): VisualData { return clone(this.data); }
  static restore(data?: VisualData): VisualLibrary {
    const library = new VisualLibrary();
    if (!data || !Array.isArray(data.versions)) return library;
    for (const version of data.versions) {
      try {
        const archived = ["interactive", "html", "snapshot"].includes(String(version.kind));
        validateVisualInput({ ...version, kind: archived ? "svg" : version.kind as VisualKind });
        if (!/^vis-[a-zA-Z0-9-]+$/.test(version.id) || !Number.isSafeInteger(version.version) || version.version < 1 || typeof version.callId !== "string") continue;
        if (library.get(version)) continue;
        library.data.versions.push(clone({ ...version, kind: archived ? "snapshot" : version.kind }));
      } catch { /* One invalid visual must not prevent opening a conversation. */ }
    }
    return library;
  }
}
