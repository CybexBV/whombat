/**
 * The box's network (hardware-support-web.md AP-3201…AP-3212): NETWORK's rows and saved networks, a change in words and
 * when it is told, the dialog's list and checks, the refusals' words, the poller that follows a change, and the fake
 * network's phases on an injected clock.
 */
import { hostNetworkValid } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { OperationError } from '../session/managed-ops';
import { HostNetwork, type NetworkChange, WifiScan } from './contract';
import { createFakeNetwork, FAKE_WIFI_PASSWORDS, fakeNetworkApi } from './fake';
import {
  createNetworkPoller,
  type NetworkApi,
  networkChangeRunning,
  networkChangeShown,
  networkChangeView,
  networkErrorCode,
  networkErrorText,
  networkSectionView,
  wifiJoinInput,
  wifiNameProblem,
  wifiNeedsPassword,
  wifiPasswordProblem,
  wifiRows,
  wifiSignalText,
} from './network';

const NOW = Date.parse('2026-10-20T09:22:00Z');
const NAME = 'Burrow HQ';

function network(over: Partial<HostNetwork> = {}): HostNetwork {
  return {
    online: true,
    checkedAt: '2026-10-20T09:21:40Z',
    wired: [{ interface: 'enp5s0', connected: true, address: '192.168.1.42' }],
    wifi: {
      interface: 'wlan0',
      state: 'connected',
      ssid: 'Home',
      signal: 4,
      address: '192.168.1.43',
      saved: [
        { ssid: 'Office', security: 'psk' },
        { ssid: 'Home', security: 'psk' },
      ],
    },
    change: null,
    ...over,
  };
}

function change(over: Partial<NetworkChange> = {}): NetworkChange {
  return {
    id: 'c-00000001',
    kind: 'join',
    ssid: 'Home',
    phase: 'applying',
    deadline: new Date(NOW + 120_000).toISOString(),
    previous: 'Office',
    ...over,
  };
}

describe('NETWORK', () => {
  it('shows the cable and the Wi-Fi with its signal, the cable winning', () => {
    const v = networkSectionView(network(), { name: NAME, now: NOW });
    expect(v.rows.map((r) => r.title)).toEqual(['Cable · Connected', 'Wi-Fi · Home · Strong signal']);
    expect(v.rows[0]?.meta).toBe('192.168.1.42');
    expect(v.rows[1]?.meta).toContain('192.168.1.43');
    expect(v.rows[1]?.meta).toContain('cable');
    expect(v.rows[1]?.signal).toBe(4);
    expect(v.canJoin).toBe(true);
  });

  it('names the interfaces only when there is more than one cable', () => {
    const v = networkSectionView(
      network({
        wired: [
          { interface: 'enp5s0', connected: true, address: '10.0.0.2' },
          { interface: 'enp6s0', connected: false },
        ],
        wifi: null,
        wifiMissing: 'no_adapter',
      }),
      { name: NAME, now: NOW },
    );
    expect(v.rows.map((r) => [r.title, r.meta])).toEqual([
      ['Cable · Connected', '10.0.0.2 · enp5s0'],
      ['Cable · Not connected', 'enp6s0'],
      ['No Wi-Fi card', expect.any(String)],
    ]);
    expect(v.canJoin).toBe(false);
  });

  it('says why there is no Wi-Fi, pointing at the hardware for the card', () => {
    const at = (wifiMissing: HostNetwork['wifiMissing']) =>
      networkSectionView(network({ wifi: null, wifiMissing }), { name: NAME, now: NOW }).rows.at(-1);
    expect(at('no_driver')).toMatchObject({
      meta: 'This Wi-Fi card has no driver yet.',
      hardware: true,
      dot: 'warn',
    });
    expect(at('disabled')).toMatchObject({ kind: 'missing', hardware: true });
    expect(at('no_adapter')).toMatchObject({ title: 'No Wi-Fi card', hardware: false, dot: 'mut' });
  });

  it('says when the box can’t reach Whombat, first', () => {
    const v = networkSectionView(network({ online: false }), { name: NAME, now: NOW });
    expect(v.rows[0]).toMatchObject({ kind: 'offline', dot: 'warn' });
    expect(
      networkSectionView(network({ online: false, checkedAt: null }), { name: NAME }).rows[0]?.kind,
    ).toBe('cable');
  });

  it('lists saved networks with the one in use first', () => {
    const v = networkSectionView(network(), { name: NAME, now: NOW });
    expect(v.saved.map((s) => [s.ssid, s.connected])).toEqual([
      ['Home', true],
      ['Office', false],
    ]);
    expect(v.saved[0]?.meta).toMatch(/^In use now/);
  });

  it('waits while a change runs, and shows it', () => {
    const v = networkSectionView(network({ change: change() }), { name: NAME, now: NOW });
    expect(v.busy).toBe(true);
    expect(v.canJoin).toBe(false);
    expect(v.change).toMatchObject({ running: true, title: expect.stringContaining('Home') });
  });
});

