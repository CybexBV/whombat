/**
 * Restore tests end to end against the fake hosts service (docs/decisions/backup-trust.md): *Test one now* restores a
 * machine's newest backup as a copy in the copies' range, cut off by the restore itself (network cables pulled, no start
 * with the server, renamed, tagged and marked), waits until it runs and its guest agent answers, then stops and deletes
 * it, and the real machine is only read. A copy that doesn't start raises one problem for the machine. The What's
 * protected page and the machine's page show the result. A machine at the copy's number that doesn't carry the test's
 * marker is never changed, started, stopped or deleted; a copy whose backup uses parts of the server, or whose cables
 * Proxmox wouldn't pull, is deleted without starting; a helper too old to cut the copy off makes no copy at all; a copy
 * whose restore answer was lost is found by its marker and removed. Postgres because every step is a signed commit the
 * runtime picks up again after a restart, and the sweep reads the tests back.
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
import { failingTests, RestoreTests, restoreTestsFor } from './runner';

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
let restoreAnswer: 'refused' | 'lost' | 'unanswered' | null = null;
/** Changes of the copy's network cards are refused (a card Proxmox won't take). */
let refuseCards = false;

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
    // Asked, but the answer never came and the copy shows up only later.
    if (restoreAnswer === 'unanswered') return problem(503, 'unavailable', 'The agent didn’t answer.');
    personsMachine();
    return restoreAnswer === 'refused'
      ? problem(409, 'platform_error', 'TASK ERROR: unable to restore')
      : problem(503, 'unavailable', 'The agent didn’t answer.');
  });
  fake.on('PUT', `${COPY_PATH}/config`, (r) => {
    const set = (r.body as { set?: Record<string, string> })?.set ?? {};
    return refuseCards && Object.keys(set).some((k) => k.startsWith('net'))
      ? problem(403, 'not_allowed', 'net0: the model must be one of virtio, e1000')
      : null;
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

    // The copy's settings as Proxmox restores them: the real machine's network card, starting with the server, its
    // guest agent switched on.
    const copyConfig = fake.configOf('shale', 'pve:990000');
    Object.assign(copyConfig.values, {
      net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr0',
      onboot: '1',
      agent: '1',
    });

    const run = await request('POST', '/restore-tests/shale/run', { guest: real.id });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json().running).toMatchObject({ guestId: real.id });
    expect((await request('POST', '/restore-tests/shale/run', {})).statusCode).toBe(409);

    // Restored into the copies' range, cut off by the restore itself: marked as this test's copy, its cables pulled,
    // its name changed and kept from starting with the server from the moment it exists, so nothing was left to change.
    const booting = await eventually(async () => {
      await runner().pass();
      const row = await testRow();
      expect(row?.step).toBe('booting');
      return row;
    });
    expect(booting).toMatchObject({ copyId: 990000, guestId: real.id, agentExpected: true });
    const restore = fake.calls('POST', '/api/v1/servers/shale/backups/restore').at(-1);
    expect(restore?.body).toMatchObject({
      new_id: 990000,
      isolate: {
        name: `whombat-test-of-${real.name}`,
        marker: `whombat-${booting?.id}`,
        tag: RESTORE_TEST_TAG,
      },
    });
    expect(copyConfig.values.net0).toContain('link_down=1');
    expect(copyConfig.values).toMatchObject({
      name: `whombat-test-of-${real.name}`,
      onboot: '0',
      description: `whombat-${booting?.id}`,
    });
    expect(copyConfig.values.tags).toContain(RESTORE_TEST_TAG);
    expect(fake.calls('PUT', `${COPY_PATH}/config`)).toHaveLength(0);
    const start = fake.calls('POST', `${COPY_PATH}/actions`)[0];
    expect(start?.body).toMatchObject({ action: 'start' });

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
    // A VM copy is stopped the way the hosts service stops a VM.
    const actions = fake
      .calls('POST', `${COPY_PATH}/actions`)
      .map((r) => (r.body as { action?: string })?.action);
    expect(actions).toContain('force_stop');
    expect(actions).not.toContain('stop');

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
    let failStarts = true;
    fake.on('POST', '/api/v1/servers/shale/guests/pve:990000/actions', (r) =>
      failStarts && (r.body as { action?: string })?.action === 'start'
        ? problem(409, 'platform_error', 'TASK ERROR: start failed')
        : null,
    );
    let done: Awaited<ReturnType<typeof latest>>;
    try {
      const run = await request('POST', '/restore-tests/shale/run', { guest: real.id });
      expect(run.statusCode, run.body).toBe(200);
      done = await eventually(async () => {
        await runner().pass();
        const row = await latest();
        expect(row?.finishedAt).toBeTruthy();
        return row;
      });
    } finally {
      failStarts = false;
    }
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

  it('makes no copy on a server whose helper can’t cut it off from the start', async () => {
    const real = realMachine();
    const restores = () => fake.calls('POST', '/api/v1/servers/shale/backups/restore').length;
    const before = restores();
    fake.manage.oldHelpers.add('shale');
    try {
      const run = await request('POST', '/restore-tests/shale/run', { guest: real.id });
      expect(run.statusCode, run.body).toBe(200);
      const done = await finished();
      expect(done).toMatchObject({ outcome: 'skipped', reason: 'old_helper' });
    } finally {
      fake.manage.oldHelpers.delete('shale');
    }
    expect(restores()).toBe(before);
    expect(fake.guest('shale', COPY)).toBeNull();
  });

  it('puts on what of the isolation didn’t take, start with the server first, and a refused card stops the start', async () => {
    const real = realMachine();
    fake.configs.delete(`shale/${COPY}`);
    const copyConfig = fake.configOf('shale', COPY);
    Object.assign(copyConfig.values, { net0: 'ne2k_pci=BC:24:11:00:00:01,bridge=vmbr9' });
    const starts = () =>
      fake
        .calls('POST', `${COPY_PATH}/actions`)
        .filter((r) => (r.body as { action?: string })?.action === 'start').length;
    const startsBefore = starts();
    const putsBefore = fake.calls('PUT', `${COPY_PATH}/config`).length;
    fake.manage.holdTasks = true;
    refuseCards = true;
    try {
      const run = await request('POST', '/restore-tests/shale/run', { guest: real.id });
      expect(run.statusCode, run.body).toBe(200);
      const task = await eventually(async () => {
        await runner().pass();
        const row = await latest();
        expect(row?.step).toBe('restoring');
        expect(row?.task).toBeTruthy();
        return String(row?.task);
      });
      fake.manage.finishTask(task);
      await eventually(() => expect(fake.guest('shale', COPY)).toBeTruthy());
      // Proxmox kept the backup's start with the server and its connected card, though the marker went on.
      Object.assign(copyConfig.values, { onboot: '1', net0: 'ne2k_pci=BC:24:11:00:00:01,bridge=vmbr9' });
      fake.manage.holdTasks = false;
      const done = await finished();
      expect(done).toMatchObject({ outcome: 'skipped', reason: 'network_kept' });
    } finally {
      fake.manage.holdTasks = false;
      refuseCards = false;
    }
    const puts = fake.calls('PUT', `${COPY_PATH}/config`).slice(putsBefore);
    const sets = puts.map((r) => Object.keys((r.body as { set: Record<string, string> }).set));
    expect(sets[0]).toEqual(['onboot']);
    expect(sets[1]).toEqual(['net0']);
    // Only the cable: the card as it was.
    expect((puts[1]?.body as { set?: Record<string, string> } | undefined)?.set?.net0).toBe(
      'ne2k_pci=BC:24:11:00:00:01,bridge=vmbr9,link_down=1',
    );
    expect(copyConfig.values.onboot).toBe('0');
    expect(starts()).toBe(startsBefore);
    expect(fake.guest('shale', COPY)).toBeNull();
  });

  it('a copy whose restore answer was lost is found by its marker and removed without starting', async () => {
    const real = realMachine();
    const starts = () =>
      fake
        .calls('POST', `${COPY_PATH}/actions`)
        .filter((r) => (r.body as { action?: string })?.action === 'start').length;
    const startsBefore = starts();
    const realClock = t.services.clock;
    restoreAnswer = 'unanswered';
    let test: Awaited<ReturnType<typeof latest>>;
    try {
      const run = await request('POST', '/restore-tests/shale/run', { guest: real.id });
      expect(run.statusCode, run.body).toBe(200);
      await eventually(async () => {
        await runner().pass();
        expect((await latest())?.step).toBe('restoring');
      });
      // No copy came for a quarter of an hour: the test gives up, with nothing at the number to remove.
      t.services.clock = () => new Date(realClock().getTime() + 20 * 60_000);
      test = await finished();
      expect(test).toMatchObject({ outcome: 'skipped', reason: 'unreachable', copyId: 990000 });
    } finally {
      t.services.clock = realClock;
      restoreAnswer = null;
    }
    // Then the restore that was asked for runs after all: Proxmox writes the copy with the isolation it was given.
    const asked = fake.calls('POST', '/api/v1/servers/shale/backups/restore').at(-1)?.body as {
      isolate: { name: string; marker: string };
    };
    expect(asked.isolate.marker).toBe(`whombat-${test?.id}`);
    fake.configs.delete(`shale/${COPY}`);
    fake.addGuest('shale', {
      id: COPY,
      vmid: 990000,
      name: asked.isolate.name,
      platform: 'pve',
      kind: 'vm',
      state: 'stopped',
    });
    Object.assign(fake.configOf('shale', COPY).values, {
      name: asked.isolate.name,
      onboot: '0',
      description: asked.isolate.marker,
      net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr0,link_down=1',
    });
    await new RestoreTests(t.services).pass();
    await eventually(() => expect(fake.guest('shale', COPY)).toBeNull());
    expect(starts()).toBe(startsBefore);
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

  it('checks room and memory against the backup’s own settings, not the machine’s today', async () => {
    const real = realMachine();
    const volumes = (fake.manage.backups.get('shale') ?? [])
      .filter((v) => `pve:${String(v.guest)}` === real.id)
      .map((v) => String(v.volume));
    const restores = () => fake.calls('POST', '/api/v1/servers/shale/backups/restore').length;
    const before = restores();
    try {
      // The backup still has a disk the machine lost since.
      for (const v of volumes)
        fake.manage.backupConfigs.set(v, { name: real.name, scsi1: 'tank:vm-100-disk-1,size=900T' });
      expect((await request('POST', '/restore-tests/shale/run', { guest: real.id })).statusCode).toBe(200);
      expect(await finished()).toMatchObject({ outcome: 'skipped', reason: 'no_space' });
      // And far more memory than the server has free.
      for (const v of volumes) fake.manage.backupConfigs.set(v, { name: real.name, memory: '99999999' });
      expect((await request('POST', '/restore-tests/shale/run', { guest: real.id })).statusCode).toBe(200);
      expect(await finished()).toMatchObject({ outcome: 'skipped', reason: 'no_memory' });
      // A helper that can't read the backup's settings: no copy, since Whombat can't tell it fits.
      fake.manage.backupConfigs.clear();
      fake.manage.noBackupConfig.add('shale');
      expect((await request('POST', '/restore-tests/shale/run', { guest: real.id })).statusCode).toBe(200);
      expect(await finished()).toMatchObject({ outcome: 'skipped', reason: 'old_helper' });
    } finally {
      fake.manage.backupConfigs.clear();
      fake.manage.noBackupConfig.delete('shale');
    }
    expect(restores()).toBe(before);
  });

  it('expects the guest agent the copy’s own settings switch on, so a copy that never boots fails', async () => {
    const real = realMachine();
    const machine = fake.guest('shale', real.id);
    if (!machine) throw new Error('no machine');
    // The real machine is off, so its agent can't answer now; its backup has the agent switched on.
    const { state, guest_agent } = machine;
    machine.state = 'stopped';
    delete machine.guest_agent;
    fake.configs.delete(`shale/${COPY}`);
    Object.assign(fake.configOf('shale', COPY).values, {
      net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr0',
      agent: '1',
    });
    const realClock = t.services.clock;
    try {
      expect((await request('POST', '/restore-tests/shale/run', { guest: real.id })).statusCode).toBe(200);
      const booting = await eventually(async () => {
        await runner().pass();
        const row = await latest();
        expect(row?.step).toBe('booting');
        expect(row?.runningAt).toBeTruthy();
        return row;
      });
      expect(booting).toMatchObject({ agentExpected: true });
      // Running for 11 minutes without the agent ever answering: it never finished starting up.
      t.services.clock = () => new Date(realClock().getTime() + 11 * 60_000);
      expect(await finished()).toMatchObject({ outcome: 'failed', reason: 'no_boot' });
    } finally {
      t.services.clock = realClock;
      machine.state = state;
      machine.guest_agent = guest_agent;
    }
    expect(fake.guest('shale', COPY)).toBeNull();
  });

  it('never restores a container that runs as the server’s own root', async () => {
    const ct = fake
      .guestsOf('shale')
      .find((x) => x.platform === 'pve' && x.kind === 'container' && x.last_backup && x.self !== true);
    if (!ct) throw new Error('no container with a backup on shale');
    const id = String(ct.id);
    const restores = () => fake.calls('POST', '/api/v1/servers/shale/backups/restore').length;
    const before = restores();
    // Privileged today.
    fake.configs.delete(`shale/${id}`);
    expect((await request('POST', '/restore-tests/shale/run', { guest: id })).statusCode).toBe(200);
    expect(await finished()).toMatchObject({ guestId: id, outcome: 'skipped', reason: 'host_parts' });
    // Unprivileged today, but not in its backup.
    fake.configOf('shale', id).values.unprivileged = '1';
    const volumes = (fake.manage.backups.get('shale') ?? []).filter((v) => `pve:${String(v.guest)}` === id);
    try {
      for (const v of volumes) fake.manage.backupConfigs.set(String(v.volume), { hostname: String(ct.name) });
      expect((await request('POST', '/restore-tests/shale/run', { guest: id })).statusCode).toBe(200);
      expect(await finished()).toMatchObject({ guestId: id, outcome: 'skipped', reason: 'host_parts' });
    } finally {
      fake.manage.backupConfigs.clear();
    }
    expect(restores()).toBe(before);
  });

  it('skips a test whose restore is still running after an hour, raises no problem, and removes the copy later', async () => {
    const real = realMachine();
    fake.configs.delete(`shale/${COPY}`);
    fake.manage.holdTasks = true;
    const realClock = t.services.clock;
    let task = '';
    let test: Awaited<ReturnType<typeof latest>>;
    try {
      expect((await request('POST', '/restore-tests/shale/run', { guest: real.id })).statusCode).toBe(200);
      task = await eventually(async () => {
        await runner().pass();
        const row = await latest();
        expect(row?.step).toBe('restoring');
        expect(row?.task).toBeTruthy();
        return String(row?.task);
      });
      t.services.clock = () => new Date(realClock().getTime() + 61 * 60_000);
      test = await finished();
      expect(test).toMatchObject({ outcome: 'skipped', reason: 'too_long' });
    } finally {
      t.services.clock = realClock;
      fake.manage.holdTasks = false;
    }
    // A skipped test raises no problem for the machine.
    expect(test && failingTests([test], ['shale'])).toEqual([]);
    // The restore ends after all and the copy carries the test's marker: the sweep removes it, never starting it.
    fake.manage.finishTask(task);
    await eventually(() => expect(fake.guest('shale', COPY)).toBeTruthy());
    expect(fake.configOf('shale', COPY).values.description).toBe(`whombat-${test?.id}`);
    await new RestoreTests(t.services).pass();
    await eventually(() => expect(fake.guest('shale', COPY)).toBeNull());
  });
});
