import { HostServerDetail } from '@whombat/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostsClient, HostsError } from '../client';
import { toHostServerDetail, toHostTask } from '../map';
import { type FakeHostsService, startFakeHosts } from './fake';

type Json = Record<string, unknown>;

const admin = { id: 'prn_mara', name: 'Mara', role: 'admin' as const };
const operator = { ...admin, role: 'operator' as const };

let fake: FakeHostsService;
let client: HostsClient;

beforeEach(async () => {
  fake = await startFakeHosts();
  fake.manage.taskMs = 5;
  client = new HostsClient({ socket: fake.socket, tokenFile: fake.tokenFile });
});
afterEach(() => fake.stop());

const start = (
  server: string,
  op: 'check' | 'install',
  body: Json = op === 'install' ? { confirm: true } : {},
) =>
  client.json<Json>({
    method: 'POST',
    path: `/api/v1/servers/${server}/packages/${op}`,
    body,
    actor: op === 'install' ? admin : operator,
  });

const task = (server: string, id: string, logStart = 0) =>
  client.json<Json>({
    path: `/api/v1/servers/${server}/tasks/${encodeURIComponent(id)}`,
    query: { platform: 'host', log_start: logStart },
    actor: operator,
  });

/** Waits for the task's `task.finished` (the fake emits it when the task ends) and gives its status. */
async function ended(server: string, id: string): Promise<Json> {
  await new Promise<void>((resolve) => {
    const check = async () => {
      if ((await task(server, id)).status !== 'running') resolve();
      else setTimeout(check, 5);
    };
    void check();
  });
  return task(server, id);
}

async function refusal(p: Promise<unknown>): Promise<HostsError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HostsError);
  return err as HostsError;
}

const system = (server: string) => fake.details[server]?.system as Json;

describe('the fake hosts service checks and installs a server’s updates', () => {
  it('lists the waiting updates and reports them as the contract has them', async () => {
    const list = await client.json<Json>({ path: '/api/v1/servers/shale/inspect/updates', actor: operator });
    expect((list.items as Json[]).map((u) => u.name)).toContain('proxmox-kernel-6.8');
    const d = toHostServerDetail(
      await client.json({ path: '/api/v1/servers/shale', actor: admin }),
      [],
      null,
      new Date(),
    );
    expect(HostServerDetail.safeParse(d).error).toBeUndefined();
    expect(d.health?.system).toMatchObject({
      updates: 3,
      securityUpdates: 1,
      packageTask: null,
      packageLast: null,
    });
  });

  it('installs as a task: its log pages, the report follows it, a new kernel needs a restart', async () => {
    // Held until the busy refusal is checked: on a loaded machine its 5 ms could end it first.
    fake.manage.holdTasks = true;
    const answer = await start('shale', 'install');
    const id = String((answer.task as Json).id);
    expect(id).toMatch(/^pkg:[0-9a-f]{16}$/);
    expect(system('shale').package_task).toMatchObject({ id, op: 'install' });
    // One package task at a time.
    expect((await refusal(start('shale', 'check'))).code).toBe('busy');
    fake.manage.holdTasks = false;
    fake.manage.finishTask(id);
    const done = await ended('shale', id);
    expect(done).toMatchObject({ status: 'ok', packages: { installed: 3, kept_back: [] } });
    const page = await task('shale', id, 2);
    expect((page.log as string[]).length).toBe((done.log as string[]).length - 2);
    expect(toHostTask(done).cancellable).toBe(false);
    expect(system('shale')).toMatchObject({
      updates: 0,
      security_updates: 0,
      reboot_required: true,
      package_task: null,
      package_last: { op: 'install', status: 'ok', installed: 3 },
    });
    expect(String(system('shale').reboot_reason)).toMatch(/^Kernel /);
  });

  it('installs only the named packages, holds back what a test says, and warns', async () => {
    fake.packages.keptBack = ['curl'];
    fake.packages.warning = 'The Proxmox enterprise repository refused (it needs a subscription).';
    const answer = await start('kvm-lab', 'install', { packages: ['openssl', 'curl'], confirm: true });
    const done = await ended('kvm-lab', String((answer.task as Json).id));
    expect(done.packages).toMatchObject({ installed: 1, kept_back: ['curl'] });
    expect(String((done.packages as Json).warning)).toContain('enterprise');
    expect(fake.packages.waiting.get('kvm-lab')?.map((u) => u.name)).toEqual(['curl', 'tzdata']);
    expect(system('kvm-lab').reboot_required).toBe(false);
  });

  it('checks: a stoppable task that finds what a test added', async () => {
    fake.packages.found.set('kvm-lab', [{ name: 'nginx', current: '1.22', new: '1.22.1', security: true }]);
    const answer = await start('kvm-lab', 'check');
    const done = await ended('kvm-lab', String((answer.task as Json).id));
    expect(done.status).toBe('ok');
    expect(system('kvm-lab')).toMatchObject({
      updates: 4,
      security_updates: 2,
      package_last: { op: 'check' },
    });
  });

  it('ends with a code when the lock stays held', async () => {
    fake.manage.taskOutcome(
      'packages.install',
      'error',
      'E: Could not get lock /var/lib/dpkg/lock-frontend',
      'busy',
    );
    const answer = await start('kvm-lab', 'install');
    const done = await ended('kvm-lab', String((answer.task as Json).id));
    expect(done).toMatchObject({ status: 'error', code: 'busy' });
    expect(done.packages).toBeUndefined();
    expect(system('kvm-lab').package_last).toMatchObject({ status: 'failed', code: 'busy', installed: null });
  });

  it('refuses as the hub does: role, confirmation, names, the switch, Unraid, an old agent', async () => {
    const asOperator = client.json({
      method: 'POST',
      path: '/api/v1/servers/shale/packages/install',
      body: { confirm: true },
      actor: operator,
    });
    expect((await refusal(asOperator)).status).toBe(403);
    expect((await refusal(start('shale', 'install', {}))).code).toBe('confirm_required');
    expect((await refusal(start('shale', 'install', { packages: ['a b'], confirm: true }))).status).toBe(400);
    expect((await refusal(start('shale', 'check', { packages: ['nginx'] }))).status).toBe(400);
    (fake.switchesOf('shale') as Json).manage = false;
    expect((await refusal(start('shale', 'check'))).code).toBe('manage_disabled');
    expect((await refusal(start('blackbox', 'install'))).code).toBe('unsupported');
    fake.packages.refuse.set('kvm-lab', { status: 501, code: 'unsupported', detail: 'unknown operation' });
    expect((await refusal(start('kvm-lab', 'check'))).detail).toBe('unknown operation');
  });
});
