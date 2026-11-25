/**
 * One cause, one message: what each connection is down because of — its server down,
 * its machine stopped, its server or machine kept quiet, the internet — in that order, and which connections talk to
 * the internet.
 */
import { describe, expect, it } from 'vitest';
import {
  answeredLast,
  type CauseConnection,
  type CauseWorld,
  causesFor,
  machineThing,
  onInternet,
} from './causes';

const world = (over: Partial<CauseWorld> = {}): CauseWorld => ({
  servers: new Map([
    ['pve-02', { name: 'pve-02', down: false }],
    ['nas', { name: 'The NAS', down: false }],
  ]),
  guests: new Map([['pve-02/pve:131', { name: 'homeassistant', stopped: false }]]),
  windows: [],
  wayOut: null,
  ...over,
});

const plex: CauseConnection = {
  thingId: 'connection:con_plex',
  machine: { serverId: 'pve-02', guestId: null },
  answering: false,
  internet: false,
};
const ha: CauseConnection = {
  thingId: 'connection:con_ha',
  machine: { serverId: 'pve-02', guestId: 'pve:131' },
  answering: false,
  internet: false,
};
const github: CauseConnection = { thingId: 'connection:con_gh', answering: false, internet: true };

describe('causesFor', () => {
  it('a server that is down takes what runs on it and on its machines', () => {
    const down = world({ servers: new Map([['pve-02', { name: 'pve-02', down: true }]]) });
    const found = causesFor([plex, ha], down);
    expect(found.get(plex.thingId)).toEqual({
      causeThing: 'server:pve-02',
      causeName: 'pve-02',
      kind: 'down',
      words: 'while pve-02 is down',
    });
    expect(found.get(ha.thingId)?.causeThing).toBe('server:pve-02');
  });

  it('a connection that still answers is down because of nothing', () => {
    const down = world({ servers: new Map([['pve-02', { name: 'pve-02', down: true }]]) });
    expect(causesFor([{ ...plex, answering: true }], down).size).toBe(0);
  });

  it('answering with an error is answering, as the incidents read it', () => {
    expect(answeredLast({ status: 'warn', outcome: 'error' })).toBe(true);
    expect(answeredLast({ status: 'ok' })).toBe(true);
    expect(answeredLast({ status: 'offline', outcome: 'offline' })).toBe(false);
    expect(answeredLast({ status: 'ok', outcome: 'offline' })).toBe(false);
    // A server that is down doesn't explain a service that answered with an error.
    const down = world({ servers: new Map([['pve-02', { name: 'pve-02', down: true }]]) });
    const erring = { ...plex, answering: answeredLast({ status: 'warn', outcome: 'error' }) };
    expect(causesFor([erring], down).size).toBe(0);
  });

  it('a stopped machine takes what runs on it, named as people know it', () => {
    const stopped = world({
      guests: new Map([['pve-02/pve:131', { name: 'homeassistant', stopped: true }]]),
    });
    expect(causesFor([ha, plex], stopped)).toEqual(
      new Map([
        [
          ha.thingId,
          {
            causeThing: machineThing('pve-02', 'pve:131'),
            causeName: 'homeassistant',
            kind: 'down',
            words: 'while homeassistant is stopped',
          },
        ],
      ]),
    );
    expect(machineThing('pve-02', 'pve:131')).toBe('server:pve-02/guest/pve%3A131');
  });

  it('a server kept quiet keeps what runs on it quiet, answering or not; Whombat’s work says so', () => {
    const quiet = world({ windows: [{ serverId: 'pve-02', guestId: null, work: false }] });
    const found = causesFor([{ ...plex, answering: true }, ha], quiet);
    expect(found.get(plex.thingId)).toMatchObject({ kind: 'quiet', words: 'while pve-02 is kept quiet' });
    expect(found.get(ha.thingId)?.causeThing).toBe('server:pve-02');
    const work = world({ windows: [{ serverId: 'pve-02', guestId: 'pve:131', work: true }] });
    const byWork = causesFor([plex, ha], work);
    expect(byWork.get(ha.thingId)?.words).toBe('while Whombat is updating homeassistant');
    expect(byWork.has(plex.thingId)).toBe(false);
  });

  it('while the internet is down, connections on the internet that fail are down with it', () => {
    const found = causesFor(
      [github, plex, { ...github, thingId: 'connection:con_ok', answering: true }],
      world({ wayOut: 'internet' }),
    );
    expect([...found.keys()]).toEqual([github.thingId]);
    expect(found.get(github.thingId)).toMatchObject({
      causeThing: 'box:network',
      words: 'while the internet is down',
    });
    expect(causesFor([github], world()).size).toBe(0);
  });
});

describe('onInternet', () => {
  const row = (url: string | null, catalogId = 'custom_api') =>
    ({ catalogId, baseUrl: url ?? '', fields: url ? { url } : {} }) as Parameters<typeof onInternet>[0];

  it('a public name or address is on the internet; a local one, or one on a server Whombat watches, isn’t', () => {
    expect(onInternet(row('https://api.example.com'), undefined)).toBe(true);
    expect(onInternet(row('http://203.0.113.10:8080'), undefined)).toBe(true);
    expect(onInternet(row('http://10.100.0.5:8123'), undefined)).toBe(false);
    expect(onInternet(row('http://nas.local:5000'), undefined)).toBe(false);
    expect(onInternet(row('http://homeassistant:8123'), undefined)).toBe(false);
    expect(onInternet(row('https://api.example.com'), { serverId: 'pve-02' })).toBe(false);
  });

  it('reads a “Website or address” check’s own address, so it joins the internet’s one message', () => {
    const uptime = (fields: Record<string, string>) =>
      ({ catalogId: 'uptime', baseUrl: 'whombat-hosts:', fields }) as Parameters<typeof onInternet>[0];
    expect(onInternet(uptime({ kind: 'http', address: 'https://example.com/ready' }), undefined)).toBe(true);
    expect(onInternet(uptime({ kind: 'tcp', address: '203.0.113.20:443' }), undefined)).toBe(true);
    expect(onInternet(uptime({ kind: 'ping', address: '10.100.0.9' }), undefined)).toBe(false);
    expect(onInternet(uptime({ kind: 'heartbeat' }), undefined)).toBe(false);
  });
});
