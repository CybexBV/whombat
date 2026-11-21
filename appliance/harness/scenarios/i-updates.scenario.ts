/**
 * (i) Update slice C (assignment §13 C, §14.10/§14.11) with the real whombat-manager and update helper (fake
 * activator bridged to the real runtime, IN-21) and the development TUF repository with its channels. The box follows
 * its channel as every box does (Whombat whombat-link.md LNK-20): a candidate is offered by being the newest release
 * the channel lists, and control assigns nothing and hears nothing of it. Every candidate describes the real runtime;
 * a "bad" candidate makes the bridge start the real runtime so it can't become healthy.
 */

import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runtimeFixture } from '../src/dev/fixtures.ts';
import { psql } from '../src/dev/postgres.ts';
import { DEV_CHANNEL, hasChannels, type ReleaseOptions, runtimeFacts } from '../src/dev/releases.ts';
import { startService, stopService } from '../src/dev/restart.ts';
import { unixJson } from '../src/dev/services.ts';
import { expandHome, paths } from '../src/lib/paths.ts';
import { must } from '../src/lib/proc.ts';
import { loadPins } from '../src/manifest/pins.ts';
import { openSession, sessionOps, whenState } from '../src/scenario-kit/app-client.ts';
import { blocked, gap, note } from '../src/scenario-kit/report.ts';
import { ensureSlice, identityOf, ownerSession, type SliceState } from '../src/scenario-kit/slice.ts';
import {
  activatorEvents,
  bridgeLog,
  nextCandidateId,
  pollNow,
  publishCandidate,
  tufDir,
  updateStatus,
  waitForStatus,
} from '../src/scenario-kit/updates.ts';
import { api, collect, ensureWorkspace, eventType, type Workspace } from '../src/scenario-kit/work.ts';
import { env, persona, runtimeHealth, ticketSource } from '../src/scenario-kit/world.ts';

let slice: SliceState;
let w: Workspace;
/**
 * What a new same-binary candidate must describe to run on the database as the previous cases left it: after C3
 * the base binary declares it reads the expand schema; after C4 only the contract fixture's binary can run.
 */
let serving: Pick<ReleaseOptions, 'runtime' | 'source' | 'schemaReads'> | null = null;
const sameBinary = (id: string, extra: Pick<ReleaseOptions, 'clientFloor'> = {}) =>
  publishCandidate({
    id,
    ...extra,
    ...(serving
      ? {
          runtime: serving.runtime,
          ...(serving.source ? { source: serving.source } : {}),
          ...(serving.schemaReads ? { schemaReads: serving.schemaReads } : {}),
        }
      : {}),
  });
const tag = Date.now().toString(36);
/** The next candidate's id; `what` only says in the code which candidate this is. */
const rid = (_what: string) => nextCandidateId();

async function releaseServed(): Promise<string | null> {
  const h = await runtimeHealth();
  return h.ok ? String((h.body as { releaseId?: string }).releaseId) : null;
}

async function meWorks(): Promise<boolean> {
  const { session } = await ownerSession(slice);
  try {
    const r = await api(session, 'me.get', 'GET');
    return !!r;
  } finally {
    session.close('closed');
  }
}

async function appliedTags(): Promise<string[]> {
  return (
    await psql('select tag from whombat_meta.schema_versions order by version', 'whombat_runtime')
  ).stdout
    .trim()
    .split('\n');
}

/** The authentic checkpoints in the backup destination (`whombat-backup snapshots -json`). */
async function backupCheckpoints(): Promise<
  { ID: string; Seq: number; CreatedAt: string; Method: string }[]
> {
  const b = env().backup;
  const src = env().sources['appliance-backup'];
  if (!b || !src) return [];
  const cli = join(
    paths.bin,
    `appliance-backup@${src.commit.slice(0, 12)}${src.dirty ? '-dirty' : ''}`,
    'whombat-backup',
  );
  const r = await must(cli, ['-config', b.config, 'snapshots', '-json'], { cwd: paths.bin });
  return (
    (
      JSON.parse(r.stdout) as {
        checkpoints: { ID: string; Seq: number; CreatedAt: string; Method: string }[] | null;
      }
    ).checkpoints ?? []
  );
}

function backupLog(): string[] {
  const f = join(paths.logs, 'backup.log');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n') : [];
}

function tufrepoBin(): string {
  const src = env().sources['appliance-manager'];
  return join(
    paths.bin,
    `appliance-manager@${src?.commit.slice(0, 12)}${src?.dirty ? '-dirty' : ''}`,
    'tufrepo',
  );
}

