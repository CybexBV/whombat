/** Add a server in the one-Whombat demo world (server-signin-mobile.md AP-1714): its answers are the contracts'. */
import { type AnyEndpoint, api, type HostInstall, type RealtimeEvent } from '@whombat/core';
import { at } from '@whombat/fixtures';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { FIXTURE_ORIGIN } from '../data/config';
import { createClock } from '../lib/time';
import { ADD_SERVER_CHAT_ID } from './assistant';
import { createFixtureServer } from './fixture-server';

const burrow = 'burrow-hq';

function setup(si = false) {
  const timers: { fn: () => void; ms: number }[] = [];
  const now = createClock(new Date(at('14:05')), Date.now());
  const server = createFixtureServer({
    inner: createFixtureFetch(),
    now,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    assistant: true,
    si,
  });
  const events: RealtimeEvent[] = [];
  server.realtime.onEvent((event) => events.push(event));
  server.realtime.connect();
  /** Runs the timers due by `ms` after the start, in order. */
  const runUntil = (ms: number) => {
    const due = timers.filter((t) => t.ms <= ms).sort((a, b) => a.ms - b.ms);
    for (const t of due) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
  };
  return { server, events, runUntil };
}

async function call<T = unknown>(
  s: ReturnType<typeof setup>,
  ep: AnyEndpoint,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; data: T }> {
  const res = await s.server.fetch(`${FIXTURE_ORIGIN}/api/v1/burrows/${burrow}${path}`, init);
  const data = (await res.json()) as unknown;
  if (res.ok) {
    const parsed = ep.response.safeParse(data);
    if (!parsed.success) throw new Error(`${ep.id}: ${parsed.error.message}`);
  }
  return { status: res.status, data: data as T };
}

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const signIn = (address: string, extra: Record<string, unknown> = {}) =>
  post({
    address,
    username: 'root',
    auth: { kind: 'password', password: 'secret' },
    control: 'full',
    ...extra,
  });

