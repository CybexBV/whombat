/**
 * Soak (IN-23): the running environment under steady, realistic traffic for a fixed time while the resident memory
 * of every service's process group is sampled. It catches leaks and crash loops that only show after tens of
 * minutes (the f9a23f4 runtime OOM'd after ~27 min).
 *
 * Traffic through the real client and relay: `me.get` every 250 ms on one session; a task to the agent every 30 s
 * (a runner turn); a 1 MiB upload every 2 min; the session closed and reopened every 5 min.
 * RSS: every 15 s, the sum of VmRSS over each service's process group (pnpm wrappers include the node child).
 * Failure: a service restarted (its set of pids changed or its group vanished), or sustained growth — the mean of
 * the last fifth of the samples exceeds the mean of the first fifth after a 3-minute warm-up by more than
 * max(64 MiB, 25 %). Traffic errors are reported (and fail the soak above 1 %).
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sleep } from '../lib/proc.ts';
import type { ApplianceSession } from '../scenario-kit/app-client.ts';
import { ensureSlice, ownerSession } from '../scenario-kit/slice.ts';
import { api, ensureWorkspace } from '../scenario-kit/work.ts';

import { judge, type SoakResultBase, type SoakSample, sample } from './soak-rss.ts';

export type SoakResult = SoakResultBase;

export async function soak(
  durationMs: number,
  outDir: string,
  log: (l: string) => void,
): Promise<SoakResult> {
  const intervalMs = 15_000;
  const warmupMs = Math.min(180_000, durationMs / 5);
  const traffic = {
    requests: 0,
    errors: 0,
    tasks: 0,
    replies: 0,
    uploads: 0,
    uploadErrors: 0,
    reconnects: 0,
  };
  const slice = await ensureSlice();
  let { session } = await ownerSession(slice, { backoff: { baseMs: 200, maxMs: 2000 } });
  const w = await ensureWorkspace(session, `Soak ${randomBytes(2).toString('hex')}`);
  const samples: SoakSample[] = [sample()];
  const until = Date.now() + durationMs;
  let stop = false;
  const seriesFile = join(outDir, 'soak-series.json');

  const loop = async (everyMs: number, fn: () => Promise<void>) => {
    while (!stop) {
      await fn().catch(() => {});
      const next = Date.now() + everyMs;
      while (!stop && Date.now() < next) await sleep(Math.min(250, next - Date.now()));
    }
  };
  const current = (): ApplianceSession => session;
  const errorLog: { at: string; error: string }[] = [];
  const block = randomBytes(1024 * 1024);
  const loops = [
    loop(250, async () => {
      traffic.requests++;
      try {
        await api(current(), 'me.get', 'GET', {}, { deadlineMs: 10_000 });
      } catch (err) {
        traffic.errors++;
        // What failed, and when (the first 20), so a failure is never just a count.
        if (errorLog.length < 20)
          errorLog.push({ at: new Date().toISOString(), error: String(err).slice(0, 300) });
      }
    }),
    loop(30_000, async () => {
      traffic.tasks++;
      const r = await api<{ dispatches: unknown[] }>(current(), 'messages.send', 'POST', {
        params: { burrow: w.slug, conversationId: w.conversationId },
        body: { text: `@${w.agent.name} soak ${traffic.tasks}` },
      });
      if (r.dispatches.length) traffic.replies++;
    }),
    loop(120_000, async () => {
      traffic.uploads++;
      try {
        const res = await api<{ attachment: { id: string } }>(current(), 'uploads.create', 'POST', {
          params: { burrow: w.slug },
          body: {
            conversationId: w.conversationId,
            name: 'soak.bin',
            contentType: 'application/octet-stream',
            size: block.length,
          },
        });
        await (current() as unknown as { upload(t: unknown, s: unknown): Promise<unknown> }).upload(
          { burrow: w.slug, attachmentId: res.attachment.id },
          {
            name: 'soak.bin',
            type: 'application/octet-stream',
            size: block.length,
            read: async (o: number, l: number) => block.subarray(o, o + l),
          },
        );
      } catch {
        traffic.uploadErrors++;
      }
    }),
    loop(300_000, async () => {
      if (traffic.reconnects++ === 0) return; // not at t=0
      const old = session;
      session = (await ownerSession(slice, { backoff: { baseMs: 200, maxMs: 2000 } })).session;
      old.close('closed');
    }),
    loop(intervalMs, async () => {
      samples.push(sample());
      writeFileSync(seriesFile, `${JSON.stringify(samples)}\n`);
      const last = samples.at(-1);
      if (samples.length % 8 === 0)
        log(
          `soak ${Math.round((Date.now() - (samples[0]?.t ?? 0)) / 60_000)} min: ${Object.entries(
            last?.rss ?? {},
          )
            .map(([k, v]) => `${k} ${v ?? '-'} MiB`)
            .join(', ')} · ${traffic.requests} req, ${traffic.errors} err`,
        );
    }),
  ];
  while (Date.now() < until) await sleep(1000);
  stop = true;
  await Promise.all(loops);
  session.close('closed');
  samples.push(sample());
  writeFileSync(seriesFile, `${JSON.stringify(samples)}\n`);
  const verdict = judge(samples, warmupMs);
  if (traffic.requests > 0 && traffic.errors / traffic.requests > 0.01) {
    verdict.ok = false;
    verdict.reasons.push(`traffic: ${traffic.errors}/${traffic.requests} requests failed`);
  }
  return {
    durationS: Math.round(durationMs / 1000),
    intervalS: intervalMs / 1000,
    samples: samples.length,
    traffic,
    errorLog,
    seriesFile,
    ...verdict,
  };
}
