/**
 * Appliance-local IPC (CT-23): the admin socket the manager and the backup service call (health, drain with
 * lease and scopes, resume, claim window, facts), the manager socket client, content-free push through the
 * manager, and the loopback listener serving only the runner protocol and MCP in managed mode.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DrainStatus,
  RuntimeClaimedRequest,
  RuntimeHealth,
  RuntimePushRequest,
  RuntimeTicketRequest,
} from '@whombat/control-contracts/local';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { markNotificationsRead, updatePreferences } from '../commands/account';
import { sendMessage } from '../commands/messages';
import { applianceEndpoints, applianceEvents, notifications } from '../db/schema/index';
import { clearDecidedApproval, type NotificationDraft, notify } from '../domain/notify';
import { IDS } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import { accountOf } from '../test/tokens';
import { AdminSocket } from './admin-socket';
import { ManagerSocketClient } from './manager-client';
import { ManagerCallError } from './ports';
import { opaqueRef } from './push';

const m = useManagedRuntime({ seed: true });

const marasMention = (text: string): NotificationDraft => ({
  burrowId: m.t.burrowId,
  burrowSlug: 'burrow-hq',
  principalId: IDS.mara,
  kind: 'mention',
  actorId: IDS.dusty,
  where: '#general',
  text,
  link: { type: 'pr', number: 482 } as never,
  createdAt: new Date(),
});
const dir = mkdtempSync(join(tmpdir(), 'wb-admin-'));
const adminPath = join(dir, 'admin.sock');
let admin: AdminSocket;

function call(path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: adminPath,
        path,
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString() || '{}'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

beforeAll(async () => {
  admin = new AdminSocket({ runtime: m.runtime, endpoint: null, releaseId: 'rel-test-1' });
  await admin.listen(adminPath);
});

afterAll(async () => {
  await admin.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('admin socket', () => {
  it('reports local health in the contract shape (no session endpoint here: degraded, 503)', async () => {
    const res = await call('/health');
    expect(res.status).toBe(503);
    const health = RuntimeHealth.parse(res.body);
    expect(health).toMatchObject({
      status: 'degraded',
      releaseId: 'rel-test-1',
      draining: false,
      checks: { db: { ok: true }, migrations: { ok: true, compatible: true, access: 'read-write' } },
    });
    expect(health.checks.migrations.schemaVersion).toBeGreaterThan(0);
  });

  it('says in health when maintenance is stale, without degrading the runtime for it', async () => {
    expect(RuntimeHealth.parse((await call('/health')).body).checks.maintenance).toEqual({ ok: true });
    const stop = m.runtime.services.housekeeping.add('stuck check', 60_000, () => new Promise(() => {}));
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 20 * 60_000);
    try {
      const health = RuntimeHealth.parse((await call('/health')).body);
      expect(health.checks.maintenance?.ok).toBe(false);
      expect(health.checks.maintenance?.detail).toMatch(/^maintenance is stale/);
      expect(health.checks.maintenance?.detail).toContain('stuck check');
      // Only the session endpoint (absent here) makes this runtime degraded.
      expect(health.status).toBe('degraded');
      expect(health.checks.sessionEndpoint.ok).toBe(false);
    } finally {
      clock.mockRestore();
      stop();
    }
  });

  it('drains with a lease, refuses another holder, is idempotent per request id, then resumes', async () => {
    const drain = { v: 1, requestId: 'upd-1', reason: 'update', scope: 'all', leaseMs: 60_000 } as const;
    const first = await call('/drain', drain);
    expect(first.status).toBe(200);
    expect(DrainStatus.parse(first.body)).toMatchObject({ requestId: 'upd-1', draining: true, safe: true });
    expect(m.t.services.maintenance.draining).toBe(true);
    // A session command answers `unavailable` meanwhile.
    const mara = await m.enroll(IDS.mara);
    const c = await m.client(mara);
    expect(
      await c.request('messages.send', {
        params: { burrow: 'burrow-hq', conversationId: IDS.general },
        body: { text: 'during drain' },
      }),
    ).toMatchObject({ t: 'error', code: 'unavailable', retryable: true });
    expect((await call('/drain', { ...drain, requestId: 'backup-9', reason: 'backup' })).status).toBe(409);
    expect((await call('/drain', drain)).status).toBe(200);
    expect((await call('/resume', { v: 1, requestId: 'backup-9' })).status).toBe(409);
    const resumed = await call('/resume', { v: 1, requestId: 'upd-1' });
    expect(resumed).toMatchObject({ status: 200, body: { draining: false } });
    expect(m.t.services.maintenance.held).toBeNull();
  });

  it('a lease that isn’t renewed opens the gate by itself', async () => {
    await call('/drain', { v: 1, requestId: 'crashed', reason: 'update', scope: 'all', leaseMs: 1_000 });
    expect(m.t.services.maintenance.draining).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(m.t.services.maintenance.held).toBeNull();
  });

  it('holds new writes at the pipeline under a `writes` barrier until resume', async () => {
    await call('/drain', { v: 1, requestId: 'bk-1', reason: 'backup', scope: 'writes', leaseMs: 60_000 });
    let wrote = false;
    const writing = m.t.services.pipeline.transactAccount(async () => {
      wrote = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(wrote).toBe(false);
    await call('/resume', { v: 1, requestId: 'bk-1' });
    await writing;
    expect(wrote).toBe(true);
  });

  it('sets the claim window and the facts (appliance.status reads them)', async () => {
    expect(
      (
        await call('/claim-window', {
          v: 1,
          required: true,
          openUntil: new Date(Date.now() + 60_000).toISOString(),
        })
      ).status,
    ).toBe(200);
    const facts = await call('/facts', {
      v: 1,
      backup: null,
      update: {
        state: 'Healthy',
        current: 'rel-test-1',
        candidate: null,
        lastCheckedAt: new Date().toISOString(),
        deferredReason: null,
        failure: null,
        clientFloor: { web: 120, android: 0, ios: 0, desktop: 0, cli: 0 },
      },
    });
    expect(facts).toMatchObject({ status: 200, body: { ok: true } });
    // The running tuple's client floor (CT-53) is taken from the update facts.
    expect(m.runtime.trust.clientFloor).toEqual({ web: 120, android: 0, ios: 0, desktop: 0, cli: 0 });
    await m.runtime.trust.setClientFloor(null);
    const owner = await m.enroll(IDS.mara);
    const status = await (await m.client(owner)).request('appliance.status', {});
    expect(status).toMatchObject({
      output: { update: { state: 'Healthy', current: 'rel-test-1' }, backup: { state: 'unprotected' } },
    });
    expect((await call('/facts', { v: 1, backup: 'nope', update: null })).status).toBe(400);
    // The manager reads runtime metadata for control's status report (no content).
    expect(await call('/facts')).toMatchObject({
      status: 200,
      body: {
        v: 1,
        claimed: false,
        recovery: { kitVerified: false },
        revocations: { pending: 0 },
        draining: false,
      },
    });
  });
});

/** `appliance.status`'s `update`, from a session answer. */
function updateOf(answer: { t: string; output?: unknown }): Record<string, unknown> {
  if (answer.t !== 'result') throw new Error(`expected a result: ${JSON.stringify(answer)}`);
  return (answer as { output: { update: Record<string, unknown> } }).output.update;
}

