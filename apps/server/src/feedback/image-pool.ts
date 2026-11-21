/**
 * The screenshot worker (docs/decisions/feedback.md FB-08, FB-F02; review 1 R1-3): one long-lived `worker_threads`
 * worker decodes and re-encodes screenshots, one job at a time, so a costly or hostile image can neither block the
 * server's event loop nor grow its heap. The worker has its own heap limit (`IMAGE_WORKER_LIMITS`); a job that
 * takes longer than `IMAGE_JOB_TIMEOUT_MS` or kills the worker (out of memory, crash) fails as that image's fault
 * and the worker is replaced for the next job. A worker that can't even start is the server's fault (`internal`).
 *
 * The worker's module is `image-worker.ts` next to this file; in a release, where this code is part of
 * `app/server.mjs`, it is `app/image-worker.mjs` (its own esbuild entry, scripts/package).
 */
import { type ResourceLimits, Worker } from 'node:worker_threads';
import {
  IMAGE_WORKER_ROLE,
  type ImageHeader,
  type ImageJobMessage,
  type ImageWorkerReply,
} from './image-worker';

/** How long one image may take in the worker, from when it starts on it. */
export const IMAGE_JOB_TIMEOUT_MS = 10_000;

/** The worker's V8 heap (the JPEG decoder's typed arrays are bounded by its own cap, `JPEG_MAX_MEMORY_MB`). */
export const IMAGE_WORKER_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
};

export interface ImageJob extends ImageHeader {
  bytes: Uint8Array;
  maxPixels: number;
  /** A preview instead of a full re-encode: fit within this many pixels a side (`image-worker.ts` `thumbnail`). */
  thumbnailMaxEdge?: number;
}

export interface ImageResult {
  bytes: Buffer;
  width: number;
  height: number;
}

/** Anything that re-encodes screenshots (the pool; tests may wrap it). */
export interface ImageRunner {
  run(job: ImageJob): Promise<ImageResult>;
}

/** Why a job failed: the image (`unsupported`: malformed, too costly, killed the worker) or the server (`internal`). */
export class ImageJobError extends Error {
  constructor(
    readonly kind: 'unsupported' | 'internal',
    message: string,
  ) {
    super(message);
    this.name = 'ImageJobError';
  }
}

/** The worker's module for code at `from`: the source file, or the release's own bundle next to `app/server.mjs`. */
export function imageWorkerUrl(from: string = import.meta.url): URL {
  return /\.m?js$/.test(new URL(from).pathname)
    ? new URL('./image-worker.mjs', from)
    : new URL('./image-worker.ts', from);
}

interface Pending {
  id: number;
  job: ImageJob;
  resolve: (result: ImageResult) => void;
  reject: (err: ImageJobError) => void;
}

export interface ImagePoolOptions {
  /** The worker's module (tests start stand-ins). */
  url?: URL;
  timeoutMs?: number;
  resourceLimits?: ResourceLimits;
  /** Told when a worker fails to start or dies (never with image bytes). */
  onWorkerFailure?: (info: { reason: string; code?: string }) => void;
}

export class ImagePool implements ImageRunner {
  timeoutMs: number;
  readonly #url: URL;
  readonly #limits: ResourceLimits;
  readonly #onFailure: ImagePoolOptions['onWorkerFailure'];
  readonly #queue: Pending[] = [];
  #worker: Worker | null = null;
  /** The current worker posted `ready`: it loaded, so a death from now on is a job's doing. */
  #ready = false;
  #current: (Pending & { timer: NodeJS.Timeout }) | null = null;
  #seq = 0;
  /** Workers started so far (tests check that a dead one was replaced). */
  started = 0;

  constructor(options: ImagePoolOptions = {}) {
    this.#url = options.url ?? imageWorkerUrl();
    this.timeoutMs = options.timeoutMs ?? IMAGE_JOB_TIMEOUT_MS;
    this.#limits = options.resourceLimits ?? IMAGE_WORKER_LIMITS;
    this.#onFailure = options.onWorkerFailure;
  }

  run(job: ImageJob): Promise<ImageResult> {
    return new Promise<ImageResult>((resolve, reject) => {
      this.#queue.push({ id: ++this.#seq, job, resolve, reject });
      this.#next();
    });
  }