describe('a change in words', () => {
  it('tells the guard while joining, and HD-11’s sentence when it went back', () => {
    expect(networkChangeView(change(), NAME).meta).toContain(`If ${NAME} can’t reach the internet`);
    const back = networkChangeView(change({ phase: 'reverted', failure: 'no_internet' }), NAME);
    expect(back.meta).toBe(
      `Joined Home, but ${NAME} couldn’t reach the internet there, so it went back to Office.`,
    );
    expect(back.dot).toBe('warn');
  });

  it('says a wrong password plainly', () => {
    const v = networkChangeView(change({ phase: 'failed', failure: 'wrong_password' }), NAME);
    expect(v).toMatchObject({ meta: 'That password didn’t work.', dot: 'bad', running: false });
  });

  it('has words for every phase of a join and a forget', () => {
    for (const kind of ['join', 'forget'] as const)
      for (const phase of [
        'applying',
        'confirming',
        'committed',
        'reverting',
        'reverted',
        'failed',
      ] as const) {
        const v = networkChangeView(change({ kind, phase }), NAME);
        expect(v.title).toMatch(/Home|Office/);
        expect(v.running).toBe(networkChangeRunning({ phase }));
      }
  });

  it('is told while it runs, after it ended when watched, and when it went back recently', () => {
    const at = (c: NetworkChange, seenRunning: boolean, now = NOW) =>
      networkChangeShown(c, { seenRunning, now });
    expect(at(change(), false)).toBe(true);
    expect(at(change({ phase: 'committed' }), true)).toBe(true);
    expect(at(change({ phase: 'committed' }), false)).toBe(false);
    expect(at(change({ phase: 'reverted' }), false)).toBe(true);
    expect(at(change({ phase: 'reverted' }), false, NOW + 120_000 + 16 * 60_000)).toBe(false);
  });
});

describe('the Wi-Fi dialog', () => {
  const scan = WifiScan.parse({
    scannedAt: '2026-10-20T09:22:00Z',
    networks: [
      { ssid: 'Neighbours', security: 'psk', signal: 3, saved: false, connected: false },
      { ssid: 'Home', security: 'psk', signal: 2, saved: true, connected: true },
      { ssid: 'Lumio Corp', security: 'enterprise', signal: 3, saved: false, connected: false },
      { ssid: 'Café', security: 'open', signal: 1, saved: false, connected: false },
    ],
  });

  it('lists the network in use first, with locks and company networks disabled', () => {
    const rows = wifiRows(scan);
    expect(rows.map((r) => r.ssid)).toEqual(['Home', 'Neighbours', 'Lumio Corp', 'Café']);
    expect(rows[0]).toMatchObject({ meta: 'Connected', secured: true, joinable: true });
    expect(rows[2]).toMatchObject({ joinable: false, meta: expect.stringContaining('Company') });
    expect(rows[3]).toMatchObject({ secured: false, joinable: true, meta: null });
    expect(rows[3]?.label).toContain('weak signal');
  });

  it('asks for a password only for a secured network it hasn’t saved', () => {
    expect(wifiNeedsPassword({ security: 'psk', saved: false })).toBe(true);
    expect(wifiNeedsPassword({ security: 'psk', saved: true })).toBe(false);
    expect(wifiNeedsPassword({ security: 'open', saved: false })).toBe(false);
  });

  it('checks the password and the name', () => {
    expect(wifiPasswordProblem('short')).not.toBeNull();
    expect(wifiPasswordProblem('long enough')).toBeNull();
    expect(wifiPasswordProblem('a'.repeat(64))).toBeNull();
    expect(wifiPasswordProblem('g'.repeat(64))).not.toBeNull();
    expect(wifiNameProblem('  ')).not.toBeNull();
    expect(wifiNameProblem('Attic')).toBeNull();
    expect(wifiNameProblem('é'.repeat(17))).not.toBeNull(); // 34 bytes
  });

  it('sends the password only for a secured network, and hidden for one typed in', () => {
    expect(wifiJoinInput({ ssid: 'Café', security: 'open', password: 'ignored!' })).toEqual({ ssid: 'Café' });
    expect(wifiJoinInput({ ssid: 'Attic', security: 'psk', password: 'attic-pass-1', hidden: true })).toEqual(
      {
        ssid: 'Attic',
        passphrase: 'attic-pass-1',
        hidden: true,
      },
    );
  });

  it('words the bars', () => {
    expect([4, 3, 2, 1, 0].map((s) => wifiSignalText(s as 0))).toEqual([
      'Strong signal',
      'Good signal',
      'Good signal',
      'Weak signal',
      'Weak signal',
    ]);
  });
});