describe('the person’s update facts (MD-18, contracts CT-138)', () => {
  it('passes the failure detail, what an update waits for and the last update through to appliance.status', async () => {
    const since = '2026-09-28T19:00:00Z';
    const update = {
      state: 'Staged',
      current: 'pve-20260928.6',
      candidate: 'pve-20260929.1',
      lastCheckedAt: since,
      deferredReason: 'checkpoint',
      failure: 'schema_incompatible',
      // The 2026-09-28 refusal, as the manager now reports it (codes, ids and numbers only).
      failureDetail: {
        stage: 'Staged',
        code: 'schema_incompatible',
        reasons: ['candidate_cannot_read_schema'],
        release: 'pve-20260928.5',
        schema: { database: 48, target: null, candidateWrites: 49, candidateReads: { min: 49, max: 49 } },
        failedChecks: [],
        at: 1_790_622_000,
      },
      waiting: { reason: 'checkpoint', since, blockers: [{ kind: 'no_destination', count: 1 }] },
      lastUpdate: { release: 'pve-20260928.6', from: 'pve-20260928.4', at: since },
    };
    expect(await call('/facts', { v: 1, backup: null, update })).toMatchObject({ status: 200 });
    const owner = await m.enroll(IDS.mara);
    const status = await (await m.client(owner)).request('appliance.status', {});
    expect(status).toMatchObject({
      t: 'result',
      output: {
        update: {
          state: 'Staged',
          failureDetail: update.failureDetail,
          waiting: { reason: 'checkpoint', blockers: [{ kind: 'no_destination', count: 1 }] },
          lastUpdate: { release: 'pve-20260928.6', from: 'pve-20260928.4' },
        },
      },
    });
    const out = updateOf(status) as { waiting: { since: string }; lastUpdate: { at: string } };
    expect(Date.parse(out.waiting.since)).toBe(Date.parse(since));
    expect(Date.parse(out.lastUpdate.at)).toBe(Date.parse(since));
    // Facts from a manager before 0.22 carry none of them, and appliance.status says nothing about them.
    const { failureDetail: _f, waiting: _w, lastUpdate: _l, ...older } = update;
    expect(await call('/facts', { v: 1, backup: null, update: older })).toMatchObject({ status: 200 });
    const plain = await (await m.client(owner)).request('appliance.status', {});
    const plainUpdate = updateOf(plain);
    expect(plainUpdate).toMatchObject({ state: 'Staged', failure: 'schema_incompatible' });
    for (const k of ['failureDetail', 'waiting', 'lastUpdate']) expect(plainUpdate).not.toHaveProperty(k);
  });
});