  /** Jobs waiting or running. */
  get pending(): number {
    return this.#queue.length + (this.#current ? 1 : 0);
  }

  /** Stops the worker; waiting and running jobs fail (`internal`). A later job starts a new worker. */
  async close(): Promise<void> {
    const failed = new ImageJobError('internal', 'image pool closed');
    for (const p of this.#queue.splice(0)) p.reject(failed);
    this.#finish(failed);
    const worker = this.#worker;
    this.#worker = null;
    await worker?.terminate();
  }

  #next(): void {
    if (this.#current) return;
    const pending = this.#queue.shift();
    if (!pending) return;
    let worker: Worker;
    try {
      worker = this.#ensure();
    } catch (err) {
      this.#onFailure?.({ reason: 'start', code: (err as { code?: string }).code });
      pending.reject(new ImageJobError('internal', 'image worker failed to start'));
      this.#next();
      return;
    }
    const timer = setTimeout(() => this.#abandon(worker), this.timeoutMs);
    this.#current = { ...pending, timer };
    // A compact copy of its own, transferred rather than cloned.
    const bytes = new Uint8Array(pending.job.bytes);
    const message: ImageJobMessage = {
      id: pending.id,
      bytes,
      contentType: pending.job.contentType,
      width: pending.job.width,
      height: pending.job.height,
      maxPixels: pending.job.maxPixels,
      ...(pending.job.thumbnailMaxEdge ? { thumbnailMaxEdge: pending.job.thumbnailMaxEdge } : {}),
    };
    worker.postMessage(message, [bytes.buffer]);
  }

  #ensure(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(this.#url, {
      workerData: { role: IMAGE_WORKER_ROLE },
      resourceLimits: this.#limits,
    });
    this.started++;
    // Idle, the worker doesn't keep the process alive; a running job's timer does.
    worker.unref();
    this.#worker = worker;
    this.#ready = false;
    worker.on('message', (reply: ImageWorkerReply) => this.#onMessage(worker, reply));
    worker.on('error', (err) => this.#onDeath(worker, err as Error));
    worker.on('exit', (code) => this.#onDeath(worker, new Error(`image worker exited with ${code}`)));
    return worker;
  }

  #onMessage(worker: Worker, reply: ImageWorkerReply): void {
    if (worker !== this.#worker) return;
    if ('ready' in reply) {
      this.#ready = true;
      return;
    }
    const current = this.#current;
    if (!current || reply.id !== current.id) return;
    clearTimeout(current.timer);
    this.#current = null;
    if (reply.ok)
      current.resolve({
        bytes: Buffer.from(reply.bytes.buffer, reply.bytes.byteOffset, reply.bytes.byteLength),
        width: reply.width,
        height: reply.height,
      });
    else current.reject(new ImageJobError('unsupported', reply.error));
    this.#next();
  }

  /** The worker died: out of its heap, crashed, or never started. The job it had fails; the next gets a new one. */
  #onDeath(worker: Worker, err: Error): void {
    if (worker !== this.#worker) return;
    const loaded = this.#ready;
    this.#worker = null;
    this.#ready = false;
    void worker.terminate();
    const code = (err as { code?: string }).code;
    this.#onFailure?.({ reason: loaded ? 'died' : 'start', ...(code ? { code } : {}) });
    // A worker that never loaded is the server's problem; one that loaded and died on this image, the image's.
    this.#finish(
      new ImageJobError(
        loaded || code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'unsupported' : 'internal',
        `image worker died: ${code ?? err.message}`.slice(0, 200),
      ),
    );
    this.#next();
  }

  /** The job took too long: the worker is stopped (it may be stuck in a decode) and replaced for the next job. */
  #abandon(worker: Worker): void {
    if (worker !== this.#worker) return;
    this.#worker = null;
    this.#ready = false;
    void worker.terminate();
    this.#finish(new ImageJobError('unsupported', 'image took too long'));
    this.#next();
  }

  #finish(err: ImageJobError): void {
    const current = this.#current;
    if (!current) return;
    clearTimeout(current.timer);
    this.#current = null;
    current.reject(err);
  }
}
