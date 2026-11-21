import { HostEnrollment, HostFleet, HostInstall, HostPendingEnrollment } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { createHostsFixtures } from './fixtures';

const NOW = Date.parse('2026-10-18T10:00:00Z');

function world() {
  const { handle } = createHostsFixtures(NOW);
  const start = (body: Record<string, unknown>) =>
    handle({ method: 'POST', path: '/installs', query: {}, body });
  const read = (id: string) =>
    HostInstall.parse(handle({ method: 'GET', path: `/installs/${id}`, query: {}, body: {} })?.body);
  /** Every state the job shows, read until it ends. */
  const walk = (body: Record<string, unknown>) => {
    const started = HostInstall.parse(start(body)?.body);
    const seen = [started.state];
    let last = started;
    for (let i = 0; i < 20 && last.finishedAt === null; i++) {
      last = read(started.id);
      if (seen[seen.length - 1] !== last.state) seen.push(last.state);
    }
    return { seen, last };
  };
  const fleet = () =>
    HostFleet.parse(handle({ method: 'GET', path: '/fleet', query: {}, body: {} })?.body).servers;
  return { handle, start, read, walk, fleet };
}

const signIn = (patch: Record<string, unknown> = {}) => ({
  address: '10.100.0.14',
  username: 'root',
  auth: { kind: 'password', password: 'hunter2' },
  control: 'full',
  ...patch,
});

describe('stream SI’s fixtures (Add a server by signing in once)', () => {
  it('walk pve-03 from signing in to ready, and add it to the fleet when it reports', () => {
    const { walk, fleet } = world();
    const { seen, last } = walk(signIn({ keepKey: { create: true } }));
    expect(seen).toEqual(['connecting', 'installing', 'waiting', 'ready']);
    expect(last).toMatchObject({
      serverId: 'pve-03',
      serverName: 'pve-03',
      system: 'Proxmox VE 9.0 · Debian 13 · amd64',
      hostKeyNew: true,
      keptKey: true,
      already: false,
    });
    expect(last.hostKey?.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(fleet().find((s) => s.id === 'pve-03')?.status).toBe('ok');
  });

  it('update a server that is already added (SI-08) and give a taken name a free one (SI-07)', () => {
    const { walk } = world();
    expect(walk(signIn({ address: '10.100.1.21' })).last).toMatchObject({
      state: 'ready',
      already: true,
      serverId: 'pve-01',
    });
    expect(walk(signIn({ address: '10.100.0.22' })).last.serverName).toBe('pve-02-2');
  });

  it('refuse a wrong password, and say where a server can’t reach this Whombat', () => {
    const { walk } = world();
    const wrong = walk(signIn({ auth: { kind: 'password', password: 'wrong' } }));
    expect(wrong.seen).toEqual(['connecting', 'failed']);
    expect(wrong.last.error).toEqual({
      code: 'sign_in_failed',
      message: 'Couldn’t sign in to 10.100.0.14: the user name or password isn’t right.',
    });
    const far = walk(signIn({ address: '10.20.0.5' }));
    expect(far.last.error?.code).toBe('cant_reach_whombat');
    expect(far.last.detail).toContain('install.sh: cannot reach');
    const sudo = walk(signIn({ username: 'john', auth: { kind: 'vault', entryId: 'vlt_1' } }));
    expect(sudo.last.error?.code).toBe('sudo_password_needed');
  });

  it('turn away a body that isn’t one, and a job that isn’t there', () => {
    const { start, handle } = world();
    expect(start({ address: '10.100.0.14' })?.status).toBe(400);
    expect(handle({ method: 'GET', path: '/installs/nope', query: {}, body: {} })?.status).toBe(404);
  });

  it('make a pre-approved command for a level, which adds web-04 once it has run', () => {
    const { handle, fleet } = world();
    const made = HostEnrollment.parse(
      handle({ method: 'POST', path: '/enrollments', query: {}, body: { control: 'operate' } })?.body,
    );
    expect(made.installCommand).toMatch(/--token \S+ --control operate$/);
    expect(made).toMatchObject({ control: 'operate', preApproved: true });
    const list = () => {
      const body = handle({ method: 'GET', path: '/enrollments', query: { state: 'all' }, body: {} })?.body;
      return (body as { items: unknown[] }).items.map((x) => HostPendingEnrollment.parse(x));
    };
    expect(list().find((e) => e.id === made.id)?.state).toBe('issued');
    expect(list().find((e) => e.id === made.id)).toMatchObject({ state: 'approved', serverId: 'web-04' });
    expect(fleet().some((s) => s.id === 'web-04')).toBe(true);
    // Without a level it is the command it always was.
    const old = HostEnrollment.parse(
      handle({ method: 'POST', path: '/enrollments', query: {}, body: {} })?.body,
    );
    expect(old.installCommand).not.toContain('--control');
  });
});
