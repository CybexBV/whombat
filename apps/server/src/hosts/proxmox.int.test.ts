/**
 * Full Proxmox support through Whombat's tools against the fake hosts service (proxmox.md PX-02, PX-05, PX-08;
 * proxmox-server.md): creating a container with Proxmox's wizard defaults, a backup and a restore over its guest
 * after a yes, a delete that asks, Whombat's one message when a task it started ends (done or failed), Undo of a
 * backup job change as the same Whombat's inverse call, backup jobs through `hosts.manageRead`, a parameter Whombat
 * doesn't pass refused by name, and a server's updates (server-updates.md SWU-07, SWU-08): installed after a yes with
 * one message, checked without asking, installed from the page, refused in plain words. What Whombat says about a task
 * goes in the thread it was asked in (task-feedback.md TF-04).
 */
import { taskLostText } from '@whombat/core';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideApproval } from '../commands/approvals';
import { sendMessage } from '../commands/messages';
import { approvals, changes, dispatches, followedTasks, messages } from '../db/schema/index';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { setConnectionKeys } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { addPersonalAgent } from '../test/personal';
import { accountOf, agentTokenFor, sessionFor } from '../test/tokens';
import { setServerAsks } from './asks';
import { LOST_AFTER_MS, newTaskFollow, taskFollowFor } from './follow';
import { startHosts } from './index';
import { ensureServersConnection } from './provision';
import { FakeHostsService } from './testing/fake';
import { serversTaskWords } from './words';

const fake = new FakeHostsService();
const t = useTestServer({
  seed: true,
  listen: true,
  env: { WHOMBAT_HOSTS_SOCKET: fake.socket, WHOMBAT_HOSTS_TOKEN_FILE: fake.tokenFile },
});

let personCookie = '';
let whombat = { agentId: '', dmId: '' };

/** A Servers call in a turn of the agent's for Mara, in a thread of her Chat when `threadRootId` is given. */
async function call(tool: string, args: Record<string, unknown>, threadRootId?: string) {
  const d = await agentTokenFor(t.services, t.burrowId, whombat.agentId, whombat.dmId, {
    onBehalfOfAccountId: await accountOf(t.services, IDS.mara),
    ...(threadRootId ? { threadRootId } : {}),
  });
  const mcp = await mcpClient(t.baseUrl, d.token);
  const res = await mcp.client.callTool({
    name: 'connection_call',
    arguments: { connection: 'servers', tool, arguments: args },
  });
  await mcp.close();
  return (res.structuredContent ?? {}) as { status: string; content?: string; message?: string };
}

/** Whombat's messages in its DM with Mara, oldest first. */
async function saidRows() {
  const rows = await t.services.db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, whombat.dmId), eq(messages.authorId, whombat.agentId)));
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

type Row = Awaited<ReturnType<typeof saidRows>>[number];

/** What a message says: a task card its outcome once it ended, else what it is doing (task-feedback.md TF-10). */
const wordsOf = (m: Row) => (m.card?.kind === 'task' ? (m.card.result ?? m.card.title) : m.text);

async function said(): Promise<string[]> {
  return (await saidRows()).map(wordsOf);
}

/** The task cards Whombat posted, oldest first, with their messages. */
async function cards() {
  return (await saidRows()).flatMap((m) => (m.card?.kind === 'task' ? [{ message: m, card: m.card }] : []));
}

/** The task card that says it is doing this (its title), once it is there. */
async function cardDoing(title: string) {
  await expect
    .poll(async () => (await cards()).some((c) => c.card.title === title), { timeout: 10_000 })
    .toBe(true);
  return (await cards()).filter((c) => c.card.title === title).at(-1) as Awaited<
    ReturnType<typeof cards>
  >[number];
}

/** Mara asks something in her Chat: the thread the agent's turn answers in. */
async function asks(text: string): Promise<string> {
  const asked = await t.commit(IDS.mara, sendMessage, { conversationId: whombat.dmId, text });
  if (asked.status !== 'ok') throw new Error('send failed');
  return asked.result.id;
}

const saysSoon = (text: string) =>
  expect.poll(async () => (await said()).includes(text), { timeout: 10_000 }).toBe(true);

