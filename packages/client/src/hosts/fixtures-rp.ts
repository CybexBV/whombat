/**
 * Point them here in the fixture world (contracts 0.117, CT-911, CT-912; Whombat backup-file.md BF-15, BF-16; app
 * backup-file.md AP-4419): this Whombat moved from 10.100.1.160 to 10.100.1.158 and three servers haven't found it
 * (`hosts.addressChange`); `hosts.repoint` starts a scripted job that `hosts.getRepoint` walks in two reads — pve-01 is
 * pointed here and pve-02 is being pointed, then pve-02 is pointed too and blackbox has no key in the owner's Vault
 * (`no_key`). Deterministic (reads, not a
 * clock). Once a job is done the change answers only the servers still waiting. Wraps `createHostsFixtures`' routes.
 */
import type { HostAddressChange, HostRepoint, HostRepointServer } from '@whombat/core/domain';
import type { HostsFixtureAnswer, HostsFixtureRequest, HostsFixtureWorld } from './fixtures';

type Handle = (req: HostsFixtureRequest) => HostsFixtureAnswer | null;

const FROM = '10.100.1.160';
const TO = '10.100.1.158';
const WAITING = ['pve-01', 'pve-02', 'blackbox'];
/** The server whose address has no key in the owner's Vault. */
const NO_KEY = 'blackbox';

export function withRp(base: Handle, ctx: { world: HostsFixtureWorld; now: number }): Handle {
  const { world, now } = ctx;
  const changedAt = new Date(now - 9 * 60_000).toISOString();
  /** Servers still looking for the old address. */
  const waiting = new Set(WAITING.filter((id) => world.servers.some((s) => s.id === id)));
  const jobs = new Map<string, { view: HostRepoint; reads: number }>();
  let seq = 0;

  const server = (id: string) => {
    const row = world.servers.find((s) => s.id === id);
    const address = world.details.get(id)?.server.address ?? null;
    return { id, name: row?.name ?? id, address };
  };

  const change = (): HostAddressChange | null =>
    waiting.size ? { from: FROM, to: TO, changedAt, waiting: [...waiting].map(server) } : null;

  /** One read further: the first read has the first server done and the next one pointing, the second the rest. */
  function advance(job: { view: HostRepoint; reads: number }): HostRepoint {
    job.reads++;
    const reached = job.reads >= 2 ? job.view.servers.length : 1;
    const servers: HostRepointServer[] = job.view.servers.map((s, i) => {
      if (i > reached) return { ...s, state: 'waiting' };
      if (i === reached) return { ...s, state: 'pointing' };
      if (s.id === NO_KEY) return { ...s, state: 'no_key' };
      waiting.delete(s.id);
      return { ...s, state: 'pointed' };
    });
    const done = reached >= servers.length;
    job.view = {
      ...job.view,
      servers,
      state: done ? 'done' : 'running',
      finishedAt: done ? (job.view.finishedAt ?? new Date(now + job.reads * 1_000).toISOString()) : null,
    };
    return job.view;
  }

  return (req) => {
    const { method, path, body } = req;
    if (method === 'GET' && path === '/address-change') return { status: 200, body: change() };
    if (method === 'POST' && path === '/repoints') {
      const ids = Array.isArray(body.servers) ? (body.servers as string[]) : [];
      const view: HostRepoint = {
        id: `rpt_fx${++seq}`,
        to: TO,
        state: 'running',
        servers: ids.map((id) => ({ ...server(id), state: 'waiting', error: null })),
        startedAt: new Date(now).toISOString(),
        finishedAt: null,
      };
      jobs.set(view.id, { view, reads: 0 });
      return { status: 202, body: view };
    }
    const one = /^\/repoints\/([^/]+)$/.exec(path);
    if (method === 'GET' && one) {
      const job = jobs.get(one[1] ?? '');
      return job
        ? { status: 200, body: advance(job) }
        : { status: 404, body: { error: { code: 'not_found', message: 'That job isn’t here.' } } };
    }
    return base(req);
  };
}
