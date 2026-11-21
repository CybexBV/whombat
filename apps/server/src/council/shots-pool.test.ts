import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import { inProcessShots, SHOTS_QUEUE_MAX, ShotJobError, ShotPool, shotsWorkerUrl } from './shots-pool';
import { SHOTS_WORKER_ROLE } from './shots-worker';

/** A stand-in worker: answers a check with the first byte as its width; a first byte 0 never answers (stuck). */
function standIn(): URL {
  const dir = mkdtempSync(join(tmpdir(), 'council-shots-'));
  const file = join(dir, 'worker.mjs');
  writeFileSync(
    file,
    `import { parentPort, workerData } from 'node:worker_threads';
if (workerData.role === ${JSON.stringify(SHOTS_WORKER_ROLE)}) {
  parentPort.on('message', (job) => {
    if (job.bytes[0] === 0) return;
    setTimeout(() => parentPort.postMessage({ id: job.id, ok: true, kind: 'check', width: job.bytes[0], height: 1 }), 20);
  });
  parentPort.postMessage({ ready: true });
}
`,
  );
  return pathToFileURL(file);
}

let pool: ShotPool | null = null;
afterEach(async () => {
  await pool?.close();
  pool = null;
});

describe('the council’s picture worker, one job at a time', () => {
  it('answers jobs in order off the event loop', async () => {
    pool = new ShotPool({ url: standIn() });
    const sizes = await Promise.all([1, 2, 3].map((n) => pool?.runner.check(Buffer.from([n]), 'image/png')));
    expect(sizes.map((s) => s?.width)).toEqual([1, 2, 3]);
  });

  it('refuses more than a short queue, as busy', async () => {
    pool = new ShotPool({ url: standIn() });
    const jobs = Array.from({ length: SHOTS_QUEUE_MAX + 3 }, (_, n) =>
      (pool as ShotPool).runner.check(Buffer.from([n + 1]), 'image/png').then(
        () => 'ok',
        (err: unknown) => (err instanceof ShotJobError ? err.kind : 'other'),
      ),
    );
    const results = await Promise.all(jobs);
    expect(results.filter((r) => r === 'busy').length).toBeGreaterThan(0);
    expect(results.filter((r) => r === 'ok').length).toBeGreaterThanOrEqual(SHOTS_QUEUE_MAX);
  });

  it('gives up on a stuck job and starts a new worker for the next', async () => {
    pool = new ShotPool({ url: standIn(), timeoutMs: 200 });
    await expect(pool.runner.check(Buffer.from([0]), 'image/png')).rejects.toMatchObject({ kind: 'refused' });
    await expect(pool.runner.check(Buffer.from([7]), 'image/png')).resolves.toMatchObject({ width: 7 });
  });

  it('runs the real worker entry from source, with the server’s loader', async () => {
    pool = new ShotPool({ url: shotsWorkerUrl(), execArgv: ['--import', 'tsx'], timeoutMs: 20_000 });
    const png = new PNG({ width: 40, height: 30 });
    png.data.fill(200);
    await expect(pool.runner.check(PNG.sync.write(png), 'image/png')).resolves.toEqual({
      width: 40,
      height: 30,
    });
    await expect(pool.runner.check(Buffer.from('not a picture'), 'image/png')).rejects.toMatchObject({
      kind: 'refused',
    });
  }, 30_000);

  it('blames itself, not the picture, when its worker can’t start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'council-shots-'));
    const broken = join(dir, 'broken.mjs');
    writeFileSync(broken, "import './missing-module.mjs';\n");
    const told: string[] = [];
    pool = new ShotPool({ url: pathToFileURL(broken), log: (why) => told.push(why) });
    await expect(pool.runner.check(Buffer.from([1]), 'image/png')).rejects.toMatchObject({ kind: 'failed' });
    expect(told).toEqual(expect.arrayContaining([expect.stringContaining('could not start')]));
  });

  it('blames itself when its worker never says it is ready', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'council-shots-'));
    const silent = join(dir, 'silent.mjs');
    writeFileSync(silent, 'setInterval(() => {}, 1000);\n');
    const told: string[] = [];
    pool = new ShotPool({ url: pathToFileURL(silent), timeoutMs: 300, log: (why) => told.push(why) });
    await expect(pool.runner.check(Buffer.from([1]), 'image/png')).rejects.toMatchObject({ kind: 'failed' });
    expect(told).toEqual(expect.arrayContaining([expect.stringContaining('did not start')]));
  });

  it('runs the real jobs in-process for tests: a refusal in plain words, a picture of a change', async () => {
    const shots = inProcessShots();
    await expect(shots.check(Buffer.from('not a picture'), 'image/png')).rejects.toMatchObject({
      kind: 'refused',
    });
    const page = (dark: boolean) => {
      const png = new PNG({ width: 64, height: 48 });
      png.data.fill(dark ? 30 : 240);
      for (let o = 3; o < png.data.length; o += 4) png.data[o] = 255;
      return PNG.sync.write(png);
    };
    const drawn = await shots.compare(
      { bytes: page(false), type: 'image/png' },
      { bytes: page(true), type: 'image/png' },
    );
    expect(drawn.areas.length).toBeGreaterThan(0);
    expect(drawn.areas[0]?.where).toBeTruthy();
    expect(drawn.png.subarray(1, 4).toString()).toBe('PNG');
  });
});