describe('ask before updating (ask-before-updating.md)', () => {
  const since = '2026-11-16T08:00:00Z';
  const facts = (extra: Record<string, unknown>) => ({
    v: 1,
    backup: null,
    update: {
      state: 'Staged',
      current: 'pve-20261115.1',
      candidate: 'pve-20261116.1',
      lastCheckedAt: since,
      deferredReason: null,
      failure: null,
      ...extra,
    },
  });

  it('a manager that can’t hold updates offers no switch', async () => {
    expect(await call('/facts', facts({}))).toMatchObject({ status: 200 });
    const c = await m.client(await m.enroll(IDS.mara));
    expect(await c.request('appliance.update.ask', { askFirst: true })).toMatchObject({
      t: 'error',
      code: 'not_implemented',
    });
    expect(m.manager.askFirst).toBe(false);
  });

  it('the owner’s switch and yes reach the manager, signed; a release that no longer waits is refused', async () => {
    expect(await call('/facts', facts({ askFirst: false }))).toMatchObject({ status: 200 });
    const c = await m.client(await m.enroll(IDS.mara));
    expect(await c.request('appliance.update.ask', { askFirst: true })).toMatchObject({
      t: 'result',
      output: { askFirst: true },
    });
    expect(m.manager.askFirst).toBe(true);
    // The manager holds the update for the owner, and appliance.status says so.
    m.manager.ownerWaits = 'pve-20261116.1';
    const waiting = { reason: 'owner', since, blockers: [] };
    expect(await call('/facts', facts({ askFirst: true, waiting }))).toMatchObject({ status: 200 });
    expect(updateOf(await c.request('appliance.status', {}))).toMatchObject({
      askFirst: true,
      candidate: 'pve-20261116.1',
      waiting: { reason: 'owner' },
    });
    expect(await c.request('appliance.update.install', { release: 'pve-20261115.9' })).toMatchObject({
      t: 'error',
      code: 'conflict',
      details: { code: 'update.not_waiting' },
    });
    expect(await c.request('appliance.update.install', { release: 'pve-20261116.1' })).toMatchObject({
      t: 'result',
      output: { release: 'pve-20261116.1' },
    });
    expect(m.manager.approved).toEqual(['pve-20261116.1']);
    const events = await m.t.services.db
      .select()
      .from(applianceEvents)
      .where(inArray(applianceEvents.type, ['update.ask_set', 'update.approved']))
      .orderBy(asc(applianceEvents.seq));
    expect(events.map((e) => [e.type, e.payload])).toEqual([
      ['update.ask_set', { byAccountId: expect.any(String), askFirst: true }],
      ['update.approved', { byAccountId: expect.any(String), release: 'pve-20261116.1' }],
    ]);
  });
});