describe('refusals', () => {
  it('reads the code from details first, then the error, and never says the password', () => {
    const e = new OperationError('host.wifi.forget', 409, 'conflict', 'x', { code: 'in_use' });
    expect(networkErrorCode(e)).toBe('in_use');
    expect(networkErrorText(e, NAME)).toContain(NAME);
    expect(networkErrorCode(new OperationError('host.wifi.join', 409, 'busy', 'x'))).toBe('busy');
    expect(networkErrorText(new Error('boom'), NAME)).toBe('That didn’t work. Try again.');
  });
});

/** Timers run by hand: `run()` fires what is due. */
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
    pending: () => timers.length,
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

describe('the poller', () => {
  it('asks once, then every 2 s while a change runs, and stops when it ended', async () => {
    const c = clock();
    const fake = createFakeNetwork({ machine: 'z13', now: c.now, applyMs: 1_000, confirmMs: 2_000 });
    const api = fakeNetworkApi(fake);
    let asks = 0;
    const counted: NetworkApi = {
      ...api,
      state: () => {
        asks++;
        return api.state();
      },
    };
    const p = createNetworkPoller({ api: counted, setTimer: c.setTimer, clearTimer: c.clearTimer });
    p.setActive(true);
    await settle();
    expect(asks).toBe(1);
    expect(p.getState().network?.wifi?.ssid).toBe('Home');
    expect(c.pending()).toBe(0);

    p.started(await api.join({ ssid: 'Neighbours', passphrase: FAKE_WIFI_PASSWORDS.Neighbours }));
    await settle();
    expect(p.getState().seenRunning).toBe(true);
    expect(p.getState().network?.change?.phase).toBe('applying');
    await c.advance(2_000);
    expect(p.getState().network?.change?.phase).toBe('confirming');
    await c.advance(2_000);
    expect(p.getState().network?.change?.phase).toBe('committed');
    expect(p.getState().seenRunning).toBe(true);
    expect(p.getState().network?.wifi?.ssid).toBe('Neighbours');
    expect(c.pending()).toBe(0);
  });

  it('keeps a running change on screen when an answer fails (the box is between networks)', async () => {
    const c = clock();
    const fake = createFakeNetwork({ machine: 'z13', now: c.now });
    const api = fakeNetworkApi(fake);
    let fail = false;
    const flaky: NetworkApi = {
      ...api,
      state: () => (fail ? Promise.reject(new Error('gone')) : api.state()),
    };
    const p = createNetworkPoller({ api: flaky, setTimer: c.setTimer, clearTimer: c.clearTimer });
    p.setActive(true);
    await settle();
    p.started(await api.join({ ssid: 'Neighbours', passphrase: FAKE_WIFI_PASSWORDS.Neighbours }));
    await settle();
    fail = true;
    await c.advance(2_000);
    expect(p.getState().reason).toBeNull();
    expect(p.getState().network?.change).not.toBeNull();
    expect(c.pending()).toBe(1);
  });

  it('says it couldn’t read the network when nothing was shown, and nothing without a manager', async () => {
    const p = createNetworkPoller({
      api: { state: () => Promise.resolve({ network: null, reason: 'unavailable' }) } as NetworkApi,
    });
    p.setActive(true);
    await settle();
    expect(p.getState()).toMatchObject({ network: null, reason: 'unavailable', loading: false });
    expect(createNetworkPoller({ api: null }).getState().reason).toBe('not_managed');
  });

  it('asks nothing while not active', async () => {
    let asks = 0;
    const p = createNetworkPoller({
      api: {
        state: () => {
          asks++;
          return Promise.resolve({ network: null, reason: 'unavailable' });
        },
      } as NetworkApi,
    });
    await settle();
    expect(asks).toBe(0);
    p.dispose();
  });
});

