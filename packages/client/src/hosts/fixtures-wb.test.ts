import { HostFirewall, HostManageReadResult, HostTask } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { createHostsFixtures, type HostsFixtureAnswer } from './fixtures';

const NOW = Date.parse('2026-10-17T12:00:00Z');

const field = (a: HostsFixtureAnswer | null, k: string): unknown =>
  (a?.body as Record<string, unknown> | undefined)?.[k];
const count = (a: HostsFixtureAnswer | null) => (field(a, 'items') as unknown[] | undefined)?.length ?? 0;

function world() {
  const { handle } = createHostsFixtures(NOW);
  const get = (path: string, query: Record<string, string> = {}) =>
    handle({ method: 'GET', path, query, body: {} });
  const manage = (body: Record<string, unknown>) =>
    handle({ method: 'POST', path: '/servers/pve-02/manage', query: {}, body });
  return { get, manage };
}

describe('stream WB fixtures', () => {
  it('list backup jobs and leave out the guests they don’t cover', () => {
    const { get } = world();
    const jobs = get('/servers/pve-02/manage', { op: 'backupjob.list' })?.body;
    expect(HostManageReadResult.safeParse(jobs).error).toBeUndefined();
    const g = get('/servers/pve-02/guests/pve:144')?.body as { backupJob: boolean };
    expect(g.backupJob).toBe(false);
  });

  it('run a backup as a task whose log grows, then keep the backup', () => {
    const { get, manage } = world();
    const before = count(get('/servers/pve-02/manage', { op: 'backup.list', guestId: 'pve:118' }));
    const out = manage({
      op: 'backup.create',
      guestId: 'pve:118',
      params: { storage: 'local', mode: 'snapshot' },
    })?.body as { task: { id: string } };
    const path = `/servers/pve-02/tasks/${encodeURIComponent(out.task.id)}`;
    let next = 0;
    let lines = 0;
    let last: HostTask | undefined;
    for (let i = 0; i < 10; i++) {
      last = HostTask.parse(get(path, { logStart: String(next) })?.body);
      lines += last.log?.length ?? 0;
      next = last.logNext ?? next;
      if (last.status !== 'running') break;
    }
    expect(last?.status).toBe('warning');
    expect(last?.message).toBe('WARNINGS: 1');
    expect(lines).toBe(next);
    expect(lines).toBeGreaterThan(5);
    const after = count(get('/servers/pve-02/manage', { op: 'backup.list', guestId: 'pve:118' }));
    expect(after).toBe(before + 1);
  });

  it('move a firewall rule with its digest and refuse a stale one', () => {
    const { get, manage } = world();
    const read = () =>
      HostFirewall.parse(
        field(get('/servers/pve-02/manage', { op: 'firewall.get', guestId: 'pve:118' }), 'firewall'),
      );
    const fw = read();
    expect(
      manage({
        op: 'firewall.rule_update',
        guestId: 'pve:118',
        params: { pos: 0, moveTo: 1 },
        digest: fw.rulesDigest,
      })?.status,
    ).toBe(200);
    expect(read().rules.map((r) => r.comment)).toEqual(['Web', 'SSH from home', 'Old admin port']);
    expect(
      manage({ op: 'firewall.rule_delete', guestId: 'pve:118', params: { pos: 0 }, digest: fw.rulesDigest })
        ?.status,
    ).toBe(409);
  });
});