describe('check for updates (check-for-updates.md)', () => {
  const update = (candidate: string | null) => ({
    v: 1,
    backup: null,
    update: {
      state: candidate ? 'Staged' : 'Healthy',
      current: 'pve-20261115.1',
      candidate,
      lastCheckedAt: null,
      deferredReason: null,
      failure: null,
    },
  });

  it('the owner’s check reaches the manager and says what came of it', async () => {
    expect(await call('/facts', update(null))).toMatchObject({ status: 200 });
    const c = await m.client(await m.enroll(IDS.mara));
    m.manager.checkAnswer = { v: 1, result: 'none', nextCheckS: 3600 };
    expect(await c.request('appliance.update.check', {})).toMatchObject({
      t: 'result',
      output: { outcome: 'upToDate' },
    });
    m.manager.checkAnswer = { v: 1, result: 'assigned', decision: 'started', nextCheckS: 3600 };
    expect(await c.request('appliance.update.check', {})).toMatchObject({ output: { outcome: 'found' } });
    // Nothing newer than the update already under way.
    expect(await call('/facts', update('pve-20261116.1'))).toMatchObject({ status: 200 });
    m.manager.checkAnswer = { v: 1, result: 'unchanged', nextCheckS: 3600 };
    expect(await c.request('appliance.update.check', {})).toMatchObject({
      output: { outcome: 'nothingNewer' },
    });
    m.manager.checkAnswer = { v: 1, result: 'assigned', decision: 'refused', nextCheckS: 3600 };
    expect(await c.request('appliance.update.check', {})).toMatchObject({ output: { outcome: 'refused' } });
    expect(m.manager.checks).toBe(4);
  });

  it('a release list out of reach is unavailable; a manager that can’t check is not_implemented', async () => {
    const c = await m.client(await m.enroll(IDS.mara));
    m.manager.checkAnswer = new ManagerCallError('/v1/update/check', 503, 'unavailable', 'control away');
    expect(await c.request('appliance.update.check', {})).toMatchObject({ t: 'error', code: 'unavailable' });
    m.manager.checkAnswer = new ManagerCallError('/v1/update/check', 404, 'unavailable', 'no checks here');
    expect(await c.request('appliance.update.check', {})).toMatchObject({
      t: 'error',
      code: 'not_implemented',
    });
  });
});

