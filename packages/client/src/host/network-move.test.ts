/**
 * Wi-Fi only and the cable again (Whombat network-move.md; app network-move-app.md): the rows' buttons
 * and the switched-off cable, the dialog's subnet note, the cable change's words, the servers' move and the router tip,
 * the cable refusals, the poller following a cable change and then the move, and the fake's `host.cable.set`.
 */
import { hostNetworkValid } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { OperationError } from '../session/managed-ops';
import { type CableChange, HostNetwork, type ServerMove } from './contract';
import { createFakeNetwork, fakeNetworkApi } from './fake';
import {
  addressTip,
  cableChangeShown,
  cableChangeView,
  createNetworkPoller,
  NETWORK_TEXT,
  type NetworkApi,
  networkErrorText,
  networkSectionView,
  serverMoveView,
  wifiOnlyDialogView,
} from './network';

const NOW = Date.parse('2026-11-03T09:00:00Z');
const NAME = 'Home';
const T = NETWORK_TEXT;

function network(over: Partial<HostNetwork> = {}): HostNetwork {
  return {
    online: true,
    checkedAt: '2026-11-03T08:59:40Z',
    wired: [
      {
        interface: 'enp0s13f0u1',
        connected: true,
        address: '10.100.1.81',
        prefixLength: 24,
        plugged: true,
        mac: '02:00:00:68:0a:1f',
      },
    ],
    wifi: {
      interface: 'wlan0',
      state: 'connected',
      ssid: 'Home',
      signal: 4,
      address: '10.100.1.97',
      prefixLength: 24,
      mac: 'ae:00:00:16:47:58',
      saved: [{ ssid: 'Home', security: 'psk' }],
    },
    change: null,
    wifiOnly: false,
    ...over,
  };
}

const wifiOf = (n: HostNetwork) => n.wifi as NonNullable<HostNetwork['wifi']>;

/** The box on Wi-Fi only, its cable still plugged in (or not). */
function wifiOnly(plugged = true): HostNetwork {
  return network({
    wifiOnly: true,
    wired: [{ interface: 'enp0s13f0u1', connected: false, plugged, mac: '02:00:00:68:0a:1f' }],
  });
}

function cableChange(over: Partial<CableChange> = {}): CableChange {
  return {
    id: 'c-00000007',
    use: 'wifi',
    by: 'person',
    phase: 'applying',
    deadline: new Date(NOW + 120_000).toISOString(),
    ...over,
  };
}

function move(over: Partial<ServerMove> = {}): ServerMove {
  return {
    from: '10.100.1.81',
    to: '10.100.1.97',
    since: new Date(NOW - 60_000).toISOString(),
    total: 6,
    found: 4,
    ...over,
  };
}

const view = (n: HostNetwork, o: Partial<Parameters<typeof networkSectionView>[1]> = {}) =>
  networkSectionView(n, { name: NAME, now: NOW, ...o });
const row = (n: HostNetwork, kind: string) => view(n).rows.find((r) => r.kind === kind);

describe('Use Wi-Fi only on the Wi-Fi row', () => {
  it('is offered with a cable and Wi-Fi both connected', () => {
    expect(row(network(), 'wifi')?.action).toBe('wifiOnly');
    expect(T.useWifiOnly).toBe('Use Wi-Fi only');
  });

  it('isn’t offered without a cable, without Wi-Fi, on Wi-Fi only, or while a change runs', () => {
    expect(row(network({ wired: [] }), 'wifi')?.action).toBeNull();
    const off = network();
    expect(
      row(
        {
          ...off,
          wifi: {
            ...wifiOf(off),
            state: 'disconnected',
            ssid: undefined,
            signal: undefined,
            address: undefined,
          },
        },
        'wifi',
      )?.action,
    ).toBeNull();
    expect(row(wifiOnly(), 'wifi')?.action).toBeNull();
    expect(row(network({ cableChange: cableChange() }), 'wifi')?.action).toBeNull();
    expect(
      row(
        network({
          change: {
            id: 'c-00000001',
            kind: 'join',
            ssid: 'Home',
            phase: 'confirming',
            deadline: new Date(NOW).toISOString(),
          },
        }),
        'wifi',
      )?.action,
    ).toBeNull();
  });

  it('isn’t offered by a manager that doesn’t know Wi-Fi only (no wifiOnly, no plugged)', () => {
    const old = network({ wired: [{ interface: 'enp5s0', connected: true, address: '10.100.1.81' }] });
    delete old.wifiOnly;
    expect(row(old, 'wifi')?.action).toBeNull();
  });

  it('waits for a running cable change: Join and Forget too', () => {
    const v = view(network({ cableChange: cableChange() }));
    expect(v.busy).toBe(true);
    expect(v.canJoin).toBe(false);
  });
});

