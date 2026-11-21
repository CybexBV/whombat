/**
 * Backup options, the list and bringing a Whombat back (backup-options.md BKO-02…BKO-13) against a fake backup service
 * and manager: what each op asks of them and what the person gets back. Needs Postgres for the receipts and the
 * session.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { IDS } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import type { BackupPort } from './backup';

const m = useManagedRuntime({ seed: true });
const calls: { method: string; path: string; body: unknown }[] = [];
let answer: (method: string, path: string) => { status: number; body: unknown } = () => ({
  status: 404,
  body: null,
});
const fake: BackupPort = {
  async call(method, path, body) {
    calls.push({ method, path, body });
    return answer(method, path);
  },
};
const manager = { restores: [] as string[], restarted: 0 };
let owner: Awaited<ReturnType<typeof m.enroll>>;

const checkpoint = (over: Record<string, unknown>) => ({
  id: 'ck-1',
  seq: 1,
  snapshotId: 'aaaa',
  createdAt: '2026-11-04T03:00:00Z',
  reason: 'scheduled',
  schemaVersion: 120,
  bytes: 3_600_000_000,
  bytesAdded: 41_000_000,
  applianceId: 'wb-home',
  own: true,
  check: null,
  ...over,
});
const POLICY = {
  v: 1,
  frequency: '6h',
  timeZone: 'UTC',
  keep: { allDays: 2, dailyDays: 14, weeklyWeeks: 8, monthlyMonths: 12 },
  limitBytes: null,
  weeklyCheck: true,
};

beforeAll(async () => {
  m.runtime.dispatcher.backup = fake;
  m.runtime.dispatcher.manager = {
    ...m.runtime.manager,
    backupRestore: async (id: string) => {
      manager.restores.push(id);
    },
    backupRestored: async () => {
      manager.restarted++;
    },
  };
  owner = await m.enroll(IDS.mara);
});

afterEach(() => {
  calls.length = 0;
});

describe('the list and the options', () => {
  it('lists the backups, says who clears them, and sets every option at once in the person’s zone', async () => {
    const c = await m.client(owner);
    let saved: unknown = POLICY;
    answer = (method, path) => {
      if (path === '/v1/checkpoints')
        return {
          status: 200,
          body: {
            checkpoints: [checkpoint({}), checkpoint({ id: 'ck-0', own: false })],
            unauthentic: 0,
            local: null,
          },
        };
      if (path === '/v1/policy' && method === 'GET') return { status: 200, body: saved };
      if (path === '/v1/policy' && method === 'PUT') {
        saved = calls.at(-1)?.body;
        return { status: 200, body: saved };
      }
      if (path === '/v1/drills') return { status: 202, body: { queued: true } };
      return { status: 404, body: null };
    };
    const list = await c.request('backup.checkpoints', {});
    expect(list).toMatchObject({
      t: 'result',
      output: { checkpoints: [{ id: 'ck-1' }, { id: 'ck-0' }], space: null },
    });
    expect(await c.request('backup.policy', {})).toMatchObject({
      t: 'result',
      output: { policy: { frequency: '6h' } },
    });
    const set = await c.request('backup.setPolicy', {
      frequency: 'hourly',
      keep: { allDays: 90, dailyDays: 0, weeklyWeeks: 0, monthlyMonths: 0 },
      limitBytes: 50_000_000_000,
      weeklyCheck: false,
    });
    expect(set).toMatchObject({
      t: 'result',
      output: { policy: { frequency: 'hourly', weeklyCheck: false } },
    });
    const put = calls.find((x) => x.method === 'PUT' && x.path === '/v1/policy');
    expect(put?.body).toMatchObject({ v: 1, frequency: 'hourly', limitBytes: 50_000_000_000 });
    expect(typeof (put?.body as { timeZone?: unknown } | undefined)?.timeZone).toBe('string');
    // A check names whose key the backup is under.
    expect(await c.request('backup.check', { checkpointId: 'ck-0' })).toMatchObject({ t: 'result' });
    expect(calls.find((x) => x.path === '/v1/drills')?.body).toEqual({ checkpointId: 'ck-0', own: false });
    expect(await c.request('backup.check', { checkpointId: 'ck-9' })).toMatchObject({
      t: 'error',
      details: { code: 'backup_gone' },
    });
  });

  it('a backup service from before answers as an unknown op would', async () => {
    const c = await m.client(owner);
    answer = () => ({ status: 404, body: null });
    expect(await c.request('backup.checkpoints', {})).toMatchObject({ t: 'error', code: 'not_implemented' });
  });

  it('moves or removes the backups left on the box’s own disk', async () => {
    const c = await m.client(owner);
    answer = (method, path) =>
      path === '/v1/local/copy'
        ? { status: 200, body: { copied: 14 } }
        : path === '/v1/local' && method === 'DELETE'
          ? { status: 200, body: { ok: true } }
          : { status: 404, body: null };
    expect(await c.request('backup.moveLocal', {})).toMatchObject({ t: 'result', output: { copied: 14 } });
    expect(await c.request('backup.removeLocal', {})).toMatchObject({ t: 'result', output: { ok: true } });
  });
});

describe('bringing a Whombat back', () => {
  const material = {
    kind: 'whombat.backup-recovery-material/1',
    applianceId: 'wb-home',
    generation: 2,
    createdAt: '2026-11-03T17:52:00Z',
    repository: 'rest:http://10.100.1.20:8747/wb-home/',
    restUser: 'wb-home',
    restPassword: 'rest-secret',
    repositoryPassword: 'repo-secret',
    repositoryId: 'r1',
    manifestKey: 'ed25519:AAAA',
  };
  const kit = `WHOMBAT RECOVERY KIT\nBackup section for whombat-backup (save the next line as kit.json):\n${JSON.stringify(material)}\n`;

  it('adopts the kit’s backups, starts the restore and finishes it with the person’s answers', async () => {
    const c = await m.client(owner);
    let phase = 'none';
    const resolved: string[] = [];
    answer = (_method, path) => {
      if (path === '/v1/adopt')
        return {
          status: 200,
          body: { oldApplianceId: 'wb-home', checkpoints: [checkpoint({ own: false })] },
        };
      if (path === '/v1/quarantine')
        return {
          status: 200,
          body: {
            phase,
            stage: null,
            since: null,
            error: null,
            restored:
              phase === 'checking'
                ? { checkpointId: 'ck-1', createdAt: '2026-11-04T03:00:00Z', schemaVersion: 120 }
                : null,
            oldApplianceId: phase === 'checking' ? 'wb-home' : null,
            relogin: phase === 'checking' ? ['acc/claude'] : [],
            servers: null,
            items: [
              'old-appliance',
              'revocations',
              'endpoints',
              'provider-logins',
              'external-outcomes',
              'identity-repin',
              'backup-destination',
            ].map((id) => ({
              id,
              required: id !== 'backup-destination',
              resolution: resolved.includes(id) ? 'x' : null,
            })),
          },
        };
      if (path === '/v1/quarantine/resolve') {
        resolved.push((calls.at(-1)?.body as { item: string } | undefined)?.item ?? '');
        return { status: 200, body: {} };
      }
      if (path === '/v1/quarantine/release') {
        phase = 'released';
        return { status: 200, body: {} };
      }
      return { status: 404, body: null };
    };
    expect(await c.request('backup.adopt', { kit: 'not a kit' })).toMatchObject({
      t: 'error',
      details: { code: 'backup_kit_invalid' },
    });
    const adopted = await c.request('backup.adopt', { kit });
    expect(adopted).toMatchObject({
      t: 'result',
      output: { oldApplianceId: 'wb-home', checkpoints: [{ id: 'ck-1' }] },
    });
    expect(calls.find((x) => x.path === '/v1/adopt')?.body).toEqual({ material });
    expect(await c.request('backup.restore', { checkpointId: 'ck-1' })).toMatchObject({ t: 'result' });
    expect(manager.restores).toEqual(['ck-1']);
    expect(
      await c.request('backup.finishRestore', {
        oldWhombat: 'lost',
        signInsChecked: true,
        devicesReviewed: true,
      }),
    ).toMatchObject({
      t: 'error',
      details: { code: 'backup_no_restore' },
    });
    phase = 'checking';
    const done = await c.request('backup.finishRestore', {
      oldWhombat: 'lost',
      signInsChecked: true,
      devicesReviewed: true,
    });
    expect(done).toMatchObject({ t: 'result', output: { phase: 'released' } });
    expect(resolved).toEqual(expect.arrayContaining(['old-appliance', 'identity-repin', 'provider-logins']));
    const old = calls.find(
      (x) => x.path === '/v1/quarantine/resolve' && (x.body as { item: string }).item === 'old-appliance',
    );
    expect((old?.body as { resolution: string } | undefined)?.resolution).toBe('credentials-rotated');
    expect(manager.restarted).toBe(1);
  });
});

describe('backups v2 (backup-options.md BKO-S06…)', () => {
  const restoreState = (phase: string, since: string, resolved: readonly string[]) => ({
    phase,
    stage: null,
    since,
    error: null,
    restored:
      phase === 'checking'
        ? { checkpointId: 'ck-7', createdAt: '2026-11-04T03:00:00Z', schemaVersion: 120 }
        : null,
    oldApplianceId: phase === 'checking' ? 'wb-home' : null,
    relogin: [],
    servers: null,
    items: ['old-appliance', 'revocations', 'endpoints', 'provider-logins', 'identity-repin'].map((id) => ({
      id,
      required: true,
      resolution: resolved.includes(id) ? 'x' : null,
    })),
  });

  it('finishing a restore can be tried again: answers once, the restart asked again until it happens', async () => {
    const c = await m.client(owner);
    const since = '2026-11-04T10:00:00Z';
    let phase = 'checking';
    // One item answered by an earlier try that stopped half-way.
    const resolved: string[] = ['old-appliance'];
    answer = (_method, path) => {
      if (path === '/v1/quarantine') return { status: 200, body: restoreState(phase, since, resolved) };
      if (path === '/v1/quarantine/resolve') {
        resolved.push((calls.at(-1)?.body as { item?: string } | undefined)?.item ?? '');
        return { status: 200, body: {} };
      }
      if (path === '/v1/quarantine/release') {
        phase = 'released';
        return { status: 200, body: {} };
      }
      return { status: 404, body: null };
    };
    let failRestart = true;
    const restarts: number[] = [];
    m.runtime.dispatcher.manager = {
      ...m.runtime.manager,
      backupRestored: async () => {
        restarts.push(Date.now());
        if (failRestart) throw new Error('manager busy');
      },
    };
    // The one question: no checks of sign-ins or devices any more.
    const first = await c.request('backup.finishRestore', { oldWhombat: 'gone' });
    expect(first).toMatchObject({ t: 'error', details: { code: 'backup_restart_failed' } });
    // The item answered before isn't answered again; the release went with what the service may use.
    const resolves = calls
      .filter((x) => x.path === '/v1/quarantine/resolve')
      .map((x) => (x.body as { item: string }).item);
    expect(resolves).not.toContain('old-appliance');
    expect(calls.find((x) => x.path === '/v1/quarantine/release')?.body).toEqual({
      oldWhombat: 'gone',
      checkpointId: 'ck-7',
    });
    // Released already: trying again asks only for the restart, once it works, and not after.
    failRestart = false;
    calls.length = 0;
    expect(await c.request('backup.finishRestore', { oldWhombat: 'gone' })).toMatchObject({
      t: 'result',
      output: { phase: 'released' },
    });
    expect(
      calls.some((x) => x.path === '/v1/quarantine/resolve' || x.path === '/v1/quarantine/release'),
    ).toBe(false);
    expect(await c.request('backup.finishRestore', { oldWhombat: 'gone' })).toMatchObject({ t: 'result' });
    expect(restarts).toHaveLength(2);
  });

  it('lost or stolen notes the new password the place needs (given once the box runs normally again)', async () => {
    const c = await m.client(owner);
    let phase = 'checking';
    answer = (_method, path) => {
      if (path === '/v1/quarantine')
        return { status: 200, body: restoreState(phase, '2026-11-04T11:00:00Z', []) };
      if (path === '/v1/quarantine/release') {
        phase = 'released';
        return { status: 200, body: {} };
      }
      return { status: path === '/v1/quarantine/resolve' ? 200 : 404, body: {} };
    };
    expect(await c.request('backup.finishRestore', { oldWhombat: 'lost' })).toMatchObject({ t: 'result' });
    const { loadBoxBackupNotes } = await import('../backup-places/notes');
    expect((await loadBoxBackupNotes(m.t.services.db)).rotate).toMatchObject({ tries: 0 });
  });

  it('pages a list far past what one answer held before, and adopt answers its first page', async () => {
    const c = await m.client(owner);
    const many = Array.from({ length: 2000 }, (_, i) =>
      checkpoint({
        id: `ck-${i}`,
        seq: i,
        createdAt: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString().replace('.000', ''),
        covered: ['database', 'servers'],
      }),
    );
    answer = (_method, path) =>
      path === '/v1/checkpoints'
        ? { status: 200, body: { checkpoints: many, unauthentic: 0, local: null } }
        : path === '/v1/adopt'
          ? { status: 200, body: { oldApplianceId: 'wb-home', checkpoints: many } }
          : { status: 404, body: null };
    const first = (await c.request('backup.checkpoints', {})) as unknown as {
      output: { checkpoints: { id: string; covered?: string[] }[]; total: number; nextCursor: string };
    };
    expect(first.output.total).toBe(2000);
    expect(first.output.checkpoints).toHaveLength(50);
    // Newest first, with what each covers.
    expect(first.output.checkpoints[0]).toMatchObject({ id: 'ck-1999', covered: ['database', 'servers'] });
    const next = (await c.request('backup.checkpoints', {
      cursor: first.output.nextCursor,
      limit: 150,
    })) as unknown as {
      output: { checkpoints: { id: string }[]; nextCursor: string | null };
    };
    expect(next.output.checkpoints[0]?.id).toBe('ck-1949');
    expect(next.output.checkpoints).toHaveLength(150);
    // Adopt (a command, so one session message): its first page; `replace` passes the person's yes on.
    const material = {
      kind: 'whombat.backup-recovery-material/1',
      applianceId: 'wb-home',
      generation: 2,
      createdAt: '2026-11-03T17:52:00Z',
      repository: 'rest:http://10.100.1.20:8747/wb-home/',
      repositoryPassword: 'repo-secret',
      repositoryId: 'r1',
      manifestKey: 'ed25519:AAAA',
    };
    const adopted = (await c.request('backup.adopt', {
      kit: JSON.stringify(material),
      replace: true,
    })) as unknown as {
      t: string;
      output: { checkpoints: unknown[]; total: number; nextCursor: string | null };
    };
    expect(adopted).toMatchObject({ t: 'result', output: { total: 2000 } });
    expect(adopted.output.checkpoints).toHaveLength(50);
    expect(adopted.output.nextCursor).toBeTruthy();
    expect(calls.find((x) => x.path === '/v1/adopt')?.body).toEqual({ material, replace: true });
  });

  it('the overview answers the Backups page in one request, and says plainly when the service is silent', async () => {
    const c = await m.client(owner);
    const { BackupServiceDown } = await import('./backup-port');
    const { useBoxBackup } = await import('./box-backup');
    useBoxBackup(m.t.services, { port: fake, status: () => null });
    answer = (method, path) => {
      if (path === '/v1/checkpoints')
        return { status: 200, body: { checkpoints: [checkpoint({})], unauthentic: 0, local: null } };
      if (path === '/v1/policy' && method === 'GET') return { status: 200, body: POLICY };
      return { status: 404, body: null };
    };
    const overview = await c.request('backup.overview', {});
    expect(overview).toMatchObject({
      t: 'result',
      output: {
        checkpoints: { checkpoints: [{ id: 'ck-1' }], total: 1 },
        policy: { policy: { frequency: '6h' }, clearedBy: 'none' },
        summary: { state: 'unprotected' },
        notice: null,
        earlierPlaces: [],
      },
    });
    answer = () => {
      throw new BackupServiceDown('unreachable');
    };
    const silent = (await c.request('backup.overview', {})) as unknown as {
      t: string;
      output: Record<string, unknown>;
    };
    expect(silent.t).toBe('result');
    // Where backups go isn't known: no word about older ones elsewhere.
    expect(silent.output).toMatchObject({ checkpoints: null, policy: null, status: null, earlierPlaces: [] });
    expect(String(silent.output.notice)).toContain('isn’t answering');
  });

  it('“Let the assistant set it up” is kept as the person’s yes, and the Inbox holds its proposal back', async () => {
    const c = await m.client(owner);
    answer = () => ({ status: 404, body: null });
    expect(await c.request('backup.letAssistantSetUp', { placeId: 'server:blackbox' })).toMatchObject({
      t: 'result',
      output: { ok: true },
    });
    const { loadBoxBackupNotes } = await import('../backup-places/notes');
    expect((await loadBoxBackupNotes(m.t.services.db)).consent).toMatchObject({
      placeId: 'server:blackbox',
      state: 'waiting',
    });
  });

  it('a bring back a restart stopped can be tried again, and the Inbox says so in plain words, alone', async () => {
    const { boxBackupNeedsYou } = await import('../home/box-backup');
    const { useBoxBackup } = await import('./box-backup');
    const since = new Date(Date.now() - 60_000).toISOString();
    const plain =
      'This Whombat restarted before the restore finished, so it was put back as it was. Try again.';
    const technical = 'apply: rename /persist/db: input/output error';
    useBoxBackup(m.t.services, {
      port: fake,
      status: () => ({
        kind: 'whombat.backup-status/1',
        state: 'unprotected',
        protected: false,
        destination: { configured: false },
        lastSuccess: null,
        lastFailure: null,
        lastAttemptOk: null,
        failedAttempts: 0,
        coverage: [],
        recoverability: { lastDrill: null },
        kitGeneration: 0,
        running: null,
        updatedAt: new Date().toISOString(),
      }),
    });
    answer = (_m, path) =>
      path === '/v1/quarantine'
        ? {
            status: 200,
            body: { ...restoreState('interrupted', since, []), error: plain, detail: technical, items: [] },
          }
        : { status: 404, body: null };
    const c = await m.client(owner);
    const state = await c.request('backup.restoreState', {});
    expect(state).toMatchObject({
      t: 'result',
      output: { phase: 'failed', reason: 'interrupted', error: plain },
    });
    expect(JSON.stringify(state)).not.toContain(technical);
    // Tried again: nothing refuses it.
    const restores: string[] = [];
    m.runtime.dispatcher.manager = {
      ...m.runtime.manager,
      backupRestore: async (id: string) => {
        restores.push(id);
      },
    };
    expect(await c.request('backup.restore', { checkpointId: 'ck-7' })).toMatchObject({ t: 'result' });
    expect(restores).toEqual(['ck-7']);
    // The Inbox's one backup item is the stopped bring back, not also the proposal of a place.
    const items = await boxBackupNeedsYou({
      db: m.t.services.db,
      burrowId: 'b',
      personId: IDS.mara,
      now: new Date(),
      services: m.t.services,
    });
    expect(items).toEqual([
      expect.objectContaining({ ref: { kind: 'backup', id: `restore-stopped:${since}` }, body: plain }),
    ]);
  });

  it('a restored box tells the person it is back, once, and the Inbox says what is left', async () => {
    const { tellRestoreDone } = await import('./restore-notice');
    const { boxRestoreNeedsYou } = await import('../home/box-backup');
    const { useBoxBackup } = await import('./box-backup');
    useBoxBackup(m.t.services, { port: fake, status: () => null });
    const since = '2026-11-04T12:00:00Z';
    answer = (_m, path) =>
      path === '/v1/quarantine'
        ? { status: 200, body: restoreState('checking', since, []) }
        : { status: 404, body: null };
    const pushed: { kind: string; what: string; quarantine: boolean }[] = [];
    const push = {
      notice: async (
        kind: 'security' | 'backup',
        _ids: readonly string[],
        what: string,
        _n: unknown,
        o?: { evenInQuarantine?: boolean },
      ) => {
        pushed.push({ kind, what, quarantine: o?.evenInQuarantine === true });
      },
    };
    // Not quarantined: nothing to tell.
    expect(await tellRestoreDone(m.t.services, fake, push)).toBe('none');
    m.t.services.maintenance.quarantined = true;
    try {
      expect(await tellRestoreDone(m.t.services, fake, push)).toBe('told');
      expect(await tellRestoreDone(m.t.services, fake, push)).toBe('none');
      expect(pushed).toEqual([{ kind: 'backup', what: `restore-done:${since}`, quarantine: true }]);
      const items = await boxRestoreNeedsYou({
        db: m.t.services.db,
        burrowId: 'b',
        personId: IDS.mara,
        now: new Date(),
        services: m.t.services,
      });
      expect(items).toEqual([
        expect.objectContaining({ kind: 'backup', ref: { kind: 'backup', id: `restore:${since}` } }),
      ]);
    } finally {
      m.t.services.maintenance.quarantined = false;
    }
  });
});