describe('a newer manager’s facts (MD-19)', () => {
  const backup = {
    kind: 'whombat.backup-status/1',
    state: 'protected',
    protected: true,
    destination: { configured: true, kind: 's3', display: 's3.example.com', appendOnly: 'not-enforced' },
    lastSuccess: null,
    lastFailure: null,
    lastAttemptOk: true,
    coverage: [],
    recoverability: { lastDrill: null },
    kitGeneration: 1,
    running: null,
    updatedAt: '2026-09-28T19:00:00Z',
  };
  const update = {
    state: 'Healthy',
    current: 'pve-20260929.1',
    candidate: null,
    lastCheckedAt: '2026-09-28T19:00:00Z',
    deferredReason: null,
    failure: null,
  };

  it('are taken as far as this runtime understands them; an unknown backup state keeps the backup facts it had', async () => {
    expect(await call('/facts', { v: 1, backup, update })).toMatchObject({ status: 200 });
    const owner = await m.enroll(IDS.mara);
    const c = await m.client(owner);
    expect(await c.request('appliance.status', {})).toMatchObject({
      output: { backup: { state: 'protected' }, update: { state: 'Healthy' } },
    });
    // A new wait reason, a new top-level member and a new backup state, all at once (pushed twice: logged once).
    const warn = vi.spyOn(m.t.services.log, 'warn');
    for (let i = 0; i < 2; i++) {
      const newer = await call('/facts', {
        v: 1,
        backup: { ...backup, state: 'replicating' },
        update: {
          ...update,
          state: 'WaitingForSafeBoundary',
          candidate: 'pve-20260930.1',
          waiting: { reason: 'solar_eclipse', since: '2026-09-28T20:00:00Z', blockers: [] },
        },
        maintenanceWindow: { from: '02:00', to: '04:00' },
      });
      expect(newer).toMatchObject({ status: 200, body: { ok: true } });
    }
    const logged = warn.mock.calls.map((c) => c[0] as unknown as { path?: string; kept?: string[] });
    warn.mockRestore();
    expect(logged.filter((l) => l.path === 'backup')).toEqual([
      expect.objectContaining({ path: 'backup', kept: ['backup'] }),
    ]);
    expect(logged.filter((l) => l.path === 'update.waiting')).toHaveLength(1);
    const status = await c.request('appliance.status', {});
    expect(status).toMatchObject({
      output: {
        // Never “unprotected” because of a state this runtime doesn't know: the backup facts it had.
        backup: { state: 'protected' },
        update: { state: 'WaitingForSafeBoundary', candidate: 'pve-20260930.1' },
      },
    });
    expect(updateOf(status)).not.toHaveProperty('waiting');
    // An unknown update state keeps the update facts it had.
    expect(await call('/facts', { v: 1, backup, update: { ...update, state: 'Hibernating' } })).toMatchObject(
      { status: 200 },
    );
    expect(await c.request('appliance.status', {})).toMatchObject({
      output: { update: { state: 'WaitingForSafeBoundary', candidate: 'pve-20260930.1' } },
    });
    // What isn't facts at all is still refused, and changes nothing.
    expect((await call('/facts', { v: 1, backup: 'nope', update: null })).status).toBe(400);
    expect(await c.request('appliance.status', {})).toMatchObject({
      output: { backup: { state: 'protected' }, update: { state: 'WaitingForSafeBoundary' } },
    });
  });
});