describe('Add a server in the demo world', () => {
  it('walks pve-03 through its steps, a hosts.install frame on each, and adds it', async () => {
    const s = setup();
    const started = await call<HostInstall>(
      s,
      api.hosts.startInstall,
      '/hosts/installs',
      signIn('10.100.0.14'),
    );
    expect(started.status).toBe(202);
    expect(started.data.state).toBe('connecting');
    const read = async () =>
      (await call<HostInstall>(s, api.hosts.getInstall, `/hosts/installs/${started.data.id}`)).data;
    s.runUntil(1000);
    expect((await read()).hostKey?.fingerprint).toMatch(/^SHA256:q3Vx.*T8w$/);
    s.runUntil(4000);
    expect(await read()).toMatchObject({ state: 'installing', system: 'Proxmox VE 9.0 · Debian 13 · amd64' });
    s.runUntil(5000);
    expect(await read()).toMatchObject({ state: 'waiting', serverId: 'pve-03', serverName: 'pve-03' });
    s.runUntil(7000);
    expect(await read()).toMatchObject({ state: 'ready', keptKey: false });
    expect(
      s.events.filter((e) => e.type === 'hosts.install').map((e) => (e as { state: string }).state),
    ).toEqual(['installing', 'waiting', 'ready']);
    const fleet = await call<{ servers: { id: string }[] }>(s, api.hosts.fleet, '/hosts/fleet');
    expect(fleet.data.servers.map((x) => x.id)).toContain('pve-03');
    await call(s, api.hosts.getServer, '/hosts/servers/pve-03');
  });

  it('plays the web’s scripts: a wrong password, a server that can’t reach it, one added before, a taken name', async () => {
    const s = setup();
    const run = async (init: RequestInit) => {
      const { data } = await call<HostInstall>(s, api.hosts.startInstall, '/hosts/installs', init);
      s.runUntil(10_000);
      return (await call<HostInstall>(s, api.hosts.getInstall, `/hosts/installs/${data.id}`)).data;
    };
    expect(
      await run(
        post({
          address: '10.100.0.14',
          username: 'root',
          auth: { kind: 'password', password: 'wrong' },
          control: 'full',
        }),
      ),
    ).toMatchObject({
      state: 'failed',
      error: {
        code: 'sign_in_failed',
        message: 'Couldn’t sign in to 10.100.0.14: the user name or password isn’t right.',
      },
    });
    const far = await run(signIn('10.20.0.5'));
    expect(far).toMatchObject({ state: 'failed', error: { code: 'cant_reach_whombat' } });
    expect(far.error?.message).toBe(
      '10.20.0.5 can’t reach this Whombat at 10.100.1.5:8443. Is it on another network?',
    );
    expect(far.detail).toContain('install.sh: cannot reach');
    expect(await run(signIn('10.100.1.11', { control: 'watch' }))).toMatchObject({
      state: 'ready',
      already: true,
      serverName: 'pve-01',
      control: 'watch',
    });
    expect(await run(signIn('10.100.0.22'))).toMatchObject({ state: 'ready', serverName: 'pve-02-2' });
    expect(
      await run(
        post({
          address: '10.100.0.50',
          username: 'mara',
          auth: { kind: 'vault', entryId: 'vlt_deploykey' },
          control: 'full',
        }),
      ),
    ).toMatchObject({ state: 'failed', error: { code: 'sudo_password_needed' } });
  });

  it('makes the pre-approved command for the level, which runs on the second read', async () => {
    const s = setup();
    const made = await call<{ id: string; installCommand: string; control: string; preApproved: boolean }>(
      s,
      api.hosts.createEnrollment,
      '/hosts/enrollments',
      post({ control: 'operate' }),
    );
    expect(made.status).toBe(201);
    expect(made.data).toMatchObject({ control: 'operate', preApproved: true });
    expect(made.data.installCommand).toMatch(/--control operate$/);
    const all = () =>
      call<{ items: { id: string; state: string; serverId?: string | null }[] }>(
        s,
        api.hosts.listEnrollments,
        '/hosts/enrollments?state=all',
      );
    expect((await all()).data.items.find((e) => e.id === made.data.id)?.state).toBe('issued');
    expect((await all()).data.items.find((e) => e.id === made.data.id)).toMatchObject({
      state: 'approved',
      serverId: 'web-04',
    });
    // No body (an older app): still a command.
    expect((await call(s, api.hosts.createEnrollment, '/hosts/enrollments', post())).status).toBe(201);
  });

  it('with `si` on: nas-02 waits for you on Home and in Waiting for you, and Neo’s card is in a chat', async () => {
    const s = setup(true);
    const home = await call<{ needsYou: { id: string; actions: { href?: string }[] }[] }>(
      s,
      api.home.overview,
      '/home',
    );
    const item = home.data.needsYou.find((i) => i.id === 'hosts.enrollment:enr_nas02');
    expect(item?.actions[0]?.href).toBe('/things/servers?add=1');
    const waiting = await call<{ items: { id: string }[] }>(
      s,
      api.hosts.listEnrollments,
      '/hosts/enrollments?state=pending',
    );
    expect(waiting.data.items.map((e) => e.id)).toEqual(['enr_nas02']);
    const approved = await call<{ serverId: string }>(
      s,
      api.hosts.approveEnrollment,
      '/hosts/enrollments/enr_nas02/approve',
      post({ name: 'nas-02' }),
    );
    expect(approved.data.serverId).toBe('nas-02');
    expect(
      (await call<{ items: unknown[] }>(s, api.hosts.listEnrollments, '/hosts/enrollments')).data.items,
    ).toEqual([]);
    const messages = await call<{ messages: { card: { kind: string; blocks?: unknown } | null }[] }>(
      s,
      api.messages.list,
      `/conversations/${ADD_SERVER_CHAT_ID}/messages`,
    );
    expect(messages.data.messages.some((m) => m.card?.kind === 'guide')).toBe(true);
    // Mara's SSH keys for the pickers.
    const vault = await call<{ entries: { id: string; kind: string }[] }>(s, api.vault.list, '/vault');
    expect(vault.data.entries.filter((e) => e.kind === 'ssh').map((e) => e.id)).toEqual([
      'vlt_deploykey',
      'vlt_homelabkey',
    ]);
  });

  it('keeps Home as mock 4 has it without `si`', async () => {
    const s = setup();
    const home = await call<{ needsYou: unknown[] }>(s, api.home.overview, '/home');
    expect(home.data.needsYou).toHaveLength(3);
  });
});