async function approveLast() {
  const [approval] = await t.services.db.select().from(approvals).orderBy(desc(approvals.number)).limit(1);
  const decided = await t.commit(IDS.mara, decideApproval, {
    number: approval?.number as number,
    decision: 'approve',
  });
  expect(decided.status).toBe('ok');
  return approval;
}

/** Mara sets a server to ask before risky actions (every server starts at Never), so its sensitive calls ask. */
async function asksBeforeRisky(server: string) {
  const set = await t.commit(IDS.mara, setServerAsks, {
    serverId: server,
    serverName: server,
    asksFirst: 'risky',
  });
  expect(set.status).toBe('ok');
}

async function lastChange(kind: string) {
  const [row] = await t.services.db
    .select()
    .from(changes)
    .where(eq(changes.kind, kind))
    .orderBy(desc(changes.createdAt))
    .limit(1);
  return row ?? null;
}

beforeAll(async () => {
  await fake.start();
  personCookie = (await sessionFor(t.services, IDS.mara)).cookie;
  const made = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { services: null });
  whombat = { agentId: made.agentId, dmId: made.dmId };
  await setConnectionKeys(t.services, whombat.agentId, { read: 'can', write: 'can' });
  // A report older than a task's end is read again after 100 ms, not 35 s.
  startHosts(t.services, { followRetryMs: 100 });
  for (const until = Date.now() + 4000; fake.streams !== 1 && Date.now() < until; )
    await new Promise((r) => setTimeout(r, 20));
  await ensureServersConnection(t.services);
});

afterAll(async () => {
  await fake.stop();
});

describe('creating, backing up, restoring and deleting through the agent', () => {
  beforeAll(() => asksBeforeRisky('shale'));

  it('creates a container with Proxmox’s wizard defaults and says when it is ready', async () => {
    const res = await call('guest_create', {
      server: 'shale',
      kind: 'container',
      name: 'dns',
      template: 'local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst',
      password: 'correct horse',
      start: true,
    });
    expect(res.status).toBe('ok');
    expect(JSON.parse(res.content ?? '{}')).toMatchObject({ accepted: true, guest: 'pve:204' });
    const sent = fake.calls('POST', '/api/v1/servers/shale/guests').at(-1);
    expect(sent?.role).toBe('admin');
    expect(sent?.actor).toBe(`${whombat.agentId}|Dusty for Mara`);
    expect(sent?.body).toEqual({
      platform: 'pve',
      kind: 'container',
      name: 'dns',
      start: true,
      set: {
        ostemplate: 'local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst',
        rootfs: 'local-zfs:8',
        cores: '1',
        memory: '512',
        swap: '512',
        net0: 'name=eth0,bridge=vmbr0,firewall=1,ip=dhcp',
        unprivileged: '1',
        features: 'nesting=1',
        password: 'correct horse',
      },
    });
    await saysSoon('The container dns on shale is ready and running.');
    // On Done recently once it is ready (TF-13).
    await expect
      .poll(async () => (await lastChange('hosts.guest_create'))?.title, { timeout: 10_000 })
      .toBe('Created the container dns on shale');
    expect(fake.guest('shale', 'pve:204')).toMatchObject({ name: 'dns', state: 'running' });
    // The password went to the server only: not in the change, not in the chat.
    expect(JSON.stringify(await lastChange('hosts.guest_create'))).not.toContain('correct horse');
    expect((await said()).join('\n')).not.toContain('UPID');
  });

  it('backs up a guest, then restores over it after a yes, each with one message when it ends', async () => {
    const backup = await call('guest_backup', { server: 'shale', guest: 'win11-lab', action: 'create' });
    expect(backup.status).toBe('ok');
    expect(fake.calls('POST', '/api/v1/servers/shale/guests/pve:107/backups').at(-1)?.body).toEqual({
      storage: 'local',
    });
    await saysSoon('The backup of win11-lab on shale is done.');
    const volume = String(
      fake.manage.backups
        .get('shale')
        ?.filter((v) => v.guest === '107')
        .at(-1)?.volume ?? '',
    );
    expect(volume).toMatch(/^local:backup\/vzdump-qemu-107-/);
    // Restoring over a guest always asks; the approval says it in words.
    const asked = await call('guest_backup', {
      server: 'shale',
      guest: 'win11-lab',
      action: 'restore',
      backup: volume,
    });
    expect(asked.status).toBe('pending_approval');
    const approval = await approveLast();
    expect(approval?.question).toBe('Restore win11-lab on shale from today’s backup?');
    // The task's card says what is happening; the approved call's own line makes way for it (TF-10).
    await cardDoing('Restoring win11-lab on shale');
    expect(await said()).not.toContain('Restoring win11-lab on shale from today’s backup now.');
    // The guest it restores over is the one the backup is of, with the confirmation the approval gave.
    expect(fake.calls('POST', '/api/v1/servers/shale/backups/restore').at(-1)?.body).toEqual({
      platform: 'pve',
      volume,
      guest: 'pve:107',
      confirm: true,
    });
    await saysSoon('win11-lab on shale is back as it was in today’s backup.');
  });

  it('says what went wrong when a task fails', async () => {
    fake.manage.taskOutcome('guest.clone', 'error', 'TASK ERROR: no space left on device');
    const res = await call('guest_clone', { server: 'shale', guest: 'win11-lab', name: 'win11-copy' });
    expect(res.status).toBe('ok');
    expect(fake.calls('POST', '/api/v1/servers/shale/guests/pve:107/clone').at(-1)?.body).toMatchObject({
      name: 'win11-copy',
      full: true,
    });
    await saysSoon('Cloning win11-lab on shale as win11-copy didn’t work: the storage is full.');
    expect(fake.guestsOf('shale').some((g) => g.name === 'win11-copy')).toBe(false);
  });

  it('asks before deleting, then deletes with the guest’s own name', async () => {
    const asked = await call('guest_delete', { server: 'shale', guest: 'win11-lab' });
    expect(asked.status).toBe('pending_approval');
    const approval = await approveLast();
    expect(approval?.title).toBe('Delete win11-lab on shale');
    await cardDoing('Deleting win11-lab on shale');
    const sent = fake.calls('DELETE', '/api/v1/servers/shale/guests/pve:107').at(-1);
    expect(sent?.query.get('confirm_name')).toBe('win11-lab');
    expect(sent?.query.get('purge')).toBe('1');
    await saysSoon('win11-lab is deleted from shale.');
    expect(fake.guest('shale', 'pve:107')).toBeNull();
  });
});

