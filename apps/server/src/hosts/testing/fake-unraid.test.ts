import { HostServerDetail } from '@whombat/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostsClient, HostsError } from '../client';
import { toHostServerDetail } from '../map';
import { type FakeHostsService, startFakeHosts } from './fake';

type Json = Record<string, unknown>;

const admin = { id: 'prn_mara', name: 'Mara', role: 'admin' as const };

let fake: FakeHostsService;
let client: HostsClient;

beforeEach(async () => {
  fake = await startFakeHosts();
  fake.manage.taskMs = 5;
  client = new HostsClient({ socket: fake.socket, tokenFile: fake.tokenFile });
});
afterEach(() => fake.stop());

function call<T = Json>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  actor: { id: string; name: string; role: 'viewer' | 'operator' | 'admin' } = admin,
): Promise<T> {
  return client.json<T>({ method, path: `/api/v1/servers/${path}`, body, actor });
}

/** The problem a call ends with. */
async function refusal(p: Promise<unknown>): Promise<HostsError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HostsError);
  return err as HostsError;
}

/** Waits for an agent task to end and gives its status. */
async function ended(server: string, id: string): Promise<Json> {
  for (let i = 0; i < 200; i++) {
    const t = await client.json<Json>({
      path: `/api/v1/servers/${server}/tasks/${encodeURIComponent(id)}`,
      query: { platform: 'unraid' },
      actor: admin,
    });
    if (t.status !== 'running') return t;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`task ${id} didn't end`);
}

const taskId = (answer: Json) => String((answer.task as Json).id);
const unraid = () => fake.details.blackbox?.unraid as Json & { array: Json & { parity: Json } };
const parity = () => unraid().array.parity as Json & { history: Json[] };
const hintKinds = () => ((fake.details.blackbox?.hints as Json[]) ?? []).map((h) => String(h.kind)).sort();

