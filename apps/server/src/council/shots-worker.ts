/**
 * The council's picture worker (docs/decisions/council.md CNL-S06): reads a builder's screenshot, and compares a before
 * and an after and draws their picture, off the server's event loop (`shots-pool.ts` starts it, one job at a time).
 *
 * Loaded two ways: imported by the server (its types and role), and as a worker's entry (`workerData.role`
 * `SHOTS_WORKER_ROLE`): from source with the loader the server runs under (tsx), and from a release as
 * `app/shots-worker.mjs`, its own esbuild entry (scripts/package), which bundles `shots.ts` into it.
 */
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { type Area, changedAreas, decodeShot, drawCompare, ShotError, type ShotType, whereOf } from './shots';

/** `workerData.role` of the picture worker: the module only listens for jobs in a worker started with it. */
export const SHOTS_WORKER_ROLE = 'whombat-council-shots';

export interface ShotBytes {
  bytes: Uint8Array;
  type: ShotType;
}

/** A job as posted to the worker: read one shot (its size), or compare two and draw them. */
export type ShotsJob =
  | ({ id: number; kind: 'check' } & ShotBytes)
  | { id: number; kind: 'compare'; before: ShotBytes; after: ShotBytes };

/** One changed area with where it is on the after screen, in words. */
export type ShotArea = Area & { where: string };

/** The worker's answers: `ready` once it listens, then one per job. */
export type ShotsReply =
  | { ready: true }
  | { id: number; ok: true; kind: 'check'; width: number; height: number }
  | {
      id: number;
      ok: true;
      kind: 'compare';
      png: Uint8Array;
      width: number;
      height: number;
      areas: ShotArea[];
    }
  | { id: number; ok: false; error: string; refusal: boolean };

/** Does one job: what the worker runs, and what an in-process runner (tests) runs. */
export function runShotsJob(job: ShotsJob): Exclude<ShotsReply, { ready: true }> {
  try {
    if (job.kind === 'check') {
      const shot = decodeShot(Buffer.from(job.bytes), job.type);
      return { id: job.id, ok: true, kind: 'check', width: shot.width, height: shot.height };
    }
    const before = decodeShot(Buffer.from(job.before.bytes), job.before.type);
    const after = decodeShot(Buffer.from(job.after.bytes), job.after.type);
    const areas = changedAreas(before, after);
    const drawn = drawCompare(before, after, areas);
    return {
      id: job.id,
      ok: true,
      kind: 'compare',
      // A copy of its own: a Buffer may share a pooled memory block, which must never be transferred.
      png: new Uint8Array(drawn.png),
      width: drawn.width,
      height: drawn.height,
      areas: areas.map((a) => ({ ...a, where: whereOf(a, after.width, after.height).slice(0, 60) })),
    };
  } catch (err) {
    // A picture Whombat can't read is the builder's to fix (plain words); anything else is ours.
    return err instanceof ShotError
      ? { id: job.id, ok: false, error: err.message, refusal: true }
      : { id: job.id, ok: false, error: 'The picture couldn’t be compared.', refusal: false };
  }
}

if (!isMainThread && (workerData as { role?: string } | null)?.role === SHOTS_WORKER_ROLE && parentPort) {
  const port = parentPort;
  port.on('message', (job: ShotsJob) => {
    const reply = runShotsJob(job);
    port.postMessage(reply, reply.ok && reply.kind === 'compare' ? [reply.png.buffer as ArrayBuffer] : []);
  });
  port.postMessage({ ready: true } satisfies ShotsReply);
}