describe('backup jobs', () => {
  it('reads them through hosts.manageRead in the contract’s shape', async () => {
    const res = await t.api.inject({
      method: 'GET',
      url: '/api/v1/burrows/burrow-hq/hosts/servers/shale/manage?op=backupjob.list',
      headers: { cookie: personCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { op: string; items: Record<string, unknown>[] };
    expect(body.items[0]).toMatchObject({
      id: 'backup-1d7e5a2c-0f3b',
      schedule: '00:00',
      selection: 'all',
      notesTemplate: '{{guestname}}',
      nextRun: '2026-10-18T00:00:00Z',
    });
  });

  it('pauses a job, and Undo resumes it as the agent', async () => {
    const res = await call('backup_job_set', {
      server: 'shale',
      action: 'pause',
      job: 'backup-1d7e5a2c-0f3b',
    });
    expect(res.status).toBe('ok');
    expect(fake.manage.jobs.get('shale')?.[0]?.enabled).toBe(false);
    const change = await lastChange('hosts.backup_job');
    expect(change).toMatchObject({
      title: 'Paused the backup job “Every night” on shale',
      undoKind: 'hosts.tool_inverse',
    });
    // The update went with the job's digest, as the service wants.
    expect(
      fake.calls('PUT', '/api/v1/servers/shale/backup-jobs/backup-1d7e5a2c-0f3b').at(-1)?.body,
    ).toMatchObject({
      enabled: false,
      digest: expect.any(String),
    });
    const undo = await t.api.inject({
      method: 'POST',
      url: `/api/v1/burrows/burrow-hq/changes/${change?.id}/undo`,
      headers: { cookie: personCookie },
    });
    expect(undo.statusCode).toBe(200);
    await expect.poll(() => fake.manage.jobs.get('shale')?.[0]?.enabled, { timeout: 10_000 }).toBe(true);
  });
});

describe('what the agent doesn’t pass is refused, naming it (PX-08)', () => {
  it('refuses a tool argument and a manage parameter by name', async () => {
    const tool = await call('guest_power', {
      server: 'shale',
      guest: 'grafana-ct',
      action: 'start',
      force: true,
    });
    expect(tool.status).toBe('failed');
    expect(tool.message).toContain('force: guest_power doesn’t take it');
    const res = await t.api.inject({
      method: 'POST',
      url: '/api/v1/burrows/burrow-hq/hosts/servers/shale/manage',
      headers: { cookie: personCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        op: 'guest.migrate',
        guestId: 'pve:103',
        params: { target: 'schist', online: true },
        confirm: true,
      }),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { message: string; fields?: unknown } }).error).toMatchObject({
      message: 'This change doesn’t take “online”.',
      fields: { 'params.online': ['Not taken by this change.'] },
    });
    expect(fake.calls('POST', '/api/v1/servers/shale/guests/pve:103/migrate')).toHaveLength(0);
  });
});

describe('a server’s updates (server-updates.md SWU-07, SWU-08, SWU-10)', () => {
  beforeAll(() => asksBeforeRisky('shale'));

  const saysLike = (...facts: string[]) =>
    expect
      .poll(async () => (await said()).some((m) => facts.every((f) => m.includes(f))), { timeout: 10_000 })
      .toBe(true);
  const manage = (server: string, body: Record<string, unknown>) =>
    t.api.inject({
      method: 'POST',
      url: `/api/v1/burrows/burrow-hq/hosts/servers/${server}/manage`,
      headers: { cookie: personCookie, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });

  it('reads what waits, installs after a yes, and says in one message how it went', async () => {
    const read = JSON.parse((await call('server_updates', { server: 'shale' })).content ?? '{}');
    expect(read).toMatchObject({ server: 'shale', waiting: 3, security: 1, canInstall: true });
    expect(read.packages[0]).toMatchObject({ name: 'openssl', security: true });
    const asked = await call('server_update', {
      server: 'shale',
      action: 'install',
      reason: 'Security updates',
    });
    expect(asked.status).toBe('pending_approval');
    const approval = await approveLast();
    expect(approval?.title).toContain('3 updates');
    const card = await cardDoing('Installing 3 updates on shale');
    const sent = fake.calls('POST', '/api/v1/servers/shale/packages/install').at(-1);
    expect(sent?.role).toBe('admin');
    expect(sent?.body).toEqual({ confirm: true });
    await saysLike('shale is up to date', '3 updates installed', 'new kernel');
    expect((await said()).join('\n')).not.toContain('pkg:');
    // Asked at the top of Mara's Chat (no thread): the ask is its own thread there, and the card follows it (TF-04).
    expect(card.message.threadRootId).toBe(approval?.messageId);
    // Done recently says what it did once it is done, with how many (TF-13).
    await expect
      .poll(async () => (await lastChange('hosts.server_update'))?.title, { timeout: 10_000 })
      .toBe('Installed 3 updates on shale');
    expect(await lastChange('hosts.server_update')).toMatchObject({ undoKind: null });
  });

  it('checks without asking and says what it found', async () => {
    fake.packages.found.set('shale', [{ name: 'nginx', current: '1.22.1', new: '1.22.2', security: true }]);
    const res = await call('server_update', { server: 'shale', action: 'check', reason: 'See what is new' });
    expect(res.status).toBe('ok');
    expect(fake.calls('POST', '/api/v1/servers/shale/packages/check').at(-1)?.role).toBe('operator');
    await saysLike('shale has 1 update waiting, 1 for security');
  });

  it('leaves the restart out when the server’s report isn’t from after the install', async () => {
    fake.packages.staleReport = true;
    expect((fake.details.shale?.system as Record<string, unknown> | undefined)?.reboot_required).toBe(true);
    const asked = await call('server_update', { server: 'shale', action: 'install', reason: 'nginx' });
    expect(asked.status).toBe('pending_approval');
    await approveLast();
    await saysLike('shale is up to date: 1 update installed.');
    const last = (await said()).filter((m) => m.startsWith('shale is up to date')).at(-1);
    expect(last).not.toContain('restart');
  });

  it('installs for the person on the server’s page, signed, its task readable with what it did', async () => {
    const res = await manage('kvm-lab', { op: 'packages.install', params: { packages: ['curl'] } });
    expect(res.statusCode).toBe(200);
    const taskId = (res.json() as { task: { id: string } }).task.id;
    expect(fake.calls('POST', '/api/v1/servers/kvm-lab/packages/install').at(-1)?.body).toEqual({
      packages: ['curl'],
      confirm: true,
    });
    const change = await lastChange('hosts.manage_packages_install');
    expect(change).toMatchObject({ title: 'Installed updates on kvm-lab', undoKind: null });
    expect(change?.detail).toContain('curl');
    const read = async () =>
      (
        await t.api.inject({
          method: 'GET',
          url: `/api/v1/burrows/burrow-hq/hosts/servers/kvm-lab/tasks/${encodeURIComponent(taskId)}?platform=host&logStart=0`,
          headers: { cookie: personCookie },
        })
      ).json() as { status: string; packages?: unknown };
    await expect.poll(async () => (await read()).status, { timeout: 10_000 }).toBe('ok');
    expect((await read()).packages).toEqual({ installed: 1, keptBack: [], warning: null });
  });

  it('refuses in plain words: Unraid’s own sentence, an old agent, Full control', async () => {
    const unraid = await manage('blackbox', { op: 'packages.check', params: {} });
    expect(unraid.statusCode).toBe(409);
    expect((unraid.json() as { error: { message: string } }).error.message).toContain('Unraid');
    fake.packages.refuse.set('kvm-lab', { status: 501, code: 'unsupported', detail: 'unknown operation' });
    const old = await call('server_update', {
      server: 'kvm-lab',
      action: 'check',
      reason: 'See what is new',
    });
    expect(JSON.parse(old.content ?? '{}').error).toBe('Update Whombat’s helper on kvm-lab first.');
    fake.packages.refuse.delete('kvm-lab');
    (fake.switchesOf('kvm-lab') as Record<string, unknown>).manage = false;
    const off = await manage('kvm-lab', { op: 'packages.install', params: {} });
    expect((off.json() as { error: { message: string } }).error.message).toContain('Full control on kvm-lab');
    (fake.switchesOf('kvm-lab') as Record<string, unknown>).manage = true;
  });

  it('says it all in the thread it was asked in: the card, the words after the yes, the end (TF-04)', async () => {
    const root = await asks('Can you update basalt?');
    const asked = await call(
      'server_update',
      { server: 'basalt', action: 'install', reason: 'Mara asked' },
      root,
    );
    expect(asked.status).toBe('pending_approval');
    // The agent hears that the install starts after the yes, with a card, and that it is woken when it ends (TF-12).
    expect(asked.message).toContain('when it ends');
    expect(asked.message).toContain('card');
    const approval = await approveLast();
    const [card] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, approval?.messageId as string));
    expect(card?.threadRootId).toBe(root);
    const inThread = async () =>
      (await saidRows()).filter((m) => m.threadRootId === root && wordsOf(m).includes('basalt')).map(wordsOf);
    // The task's card in the thread, settling into how it went.
    await expect
      .poll(async () => (await inThread()).some((m) => m.includes('up to date')), { timeout: 10_000 })
      .toBe(true);
    expect(
      (await saidRows()).filter((m) => m.threadRootId === null && wordsOf(m).includes('basalt')),
    ).toEqual([]);
  });

  it('tells the end of a call that didn’t ask in the turn’s thread (TF-04)', async () => {
    const root = await asks('Anything new for basalt?');
    const res = await call(
      'server_update',
      { server: 'basalt', action: 'check', reason: 'Mara asked' },
      root,
    );
    expect(res.status).toBe('ok');
    await expect
      .poll(
        async () =>
          (await saidRows()).filter((m) => m.threadRootId === root && wordsOf(m).includes('basalt')).length,
        { timeout: 10_000 },
      )
      .toBe(1);
    expect(
      (await saidRows()).filter((m) => m.threadRootId === null && wordsOf(m).includes('basalt')),
    ).toEqual([]);
  });
});