describe('the cable on Wi-Fi only', () => {
  it('says it is switched off, that it can be unplugged, and offers the cable again', () => {
    const r = row(wifiOnly(), 'cable');
    expect(r?.title).toBe('Cable · Switched off');
    expect(r?.meta).toContain('You can unplug the cable.');
    expect(r?.meta).toContain(NAME);
    expect(r?.dot).toBe('mut');
    expect(r?.action).toBe('cable');
    expect(T.useCableAgain).toBe('Use the cable again');
  });

  it('says the cable can be unplugged only once Wi-Fi only is kept, not while it is checked', () => {
    const all = move({ found: 6 });
    for (const phase of ['applying', 'confirming', 'reverting'] as const) {
      const checking = { ...wifiOnly(), cableChange: cableChange({ phase }) };
      expect(row(checking, 'cable')?.meta).not.toContain('unplug');
      expect(view(checking, { move: all }).move?.title).not.toContain('unplug');
    }
    const kept = { ...wifiOnly(), cableChange: cableChange({ phase: 'committed' }) };
    expect(row(kept, 'cable')?.meta).toContain('You can unplug the cable.');
    expect(view(kept, { move: all }).move?.title).toContain('You can unplug the cable now.');
  });

  it('without the cable plugged in: only Wi-Fi only, no button', () => {
    const r = row(wifiOnly(false), 'cable');
    expect(r?.meta).not.toContain('unplug');
    expect(r?.action).toBeNull();
  });

  it('keeps the row when the adapter is gone, and offers nothing while a change runs', () => {
    const gone = view({ ...wifiOnly(), wired: [] }).rows.filter((r) => r.kind === 'cable');
    expect(gone.map((r) => [r.key, r.title, r.action])).toEqual([
      ['cable:off', 'Cable · Switched off', null],
    ]);
    expect(row({ ...wifiOnly(), cableChange: cableChange({ use: 'cable' }) }, 'cable')?.action).toBeNull();
  });

  it('doesn’t tell the Wi-Fi it waits for the cable', () => {
    expect(row(wifiOnly(), 'wifi')?.meta).toBe('10.100.1.97');
  });
});

describe('the Use Wi-Fi only dialog', () => {
  it('names the network it stays on and the guard', () => {
    const d = wifiOnlyDialogView(network(), NAME);
    expect(d.title).toBe('Use Wi-Fi only?');
    expect(d.lead).toContain('“Home”');
    expect(d.guard).toContain('2 minutes');
    expect(d.otherNetwork).toBeNull();
  });

  it('says up front when the Wi-Fi is another network than the cable', () => {
    const n = network();
    const other = { ...n, wifi: { ...wifiOf(n), address: '192.168.50.12' } };
    expect(wifiOnlyDialogView(other, NAME).otherNetwork).toContain('point them here');
    // Unknown (no prefix): nothing said.
    const unknown = { ...n, wifi: { ...wifiOf(n), address: '192.168.50.12', prefixLength: undefined } };
    expect(wifiOnlyDialogView(unknown, NAME).otherNetwork).toBeNull();
  });
});

describe('a cable change in words', () => {
  it('has a line for every phase of both directions, running until it ended', () => {
    for (const use of ['wifi', 'cable'] as const)
      for (const phase of [
        'applying',
        'confirming',
        'committed',
        'reverting',
        'reverted',
        'failed',
      ] as const) {
        const v = cableChangeView(
          cableChange({
            use,
            phase,
            ...(['reverting', 'reverted', 'failed'].includes(phase) ? { failure: 'no_internet' } : {}),
          }),
          NAME,
        );
        expect(v.title.length).toBeGreaterThan(0);
        expect(v.running).toBe(['applying', 'confirming', 'reverting'].includes(phase));
      }
    expect(cableChangeView(cableChange(), NAME).title).toBe('Moving to Wi-Fi…');
    expect(cableChangeView(cableChange({ use: 'cable' }), NAME).title).toBe('Moving to the cable…');
    expect(cableChangeView(cableChange({ phase: 'committed' }), NAME)).toMatchObject({ dot: 'ok' });
    expect(cableChangeView(cableChange({ phase: 'reverted', failure: 'no_internet' }), NAME).dot).toBe(
      'warn',
    );
    expect(cableChangeView(cableChange({ phase: 'failed', failure: 'failed' }), NAME).dot).toBe('bad');
  });

  it('says the box went back to its cable by itself', () => {
    const backup = cableChange({ use: 'cable', by: 'backup', phase: 'committed' });
    const v = cableChangeView(backup, NAME);
    expect(v.title).toContain('Wi-Fi stopped reaching Whombat');
    expect(v.dot).toBe('warn');
    expect(cableChangeShown(backup, { seenRunning: false, now: NOW })).toBe(true);
  });

  it('is told while it runs or was watched; a switch that simply worked isn’t told to the next visitor', () => {
    const done = cableChange({ phase: 'committed' });
    expect(cableChangeShown(cableChange(), { seenRunning: false, now: NOW })).toBe(true);
    expect(cableChangeShown(done, { seenRunning: true, now: NOW })).toBe(true);
    expect(cableChangeShown(done, { seenRunning: false, now: NOW })).toBe(false);
    const back = cableChange({ phase: 'reverted', failure: 'no_internet' });
    expect(cableChangeShown(back, { seenRunning: false, now: NOW })).toBe(true);
    expect(view(network({ cableChange: done }), { cableSeenRunning: true }).cableChange?.id).toBe(done.id);
  });
});