describe('the fake hosts service as an unRAID server (blackbox)', () => {
  it('serves the unRAID detail, the Docker extras and the hints, and it maps to the contract', async () => {
    const d = await call<Json>('GET', 'blackbox');
    const u = d.unraid as Json;
    expect(u).toMatchObject({
      version: '7.3.1',
      name: 'BlackBox',
      license: 'Pro',
      os_update: { version: '7.3.2' },
    });
    expect((d.server as Json).detail_view).toBe('unraid');
    const docker = (d.workloads as Record<string, { guests: Json[]; running: number; total: number }>).docker;
    expect(docker?.guests.find((g) => g.id === 'docker:plex')).toMatchObject({
      autostart: true,
      template: true,
      update_available: true,
      web_ui: 'http://10.100.0.40:32400/web/index.html',
    });
    expect(docker?.guests.find((g) => g.id === 'docker:tailscale-test')).toMatchObject({ template: false });
    expect(docker?.running).toBe(docker?.guests.filter((g) => g.state === 'running').length);
    expect(hintKinds()).toEqual([
      'docker.update_available',
      'unraid.notification',
      'unraid.os_update',
      'unraid.plugin_updates',
      'unraid.pool_full',
    ]);
    const mapped = toHostServerDetail(d, [], null, new Date('2026-10-11T14:00:00Z'));
    expect(HostServerDetail.safeParse(mapped).error).toBeUndefined();
    expect(mapped.unraid?.array.parity.last?.result).toBe('ok');
    expect(mapped.unraid?.pools.map((p) => p.name)).toEqual(['apps', 'data', 'storage']);
    // Two finished agent tasks from before.
    const list = await client.json<{ items: Json[] }>({
      path: '/api/v1/servers/blackbox/tasks',
      query: { platform: 'unraid' },
      actor: admin,
    });
    expect(list.items.map((t) => t.status).sort()).toEqual(['error', 'ok']);
    expect(list.items.every((t) => String(t.id).startsWith('unraid:'))).toBe(true);
  });

  it('runs a parity check as an agent task and keeps the run with the errors it found', async () => {
    fake.unraid.parityErrors = 2;
    // Held until the busy refusal is checked: on a loaded machine its 5 ms could end it first.
    fake.manage.holdTasks = true;
    const started = await call<Json>('POST', 'blackbox/unraid/parity/start', { correct: false });
    expect(taskId(started)).toMatch(/^unraid:[0-9a-f]{16}$/);
    expect(parity()).toMatchObject({ state: 'running', action: 'check', pct: 0 });
    expect((await refusal(call('POST', 'blackbox/unraid/parity/start'))).code).toBe('busy');
    fake.manage.holdTasks = false;
    fake.manage.finishTask(taskId(started));
    const t = await ended('blackbox', taskId(started));
    expect(t).toMatchObject({ status: 'ok', type: 'parity-check' });
    expect((t.log as string[]).join('\n')).toContain('mdcmd check NOCORRECT');
    expect(parity()).toMatchObject({ state: 'idle', action: null, last: { errors: 2, result: 'errors' } });
    expect(parity().history[0]).toEqual(parity().last);
    expect(hintKinds()).toContain('unraid.parity_errors');

    fake.unraid.parityErrors = 0;
    const again = await call<Json>('POST', 'blackbox/unraid/parity/start', { correct: true });
    await ended('blackbox', taskId(again));
    expect(parity().last).toMatchObject({ errors: 0, result: 'ok', action: 'correct' });
    expect(parity().history.length).toBeLessThanOrEqual(10);
    expect(hintKinds()).not.toContain('unraid.parity_errors');
    expect(
      (await refusal(call('POST', 'blackbox/unraid/parity/start', { correct: 'yes' }))).fieldErrors,
    ).toEqual({
      correct: 'Send true or false.',
    });
  });

  it('pauses, resumes and cancels a parity check', async () => {
    expect((await refusal(call('POST', 'blackbox/unraid/parity/pause'))).code).toBe('busy');
    fake.manage.holdTasks = true;
    const check = taskId(await call<Json>('POST', 'blackbox/unraid/parity/start'));
    const pause = taskId(await call<Json>('POST', 'blackbox/unraid/parity/pause'));
    fake.manage.finishTask(pause);
    expect(parity().state).toBe('paused');
    expect((await refusal(call('POST', 'blackbox/unraid/parity/pause'))).code).toBe('busy');
    const resume = taskId(await call<Json>('POST', 'blackbox/unraid/parity/resume'));
    fake.manage.finishTask(resume);
    expect(parity().state).toBe('running');
    const cancel = taskId(await call<Json>('POST', 'blackbox/unraid/parity/cancel'));
    fake.manage.finishTask(cancel);
    expect(await ended('blackbox', check)).toMatchObject({ status: 'error', message: 'cancelled' });
    expect(parity()).toMatchObject({ state: 'idle', last: { result: 'cancelled' } });
  });

  it('stops the array only when confirmed, and starts it again', async () => {
    const refused = await refusal(call('POST', 'blackbox/unraid/array/stop'));
    expect([refused.status, refused.code]).toEqual([400, 'confirm_required']);
    const operator = { ...admin, role: 'operator' as const };
    expect(
      (await refusal(call('POST', 'blackbox/unraid/array/stop', { confirm: true }, operator))).code,
    ).toBe('insufficient_role');
    expect((await refusal(call('POST', 'blackbox/unraid/array/stop', { confirm: true, now: 1 }))).code).toBe(
      'bad_request',
    );
    fake.manage.holdTasks = true;
    const stop = await call<Json>('POST', 'blackbox/unraid/array/stop', { confirm: true });
    expect(unraid().array.state).toBe('stopping');
    fake.manage.holdTasks = false;
    fake.manage.finishTask(taskId(stop));
    await ended('blackbox', taskId(stop));
    expect(unraid().array).toMatchObject({ state: 'stopped', state_raw: 'STOPPED' });
    expect(hintKinds()).toContain('unraid.array_stopped');
    expect((await refusal(call('POST', 'blackbox/unraid/parity/start'))).code).toBe('busy');
    expect((await refusal(call('POST', 'blackbox/unraid/mover'))).code).toBe('busy');
    await ended('blackbox', taskId(await call<Json>('POST', 'blackbox/unraid/array/start')));
    expect(unraid().array).toMatchObject({ state: 'started', state_raw: 'STARTED' });
    expect((await refusal(call('POST', 'blackbox/unraid/array/start'))).code).toBe('busy');
    expect(hintKinds()).not.toContain('unraid.array_stopped');
  });

  it('spins disks down and up, and runs the mover once at a time', async () => {
    const bad = await refusal(call('POST', 'blackbox/unraid/disks/disk9/spin-down'));
    expect([bad.code, bad.fieldErrors]).toEqual(['invalid_value', { disk: 'No disk of that name.' }]);
    const disks = () => unraid().array.disks as Json[];
    await ended('blackbox', taskId(await call<Json>('POST', 'blackbox/unraid/disks/parity/spin-down')));
    expect(disks()[0]).toMatchObject({ name: 'parity', spun_down: true, temp_c: null });
    expect(disks()[1]).toMatchObject({ name: 'disk1', spun_down: false });
    await ended('blackbox', taskId(await call<Json>('POST', 'blackbox/unraid/disks/all/spin-up')));
    expect(disks()[0]).toMatchObject({ spun_down: false, temp_c: 33 });

    fake.manage.holdTasks = true;
    const mover = taskId(await call<Json>('POST', 'blackbox/unraid/mover'));
    expect(unraid().array.mover_running).toBe(true);
    expect((await refusal(call('POST', 'blackbox/unraid/mover'))).code).toBe('busy');
    fake.manage.finishTask(mover);
    expect(unraid().array.mover_running).toBe(false);
  });

  it('checks and updates plugins, never Unraid itself', async () => {
    expect(taskId(await call<Json>('POST', 'blackbox/unraid/plugins/check'))).toMatch(/^unraid:/);
    const own = await refusal(
      call('POST', 'blackbox/unraid/plugins/unRAIDServer.plg/update', { confirm: true }),
    );
    expect([own.status, own.code]).toEqual([403, 'not_allowed']);
    expect(
      (await refusal(call('POST', 'blackbox/unraid/plugins/nope.plg/update', { confirm: true }))).code,
    ).toBe('not_found');
    expect((await refusal(call('POST', 'blackbox/unraid/plugins/unassigned.devices.plg/update'))).code).toBe(
      'confirm_required',
    );
    const up = await call<Json>('POST', 'blackbox/unraid/plugins/unassigned.devices.plg/update', {
      confirm: true,
    });
    await ended('blackbox', taskId(up));
    const plugins = () => unraid().plugins as Json[];
    expect(plugins().find((p) => p.file === 'unassigned.devices.plg')).toMatchObject({
      version: '2026.10.12',
      update: null,
    });
    expect(fake.details.blackbox?.hints).toContainEqual(
      expect.objectContaining({ kind: 'unraid.plugin_updates', title: '1 plugin update' }),
    );
    await ended(
      'blackbox',
      taskId(await call<Json>('POST', 'blackbox/unraid/plugins/all/update', { confirm: true })),
    );
    expect(plugins().every((p) => p.update === null)).toBe(true);
    expect(hintKinds()).not.toContain('unraid.plugin_updates');
  });

  it('updates a container from its template and checks for updates', async () => {
    expect(taskId(await call<Json>('POST', 'blackbox/unraid/containers/check'))).toMatch(/^unraid:/);
    expect((await refusal(call('POST', 'blackbox/guests/docker:plex/update'))).code).toBe('confirm_required');
    const t = await ended(
      'blackbox',
      taskId(await call<Json>('POST', 'blackbox/guests/docker:plex/update', { confirm: true })),
    );
    expect(t).toMatchObject({ status: 'ok', guest: 'docker:plex', type: 'container-update' });
    expect(fake.guest('blackbox', 'docker:plex')?.update_available).toBe(false);
    expect(hintKinds()).not.toContain('docker.update_available');
    const none = await refusal(
      call('POST', 'blackbox/guests/docker:tailscale-test/update', { confirm: true }),
    );
    expect([none.status, none.code, none.detail]).toEqual([
      403,
      'not_allowed',
      'There’s no template for this container.',
    ]);
    expect(
      (await refusal(call('POST', 'blackbox/guests/libvirt:pbs/update', { confirm: true }))).status,
    ).toBe(501);
    expect((await refusal(call('POST', 'basalt/guests/docker:grafana/update', { confirm: true }))).code).toBe(
      'unsupported',
    );
    expect((await refusal(call('POST', 'blackbox/guests/docker:nope/update', { confirm: true }))).code).toBe(
      'guest_not_found',
    );
  });

  it('sets autostart for Docker on unRAID and libvirt anywhere', async () => {
    const vm = await call<Json>('PUT', 'basalt/guests/libvirt:truenas-lab/autostart', { on: true });
    expect(vm).toMatchObject({ ok: true, changes: [{ key: 'autostart', old: 'false', new: 'true' }] });
    expect(fake.guest('basalt', 'libvirt:truenas-lab')?.autostart).toBe(true);
    const box = await call<Json>('PUT', 'blackbox/guests/docker:immich-redis/autostart', { on: true });
    expect(box.changes).toEqual([{ key: 'autostart', old: 'false', new: 'true' }]);
    expect((await refusal(call('PUT', 'basalt/guests/docker:grafana/autostart', { on: true }))).status).toBe(
      501,
    );
    expect((await refusal(call('PUT', 'basalt/guests/incus:nixbuild/autostart', { on: true }))).status).toBe(
      501,
    );
    expect((await refusal(call('PUT', 'blackbox/guests/libvirt:pbs/autostart', {}))).fieldErrors).toEqual({
      on: 'Send true or false.',
    });
    const pbs = fake.guest('blackbox', 'libvirt:pbs') as Json;
    pbs.self = true;
    const self = await refusal(call('PUT', 'blackbox/guests/libvirt:pbs/autostart', { on: false }));
    expect([self.status, self.code, self.detail]).toEqual([409, 'self_guest', 'That’s this Whombat itself.']);
  });

  it('archives unRAID notifications, one or all', async () => {
    const notes = () => unraid().notifications as Json[];
    const alert = String(notes()[0]?.id);
    expect(fake.details.blackbox?.hints).toContainEqual(
      expect.objectContaining({ kind: 'unraid.notification', entity: alert, severity: 'warning' }),
    );
    expect((await refusal(call('POST', 'blackbox/unraid/notifications/archive', { id: 'nope' }))).code).toBe(
      'not_found',
    );
    expect(await call<Json>('POST', 'blackbox/unraid/notifications/archive', { id: alert })).toMatchObject({
      ok: true,
    });
    expect(notes().map((n) => n.id)).not.toContain(alert);
    expect(fake.details.blackbox?.hints).toContainEqual(
      expect.objectContaining({ kind: 'unraid.notification', severity: 'info' }),
    );
    await call('POST', 'blackbox/unraid/notifications/archive');
    expect(notes()).toEqual([]);
    expect(hintKinds()).not.toContain('unraid.notification');
  });

  it('refuses when managing is off, and on a server without unRAID', async () => {
    const switches = fake.switchesOf('blackbox') as Json;
    switches.manage = false;
    const off = await refusal(call('POST', 'blackbox/unraid/parity/start'));
    expect([off.status, off.code]).toEqual([403, 'manage_disabled']);
    expect((await refusal(call('PUT', 'blackbox/guests/docker:plex/autostart', { on: false }))).code).toBe(
      'manage_disabled',
    );
    const none = await refusal(call('POST', 'basalt/unraid/mover'));
    expect([none.status, none.code]).toEqual([501, 'unsupported']);
  });
});