describe('a task Whombat follows is a card in its thread (task-feedback.md TF-10…TF-13)', () => {
  /** A backup in a thread of Mara's chat (a new one, or `root`), its task held running: the thread, task and row. */
  async function backupHeld(text: string, guest = 'grafana-ct', root?: string) {
    fake.manage.holdTasks = true;
    const thread = root ?? (await asks(text));
    const res = await call('guest_backup', { server: 'shale', guest, action: 'create' }, thread);
    fake.manage.holdTasks = false;
    expect(res.status).toBe('ok');
    const taskId = String(JSON.parse(res.content ?? '{}').task);
    const [row] = await t.services.db.select().from(followedTasks).where(eq(followedTasks.taskId, taskId));
    if (!row) throw new Error('not followed');
    return { root: thread, taskId, row };
  }
  /** The hub ends a task without a word on its stream (a gap, a restart). */
  const endSilently = (taskId: string) => {
    const task = fake.manage.tasks.get(taskId) as unknown as Record<string, unknown>;
    task.status = 'ok';
    task.ended = new Date().toISOString();
    task.message = 'OK';
  };
  const rowOf = async (id: string) =>
    (await t.services.db.select().from(followedTasks).where(eq(followedTasks.id, id)))[0];
  const cardOf = async (messageId: string | null) => {
    const [m] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId as string));
    return m?.card?.kind === 'task' ? m.card : null;
  };
  const stateSoon = (messageId: string | null) =>
    expect.poll(async () => (await cardOf(messageId))?.state, { timeout: 10_000 });

  it('posts the card in the thread, settles it in place, records the change and wakes the agent there', async () => {
    const frames: { type: string; message?: { id: string; card?: { state?: string } | null } }[] = [];
    const off = t.services.bus.onFrame((f) => frames.push(f.event as (typeof frames)[number]));
    const { root, taskId, row } = await backupHeld('Back up grafana please');
    expect(row).toMatchObject({ state: 'running', threadRootId: root, personId: IDS.mara, dispatchId: null });
    expect(await cardOf(row.messageId)).toMatchObject({
      kind: 'task',
      followedTaskId: row.id,
      serverId: 'shale',
      server: 'shale',
      title: 'Backing up grafana-ct on shale',
      state: 'running',
      endedAt: null,
      result: null,
    });
    const [posted] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, row.messageId as string));
    expect(posted).toMatchObject({ threadRootId: root, authorId: whombat.agentId });
    // Done recently waits for the end (TF-13).
    expect((await lastChange('hosts.guest_backup'))?.title).not.toContain('grafana-ct');

    fake.manage.finishTask(taskId, 'ok');
    await stateSoon(row.messageId).toBe('ok');
    off();
    const done = await cardOf(row.messageId);
    expect(done?.result).toBe('The backup of grafana-ct on shale is done.');
    expect(done?.endedAt).toBeTruthy();
    // The same message, updated in place wherever it is open.
    expect(
      frames.some(
        (e) =>
          e.type === 'message.updated' && e.message?.id === row.messageId && e.message.card?.state === 'ok',
      ),
    ).toBe(true);
    expect(await lastChange('hosts.guest_backup')).toMatchObject({
      title: 'Backed up grafana-ct on shale',
      threadRootId: root,
    });
    // The agent is woken in that thread for Mara, with how it went; no plain line is posted for it.
    const ended = await rowOf(row.id);
    const [wake] = await t.services.db
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, ended?.dispatchId as string));
    expect(wake).toMatchObject({
      trigger: 'task_finished',
      agentId: whombat.agentId,
      conversationId: whombat.dmId,
      threadRootId: root,
      onBehalfOfAccountId: await accountOf(t.services, IDS.mara),
    });
    const context = await buildDispatchContext(t.services, wake as NonNullable<typeof wake>);
    expect(context.taskFinished).toEqual([
      expect.objectContaining({
        followedTaskId: row.id,
        serverId: 'shale',
        what: 'Backing up grafana-ct on shale',
        result: 'ok',
        words: 'The backup of grafana-ct on shale is done.',
        rebootRequired: false,
      }),
    ]);
    expect(
      (await saidRows()).filter((m) => m.threadRootId === root && !m.card && m.text.includes('grafana-ct')),
    ).toEqual([]);
    // The card's message says its title, which clients fold into the card.
    expect(posted?.text).toBe('Backing up grafana-ct on shale');
  });

  it('a task ending while that turn still waits joins it (TF-12)', async () => {
    const a = await backupHeld('Back up two of them', 'pihole');
    const b = await backupHeld('', 'vaultwarden', a.root);
    fake.manage.finishTask(a.taskId, 'ok');
    await expect.poll(async () => (await rowOf(a.row.id))?.dispatchId, { timeout: 10_000 }).toBeTruthy();
    fake.manage.finishTask(b.taskId, 'error', 'no space left on device');
    await expect.poll(async () => (await rowOf(b.row.id))?.dispatchId, { timeout: 10_000 }).toBeTruthy();
    const dispatchId = (await rowOf(a.row.id))?.dispatchId as string;
    expect((await rowOf(b.row.id))?.dispatchId).toBe(dispatchId);
    const [wake] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
    const context = await buildDispatchContext(t.services, wake as NonNullable<typeof wake>);
    expect(context.taskFinished?.map((x) => [x.followedTaskId, x.result])).toEqual([
      [a.row.id, 'ok'],
      [b.row.id, 'error'],
    ]);
    // A failed one isn't on Done recently.
    expect((await lastChange('hosts.guest_backup'))?.title).not.toContain('vaultwarden');
  });

  it('posts how it went as a line in the thread when the agent can’t be woken there (TF-12)', async () => {
    const root = await asks('And slate?');
    const follow = taskFollowFor(t.services);
    const words = serversTaskWords('guest_backup', { action: 'create' }, { server: 'shale', guest: 'slate' });
    // Mara's Chat is read only in a turn for her (one-person.md OP-S71): a task kept for nobody can't wake the agent there.
    await follow.remember({
      taskId: 'UPID:shale:00001:fallback:',
      serverId: 'shale',
      serverName: 'shale',
      burrowId: t.burrowId,
      conversationId: whombat.dmId,
      threadRootId: root,
      agentId: whombat.agentId,
      personId: null,
      words: words as NonNullable<typeof words>,
    });
    await follow.finished('shale', 'UPID:shale:00001:fallback:', 'ok', 'OK');
    const lines = (await saidRows()).filter((m) => m.threadRootId === root && !m.card).map((m) => m.text);
    expect(lines).toEqual(['The backup of slate on shale is done.']);
  });

  it('after a restart or a gap in the stream, asks the hub and settles the card from its answer (TF-11)', async () => {
    const restart = await backupHeld('Back up nginx-proxy', 'nginx-proxy');
    endSilently(restart.taskId);
    // A new follow-up is what a restart makes: it re-reads the running rows and asks the hub.
    await newTaskFollow(t.services).check(true);
    await stateSoon(restart.row.messageId).toBe('ok');
    expect(
      fake.requests.some((r) => r.method === 'GET' && r.path.includes('/tasks/') && r.role === 'operator'),
    ).toBe(true);

    const gap = await backupHeld('Back up gitlab-runner', 'gitlab-runner');
    endSilently(gap.taskId);
    taskFollowFor(t.services).onChange({ kind: 'resync' });
    await stateSoon(gap.row.messageId).toBe('ok');
  });

  it('says it lost track of a task the hub can’t tell about a day after it started (TF-11)', async () => {
    const { taskId, row } = await backupHeld('Back up k3s-node-1', 'k3s-node-1');
    // Still running: asked about, nothing changes.
    await newTaskFollow(t.services).check(true);
    expect((await cardOf(row.messageId))?.state).toBe('running');
    fake.manage.tasks.delete(taskId);
    await newTaskFollow(t.services, { now: () => Date.now() + LOST_AFTER_MS + 60_000 }).check(true);
    await stateSoon(row.messageId).toBe('lost');
    expect((await cardOf(row.messageId))?.result).toBe(taskLostText('shale'));
  });
});
