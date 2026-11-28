/**
 * Restore tests end to end against the fake hosts service (docs/decisions/backup-trust.md): *Test one now* restores a
 * machine's newest backup as a copy in the copies' range, pulls its network cables, renames and tags it before it
 * starts, waits until it runs and its guest agent answers, then stops and deletes it, and the real machine is only
 * read. A copy that doesn't start raises one problem for the machine. The What's protected page and the machine's page
 * show the result. A machine at the copy's number that doesn't carry the test's marker is never changed, started,
 * stopped or deleted, and a copy whose backup uses parts of the server is deleted without starting. Postgres because
 * every step is a signed commit the runtime picks up again after a restart, and the sweep reads the tests back.
 */
import { RESTORE_TEST_FAILED_HINT, RESTORE_TEST_TAG } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { restoreTests } from '../db/schema/index';
import { startHosts } from '../hosts/index';
import { hostsFor } from '../hosts/service';
import { FakeHostsService, problem } from '../hosts/testing/fake';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { eventually } from '../test/collab';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { RestoreTests, restoreTestsFor } from './runner';

const fake = new FakeHostsService();
const t = useTestServer({
  seed: true,
  listen: true,
  env: { WHOMBAT_HOSTS_SOCKET: fake.socket, WHOMBAT_HOSTS_TOKEN_FILE: fake.tokenFile },
});
let cookie = '';

