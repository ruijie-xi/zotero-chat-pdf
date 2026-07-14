import { ensureDir } from "./cache-dir";

const writeQueues = new Map<string, Promise<void>>();

/** Serialize mutations to one logical file/repository key. */
export async function withStorageLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => gate);
  writeQueues.set(key, queued);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (writeQueues.get(key) === queued) writeQueues.delete(key);
  }
}

/** Write through a unique temporary path and atomically replace the target. */
export async function atomicWrite(path: string, data: Uint8Array): Promise<void> {
  const parent = PathUtils.parent(path);
  if (parent) await ensureDir(parent);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tmpPath = `${path}.tmp-${suffix}`;
  try {
    await (IOUtils.write as any)(path, data, { tmpPath, flush: true });
  } finally {
    if (await IOUtils.exists(tmpPath)) {
      await IOUtils.remove(tmpPath).catch(() => {});
    }
  }
}

export async function atomicWriteText(path: string, text: string): Promise<void> {
  await atomicWrite(path, new TextEncoder().encode(text));
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, JSON.stringify(value, null, 2));
}
