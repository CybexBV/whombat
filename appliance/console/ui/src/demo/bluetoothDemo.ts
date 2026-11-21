/**
 * The demo's Bluetooth (dev only, `?demo=`): the box's adapter, its paired devices and the devices around it, a scan
 * that finds them one by one, and pairings that run through Whombat's phases on a short clock, as the console server's
 * `/api/bluetooth…` answer them (S's fake world, brief §3: the Keychron K3 connected at 80 %, the WH-1000XM5 not
 * connected; nearby the MX Master 3S pairs without a code, the Magic Keyboard with one typed digit by digit, the JBL
 * Flip 6 without, one device refuses; the Pixel 9 next to them never shows: the service leaves phones out, BT-01).
 */
import type {
  BluetoothDevice,
  BluetoothMissing,
  BluetoothPairing,
  BluetoothPairingFailure,
  BluetoothState,
  BluetoothSummary,
} from '../lib/bluetooth';
import type { PostResult } from '../lib/client';

/** How a device nearby pairs in the demo. */
export type DemoPairs = 'plain' | 'code' | 'confirm' | BluetoothPairingFailure;

export interface NearbyDevice extends BluetoothDevice {
  pairs: DemoPairs;
}

export interface BluetoothWorld {
  adapter: { name: string; powered: boolean } | null;
  missing?: BluetoothMissing;
  paired: BluetoothDevice[];
  nearby: NearbyDevice[];
  /** BT-02: the screen may change Bluetooth now. */
  mayChange: boolean;
  /** A scan runs at the start, this long ago (ms), its devices found so far. */
  scanningSince?: number;
  /** How long a device takes to show after the scan starts (ms each; default 700). */
  findMs?: number;
  /** A scan lasts this long (s; default 60, BLUETOOTH_SCAN_S). */
  scanS?: number;
  /** The pairing in the state at the start; `frozen`: it stays as it is (a fixture of one phase). */
  pairing?: BluetoothPairing;
  frozen?: boolean;
  /** Devices whose connect doesn't (switched off). */
  connectFails?: string[];
  /** /api/bluetooth answers 503 (the sheet can't read it). */
  unreadable?: boolean;
}

const PAIRING_MS = 1200;
const TYPE_MS = 650;
const CONNECT_MS = 1200;
const FAIL_MS = { rejected: 2000, timeout: 3500, not_found: 1500, canceled: 0, failed: 2500 } as const;
const CODE = '482913';
const KEEP_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (ms: number) => new Date(ms).toISOString();

export type BluetoothDemo = ReturnType<typeof bluetoothDemo>;