describe('the servers’ move', () => {
  const opts = { name: NAME, unplug: false, now: NOW };

  it('counts the servers that found the new address while they come', () => {
    const v = serverMoveView(move(), opts);
    expect(v?.title).toContain('4 of 6 servers');
    expect(v?.missing).toBeNull();
    expect(v?.repoint).toBe(false);
    expect(v?.running).toBe(true);
  });

  it('names the ones still missing after 5 minutes, with Point them here', () => {
    const v = serverMoveView(move({ since: new Date(NOW - 6 * 60_000).toISOString() }), opts);
    expect(v?.missing).toContain('2 servers');
    expect(v?.repoint).toBe(true);
    expect(v?.dot).toBe('warn');
    expect(T.move.pointHere).toBe('Point them here');
    expect(
      serverMoveView(move({ found: 5, since: new Date(NOW - 6 * 60_000).toISOString() }), opts)?.missing,
    ).toContain('1 server ');
  });

  it('says all found, and that the cable can go on Wi-Fi only, for an hour', () => {
    const all = move({ found: 6 });
    expect(serverMoveView(all, opts)?.title).toContain('All your servers');
    expect(serverMoveView(all, opts)?.title).not.toContain('unplug');
    expect(serverMoveView(all, { ...opts, unplug: true })?.title).toContain('You can unplug the cable now.');
    expect(serverMoveView({ ...all, since: new Date(NOW - 61 * 60_000).toISOString() }, opts)).toBeNull();
    expect(serverMoveView(move({ total: 0, found: 0 }), opts)).toBeNull();
    expect(view(wifiOnly(), { move: all }).move?.title).toContain('unplug');
  });
});

describe('the router tip', () => {
  it('names the old and new address and the Wi-Fi card’s hardware address in capitals', () => {
    const tip = addressTip(wifiOnly(), move(), NAME);
    expect(tip).toContain('10.100.1.81');
    expect(tip).toContain('10.100.1.97');
    expect(tip).toContain('the Wi-Fi card (AE:00:00:16:47:58)');
  });

  it('names the cable when the box moved to it, and leaves out an unknown hardware address', () => {
    const back = move({ from: '10.100.1.97', to: '10.100.1.81' });
    expect(addressTip(network(), back, NAME)).toContain('the cable (02:00:00:68:0A:1F)');
    const n = wifiOnly();
    const noMac = { ...n, wifi: { ...wifiOf(n), mac: undefined } };
    expect(addressTip(noMac, move(), NAME)).toContain('the Wi-Fi card, then');
  });

  it('says nothing when the address didn’t change or isn’t known', () => {
    expect(addressTip(network(), move({ from: '10.100.1.97' }), NAME)).toBeNull();
    expect(addressTip(network(), move({ from: undefined }), NAME)).toBeNull();
    expect(addressTip(network(), null, NAME)).toBeNull();
  });
});

describe('cable refusals', () => {
  it('has words for every cable code', () => {
    for (const code of ['busy', 'no_wifi', 'not_connected', 'no_cable', 'unchanged']) {
      const e = new OperationError('host.cable.set', 409, 'conflict', 'x', { code });
      expect(networkErrorText(e, NAME)).not.toBe(T.failed);
    }
  });
});

