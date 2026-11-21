/**
 * `release/ship status [--dev]` (UP-G3): one screen for the person on call. PROD: control's `deploy.sh status`
 * (hosted components and versions, the fleet by release and state, open rollouts with their wave, open alerts) as it
 * prints it; `--dev`: the same facts from DEV control's operator API and the DEV box. Both end with where each recent
 * candidate is in the pipeline (its records).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadState } from '../devbox/state.ts';
import { run } from '../lib/proc.ts';
import { devControl, devOp, type ShipContext } from './context.ts';
import { compareIds, parseReleaseId } from './ids.ts';
import { currentWaveOf, deviceLine } from './promote.ts';
import { describePause } from './record.ts';
import { readRecord, STAGES } from './records.ts';

interface Dev {
  device: string;
  state: string;
  internal?: boolean;
  lastSeenAt?: number | null;
  status?: {
    release?: string;
    managerVersion?: string;
    update?: { state?: string; failure?: string | null };
  };
}

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
    // Every record there is: validate's branch and publish-dev's run side by side (IN-115).
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

export async function status(ctx: ShipContext, a: { dev: boolean }): Promise<void> {
  const w = (s: string) => process.stdout.write(`${s}\n`);
  if (!a.dev) {
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
  } else {
    const c = devControl(ctx);
    const now = Math.floor(Date.now() / 1000);
    const [health, devices, rollouts, releases] = await Promise.all([
      fetch(`${c.adminUrl}/v1/operator/health`)
        .then((r) => r.json() as Promise<{ ok: boolean; env: string }>)
        .catch(() => null),
      devOp<{ devices: Dev[] }>(c, 'GET', '/devices'),
      devOp<{
        rollouts: {
          rollout: string;
          release: string;
          state: string;
          currentWave?: number;
          waves?: unknown[];
          pauseReason?: string | null;
          pauseDetail?: { device?: string | null; failureDetail?: Record<string, unknown> | null } | null;
        }[];
      }>(c, 'GET', '/rollouts'),
      devOp<{ releases: { release: string; state: string }[] }>(c, 'GET', '/releases'),
    ]);
    const alerts = await devOp<{
      alerts: { kind: string; severity: string; subject: string; openedAt: number }[];
    }>(c, 'GET', '/alerts?state=open').catch(() => null);
    const live = devices.devices.filter((d) => d.state !== 'retired');
    const byRelease = new Map<string, string[]>();
    for (const d of live) {
      const k = d.status?.release ?? 'unknown';
      byRelease.set(k, [
        ...(byRelease.get(k) ?? []),
        `${d.device}${d.internal ? '*' : ''} ${d.status?.update?.state ?? '?'}${(d.lastSeenAt ?? 0) < now - 86_400 ? ' (unseen 24 h)' : ''}`,
      ]);
    }
    w(
      `DEV control ${c.publicUrl}: ${health?.ok ? `ok (${health.env})` : 'not answering'} · ${releases.releases.length} releases registered`,
    );
    w('Fleet by release (* internal):');
    for (const [rel, ds] of byRelease) w(`  ${rel}: ${ds.join(', ')}`);
    const open = rollouts.rollouts.filter((r) => r.state === 'active' || r.state === 'paused');
    w(`Open rollouts: ${open.length ? '' : 'none'}`);
    for (const r of open) {
      w(
        `  ${r.rollout} ${r.release} ${r.state}, wave ${currentWaveOf(r as Parameters<typeof currentWaveOf>[0]) + 1} of ${r.waves?.length ?? '?'}${r.state === 'paused' ? ` — ${describePause(r)}` : ''}`,
      );
      const devs = await devOp<{ devices: Parameters<typeof deviceLine>[0][] }>(
        c,
        'GET',
        `/rollouts/${r.rollout}/devices`,
      ).catch(() => null);
      for (const d of devs?.devices ?? []) {
        const f = devices.devices.find((x) => x.device === d.device);
        w(
          `    ${deviceLine(d, f ? { lastSeenAt: f.lastSeenAt ?? null, state: f.status?.update?.state ?? null } : null)}`,
        );
      }
    }
    w(
      `Alerts: ${alerts ? (alerts.alerts.length ? '' : 'none open') : 'this control has none (before contracts 0.22)'}`,
    );
    for (const x of alerts?.alerts ?? []) w(`  ${x.severity} ${x.kind}: ${x.subject}`);
    const st = loadState();
    w(
      `DEV box: ${st?.device ? `${st.device} (installed from ${st.installedFrom.releaseId})` : 'none (dev/devbox create)'}`,
    );
  }
  w(`Pipeline (${ctx.root}):`);
  for (const l of pipelineLines(ctx.root)) w(l);
}
