/**
 * The council's picture worker, one job at a time (docs/decisions/council.md CNL-S06): reading a builder's screenshot
 * and drawing a before and an after cost hundreds of milliseconds and up to a few hundred megabytes for the largest
 * screenshots, so they run in a `worker_threads` worker with its own heap limit, never on the server's event loop, and
 * never more than one at once. A short queue waits; more than that is refused (`busy`), and the builder sends again.
 * A job that takes too long or kills the worker fails, and the next job gets a new worker.
 *
 * Tests run the same jobs in-process (`inProcessShots`): a worker started from TypeScript source needs the loader the
 * server runs under.
 */
import { type ResourceLimits, Worker } from 'node:worker_threads';
import type { ShotType } from './shots';
import {
  runShotsJob,
  SHOTS_WORKER_ROLE,
  type ShotArea,
  type ShotsJob,
  type ShotsReply,
} from './shots-worker';

/** How long one job may take in the worker, from when it starts on it. */
export const SHOTS_JOB_TIMEOUT_MS = 20_000;
/** Jobs that may wait behind the running one. */
export const SHOTS_QUEUE_MAX = 4;

const SHOTS_WORKER_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
};

export interface ShotCompared {
  png: Buffer;
  width: number;
  height: number;
  areas: ShotArea[];
}

/** What reads and compares the builder's pictures. */
export interface ShotRunner {
  check(bytes: Buffer, type: ShotType): Promise<{ width: number; height: number }>;
  compare(
    before: { bytes: Buffer; type: ShotType },
    after: { bytes: Buffer; type: ShotType },
  ): Promise<ShotCompared>;
}

/** Why a job failed: the picture (`refused`, its words are the builder's to read), too many at once, or Whombat. */
export class ShotJobError extends Error {
  constructor(
    readonly kind: 'refused' | 'busy' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'ShotJobError';
  }
}

type Done = Exclude<ShotsReply, { ready: true }>;
type JobBody = ShotsJob extends infer J ? (J extends { id: number } ? Omit<J, 'id'> : never) : never;

/** The worker's module for code at `from`: the source file, or the release's own bundle next to `app/server.mjs`. */
export function shotsWorkerUrl(from: string = import.meta.url): URL {
  return /\.m?js$/.test(new URL(from).pathname)
    ? new URL('./shots-worker.mjs', from)
    : new URL('./shots-worker.ts', from);
}

function answer(reply: Done): Done & { ok: true } {
  if (!reply.ok) throw new ShotJobError(reply.refusal ? 'refused' : 'failed', reply.error);
  return reply;
}

const bytesOf = (b: Buffer) => new Uint8Array(b);

/** Runs jobs through `run` and gives them the runner's shape. */
function runner(run: (job: JobBody) => Promise<Done>): ShotRunner {
  return {
    async check(bytes, type) {
      const reply = answer(await run({ kind: 'check', bytes: bytesOf(bytes), type }));
      if (reply.kind !== 'check') throw new ShotJobError('failed', 'The picture couldn’t be read.');
      return { width: reply.width, height: reply.height };
    },
    async compare(before, after) {
      const reply = answer(
        await run({
          kind: 'compare',
          before: { bytes: bytesOf(before.bytes), type: before.type },
          after: { bytes: bytesOf(after.bytes), type: after.type },
        }),
      );
      if (reply.kind !== 'compare') throw new ShotJobError('failed', 'The pictures couldn’t be compared.');
      return {
        png: Buffer.from(reply.png.buffer, reply.png.byteOffset, reply.png.byteLength),
        width: reply.width,
        height: reply.height,
        areas: reply.areas,
      };
    },
  };
}

/** The same jobs on the calling thread, one at a time (tests). */
export function inProcessShots(): ShotRunner {
  let id = 0;
  return runner(async (job) => runShotsJob({ ...job, id: ++id } as ShotsJob));
}

interface Pending {
  job: ShotsJob;
  resolve: (reply: Done) => void;
  reject: (err: ShotJobError) => void;
}

/** One long-lived worker, one job at a time, a short queue. */
export class ShotPool {
  readonly runner: ShotRunner;
  readonly #url: URL;
  readonly #timeoutMs: number;
  readonly #queue: Pending[] = [];
  #worker: Worker | null = null;
  #current: (Pending & { timer: NodeJS.Timeout }) | null = null;
  #seq = 0;

  readonly #execArgv: string[] | undefined;
  readonly #log: ((why: string, err?: unknown) => void) | undefined;
  /** The current worker posted `ready`: it loaded, so a death from now on is a job's doing. */
  #ready = false;

