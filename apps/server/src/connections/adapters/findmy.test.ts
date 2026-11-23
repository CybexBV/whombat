/**
 * The assistant's `findmy_people` without Postgres (docs/decisions/findmy-connection.md): it reads first when the last
 * read is old, answers the last read with its age and why when it can't, picks one person by name, and never gives a
 * spot on a map. A made-up Mac behind a stand-in hosts service; the clock and the wait are the test's.
 */
import { describe, expect, it } from 'vitest';
import type { HostsActor } from '../../hosts/client';
import { FindMyStore } from '../../hosts/findmy';
import type { HostsService } from '../../hosts/service';
import { FakeFindMyMac } from '../../hosts/testing/fake-findmy';
import { ConnectionArgumentError } from '../request';
import { FINDMY_ADAPTER, type FindMyPeopleDeps, findMyPeopleTool, matchPeople } from './findmy';
import type { AdapterContext } from './types';

const MIN = 60_000;
const ACTOR: HostsActor = { id: 'prn_dusty', name: 'Dusty for Mara', role: 'admin' };

/** `waitEnds`: the tool's 45-second wait is over at once (a read that takes longer). */
function world(options: { waitEnds?: boolean } = {}) {
  const fake = new FakeFindMyMac();
  let now = Date.parse('2026-11-23T10:00:00.000Z');
  const store = new FindMyStore({ now: () => now, sleep: async () => {} });
  const hosts = {
    call: fake.call.bind(fake),
    fleetRaw: async () => ({ servers: [] }),
  } as unknown as HostsService;
  const deps: FindMyPeopleDeps = {
    scope: async () => ({ hosts, call: {} as never, personId: null, actor: () => ACTOR }),
    store: () => store,
    wait: () => (options.waitEnds ? Promise.resolve() : new Promise<void>(() => {})),
    now: () => now,
  };
  const ctx = {
    baseUrl: 'whombat-hosts:',
    fields: { mac: 'studio' },
    bases: {},
    send: async () => {
      throw new Error('Find My sends nothing to its base');
    },
  } as AdapterContext;
  const tool = findMyPeopleTool(deps);
  return {
    fake,
    store,
    ctx,
    advance: (ms: number) => {
      now += ms;
    },
    ask: async (args: Record<string, unknown> = {}) => {
      const out = await tool(ctx, args);
      return { out, body: JSON.parse(out.content) as Record<string, unknown> };
    },
  };
}

describe('findmy_people', () => {
  it('reads first, then answers names, places, streets and when Find My saw them, never a spot on a map', async () => {
    const w = world();
    const { out, body } = await w.ask();
    expect(out.isError).toBe(false);
    expect(body).toMatchObject({ mac: 'studio', read: 'just now' });
    const people = body.people as Record<string, unknown>[];
    expect(people.map((p) => p.name)).toEqual(['Mara Visser', 'Ruben Visser', 'Noor Visser']);
    expect(people[0]).toMatchObject({ place: 'Home', street: 'Damrak 1, Amsterdam', nearby: true });
    expect(people[2]).toMatchObject({ place: null });
    expect(out.content).not.toMatch(/"(lat|lon|location|accuracyM|imageB64)"/);
    expect(w.fake.ops()).toContain('ui.open');
  });

  it('doesn’t read again within two minutes', async () => {
    const w = world();
    await w.ask();
    const steps = w.fake.steps.length;
    w.advance(MIN);
    const { body } = await w.ask();
    expect(w.fake.steps.length).toBe(steps);
    expect(body.read).toBe('1 min ago');
  });

  it('answers one person by name or first name, and says who is there when nobody is called that', async () => {
    const w = world();
    const { body } = await w.ask({ person: 'ruben' });
    expect((body.people as { name: string }[]).map((p) => p.name)).toEqual(['Ruben Visser']);
    const none = await w.ask({ person: 'Ilse' });
    expect(none.body.people).toEqual([]);
    expect(String(none.body.notFound)).toContain('Mara Visser');
  });

  it('answers the last read with its age and why when someone is using the Mac', async () => {
    const w = world();
    await w.ask();
    w.fake.idle = 5;
    w.advance(10 * MIN);
    const { out, body } = await w.ask();
    expect(out.isError).toBe(false);
    expect(body.read).toBe('10 min ago');
    expect(String(body.note)).toContain('10 min ago');
    expect(String(body.note)).toContain('using');
    expect((body.people as unknown[]).length).toBe(3);
  });

  it('says why when nothing could be read, and that it is still reading after its wait', async () => {
    const w = world();
    w.fake.idle = 5;
    const busy = await w.ask();
    expect(busy.out.isError).toBe(true);
    expect(String(busy.body.error)).toContain('studio');

    // The wait ends before the read does.
    const slow = world({ waitEnds: true });
    let release = () => {};
    slow.fake.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { out, body } = await slow.ask();
    expect(out.isError).toBe(true);
    expect(String(body.error)).toContain('still reading');
    release();
    await slow.store.idle('studio');
  });

  it('refuses outside an assistant’s turn and a person that isn’t a name', async () => {
    const w = world();
    await expect(FINDMY_ADAPTER.findmy_people?.(w.ctx, {})).rejects.toBeInstanceOf(ConnectionArgumentError);
    await expect(w.ask({ person: '' })).rejects.toBeInstanceOf(ConnectionArgumentError);
    await expect(w.ask({ lat: 52 })).rejects.toBeInstanceOf(ConnectionArgumentError);
  });
});

describe('a person by name', () => {
  const people = ['Mara Visser', 'Ruben Visser', 'Marat Jansen'].map((name) => ({
    id: '0123456789ab',
    name,
    place: null,
    address: null,
    when: null,
    nearby: false,
    location: null,
  }));

  it('is the whole name, else the first name, else a part of it', () => {
    expect(matchPeople(people, 'mara visser').map((p) => p.name)).toEqual(['Mara Visser']);
    expect(matchPeople(people, 'Mara').map((p) => p.name)).toEqual(['Mara Visser']);
    expect(matchPeople(people, 'visser').map((p) => p.name)).toEqual(['Mara Visser', 'Ruben Visser']);
  });
});