function request(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  return t.api.inject({
    method,
    url: `/api/v1/burrows/burrow-hq${url}`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
}

/** A Proxmox VM of shale's with a backup, its guest agent answering. */
function realMachine(): { id: string; name: string } {
  const g = fake
    .guestsOf('shale')
    .find(
      (x) =>
        x.platform === 'pve' && x.kind === 'vm' && x.last_backup && x.template !== true && x.self !== true,
    );
  if (!g) throw new Error('no machine with a backup on shale');
  g.guest_agent = 'running';
  return { id: String(g.id), name: String(g.name) };
}

async function testRow() {
  const [row] = await t.services.db
    .select()
    .from(restoreTests)
    .where(eq(restoreTests.burrowId, TEST_BURROW_ID))
    .orderBy(restoreTests.startedAt);
  return row;
}

async function latest() {
  const rows = await t.services.db
    .select()
    .from(restoreTests)
    .where(eq(restoreTests.burrowId, TEST_BURROW_ID));
  return rows.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
}

const runner = () => restoreTestsFor(t.services);

const COPY = 'pve:990000';
const COPY_PATH = `/api/v1/servers/shale/guests/${COPY}`;

/** The calls that would change, start, stop or delete the machine at the copy's first number. */
function touches(): number {
  return (
    fake.calls('PUT', `${COPY_PATH}/config`).length +
    fake.calls('POST', `${COPY_PATH}/actions`).length +
    fake.calls('DELETE', COPY_PATH).length
  );
}

/** A person's own machine at the copy's first number. */
function personsMachine(): void {
  fake.configs.delete(`shale/${COPY}`);
  if (!fake.guest('shale', COPY))
    fake.addGuest('shale', {
      id: COPY,
      vmid: 990000,
      name: 'scratch',
      platform: 'pve',
      kind: 'vm',
      state: 'running',
    });
}

/** How the restore call answers in a test (null: as Proxmox does). */
let restoreAnswer: 'refused' | 'lost' | null = null;

/** Runs passes until the newest test is finished. */
async function finished() {
  return eventually(async () => {
    await runner().pass();
    const row = await latest();
    expect(row?.finishedAt).toBeTruthy();
    return row;
  });
}

beforeAll(async () => {
  await fake.start();
  cookie = (await sessionFor(t.services, IDS.mara)).cookie;
  startHosts(t.services);
  // The home jobs start it with the runtime; here only its problems are needed.
  runner().start();
  fake.manage.taskMs = 5;
  // A person makes a machine at the number the test chose, just as the restore is asked for.
  fake.on('POST', '/api/v1/servers/shale/backups/restore', () => {
    if (!restoreAnswer) return null;
    personsMachine();
    return restoreAnswer === 'refused'
      ? problem(409, 'platform_error', 'TASK ERROR: unable to restore')
      : problem(503, 'unavailable', 'The agent didn’t answer.');
  });
});

afterAll(async () => {
  runner().close();
  await fake.stop();
});

describe('restore tests (backup-trust.md)', () => {
  it('test a machine’s newest backup on a copy with its network off, then delete the copy', async () => {
    const real = realMachine();
    const realPath = `/api/v1/servers/shale/guests/${real.id}`;
    const on = await request('PUT', '/restore-tests/shale', { on: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ on: true, guests: [] });
    expect(on.json().eligible.map((g: { id: string }) => g.id)).toContain(real.id);

    // The copy's settings as Proxmox restores them: the real machine's network card, starting with the server.
    const copyConfig = fake.configOf('shale', 'pve:990000');
    Object.assign(copyConfig.values, { net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr0', onboot: '1' });

    const run = await request('POST', '/restore-tests/shale/run', { guest: real.id });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json().running).toMatchObject({ guestId: real.id });
    expect((await request('POST', '/restore-tests/shale/run', {})).statusCode).toBe(409);

    // Restored into the copies' range; marked as this test's copy, its cables pulled and its name changed before it
    // was asked to start.
    const booting = await eventually(async () => {
      await runner().pass();
      const row = await testRow();
      expect(row?.step).toBe('booting');
      return row;
    });
    expect(booting).toMatchObject({ copyId: 990000, guestId: real.id, agentExpected: true });
    expect(copyConfig.values.net0).toContain('link_down=1');
    expect(copyConfig.values).toMatchObject({
      name: `whombat-test-of-${real.name}`,
      onboot: '0',
      description: `whombat-${booting?.id}`,
    });
    expect(copyConfig.values.tags).toContain(RESTORE_TEST_TAG);
    const puts = fake.calls('PUT', `${COPY_PATH}/config`);
    expect(puts).toHaveLength(2);
    const start = fake.calls('POST', `${COPY_PATH}/actions`)[0];
    expect(start?.body).toMatchObject({ action: 'start' });
    const order = (r: (typeof puts)[number] | undefined) => (r ? fake.requests.indexOf(r) : -1);
    expect(order(puts[0])).toBeGreaterThanOrEqual(0);
    expect(order(puts[0])).toBeLessThan(order(start));

    // Running, and its guest agent answers: it worked; then it is stopped and deleted.
    await eventually(() => expect(fake.guest('shale', 'pve:990000')?.state).toBe('running'));
    const copy = fake.guest('shale', 'pve:990000');
    if (copy) copy.guest_agent = 'running';
    const done = await eventually(async () => {
      await runner().pass();
      const row = await testRow();
      expect(row?.finishedAt).toBeTruthy();
      return row;
    });
    expect(done).toMatchObject({ outcome: 'worked', booted: true, step: 'done' });
    expect(fake.guest('shale', 'pve:990000')).toBeNull();

    // The real machine was only read.
    for (const method of ['PUT', 'POST', 'DELETE'] as const) {
      expect(fake.calls(method, realPath)).toHaveLength(0);
      expect(fake.calls(method, `${realPath}/config`)).toHaveLength(0);
      expect(fake.calls(method, `${realPath}/actions`)).toHaveLength(0);
    }

    // The machine's page and What's protected say so.
    const page = await request('GET', `/hosts/servers/shale/guests/${encodeURIComponent(real.id)}`);
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().restoreTest).toMatchObject({ outcome: 'worked', booted: true });
    const view = await request('GET', '/protected');
    expect(view.statusCode, view.body).toBe(200);
    const row = view.json().rows.find((r: { guestId?: string }) => r.guestId === real.id);
    expect(row).toMatchObject({ kind: 'vm', on: expect.any(String), restoreTest: { outcome: 'worked' } });
    expect(view.json().restoreTests.find((s: { serverId: string }) => s.serverId === 'shale')).toMatchObject({
      on: true,
      running: null,
      last: { guestId: real.id, outcome: 'worked' },
    });
  });

  it('a copy that won’t start raises one problem for the machine, and the copy still goes', async () => {
    const real = realMachine();
    fake.on('POST', '/api/v1/servers/shale/guests/pve:990000/actions', (r) =>
      (r.body as { action?: string })?.action === 'start'
        ? problem(409, 'platform_error', 'TASK ERROR: start failed')
        : null,
    );
    const run = await request('POST', '/restore-tests/shale/run', { guest: real.id });
    expect(run.statusCode, run.body).toBe(200);
    const done = await eventually(async () => {
      await runner().pass();
      const row = await latest();
      expect(row?.finishedAt).toBeTruthy();
      return row;
    });
    expect(done).toMatchObject({ outcome: 'failed', reason: 'start_failed' });
    expect(fake.guest('shale', 'pve:990000')).toBeNull();
    await runner().pass();
    hostsFor(t.services).forget('fleet');
    const hints = (await hostsFor(t.services).fleet()).hints.filter(
      (h) => h.kind === RESTORE_TEST_FAILED_HINT,
    );
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ serverId: 'shale', entity: real.id });
    expect(hints[0]?.title).toContain(real.name);

    // Off: no problem any more.
    expect((await request('PUT', '/restore-tests/shale', { on: false })).statusCode).toBe(200);
    await runner().pass();
    hostsFor(t.services).forget('fleet');
    expect((await hostsFor(t.services).fleet()).hints.some((h) => h.kind === RESTORE_TEST_FAILED_HINT)).toBe(
      false,
    );
  });

  it('a copy whose backup uses parts of the server is deleted without ever starting', async () => {
    const real = realMachine();
    // The machine has no hook script today, but its backup does: the copy's own settings tell.
    fake.configs.delete(`shale/${COPY}`);
    Object.assign(fake.configOf('shale', COPY).values, {
      net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr0',
      hookscript: 'local:snippets/hook.pl',
    });
    const starts = () =>
      fake
        .calls('POST', `${COPY_PATH}/actions`)
        .filter((r) => (r.body as { action?: string })?.action === 'start').length;
    const startsBefore = starts();
    const run = await request('POST', '/restore-tests/shale/run', { guest: real.id });
    expect(run.statusCode, run.body).toBe(200);
    const done = await finished();
    expect(done).toMatchObject({ outcome: 'skipped', reason: 'host_parts', copyId: 990000 });
    expect(starts()).toBe(startsBefore);
    expect(fake.guest('shale', COPY)).toBeNull();
  });

  it('never touches a person’s machine at the copy’s number when the restore is refused', async () => {
    const real = realMachine();
    const before = touches();
    restoreAnswer = 'refused';
    try {
      const run = await request('POST', '/restore-tests/shale/run', { guest: real.id });
      expect(run.statusCode, run.body).toBe(200);
      const done = await finished();
      expect(done).toMatchObject({ outcome: 'skipped', reason: 'refused', copyId: 990000 });
    } finally {
      restoreAnswer = null;
    }
    expect(touches()).toBe(before);
    expect(fake.guest('shale', COPY)).toMatchObject({ name: 'scratch', state: 'running' });
    fake.removeGuest('shale', COPY);
  });

  it('never touches a machine at the copy’s number when the restore’s answer was lost', async () => {
    const real = realMachine();
    const before = touches();
    restoreAnswer = 'lost';
    try {
      const run = await request('POST', '/restore-tests/shale/run', { guest: real.id });
      expect(run.statusCode, run.body).toBe(200);
      const done = await finished();
      expect(done).toMatchObject({ outcome: 'skipped', reason: 'not_ours', copyId: 990000 });
    } finally {
      restoreAnswer = null;
    }
    expect(touches()).toBe(before);
    expect(fake.guest('shale', COPY)).toMatchObject({ name: 'scratch', state: 'running' });
    fake.removeGuest('shale', COPY);
  });

  it('the sweep deletes a copy carrying a test’s marker and nothing that only looks like one', async () => {
    const rows = await t.services.db
      .select()
      .from(restoreTests)
      .where(eq(restoreTests.burrowId, TEST_BURROW_ID));
    const earlier = rows.find((r) => r.copyId === 990000 && r.finishedAt);
    if (!earlier) throw new Error('no finished test');
    const left = { platform: 'pve', kind: 'vm', state: 'stopped' };
    fake.configs.delete(`shale/${COPY}`);
    fake.addGuest('shale', { ...left, id: COPY, vmid: 990000, name: 'whombat-test-of-plex' });
    fake.configOf('shale', COPY).values.description = `whombat-${earlier.id}`;
    // Named and tagged like a copy, but no test made it.
    fake.addGuest('shale', { ...left, id: 'pve:990003', vmid: 990003, name: 'whombat-test-of-plex' });
    fake.configOf('shale', 'pve:990003').values.tags = RESTORE_TEST_TAG;
    // A runner of its own: the shared one looked the server over minutes ago.
    await new RestoreTests(t.services).pass();
    // The delete is a task of its own.
    await eventually(() => expect(fake.guest('shale', COPY)).toBeNull());
    expect(fake.guest('shale', 'pve:990003')).toMatchObject({ name: 'whombat-test-of-plex' });
    expect(fake.calls('DELETE', '/api/v1/servers/shale/guests/pve:990003')).toHaveLength(0);
    fake.removeGuest('shale', 'pve:990003');
  });
});
