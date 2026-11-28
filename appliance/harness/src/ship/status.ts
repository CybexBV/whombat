/**
 * `release/ship status` (UP-G3): one screen for the person on call. Production control's `deploy.sh status` (hosted
 * components and versions, the fleet by release and state, open rollouts with their wave, open alerts) as it prints
 * it, then where each recent candidate is in the pipeline (its records).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../lib/proc.ts';
import type { ShipContext } from './context.ts';
import { compareIds, parseReleaseId } from './ids.ts';
import { readRecord, STAGES } from './records.ts';

/** Where each recent PROD candidate is: the last record in its chain and whether it passed. */
export function pipelineLines(root: string, limit = 8): string[] {
  if (!existsSync(root)) return [];
  const ids = readdirSync(root)
    .map(parseReleaseId)
    .filter((r): r is NonNullable<typeof r> => r?.env === 'prod')
    .sort((a, b) => compareIds(b, a))
    .slice(0, limit);
  const out: string[] = [];
  for (const r of ids) {
    const dir = join(root, r.id);
    // Every record there is, older releases' records of stages that are gone included.
    const marks: string[] = [];
    for (const s of STAGES) {
      let rec: ReturnType<typeof readRecord> = null;
      try {
        rec = readRecord(dir, s);
      } catch {
        marks.push(`${s} unreadable`);
      }
      if (!rec?.record.chain) continue;
      const c = rec.record.chain;
      marks.push(`${s} ${c.ok ? (c.complete ? 'ok' : 'ok, partial') : 'FAILED'}`);
    }
    out.push(`  ${r.id.padEnd(16)} ${marks.length ? marks.join(' · ') : 'no release/ship records'}`);
  }
  return out;
}

export async function status(ctx: ShipContext): Promise<void> {
  const w = (s: string) => process.stdout.write(`${s}\n`);
  if (!existsSync(ctx.prod.deploySh)) w(`PROD: no deploy.sh at ${ctx.prod.deploySh} (WB_DEPLOY_SH)`);
  else {
    const r = await run(ctx.prod.deploySh, ['status'], {
      cwd: join(ctx.prod.deploySh, '..', '..', '..'),
      timeoutMs: 180_000,
    });
    w(
      r.code === 0
        ? r.stdout.trimEnd()
        : `PROD: deploy.sh status failed (${r.code}): ${r.stderr.trim().split('\n').slice(-3).join(' ')}`,
    );
  }
  w(`Pipeline (${ctx.root}):`);
  for (const l of pipelineLines(ctx.root)) w(l);
}