/** Timers run by hand. */
function clock() {
  let t = NOW;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const timer = { at: t + ms, fn };
      timers.push(timer);
      return timer;
    },
    clearTimer: (h: unknown) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
    next: () => (timers.length ? Math.min(...timers.map((x) => x.at)) - t : null),
    async advance(ms: number) {
      t += ms;
      for (const timer of [...timers].filter((x) => x.at <= t)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.fn();
      }
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the poller with a cable change', () => {
  it('follows the change every 2 s, then the move every 5 s until all servers found the box', async () => {
    const c = clock();
    const fake = createFakeNetwork({
      machine: 'z13',
      now: c.now,
      applyMs: 1_000,
      confirmMs: 2_000,
      moveStepMs: 4_000,
    });
    const api = fakeNetworkApi(fake);
    const p = createNetworkPoller({ api, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
    p.setActive(true);
    await settle();
    expect(c.next()).toBeNull();

    p.cableStarted(await api.setCable('wifi'));
    await settle();
    expect(p.getState().cableSeenRunning).toBe(true);
    expect(c.next()).toBe(2_000);
    await c.advance(2_000);
    expect(p.getState().network?.cableChange?.phase).toBe('confirming');
    await c.advance(2_000);
    expect(p.getState().network?.cableChange?.phase).toBe('committed');
    expect(p.getState().network?.wifiOnly).toBe(true);
    // The change ended; servers are still to come.
    expect(p.getState().move?.found).toBe(1);
    expect(c.next()).toBe(5_000);
    for (let i = 0; i < 4; i++) await c.advance(5_000);
    expect(p.getState().move?.found).toBe(6);
    // A minute after the change it stops: the cable's address and the servers' move come a few seconds after it.
    let asked = 0;
    while (c.next() !== null && asked < 50) {
      await c.advance(c.next() as number);
      asked++;
    }
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThanOrEqual(9);
    expect(c.next()).toBeNull();
  });

  it('stops following a move 10 minutes after it started', async () => {
    const c = clock();
    const fake = createFakeNetwork({ machine: 'z13', now: c.now, applyMs: 0, confirmMs: 0, moveMissing: 2 });
    const api = fakeNetworkApi(fake);
    const p = createNetworkPoller({ api, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
    p.setActive(true);
    await settle();
    p.cableStarted(await api.setCable('wifi'));
    await settle();
    let asked = 0;
    while (c.next() !== null && asked < 500) {
      await c.advance(c.next() as number);
      asked++;
    }
    expect(p.getState().move?.found).toBe(4);
    expect(asked).toBeGreaterThan(100);
    expect(asked).toBeLessThanOrEqual(121);
  });
});

describe('the fake’s host.cable.set', () => {
  it('switches to Wi-Fi only and back, answering what the contract allows', () => {
    let t = NOW;
    const fake = createFakeNetwork({ machine: 'z13', now: () => t, applyMs: 1_000, confirmMs: 1_000 });
    const read = () => fake.call('host.network', {}).body as { network: HostNetwork; move?: ServerMove };
    expect(fake.call('host.cable.set', { use: 'cable' }).body).toMatchObject({
      error: { details: { code: 'unchanged' } },
    });
    expect(fake.call('host.cable.set', { use: 'wifi' }).status).toBe(202);
    expect(fake.call('host.cable.set', { use: 'wifi' }).body).toMatchObject({
      error: { details: { code: 'busy' } },
    });
    for (const step of [0, 1_000, 1_000]) {
      t += step;
      const n = read().network;
      expect(HostNetwork.parse(n)).toBeTruthy();
      expect(hostNetworkValid(n)).toBe(true);
    }
    const { network: n, move: m } = read();
    expect(n.wifiOnly).toBe(true);
    expect(n.cableChange?.phase).toBe('committed');
    expect(n.wired[0]).toMatchObject({ connected: false, plugged: true });
    expect(m).toMatchObject({ from: '192.168.1.42', to: '192.168.1.43', total: 6 });

    fake.plugCable(false);
    expect(fake.call('host.cable.set', { use: 'cable' }).body).toMatchObject({
      error: { details: { code: 'no_cable' } },
    });
    fake.plugCable(true);
    expect(fake.call('host.cable.set', { use: 'cable' }).status).toBe(202);
    t += 2_000;
    expect(read().network.wifiOnly).toBe(false);
    expect(read().network.wired[0]?.connected).toBe(true);
  });

  it('goes back to the cable on a network without internet', async () => {
    let t = NOW;
    const fake = createFakeNetwork({ machine: 'z13', now: () => t, applyMs: 0, confirmMs: 0 });
    const api: NetworkApi = fakeNetworkApi(fake);
    await api.join({ ssid: 'Café Wombat' });
    t += 10;
    const change = await api.setCable('wifi');
    expect(change.use).toBe('wifi');
    t += 10;
    const n = (fake.call('host.network', {}).body as { network: HostNetwork }).network;
    expect(n.cableChange).toMatchObject({ phase: 'reverted', failure: 'no_internet' });
    expect(n.wifiOnly).toBe(false);
  });

  it('refuses Wi-Fi only without Wi-Fi', () => {
    expect(createFakeNetwork({ machine: 'vm' }).call('host.cable.set', { use: 'wifi' }).body).toMatchObject({
      error: { details: { code: 'no_wifi' } },
    });
  });
});
