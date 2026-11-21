/**
 * The demo's network (dev only, `?demo=`): a box's cables and Wi-Fi card, the networks around it, and joins and
 * forgets that run through Whombat's phases on a short clock (applying 1.5 s, confirming 2 s, reverting 1.5 s), as the
 * console server's `/api/network…` and the installer's `/api/wifi…` answer them. The demo takes any password but the
 * world's `wrong` one; `Office` reverts (Whombat couldn't reach the internet there).
 */
import type { PostResult } from '../lib/client';
import type { HostNetwork, NetworkChange, NetworkSummary, WifiNetwork } from '../lib/network';
import { connectedVia } from '../lib/network';

export interface WifiWorld {
  network: HostNetwork;
  /** HD-07: the screen may change the Wi-Fi now. */
  mayChange: boolean;
  scan: WifiNetwork[];
  /** A scan takes this long (ms; default 900). */
  scanMs?: number;
  /** The password the demo refuses (“That password didn’t work.”). */
  wrong?: string;
  /** A join takes this long in the installer (ms; default 1500). */
  joinMs?: number;
  /** The installer's card: why there is none (absent: it has one). */
  installerMissing?: 'no_adapter' | 'no_driver' | 'disabled';
}

const APPLY_MS = 1500;
const CONFIRM_MS = 2000;
const REVERT_MS = 1500;
const REVERTS = new Set(['Office']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type WifiDemo = ReturnType<typeof wifiDemo>;

export function wifiDemo(world: WifiWorld) {
  let network = structuredClone(world.network);
  let running: { change: NetworkChange; at: number; passphrase: string | null } | null = null;
  let changes = 0;
  let scanned = false;

  const connectTo = (ssid: string) => {
    const w = network.wifi;
    if (!w) return;
    const n = world.scan.find((x) => x.ssid === ssid);
    const saved = w.saved.some((s) => s.ssid === ssid)
      ? w.saved
      : [...w.saved, { ssid, security: n?.security ?? 'psk' }];
    network = {
      ...network,
      online: true,
      wifi: { ...w, state: 'connected', ssid, signal: n?.signal ?? 3, address: '192.168.1.57', saved },
    };
  };
  const unsave = (ssid: string) => {
    const w = network.wifi;
    if (w) network = { ...network, wifi: { ...w, saved: w.saved.filter((s) => s.ssid !== ssid) } };
  };

  /** The running change's phase by its clock; the network follows it. */
  const tick = () => {
    if (!running) return;
    const ms = Date.now() - running.at;
    const c = running.change;
    const wrong = c.kind === 'join' && world.wrong !== undefined && running.passphrase === world.wrong;
    const reverts = c.kind === 'join' && REVERTS.has(c.ssid);
    let phase: NetworkChange['phase'] = 'applying';
    let failure: NetworkChange['failure'];
    if (wrong) {
      if (ms >= 1200) [phase, failure] = ['failed', 'wrong_password'];
    } else if (ms < APPLY_MS) phase = 'applying';
    else if (!c.previous) phase = 'committed';
    else if (ms < APPLY_MS + CONFIRM_MS) phase = 'confirming';
    else if (!reverts) phase = 'committed';
    else if (ms < APPLY_MS + CONFIRM_MS + REVERT_MS) [phase, failure] = ['reverting', 'no_internet'];
    else [phase, failure] = ['reverted', 'no_internet'];

    if (c.kind === 'join' && (phase === 'confirming' || phase === 'committed')) connectTo(c.ssid);
    if (c.kind === 'join' && (phase === 'reverting' || phase === 'reverted') && c.previous) {
      connectTo(c.previous);
      unsave(c.ssid);
    }
    if (c.kind === 'forget' && phase === 'committed') unsave(c.ssid);
    network = { ...network, change: { ...c, phase, ...(failure ? { failure } : {}) } };
    if (phase === 'committed' || phase === 'reverted' || phase === 'failed') running = null;
  };

  const scanNow = (): WifiNetwork[] => {
    const current = network.wifi?.state === 'connected' ? network.wifi.ssid : undefined;
    const saved = new Set(network.wifi?.saved.map((s) => s.ssid));
    return world.scan.map((n) => ({ ...n, connected: n.ssid === current, saved: saved.has(n.ssid) }));
  };

  const start = (kind: 'join' | 'forget', ssid: string, passphrase: string | null): PostResult => {
    if (!world.mayChange) return { status: 409, body: { message: 'locked' } };
    if (running) return { status: 409, body: { message: 'busy' } };
    const current = network.wifi?.state === 'connected' ? network.wifi.ssid : undefined;
    changes += 1;
    const change: NetworkChange = {
      id: `c-demo${String(changes).padStart(4, '0')}`,
      kind,
      ssid,
      phase: 'applying',
      deadline: new Date(Date.now() + 120_000).toISOString(),
      ...(kind === 'join' && current && current !== ssid ? { previous: current } : {}),
    };
    running = { change, at: Date.now(), passphrase };
    network = { ...network, change };
    return { status: 200, body: { v: 1, change } };
  };

  /** The installer's view of the same card. */
  const installerView = () => {
    if (world.installerMissing) return { adapter: false, wifiMissing: world.installerMissing, networks: [] };
    const current = network.wifi?.state === 'connected' ? network.wifi.ssid : undefined;
    return { adapter: true, ...(current ? { connected: current } : {}), networks: scanned ? scanNow() : [] };
  };

  return {
    /** `/api/state`'s summary, as the console server makes it. */
    summary(): NetworkSummary {
      tick();
      const via = connectedVia(network);
      return {
        online: network.online,
        via,
        ssid: via === 'wifi' ? (network.wifi?.ssid ?? null) : null,
        wifiMissing: network.wifiMissing ?? null,
      };
    },
    async get(path: string): Promise<PostResult> {
      tick();
      if (path === '/api/network') {
        const may = world.mayChange;
        return { status: 200, body: { v: 1, network, mayChange: may, ...(may ? {} : { why: 'locked' }) } };
      }
      if (path === '/api/wifi') return { status: 200, body: installerView() };
      return { status: 404, body: { message: 'not found' } };
    },
    async post(path: string, body: Record<string, unknown>): Promise<PostResult> {
      tick();
      const ssid = typeof body.ssid === 'string' ? body.ssid : '';
      const pass = typeof body.passphrase === 'string' ? body.passphrase : null;
      switch (path) {
        case '/api/network/wifi/scan':
          await sleep(world.scanMs ?? 900);
          if (!network.wifi) return { status: 409, body: { message: 'no_wifi' } };
          return {
            status: 200,
            body: { v: 1, scan: { networks: scanNow(), scannedAt: new Date().toISOString() } },
          };
        case '/api/network/wifi/join':
          return start('join', ssid, pass);
        case '/api/network/wifi/forget':
          return start('forget', ssid, null);
        case '/api/wifi/scan':
          if (world.installerMissing) return { status: 409, body: { message: 'no_wifi' } };
          await sleep(world.scanMs ?? 900);
          scanned = true;
          return { status: 200, body: installerView() };
        case '/api/wifi/join':
          await sleep(world.joinMs ?? 1500);
          if (world.wrong !== undefined && pass === world.wrong)
            return { status: 200, body: { failure: 'wrong_password' } };
          if (!world.scan.some((n) => n.ssid === ssid) && body.hidden !== true)
            return { status: 200, body: { failure: 'not_found' } };
          connectTo(ssid);
          return { status: 200, body: { connected: true } };
        default:
          return { status: 404, body: { message: 'not found' } };
      }
    },
  };
}