export function bluetoothDemo(world: BluetoothWorld) {
  let paired = structuredClone(world.paired);
  let nearby = structuredClone(world.nearby);
  const scanS = world.scanS ?? 60;
  const findMs = world.findMs ?? 700;
  /** The scan: when it started (devices show one by one from then) and when it ends. */
  let scan: { at: number; until: number } | null =
    world.scanningSince !== undefined
      ? { at: Date.now() - world.scanningSince, until: Date.now() - world.scanningSince + scanS * 1000 }
      : null;
  /** The pairing, when its phase started its clock, and when Yes was said (a confirm's). */
  let pairing: { p: BluetoothPairing; at: number; answered: number | null } | null = world.pairing
    ? { p: world.pairing, at: Date.now(), answered: null }
    : null;
  let pairings = 0;

  const found = (): BluetoothDevice[] => {
    if (!scan) return [];
    const ms = Date.now() - scan.at;
    return nearby
      .filter((_, i) => ms >= (i + 1) * findMs)
      .map(({ pairs: _pairs, ...d }) => d)
      .sort((a, b) => (b.signal ?? 0) - (a.signal ?? 0));
  };

  /** The running pairing's phase by its clock; a done one joins the paired devices. */
  const tick = () => {
    if (scan && Date.now() >= scan.until) scan = null;
    if (!pairing || world.frozen) return;
    const { p, at } = pairing;
    if (p.phase === 'done' || p.phase === 'failed') {
      if (Date.now() - at > KEEP_MS) pairing = null;
      return;
    }
    const ms = Date.now() - at;
    const how = nearby.find((d) => d.address === p.address)?.pairs ?? 'plain';
    const next = (
      phase: BluetoothPairing['phase'],
      extra: Partial<BluetoothPairing> = {},
    ): BluetoothPairing => {
      const { code: _c, typed: _t, failure: _f, ...base } = p;
      return { ...base, phase, ...extra };
    };
    let q: BluetoothPairing = p;
    if (ms < PAIRING_MS) q = next('pairing');
    else if (how === 'plain') q = ms < PAIRING_MS + CONNECT_MS ? next('connecting') : next('done');
    else if (how === 'code') {
      const typed = Math.floor((ms - PAIRING_MS) / TYPE_MS);
      const after = PAIRING_MS + (CODE.length + 1) * TYPE_MS;
      if (typed <= CODE.length) q = next('code', { code: CODE, typed });
      else q = ms < after + CONNECT_MS ? next('connecting') : next('done');
    } else if (how === 'confirm') {
      if (pairing.answered === null) q = next('confirm', { code: '731264' });
      else q = Date.now() - pairing.answered < CONNECT_MS ? next('connecting') : next('done');
    } else if (ms >= PAIRING_MS + FAIL_MS[how]) q = next('failed', { failure: how });
    if (q.phase === 'done' || q.phase === 'failed') pairing = { ...pairing, at: Date.now() };
    if (q.phase === 'done') {
      const d = nearby.find((x) => x.address === p.address);
      if (d) {
        const { pairs: _pairs, signal: _signal, ...device } = d;
        paired = [{ ...device, connected: true }, ...paired];
        nearby = nearby.filter((x) => x.address !== p.address);
      }
    }
    pairing = { ...pairing, p: q };
  };

  const state = (): BluetoothState => ({
    adapter: world.adapter,
    ...(world.missing ? { missing: world.missing } : {}),
    devices: [...paired].sort(
      (a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name),
    ),
    scan: scan ? { until: iso(scan.until), devices: found() } : null,
    pairing: pairing?.p ?? null,
  });

  const locked = (): PostResult | null =>
    world.mayChange ? null : { status: 409, body: { message: 'locked' } };
  const usable = () => world.adapter?.powered === true;

  return {
    /** `/api/state`'s summary, as the console server makes it. */
    summary(): BluetoothSummary | null {
      tick();
      const missing = !world.adapter
        ? (world.missing ?? 'no_adapter')
        : world.adapter.powered
          ? null
          : (world.missing ?? 'disabled');
      if (missing === 'no_adapter') return null;
      return {
        missing,
        connected: missing
          ? []
          : paired.filter((d) => d.connected).map((d) => ({ name: d.name, kind: d.kind })),
      };
    },
    async get(path: string): Promise<PostResult> {
      tick();
      if (path !== '/api/bluetooth') return { status: 404, body: { message: 'not found' } };
      if (world.unreadable) return { status: 503, body: { message: 'unavailable' } };
      const may = world.mayChange;
      return {
        status: 200,
        body: { v: 1, bluetooth: state(), mayChange: may, ...(may ? {} : { why: 'locked' }) },
      };
    },
    async post(path: string, body: Record<string, unknown>): Promise<PostResult> {
      tick();
      const refused = locked();
      if (refused) return refused;
      if (!usable()) return { status: 409, body: { message: 'no_bluetooth' } };
      const address = typeof body.address === 'string' ? body.address : '';
      const device = paired.find((d) => d.address === address);
      switch (path) {
        case '/api/bluetooth/scan':
          // Not while a pairing runs (the desk says `busy`, 0.109).
          if (pairing && pairing.p.phase !== 'done' && pairing.p.phase !== 'failed')
            return { status: 409, body: { message: 'busy' } };
          await sleep(300);
          // Asked again, it looks a minute more (BT-07).
          scan = { at: scan?.at ?? Date.now(), until: Date.now() + scanS * 1000 };
          return { status: 200, body: { v: 1, scan: state().scan } };
        case '/api/bluetooth/pair': {
          if (pairing && pairing.p.phase !== 'done' && pairing.p.phase !== 'failed')
            return { status: 409, body: { message: 'busy' } };
          const d = nearby.find((x) => x.address === address);
          if (!d) return { status: 404, body: { message: 'not_found' } };
          pairings += 1;
          const p: BluetoothPairing = {
            id: `p-demo${String(pairings).padStart(4, '0')}`,
            address,
            name: d.name,
            kind: d.kind,
            phase: 'pairing',
            deadline: iso(Date.now() + 90_000),
          };
          // Pairing stops looking (BT-07).
          scan = null;
          pairing = { p, at: Date.now(), answered: null };
          return { status: 200, body: { v: 1, pairing: p } };
        }
        case '/api/bluetooth/confirm':
        case '/api/bluetooth/cancel': {
          if (!pairing || pairing.p.id !== body.pairingId)
            return { status: 404, body: { message: 'not_found' } };
          const accept = path.endsWith('/confirm') && body.accept === true;
          if (accept) pairing = { ...pairing, answered: Date.now() };
          else {
            const { code: _c, typed: _t, ...base } = pairing.p;
            pairing = {
              ...pairing,
              at: Date.now(),
              p: { ...base, phase: 'failed', failure: path.endsWith('/cancel') ? 'canceled' : 'rejected' },
            };
          }
          tick();
          return { status: 200, body: { v: 1, pairing: pairing.p } };
        }
        case '/api/bluetooth/connect':
        case '/api/bluetooth/disconnect': {
          if (!device) return { status: 409, body: { message: 'not_paired' } };
          const on = path.endsWith('/connect');
          await sleep(on ? 1500 : 500);
          const works = !on || !world.connectFails?.includes(device.name);
          paired = paired.map((d) => (d.address === address && works ? { ...d, connected: on } : d));
          const after = paired.find((d) => d.address === address);
          return { status: 200, body: { v: 1, device: after } };
        }
        case '/api/bluetooth/forget':
          if (!device) return { status: 409, body: { message: 'not_paired' } };
          await sleep(400);
          paired = paired.filter((d) => d.address !== address);
          return { status: 200, body: { v: 1 } };
        default:
          return { status: 404, body: { message: 'not found' } };
      }
    },
  };
}
