/**
 * Restore tests end to end against the fake hosts service (docs/decisions/backup-trust.md): *Test one now* restores a
 * machine's newest backup as a copy in the copies' range, pulls its network cables, renames and tags it before it
 * starts, waits until it runs and its guest agent answers, then stops and deletes it, and the real machine is only
 * read. A copy that doesn't start raises one problem for the machine. The What's protected page and the machine's page
 * show the result. Postgres because every step is a signed commit the runtime picks up again after a restart.
 */
import { RESTORE_TEST_FAILED_HINT, RESTORE_TEST_TAG } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { restoreTests } from '../db/schema/index';
import { startHosts } from '../hosts/index';
import { hostsFor } from '../hosts/service';
import { FakeHostsService, problem } from '../hosts/testing/fake';
import { TEST_BURROW_ID, IDS } from '../seed/test-world';
import { eventually } from '../test/collab';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { restoreTestsFor } from './runner';

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
    .find((x) => x.platform === 'pve' && x.kind === 'vm' && x.last_backup && x.template !== true && x.self !== true);
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
  const rows = await t.services.db.select().from(restoreTests).where(eq(restoreTests.burrowId, TEST_BURROW_ID));
  return rows.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
}

const runner = () => restoreTestsFor(t.services);

beforeAll(async () => {
  await fake.start();
  cookie = (await sessionFor(t.services, IDS.mara)).cookie;
  startHosts(t.services);
  // The home jobs start it with the runtime; here only its problems are needed.
  runner().start();
  fake.manage.taskMs = 5;
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

    // Restored into the copies' range; its cables pulled and its name changed before it was asked to start.
    const booting = await eventually(async () => {
      await runner().pass();
      const row = await testRow();
      expect(row?.step).toBe('booting');
      return row;
    });
    expect(booting).toMatchObject({ copyId: 990000, guestId: real.id, agentExpected: true });
    expect(copyConfig.values.net0).toContain('link_down=1');
    expect(copyConfig.values).toMatchObject({ name: `whombat-test-of-${real.name}`, onboot: '0' });
    expect(copyConfig.values.tags).toContain(RESTORE_TEST_TAG);
    expect(fake.calls('PUT', '/api/v1/servers/shale/guests/pve:990000/config')).toHaveLength(1);

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
    const hints = (await hostsFor(t.services).fleet()).hints.filter((h) => h.kind === RESTORE_TEST_FAILED_HINT);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ serverId: 'shale', entity: real.id });
    expect(hints[0]?.title).toContain(real.name);

    // Off: no problem any more.
    expect((await request('PUT', '/restore-tests/shale', { on: false })).statusCode).toBe(200);
    await runner().pass();
    hostsFor(t.services).forget('fleet');
    expect((await hostsFor(t.services).fleet()).hints.some((h) => h.kind === RESTORE_TEST_FAILED_HINT)).toBe(false);
  });
});