beforeAll(async () => {
  if (env().manager?.kind !== 'real') return;
  slice = await ensureSlice();
  const { session } = await ownerSession(slice);
  w = await ensureWorkspace(session, `Updates ${tag}`);
  session.close('closed');
}, 180_000);

describe('i update slice C', () => {
  it('C1 the channel’s newest release is taken, staged, activated at a safe boundary, verified and becomes Healthy; accepted work completes once', async (ctx) => {
    if (env().manager?.kind !== 'real')
      blocked(ctx, 'whombat-appliance/real-manager', 'dev/up ran the stand-in manager');
    const before = await updateStatus();
    const { session } = await ownerSession(slice, { backoff: { baseMs: 200, maxMs: 2000 } });
    const events = collect(session, [`conv:${w.conversationId}`]);
    const t = await publishCandidate({ id: rid('good') });
    // Accepted work in flight when the update arrives.
    const sent = await api<{ message: { id: string } }>(session, 'messages.send', 'POST', {
      params: { burrow: w.slug, conversationId: w.conversationId },
      body: { text: `@${w.agent.name} please look at the update` },
    });
    await pollNow();
    const r = await waitForStatus(
      (s) => s.state === 'Healthy' && s.current === t.releaseId,
      180_000,
      'candidate Healthy',
    );
    const reply = await events.waitFor(
      (e) => {
        const m = (e.event as { message?: { author?: { id: string }; authorId?: string } }).message;
        return eventType(e) === 'message.created' && (m?.author?.id ?? m?.authorId) === w.agent.id ? m : null;
      },
      90_000,
      'agent reply across the update',
    );
    const served = await releaseServed();
    note(ctx, 'C1', {
      from: before.current,
      to: t.releaseId,
      states: r.seen,
      served,
      activator: activatorEvents().slice(-3),
      sent: sent.message.id,
    });
    expect(r.seen).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^WaitingForSafeBoundary/),
        expect.stringMatching(/^Verifying/),
      ]),
    );
    expect(served).toBe(t.releaseId);
    expect(reply).toBeTruthy();
    expect(events.duplicateMessages()).toEqual([]);
    events.close();
    session.close('closed');
  }, 360_000);

  it('C2 a candidate that fails verification rolls back to known-good; the runtime serves again', async (ctx) => {
    if (env().manager?.kind !== 'real')
      blocked(ctx, 'whombat-appliance/real-manager', 'dev/up ran the stand-in manager');
    const known = (await updateStatus()).current;
    const t = await publishCandidate({ id: rid('bad'), runtimeHealth: 'bad' });
    await pollNow();
    // Quarantined/RolledBack status no longer names the candidate; the states seen show it was this one.
    const r = await waitForStatus(
      (s) => ['RolledBack', 'Quarantined'].includes(s.state) && !!s.failure,
      240_000,
      'rollback',
    );
    let served: string | null = null;
    for (let i = 0; i < 60 && served !== known; i++) {
      served = await releaseServed();
      if (served !== known) await new Promise((res) => setTimeout(res, 1000));
    }
    const after = await updateStatus();
    note(ctx, 'C2', {
      known,
      candidate: t.releaseId,
      states: r.seen,
      final: after,
      served,
      bridge: bridgeLog().slice(-3),
    });
    expect(r.seen.some((x) => x.startsWith('Verifying') && x.includes(t.releaseId))).toBe(true);
    expect(after.current).toBe(known);
    expect(after.failure).toBeTruthy();
    expect(served).toBe(known);
    expect(await meWorks()).toBe(true);
  }, 360_000);

  it('C3 an expand-migration candidate migrates the real database, fails verification, and rolls back to the older binary, which keeps reading and writing', async (ctx) => {
    if (env().manager?.kind !== 'real')
      blocked(ctx, 'whombat-appliance/real-manager', 'dev/up ran the stand-in manager');
    const rt = env().sources['whombat-runtime'];
    if (!rt) throw new Error('no runtime source');
    const fx = await runtimeFixture(
      rt,
      'expand',
      expandHome(loadPins().components.find((c) => c.id === 'whombat-runtime')?.source ?? ''),
    );
    const base = runtimeFacts(rt.path);
    const exp = runtimeFacts(fx.dir);
    // The base (the real pinned binary) declares it reads one schema further: the fixture's expand floors say so.
    const t0 = await publishCandidate({
      id: rid('base'),
      schemaReads: { min: base.schema.reads, max: exp.schema.writes },
    });
    await pollNow();
    await waitForStatus((s) => s.state === 'Healthy' && s.current === t0.releaseId, 180_000, 'base Healthy');
    // The candidate: the fixture binary (expand migration), which then can't start.
    const t = await publishCandidate({
      id: rid('expand'),
      runtime: exp,
      source: fx.dir,
      runtimeHealth: 'bad',
      schemaReads: { min: base.schema.reads, max: exp.schema.writes },
    });
    await pollNow();
    const r = await waitForStatus(
      (s) => ['RolledBack', 'Quarantined'].includes(s.state) && !!s.failure,
      240_000,
      'rollback after the expand migration',
    );
    let served: string | null = null;
    for (let i = 0; i < 90 && served !== t0.releaseId; i++) {
      served = await releaseServed();
      if (served !== t0.releaseId) await new Promise((res) => setTimeout(res, 1000));
    }
    const applied = (
      await psql('select tag from whombat_meta.schema_versions order by version', 'whombat_runtime')
    ).stdout
      .trim()
      .split('\n');
    const h = (await runtimeHealth()).body as {
      version?: string;
      checks?: { migrations?: { schemaVersion?: number; access?: string; verdict?: string } };
    };
    note(ctx, 'C3', {
      fixture: fx,
      states: r.seen,
      served,
      health: h,
      lastApplied: applied.slice(-2),
      activator: activatorEvents().slice(-4),
    });
    expect(applied).toContain(fx.tags[0]);
    expect(r.seen.some((x) => x.includes(t.releaseId))).toBe(true);
    serving = { runtime: base, schemaReads: { min: base.schema.reads, max: exp.schema.writes } };
    expect(served).toBe(t0.releaseId);
    expect(h.version).toBe(base.version);
    expect(h.checks?.migrations?.access).toBe('read-write');
    expect(await meWorks()).toBe(true);
  }, 600_000);

  it('C4 an incompatible (contract) candidate needs a verified backup checkpoint: the manager takes it through the backup service under its drain, then migrates; the candidate serves', async (ctx) => {
    if (env().manager?.kind !== 'real')
      blocked(ctx, 'whombat-appliance/real-manager', 'dev/up ran the stand-in manager');
    const rt = env().sources['whombat-runtime'];
    if (!rt) throw new Error('no runtime source');
    const fx = await runtimeFixture(
      rt,
      'contract',
      expandHome(loadPins().components.find((c) => c.id === 'whombat-runtime')?.source ?? ''),
    );
    const known = (await updateStatus()).current;
    const facts = runtimeFacts(fx.dir);
    const schemaReads = { min: runtimeFacts(rt.path).schema.reads, max: facts.schema.writes };
    const withBackup = !!env().backup && env().services.backup?.status === 'running';
    const before = withBackup ? await backupCheckpoints() : [];
    const t = await publishCandidate({
      id: rid('contract'),
      runtime: facts,
      source: fx.dir,
      contractMigration: true,
      schemaReads,
    });
    await pollNow();
    if (!withBackup) {
      // Without the backup service (dev/up --without backup) the manager can only wait.
      const r = await waitForStatus(
        (s) =>
          s.candidate === t.releaseId &&
          /checkpoint/i.test(`${s.explanation ?? ''} ${s.deferredReason ?? ''} ${JSON.stringify(s)}`),
        180_000,
        'waiting for a checkpoint',
      );
      await new Promise((res) => setTimeout(res, 10_000));
      const applied = await appliedTags();
      note(ctx, 'C4 (no backup service)', { states: r.seen, served: await releaseServed() });
      expect((await updateStatus()).current).toBe(known);
      expect(await releaseServed()).toBe(known);
      expect(applied).not.toContain(fx.tags[1]);
      blocked(ctx, 'whombat-appliance/backup-service-in-dev-env', 'dev/up ran without the backup service');
    }
    const r = await waitForStatus(
      (s) => s.state === 'Healthy' && s.current === t.releaseId,
      420_000,
      'contract candidate Healthy after a checkpoint',
    );
    const applied = await appliedTags();
    const migrate = activatorEvents()
      .filter((l) => l.startsWith('migrate '))
      .at(-1);
    const ref = migrate ? (/checkpoint="([^"]*)"/.exec(migrate)?.[1] ?? '') : '';
    const after = await backupCheckpoints();
    const taken = after.filter((c) => !before.some((b) => b.ID === c.ID));
    const h = (await runtimeHealth()).body as {
      version?: string;
      checks?: { migrations?: { schemaVersion?: number; access?: string } };
    };
    note(ctx, 'C4', {
      states: r.seen,
      served: await releaseServed(),
      migrate,
      checkpoint: ref,
      newCheckpoints: taken,
      lastApplied: applied.slice(-2),
      health: h,
      backupLog: backupLog().slice(-6),
    });
    expect(ref).toMatch(/^ck-/);
    expect(taken.map((c) => c.ID)).toContain(ref);
    expect(applied).toContain(fx.tags[1]);
    expect(await releaseServed()).toBe(t.releaseId);
    expect(h.version).toBe(facts.version);
    expect(h.checks?.migrations?.access).toBe('read-write');
    expect(await meWorks()).toBe(true);
    serving = { runtime: facts, source: fx.dir, schemaReads };
  }, 600_000);

  it('C5 expired or forged TUF metadata is refused; the installed release keeps serving; fresh metadata recovers', async (ctx) => {
    if (env().manager?.kind !== 'real')
      blocked(ctx, 'whombat-appliance/real-manager', 'dev/up ran the stand-in manager');
    const known = (await updateStatus()).current;
    const tuf = tufDir();
    const t = await sameBinary(rid('tuf'));
    // (a) expired timestamp: the channel's newest release can't be read from stale metadata.
    await must(tufrepoBin(), ['expire-timestamp', '--dir', tuf, '--at', '2026-01-01T00:00:00Z'], {
      cwd: tuf,
    });
    await pollNow();
    await new Promise((res) => setTimeout(res, 20_000));
    const expired = await updateStatus();
    const servedExpired = await releaseServed();
    const mgrLog = readFileSync(join(paths.logs, 'manager.log'), 'utf8').split('\n');
    const refusal = mgrLog.filter((l) => /expired|fresh metadata|refused/i.test(l)).slice(-2);
    // (b) forged metadata: the release's name changed in the newest version, as served, of the role that lists it
    // (the box's channel role; the top-level targets in a repository from before channels).
    await must(tufrepoBin(), ['publish-timestamp', '--dir', tuf], { cwd: tuf });
    const md = join(tuf, 'metadata');
    const role = hasChannels(tuf) ? DEV_CHANNEL : 'targets';
    const newest = readdirSync(md)
      .filter((f) => new RegExp(`^\\d+\\.${role}\\.json$`).test(f))
      .sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10))[0] as string;
    copyFileSync(join(md, newest), join(md, `${newest}.orig`));
    const doc = readFileSync(join(md, newest), 'utf8');
    if (!doc.includes(t.releaseId))
      throw new Error(`${newest} doesn’t list ${t.releaseId}: nothing to forge`);
    writeFileSync(join(md, newest), doc.replaceAll(t.releaseId, t.releaseId.replace(/.$/, 'x')));
    await pollNow();
    await new Promise((res) => setTimeout(res, 20_000));
    const forged = await updateStatus();
    const servedForged = await releaseServed();
    const refusal2 = readFileSync(join(paths.logs, 'manager.log'), 'utf8')
      .split('\n')
      .filter((l) => /signature|verif|metadata/i.test(l))
      .slice(-2);
    // Restore genuine metadata: the same release now installs.
    copyFileSync(join(md, `${newest}.orig`), join(md, newest));
    await must(tufrepoBin(), ['publish-timestamp', '--dir', tuf], { cwd: tuf });
    await pollNow();
    const r = await waitForStatus(
      (s) => s.state === 'Healthy' && s.current === t.releaseId,
      180_000,
      'install after genuine metadata',
    ).catch((err) => {
      gap(
        ctx,
        'whombat-appliance/manager',
        `after a refused (forged) targets version, genuine metadata at the same version doesn't recover: the helper's mirror lacks the snapshot and stage-runtime keeps failing metadata_stale (${String(err).slice(0, 200)})`,
      );
      throw err;
    });
    note(ctx, 'C5', {
      known,
      expired,
      servedExpired,
      refusal,
      forged,
      servedForged,
      refusal2,
      recovered: r.seen,
    });
    expect(expired.current).toBe(known);
    expect(servedExpired).toBe(known);
    expect(forged.current).toBe(known);
    expect(servedForged).toBe(known);
    expect(await releaseServed()).toBe(t.releaseId);
  }, 420_000);

  it('C6 control is away: the box still takes its channel’s newest release, and its Whombat Link is on when control is back', async (ctx) => {
    if (env().manager?.kind !== 'real')
      blocked(ctx, 'whombat-appliance/real-manager', 'dev/up ran the stand-in manager');
    // Updates never depend on control (Whombat whombat-link.md LNK-05): the release is published and taken while it is
    // stopped. The manager isn't restarted here (its start asks control for a ticket): it finds the release at its
    // own next look at the repository, every 20 s in this environment.
    await stopService('control');
    let r: Awaited<ReturnType<typeof waitForStatus>>;
    let t: Awaited<ReturnType<typeof sameBinary>>;
    try {
      t = await sameBinary(rid('outage'));
      r = await waitForStatus(
        (s) => s.state === 'Healthy' && s.current === t.releaseId,
        240_000,
        'Healthy without control',
      );
    } finally {
      await startService('control');
    }
    const served = await releaseServed();
    // The owner's session comes back through the relay once the box has a fresh ticket from control.
    let works = false;
    for (let i = 0; i < 60 && !works; i++) {
      works = await meWorks().catch(() => false);
      if (!works) await new Promise((res) => setTimeout(res, 2000));
    }
    const link = (await unixJson(env().appliance?.managerSocket ?? '', 'POST', '/v1/link/state', { v: 1 }))
      .body as { link?: { state?: string } };
    note(ctx, 'C6', { states: r.seen, served, linkAfterControlBack: link.link?.state });
    expect(served).toBe(t.releaseId);
    expect(works).toBe(true);
    expect(link.link?.state).toBe('on');
  }, 600_000);
  it('C7 a client security floor: the first release carries none, the next one sets it; a client below it is refused, at or above it is let in', async (ctx) => {
    if (env().manager?.kind !== 'real')
      blocked(ctx, 'whombat-appliance/real-manager', 'dev/up ran the stand-in manager');
    // Rollout rule (CT-53): the first release with a 0.5.3+ manager and helper ships without a floor.
    const first = await sameBinary(rid('nofloor'));
    await pollNow();
    await waitForStatus(
      (s) => s.state === 'Healthy' && s.current === first.releaseId,
      180_000,
      'no-floor release',
    );
    const FLOOR = 4021;
    const floored = await sameBinary(rid('floor'), { clientFloor: { cli: FLOOR, web: 120 } });
    await pollNow();
    const r = await waitForStatus(
      (s) => s.state === 'Healthy' && s.current === floored.releaseId,
      180_000,
      'floored release Healthy',
    );
    // The manager hands the running tuple's floor to the runtime (facts); give it a push cycle.
    const connect = async (buildNumber: number | undefined) => {
      const p = await persona(slice.owner.email.split('@')[0] ?? '', slice.owner.name);
      const s = openSession({
        tickets: ticketSource(p, slice.deviceId),
        identity: identityOf(slice),
        appliance: { peerId: slice.peerId },
        channel: 'app',
        ...(buildNumber !== undefined ? { buildNumber } : {}),
      });
      s.connect();
      const st = await whenState(s, (x) => x.status === 'open' || x.status === 'closed', 20_000);
      const out = st.status === 'closed' ? `closed:${st.reason}` : st.status;
      const status = st.status === 'open' ? await sessionOps.applianceStatus(s) : null;
      s.close('closed');
      return { out, status };
    };
    let below = await connect(FLOOR - 1);
    for (let i = 0; i < 30 && below.out === 'open'; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      below = await connect(FLOOR - 1);
    }
    const absent = await connect(undefined);
    const at = await connect(FLOOR);
    const above = await connect(FLOOR + 1);
    note(ctx, 'C7', {
      states: r.seen,
      tupleFloor: floored.clientFloor,
      below: below.out,
      absent: absent.out,
      at: at.out,
      above: above.out,
      statusFloor: (at.status as { clientFloor?: unknown } | null)?.clientFloor,
    });
    expect(below.out).toBe('closed:client_below_floor');
    expect(absent.out).toBe('closed:client_below_floor');
    expect(at.out).toBe('open');
    expect(above.out).toBe('open');
    expect(JSON.stringify((at.status as { clientFloor?: unknown } | null)?.clientFloor)).toContain(
      String(FLOOR),
    );
    // Leave no floor behind (IN-45): the scenarios after slice C connect as the harness client, without a build
    // number. A later release without a floor lifts it (floors aren't monotonic, CT-53).
    const lifted = await sameBinary(rid('nofloor2'));
    await pollNow();
    await waitForStatus(
      (s) => s.state === 'Healthy' && s.current === lifted.releaseId,
      180_000,
      'floorless release Healthy again',
    );
    let after = await connect(undefined);
    for (let i = 0; i < 30 && after.out !== 'open'; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      after = await connect(undefined);
    }
    expect(after.out).toBe('open');
  }, 900_000);
});
