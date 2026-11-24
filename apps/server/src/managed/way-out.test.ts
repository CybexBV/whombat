/**
 * Whombat's own way out (monitoring.md MON-08): the default gateway from the kernel's route table, which step fails
 * first, two minutes before an outage opens, its words, and the targets it reaches the internet at.
 */
import { describe, expect, it } from 'vitest';
import {
  defaultGateway,
  nextWayOut,
  probeWayOut,
  WAY_OUT_CONFIRM_MS,
  type WayOutProbes,
  wayOutBody,
  wayOutHistoryWords,
  wayOutItem,
  wayOutTargets,
  wayOutTitle,
} from './way-out';

const ROUTES = `Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
eth0\t00000000\t0100640A\t0003\t0\t0\t100\t00000000\t0\t0\t0
eth0\t0000640A\t00000000\t0001\t0\t0\t100\t0000FFFF\t0\t0\t0
`;

describe('defaultGateway', () => {
  it('reads the default route’s gateway, little-endian', () => {
    expect(defaultGateway(ROUTES)).toBe('10.100.0.1');
  });
  it('has none without a default route', () => {
    expect(
      defaultGateway(
        ROUTES.split('\n')
          .filter((l) => !l.includes('0100640A'))
          .join('\n'),
      ),
    ).toBeNull();
    expect(defaultGateway('')).toBeNull();
  });
});

/** A network where each part answers or not. */
function network(parts: { router?: boolean; internet?: boolean; names?: boolean; gateway?: string | null }) {
  const probes: WayOutProbes = {
    gateway: async () => (parts.gateway === undefined ? '10.100.0.1' : parts.gateway),
    answers: async (host) => (host === '10.100.0.1' ? parts.router !== false : parts.internet !== false),
    lookup: async () => (parts.names === false ? [] : ['203.0.113.7']),
  };
  return probes;
}
const targets = [
  { host: 'app.example.com', port: 443 },
  { host: '1.1.1.1', port: 443 },
];

describe('probeWayOut', () => {
  it('says the first step that fails: router, then internet, then name lookups', async () => {
    expect(await probeWayOut(network({}), targets, new Map())).toBeNull();
    expect(await probeWayOut(network({ router: false, internet: false }), targets, new Map())).toBe('router');
    expect(await probeWayOut(network({ gateway: null }), targets, new Map())).toBe('router');
    expect(await probeWayOut(network({ internet: false }), targets, new Map())).toBe('internet');
    expect(await probeWayOut(network({ names: false }), targets, new Map())).toBe('names');
  });

  it('reaches a named target at the address it last found when lookups stop', async () => {
    const known = new Map<string, string>();
    await probeWayOut(network({}), targets, known);
    expect(known.get('app.example.com')).toBe('203.0.113.7');
    const reached: string[] = [];
    const probes = network({ names: false });
    await probeWayOut(
      {
        ...probes,
        answers: async (host, port) => {
          reached.push(host);
          return probes.answers(host, port);
        },
      },
      targets,
      known,
    );
    expect(reached).toContain('203.0.113.7');
  });
});

describe('nextWayOut', () => {
  const t0 = new Date('2026-11-24T14:02:00Z');
  const at = (ms: number) => new Date(t0.getTime() + ms);

  it('opens an outage after two minutes of the same step failing, from when it started', () => {
    let memory = { failing: null } as Parameters<typeof nextWayOut>[0];
    let change = nextWayOut(memory, 'internet', t0, null);
    expect(change.open).toBeNull();
    memory = change.memory;
    change = nextWayOut(memory, 'internet', at(60_000), null);
    expect(change.open).toBeNull();
    memory = change.memory;
    change = nextWayOut(memory, 'internet', at(WAY_OUT_CONFIRM_MS), null);
    expect(change.open).toEqual({ step: 'internet', startedAt: t0 });
  });

  it('one lost answer is nothing; the first working pass ends an outage', () => {
    const blip = nextWayOut({ failing: null }, 'internet', t0, null);
    expect(nextWayOut(blip.memory, null, at(60_000), null)).toMatchObject({ open: null, close: false });
    expect(
      nextWayOut({ failing: { step: 'internet', since: t0 } }, null, at(600_000), { step: 'internet' }),
    ).toMatchObject({
      open: null,
      close: true,
    });
  });

  it('a different step failing for two minutes ends the old outage and opens its own', () => {
    const memory = { failing: { step: 'router' as const, since: t0 } };
    const change = nextWayOut(memory, 'router', at(WAY_OUT_CONFIRM_MS), { step: 'internet' });
    expect(change).toMatchObject({ open: { step: 'router' }, close: true });
  });
});

describe('the words', () => {
  const since = new Date('2026-11-24T13:02:00Z');
  it('says which step fails since when, and what it takes with it', () => {
    expect(wayOutTitle('internet', since, 'Europe/Amsterdam')).toBe('The internet is down since 14:02');
    expect(wayOutTitle('names', since, 'Europe/Amsterdam')).toContain('Name lookups don’t work');
    expect(wayOutTitle('router', since, 'Europe/Amsterdam')).toContain('The router doesn’t answer');
    expect(wayOutBody('internet', ['GitHub', 'Google', 'Hetzner', 'Mollie', 'Plausible'])).toContain(
      'GitHub, Google and 3 more can’t be reached until it’s back.',
    );
    const item = wayOutItem(
      { id: 'wo_1', step: 'internet', startedAt: since },
      { timeZone: 'UTC', takes: [] },
    );
    expect(item).toMatchObject({
      kind: 'alert',
      severity: 'bad',
      nature: 'you',
      ref: { kind: 'way_out', id: 'wo_1' },
    });
  });

  it('says an outage that is over as history', () => {
    const row = { step: 'internet' as const, startedAt: since, endedAt: new Date('2026-11-24T13:31:00Z') };
    expect(wayOutHistoryWords(row, 'Europe/Amsterdam')).toBe('The internet was down 14:02–14:31');
  });
});

describe('wayOutTargets', () => {
  it('reaches Whombat’s own service and an anycast address; two anycast without the service', () => {
    expect(wayOutTargets({ appUrl: 'https://app.example.com' })).toEqual([
      { host: 'app.example.com', port: 443 },
      { host: '1.1.1.1', port: 443 },
    ]);
    expect(wayOutTargets({ appUrl: 'http://localhost:5180' }).map((t) => t.host)).toEqual([
      '1.1.1.1',
      '9.9.9.9',
    ]);
    expect(wayOutTargets({ targets: '203.0.113.1:443, [2001:db8::1]:53' })).toEqual([
      { host: '203.0.113.1', port: 443 },
      { host: '2001:db8::1', port: 53 },
    ]);
  });
});