describe('the fake network', () => {
  it('answers the network and a scan as the contract has them', () => {
    const fake = createFakeNetwork({ machine: 'z13', now: () => NOW });
    const n = fake.call('host.network', {}).body as { network: unknown };
    expect(HostNetwork.parse(n.network).wifi?.ssid).toBe('Home');
    const s = fake.call('host.wifi.scan', {}).body as { scan: unknown };
    const scan = WifiScan.parse(s.scan);
    expect(scan.networks.map((x) => x.ssid)).not.toContain('Attic');
    expect(scan.networks[0]?.signal).toBe(4);
  });

  it('answers what the contracts’ checks allow in every phase (failure in reverting, reverted and failed)', () => {
    let t = NOW;
    const fake = createFakeNetwork({ machine: 'z13', now: () => t, applyMs: 1_000, confirmMs: 1_000 });
    fake.plugCable(false);
    const read = () => (fake.call('host.network', {}).body as { network: HostNetwork }).network;
    expect(hostNetworkValid(read())).toBe(true);
    fake.call('host.wifi.join', { ssid: 'Café Wombat' });
    for (let i = 0; i < 5; i++) {
      const n = HostNetwork.parse(read());
      expect(hostNetworkValid(n)).toBe(true);
      t += 1_000;
    }
    fake.call('host.wifi.join', { ssid: 'Neighbours', passphrase: 'nope nope' });
    t += 1_000;
    expect(hostNetworkValid(read())).toBe(true);
  });

  it('fails a wrong password and keeps nothing', () => {
    let t = NOW;
    const fake = createFakeNetwork({ machine: 'z13', now: () => t, applyMs: 1_000 });
    const r = fake.call('host.wifi.join', { ssid: 'Neighbours', passphrase: 'not the one' });
    expect(r.status).toBe(202);
    t += 1_000;
    const n = (fake.call('host.network', {}).body as { network: HostNetwork }).network;
    expect(n.change).toMatchObject({ phase: 'failed', failure: 'wrong_password' });
    expect(n.wifi?.ssid).toBe('Home');
    expect(n.wifi?.saved.map((s) => s.ssid)).not.toContain('Neighbours');
  });

  it('goes back when the new network has no internet and no cable carries the box', () => {
    let t = NOW;
    const fake = createFakeNetwork({ machine: 'z13', now: () => t, applyMs: 1_000, confirmMs: 1_000 });
    fake.plugCable(false);
    fake.call('host.wifi.join', { ssid: 'Café Wombat' });
    const phases: string[] = [];
    for (let i = 0; i < 4; i++) {
      t += 1_000;
      phases.push(
        (fake.call('host.network', {}).body as { network: HostNetwork }).network.change?.phase ?? '',
      );
    }
    expect(phases).toEqual(['confirming', 'reverting', 'reverted', 'reverted']);
    const n = (fake.call('host.network', {}).body as { network: HostNetwork }).network;
    expect(n.change?.failure).toBe('no_internet');
    expect(n.wifi?.ssid).toBe('Home');
  });

  it('refuses a second change and forgetting the only connection', () => {
    const fake = createFakeNetwork({ machine: 'z13', now: () => NOW });
    fake.call('host.wifi.join', { ssid: 'Café Wombat' });
    expect(fake.call('host.wifi.forget', { ssid: 'Office' }).status).toBe(409);
    const alone = createFakeNetwork({ machine: 'z13', now: () => NOW });
    alone.plugCable(false);
    const r = alone.call('host.wifi.forget', { ssid: 'Home' });
    expect((r.body as { error: { code: string; details: { code: string } } }).error).toMatchObject({
      code: 'conflict',
      details: { code: 'in_use' },
    });
  });

  it('has no Wi-Fi on a VM, and a card without a driver on the other machine', () => {
    const vm = (
      createFakeNetwork({ machine: 'vm' }).call('host.network', {}).body as { network: HostNetwork }
    ).network;
    expect(vm).toMatchObject({ wifi: null, wifiMissing: 'no_adapter' });
    const pc = (
      createFakeNetwork({ machine: 'nodriver' }).call('host.network', {}).body as {
        network: HostNetwork;
      }
    ).network;
    expect(pc.wifiMissing).toBe('no_driver');
    expect(createFakeNetwork({ machine: 'vm' }).call('host.wifi.join', { ssid: 'Home' }).status).toBe(403);
  });
});
