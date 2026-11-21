/** Updates in the fixture worlds (server-updates-app.md AP-2878): the four servers' states and a task's life. */
import { HostServerDetail, HostTask } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { createHostsFixtures } from './fixtures';
import { withUpdatesFixtures } from './fixtures-swu';

const NOW = Date.parse('2026-10-19T12:00:00Z');

function world() {
  let t = NOW;
  const handle = withUpdatesFixtures(createHostsFixtures(NOW).handle, { now: NOW, clock: () => t });
  const get = (path: string, query: Record<string, string> = {}) =>
    handle({ method: 'GET', path, query, body: {} });
  const post = (path: string, body: Record<string, unknown>) =>
    handle({ method: 'POST', path, query: {}, body });
  // Checked against the schema, then read whole (the 0.98.0 fields aren't in an older one).
  const system = (id: string) => {
    const body = get(`/servers/${id}`)?.body as HostServerDetail;
    HostServerDetail.parse(body);
    return body.health?.system as NonNullable<NonNullable<HostServerDetail['health']>['system']> &
      Record<string, unknown>;
  };
  return { get, post, system, tick: (ms: number) => (t += ms) };
}

describe('the updates fixture world', () => {
  it('starts with updates waiting, an install running and a restart waiting', () => {
    const w = world();
    expect(w.system('pve-02')).toMatchObject({ updates: 4, securityUpdates: 1, packageTask: null });
    expect(w.system('thetitan').packageTask).toMatchObject({ op: 'install' });
    expect(w.system('the-falcon')).toMatchObject({
      updates: 0,
      rebootRequired: true,
      packageLast: { op: 'install', status: 'ok', installed: 12 },
    });
    const hints = HostServerDetail.parse(w.get('/servers/pve-02')?.body).hints.map((h) => h.kind);
    expect(hints).toContain('system.updates');
  });

  it('installs as a task whose log grows, then reads the list and the restart need again', () => {
    const w = world();
    const started = w.post('/servers/pve-02/manage', {
      op: 'packages.install',
      params: {},
      platform: 'host',
    });
    expect(started?.status).toBe(202);
    const id = (started?.body as { task: { id: string } } | undefined)?.task.id ?? '';
    expect(id).toMatch(/^pkg:[0-9a-f]{16}$/);
    expect(w.post('/servers/pve-02/manage', { op: 'packages.check', params: {} })?.status).toBe(409);
    expect(w.post('/servers/pve-02/manage', { op: 'task.stop', params: { task: id } })?.status).toBe(409);
    const first = HostTask.parse(w.get(`/servers/pve-02/tasks/${id}`, { logStart: '0' })?.body);
    expect([first.status, first.cancellable, first.log?.length]).toEqual(['running', false, 1]);
    w.tick(10 * 60_000);
    const done = w.get(`/servers/pve-02/tasks/${id}`, { logStart: '1' })?.body as HostTask & {
      packages?: { installed: number };
    };
    expect(done.status).toBe('ok');
    expect(done.packages?.installed).toBe(4);
    expect(w.system('pve-02')).toMatchObject({
      updates: 0,
      rebootRequired: true,
      packageTask: null,
      packageLast: { op: 'install', status: 'ok', installed: 4 },
    });
    w.post('/servers/pve-02/actions', { action: 'host_reboot', confirm: true });
    expect(w.system('pve-02').rebootRequired).toBe(false);
  });

  it('lets a check be stopped', () => {
    const w = world();
    const id = (
      w.post('/servers/pve-02/manage', { op: 'packages.check', params: {} })?.body as
        | { task: { id: string } }
        | undefined
    )?.task.id;
    expect(HostTask.parse(w.get(`/servers/pve-02/tasks/${id}`)?.body).cancellable).toBe(true);
    expect(w.post('/servers/pve-02/manage', { op: 'task.stop', params: { task: id } })?.status).toBe(200);
    expect(w.system('pve-02').packageLast).toMatchObject({ op: 'check', status: 'failed' });
  });

  it('lists the waiting packages for Look inside', () => {
    const w = world();
    const body = w.get('/servers/pve-02/inspect/updates')?.body as { items: { name: string }[] } | undefined;
    expect(body?.items.map((i) => i.name)).toContain('openssl');
  });
});