  constructor(
    options: {
      url?: URL;
      timeoutMs?: number;
      /** The worker's Node options (default the server's own, which carry its loader from source). */
      execArgv?: string[];
      /** Told when the worker can't start or dies, never with picture bytes. */
      log?: (why: string, err?: unknown) => void;
    } = {},
  ) {
    this.#url = options.url ?? shotsWorkerUrl();
    this.#timeoutMs = options.timeoutMs ?? SHOTS_JOB_TIMEOUT_MS;
    this.#execArgv = options.execArgv;
    this.#log = options.log;
    this.runner = runner((job) => this.#run(job));
  }

  #run(body: JobBody): Promise<Done> {
    return new Promise<Done>((resolve, reject) => {
      if (this.#queue.length >= SHOTS_QUEUE_MAX)
        return reject(
          new ShotJobError('busy', 'Whombat is busy with other pictures: send it again in a moment.'),
        );
      this.#queue.push({ job: { ...body, id: ++this.#seq } as ShotsJob, resolve, reject });
      this.#next();
    });
  }

  async close(): Promise<void> {
    for (const p of this.#queue.splice(0)) p.reject(new ShotJobError('failed', 'closed'));
    this.#fail(new ShotJobError('failed', 'closed'));
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
    } catch {
      pending.reject(new ShotJobError('failed', 'The picture worker couldn’t start.'));
      this.#next();
      return;
    }
    const timer = setTimeout(() => this.#abandon(worker), this.#timeoutMs);
    this.#current = { ...pending, timer };
    const job = pending.job;
    const transfer =
      job.kind === 'check' ? [job.bytes.buffer] : [job.before.bytes.buffer, job.after.bytes.buffer];
    worker.postMessage(job, transfer as ArrayBuffer[]);
  }

  #ensure(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(this.#url, {
      workerData: { role: SHOTS_WORKER_ROLE },
      resourceLimits: SHOTS_WORKER_LIMITS,
      ...(this.#execArgv ? { execArgv: this.#execArgv } : {}),
    });
    // Idle, it doesn't keep the process alive; a running job's timer does.
    worker.unref();
    this.#worker = worker;
    this.#ready = false;
    worker.on('message', (reply: ShotsReply) => {
      if (worker !== this.#worker) return;
      if ('ready' in reply) {
        this.#ready = true;
        return;
      }
      const current = this.#current;
      if (!current || reply.id !== current.job.id) return;
      clearTimeout(current.timer);
      this.#current = null;
      current.resolve(reply);
      this.#next();
    });
    const died = (err?: unknown) => {
      if (worker !== this.#worker) return;
      // One that never loaded is Whombat's own trouble (a missing bundle, a loader), never the picture's.
      if (!this.#ready) {
        this.#log?.('the picture worker could not start', err);
        this.#replace(worker, new ShotJobError('failed', 'Whombat couldn’t compare pictures just now.'));
        return;
      }
      this.#log?.('the picture worker died on a picture', err);
      this.#replace(worker, new ShotJobError('refused', 'The picture was too much to compare.'));
    };
    worker.on('error', died);
    worker.on('exit', (code) => died(new Error(`exited with ${code}`)));
    return worker;
  }

  #abandon(worker: Worker): void {
    if (worker !== this.#worker) return;
    // Still starting when time ran out: Whombat's trouble, not the picture's.
    if (!this.#ready) {
      this.#log?.('the picture worker did not start in time');
      this.#replace(worker, new ShotJobError('failed', 'Whombat couldn’t compare pictures just now.'));
      return;
    }
    this.#replace(worker, new ShotJobError('refused', 'The picture took too long to compare.'));
  }

  /** The worker died or is stuck: its job fails, the next job gets a new one. */
  #replace(worker: Worker, err: ShotJobError): void {
    if (worker !== this.#worker) return;
    this.#worker = null;
    this.#ready = false;
    void worker.terminate();
    this.#fail(err);
    this.#next();
  }

  #fail(err: ShotJobError): void {
    const current = this.#current;
    if (!current) return;
    clearTimeout(current.timer);
    this.#current = null;
    current.reject(err);
  }
}

const runners = new WeakMap<object, ShotRunner>();

/** This server's picture runner: the worker pool, made on first use. */
export function shotRunnerFor(owner: object, log?: (why: string, err?: unknown) => void): ShotRunner {
  let found = runners.get(owner);
  if (!found) {
    found = new ShotPool(log ? { log } : {}).runner;
    runners.set(owner, found);
  }
  return found;
}

/** Tests: the jobs run in-process instead. */
export function setShotRunner(owner: object, runner: ShotRunner): void {
  runners.set(owner, runner);
}