describe('manager socket client', () => {
  let server: Server;
  const managerPath = join(dir, 'manager.sock');
  const seen: { path: string; body: unknown }[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        seen.push({ path: req.url ?? '', body });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/v1/runtime/ticket')
          res.end(
            JSON.stringify({
              ticket: 'aaaaaaaaaaaaaaaa.bbbb.cccc',
              relayUrl: 'wss://relay.dev.whombat.com/v1/connect',
              worker: 'w-1',
              expiresAt: '2026-09-25T12:05:00Z',
            }),
          );
        else if (req.url === '/v1/runtime/push')
          res.end(
            JSON.stringify({
              accepted: 1,
              invalidHandles: ['hhhhhhhhhhhhhhhhhhhhhhhhinvalid'],
              rateLimited: false,
            }),
          );
        else if (req.url === '/v1/runtime/revocations') {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: { code: 'unavailable', message: 'control unreachable' } }));
        } else res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(managerPath, () => resolve()));
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('speaks the contract both ways', async () => {
    const client = new ManagerSocketClient(managerPath);
    expect(await client.ticket('interactive')).toMatchObject({ worker: 'w-1' });
    await client.reportClaimed({ claimId: 'clm_test_0001', claimedAt: '2026-09-25T12:00:00.000Z' });
    await expect(
      client.reportRevocation({
        peerId: '12D3KooWDx1NHu9Mv4arCv533dfNXwqLdKU2Bmk1W4SJMHF2QaLF',
        revokedAt: '2026-09-25T12:00:00.000Z',
      }),
    ).rejects.toThrow(/503/);
    RuntimeTicketRequest.parse(seen[0]?.body);
    RuntimeClaimedRequest.parse(seen[1]?.body);
  });

  it('turns a notification into a push request for the recipient’s handles: opaque refs, a preview', async () => {
    const mara = await m.enroll(IDS.mara);
    await m.t.services.db
      .update(applianceEndpoints)
      .set({ pushHandle: 'hhhhhhhhhhhhhhhhhhhhhhhhinvalid' })
      .where(eq(applianceEndpoints.id, mara.endpointId));
    const before = m.manager.pushes.length;
    await notify(m.t.services, [marasMention('Mara, the secret launch date is Friday')]);
    await m.t.services.background.settle();
    const pushes = m.manager.pushes.slice(before);
    expect(pushes.length).toBeGreaterThanOrEqual(1);
    const request = RuntimePushRequest.parse(pushes[0]);
    expect(request).toMatchObject({
      kind: 'mention',
      handles: ['hhhhhhhhhhhhhhhhhhhhhhhhinvalid'],
      preview: { title: 'Dusty mentioned you in #general', body: 'Mara, the secret launch date is Friday' },
    });
    // The ref and the collapse key are hashes: nothing but the preview says what it is about.
    const { preview: _preview, ...rest } = request;
    expect(JSON.stringify(rest)).not.toMatch(/secret|launch|general|Mara|thread|notification/);
    expect(request.collapseKey).not.toBe(request.ref);
  });

  it('one collapse key per group, a ref per notification (NT-15)', async () => {
    const before = m.manager.pushes.length;
    await notify(m.t.services, [
      { ...marasMention('one'), group: `thread:${IDS.general}:main` },
      { ...marasMention('two'), group: `thread:${IDS.general}:main` },
      { ...marasMention('three'), group: `thread:${IDS.general}:msg_other` },
    ]);
    await m.t.services.background.settle();
    const [a, b, c] = m.manager.pushes.slice(before);
    expect(a?.collapseKey).toBe(b?.collapseKey);
    expect(a?.ref).not.toBe(b?.ref);
    expect(c?.collapseKey).not.toBe(a?.collapseKey);
  });

  it('previews off: no preview reaches control (NT-14)', async () => {
    const accountId = await accountOf(m.t.services, IDS.mara);
    const notifications = (on: boolean) => ({
      dndUntil: null,
      schedule: { enabled: false, start: '22:00', end: '08:00', days: [] },
      email: 'hourly' as const,
      threadReplies: true,
      previews: on,
    });
    await updatePreferences(m.t.services, accountId, { notifications: notifications(false) });
    try {
      const before = m.manager.pushes.length;
      await notify(m.t.services, [marasMention('the secret launch date is Friday')]);
      await m.t.services.background.settle();
      const [request] = m.manager.pushes.slice(before);
      expect(request).toBeDefined();
      expect(request?.preview).toBeUndefined();
      expect(JSON.stringify(request)).not.toMatch(/secret|launch|Friday/);
    } finally {
      await updatePreferences(m.t.services, accountId, { notifications: notifications(true) });
    }
  });

  it('a decided approval clears its notification once (NT-16)', async () => {
    const approval = {
      id: 'approval_clear_test',
      number: 42,
      state: 'approved',
      conditions: [{ id: 'person', kind: 'person_approves', approverIds: [IDS.mara], met: true, label: 'x' }],
    } as never;
    const before = m.manager.pushes.length;
    await clearDecidedApproval(
      m.t.services,
      { ...(approval as object), state: 'pending' } as never,
      'burrow-hq',
    );
    expect(m.manager.pushes.slice(before)).toEqual([]);
    await clearDecidedApproval(m.t.services, approval, 'burrow-hq');
    await clearDecidedApproval(m.t.services, approval, 'burrow-hq');
    const sent = m.manager.pushes.slice(before);
    expect(sent).toHaveLength(1);
    expect(RuntimePushRequest.parse(sent[0])).toMatchObject({ kind: 'approval', clear: true });
    expect(sent[0]?.preview).toBeUndefined();
    expect(sent[0]?.collapseKey).toBe(opaqueRef('collapse', 'approval:approval_clear_test'));
  });

  it('reading a thread’s notifications clears it from the phone once nothing there is unread (RF-09)', async () => {
    const mara = await m.enroll(IDS.mara);
    await m.t.services.db
      .update(applianceEndpoints)
      .set({ pushHandle: 'hhhhhhhhhhhhhhhhhhhhhhhthreads' })
      .where(eq(applianceEndpoints.id, mara.endpointId));
    const post = async (text: string, threadRootId?: string) => {
      const res = await m.t.commit(IDS.dusty, sendMessage, {
        conversationId: IDS.billing,
        text,
        ...(threadRootId ? { threadRootId } : {}),
      });
      if (res.status !== 'ok') throw new Error('send failed');
      return res.result.id;
    };
    const root = await post('The PDF thread');
    const first = await post('@Mara one thing', root);
    const second = await post('@Mara and another', root);
    const rows = await m.t.services.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.principalId, IDS.mara), isNull(notifications.readAt)));
    const idOf = (messageId: string) => rows.find((r) => r.messageId === messageId)?.id as string;
    expect(idOf(first) && idOf(second)).toBeTruthy();
    const clears = (from: number) => m.manager.pushes.slice(from).filter((p) => p.clear === true);
    const before = m.manager.pushes.length;
    // One still unread in the thread: its notification stays.
    await markNotificationsRead(m.t.services, IDS.mara, { ids: [idOf(first)] });
    expect(clears(before)).toEqual([]);
    await markNotificationsRead(m.t.services, IDS.mara, { ids: [idOf(second)] });
    await vi.waitFor(() => expect(clears(before)).toHaveLength(1));
    const [clear] = clears(before);
    expect(RuntimePushRequest.parse(clear)).toMatchObject({ kind: 'mention', clear: true });
    expect(clear?.preview).toBeUndefined();
    expect(clear?.collapseKey).toBe(opaqueRef('collapse', `thread:${IDS.billing}:${root}`));
    // Read again, or everything with nothing new: no more clears.
    await markNotificationsRead(m.t.services, IDS.mara, { ids: [idOf(second)] });
    await markNotificationsRead(m.t.services, IDS.mara, { all: true });
    expect(clears(before)).toHaveLength(1);
  });

  it('an older manager (contracts 0.50): the request again without its preview, a clear dropped (NT-18)', async () => {
    m.manager.before051 = true;
    try {
      const before = m.manager.pushes.length;
      await notify(m.t.services, [marasMention('hello there')]);
      await m.t.services.background.settle();
      const sent = m.manager.pushes.slice(before);
      expect(sent).toHaveLength(1);
      expect(sent[0]).not.toHaveProperty('preview');
      expect(sent[0]?.kind).toBe('mention');
      await clearDecidedApproval(
        m.t.services,
        {
          id: 'approval_clear_old',
          number: 43,
          state: 'declined',
          conditions: [
            { id: 'person', kind: 'person_approves', approverIds: [IDS.mara], met: false, label: 'x' },
          ],
        } as never,
        'burrow-hq',
      );
      expect(m.manager.pushes.slice(before)).toHaveLength(1);
    } finally {
      m.manager.before051 = false;
    }
  });
});
