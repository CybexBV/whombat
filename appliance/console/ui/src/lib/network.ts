/**
 * The box's network on its screen (Whombat hardware-support.md HD-05…HD-11; appliance CG-100…): the shapes the console
 * server passes through (`/api/state`'s `network`, `/api/network`, `/api/network/wifi/*`) and the installer's
 * (`/api/wifi*`), read the way `parseState` reads (a piece the page doesn't understand is left out), and the pure rules
 * the Wi-Fi sheet and the chip follow.
 *
 * The shapes copy contracts 0.102.0 (`@whombat/protocol/session` network.ts, `@whombat/control-contracts/local`
 * desk.ts: `HostNetwork`, `WifiNetwork`, `NetworkChange`, `DeskNetworkAnswer`, …): the page can't import the contracts
 * (CG-40), so it keeps copies with the same names and members.
 */

export const WIFI_SECURITIES = ['open', 'psk', 'enterprise', 'other'] as const;
export type WifiSecurity = (typeof WIFI_SECURITIES)[number];
export type WifiSignal = 0 | 1 | 2 | 3 | 4;
export const WIFI_MISSING = ['no_adapter', 'no_driver', 'disabled'] as const;
export type WifiMissing = (typeof WIFI_MISSING)[number];
export const NETWORK_CHANGE_PHASES = [
  'applying',
  'confirming',
  'committed',
  'reverting',
  'reverted',
  'failed',
] as const;
export type NetworkChangePhase = (typeof NETWORK_CHANGE_PHASES)[number];
export const NETWORK_CHANGE_FAILURES = [
  'wrong_password',
  'not_found',
  'no_address',
  'no_internet',
  'failed',
] as const;
export type NetworkChangeFailure = (typeof NETWORK_CHANGE_FAILURES)[number];

export interface WifiNetwork {
  ssid: string;
  security: WifiSecurity;
  signal: WifiSignal;
  saved: boolean;
  connected: boolean;
}

export interface WifiScan {
  networks: WifiNetwork[];
  scannedAt: string;
}

export interface HostWired {
  interface: string;
  connected: boolean;
  address?: string;
}

export interface HostWifi {
  interface: string;
  state: 'disconnected' | 'connecting' | 'connected';
  ssid?: string;
  signal?: WifiSignal;
  address?: string;
  saved: { ssid: string; security: WifiSecurity }[];
}

export interface NetworkChange {
  id: string;
  kind: 'join' | 'forget';
  ssid: string;
  phase: NetworkChangePhase;
  deadline: string;
  previous?: string;
  failure?: NetworkChangeFailure;
}

export interface HostNetwork {
  online: boolean;
  checkedAt: string | null;
  wired: HostWired[];
  wifi: HostWifi | null;
  wifiMissing?: WifiMissing;
  change: NetworkChange | null;
}

/** `GET /api/network` (DeskNetworkAnswer): `mayChange` false, the screen shows the Wi-Fi read-only (HD-07). */
export interface NetworkAnswer {
  network: HostNetwork;
  mayChange: boolean;
}

/** `/api/state`'s `network` (CG-101): what the chip shows. */
export interface NetworkSummary {
  online: boolean;
  via: 'cable' | 'wifi' | 'none';
  ssid: string | null;
  /** Why the box has no Wi-Fi it can use (absent: it has). */
  wifiMissing: WifiMissing | null;
}

/** The installer's `GET /api/wifi` (CG-121). */
export interface InstallerWifi {
  adapter: boolean;
  wifiMissing: WifiMissing | null;
  connected: string | null;
  networks: WifiNetwork[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | null =>
  values.includes(v as T) ? (v as T) : null;
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Bytes of a name in UTF-8. */
const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/**
 * A Wi-Fi network's name the page can show and send (the contracts' `ssidValid`): 1…32 UTF-8 bytes, no control,
 * format or separator character but the space. A name that isn't is left out of every list.
 */
export function ssidValid(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    s.length > 0 &&
    utf8Length(s) <= 32 &&
    /^(?:[^\p{Cc}\p{Cf}\p{Cs}\p{Z}]| )+$/u.test(s)
  );
}

/** A WPA2/WPA3 Personal passphrase (`WifiPassphrase`): 8…63 printable ASCII characters, or 64 hex digits. */
export function passphraseValid(p: string): boolean {
  return /^(?:[\x20-\x7e]{8,63}|[0-9A-Fa-f]{64})$/.test(p);
}

function signal(v: unknown): WifiSignal | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 4 ? (v as WifiSignal) : null;
}

export function parseWifiNetwork(v: unknown): WifiNetwork | null {
  if (!isObj(v) || !ssidValid(v.ssid)) return null;
  const security = oneOf(v.security, WIFI_SECURITIES);
  const bars = signal(v.signal);
  if (!security || bars === null) return null;
  return { ssid: v.ssid, security, signal: bars, saved: v.saved === true, connected: v.connected === true };
}

const networks = (v: unknown): WifiNetwork[] =>
  (Array.isArray(v) ? v : []).flatMap((n) => {
    const p = parseWifiNetwork(n);
    return p ? [p] : [];
  });

export function parseScan(v: unknown): WifiScan | null {
  const s = isObj(v) && isObj(v.scan) ? v.scan : null;
  if (!s) return null;
  return { networks: networks(s.networks), scannedAt: typeof s.scannedAt === 'string' ? s.scannedAt : '' };
}

export function parseChange(v: unknown): NetworkChange | null {
  if (!isObj(v) || typeof v.id !== 'string' || !ssidValid(v.ssid)) return null;
  const kind = oneOf(v.kind, ['join', 'forget'] as const);
  const phase = oneOf(v.phase, NETWORK_CHANGE_PHASES);
  if (!kind || !phase) return null;
  const failure = oneOf(v.failure, NETWORK_CHANGE_FAILURES) ?? undefined;
  return {
    id: v.id,
    kind,
    ssid: v.ssid,
    phase,
    deadline: typeof v.deadline === 'string' ? v.deadline : '',
    ...(ssidValid(v.previous) ? { previous: v.previous } : {}),
    ...(failure ? { failure } : {}),
  };
}

function parseWifi(v: unknown): HostWifi | null {
  if (!isObj(v)) return null;
  const state = oneOf(v.state, ['disconnected', 'connecting', 'connected'] as const);
  if (!state) return null;
  const saved = (Array.isArray(v.saved) ? v.saved : []).flatMap((s) => {
    if (!isObj(s) || !ssidValid(s.ssid)) return [];
    const security = oneOf(s.security, WIFI_SECURITIES);
    return security ? [{ ssid: s.ssid, security }] : [];
  });
  const bars = signal(v.signal);
  return {
    interface: typeof v.interface === 'string' ? v.interface : '',
    state,
    ...(ssidValid(v.ssid) ? { ssid: v.ssid } : {}),
    ...(bars !== null ? { signal: bars } : {}),
    ...(optStr(v.address) ? { address: optStr(v.address) } : {}),
    saved,
  };
}

export function parseNetwork(v: unknown): HostNetwork | null {
  if (!isObj(v)) return null;
  const wired = (Array.isArray(v.wired) ? v.wired : []).flatMap((w) =>
    isObj(w) && typeof w.interface === 'string'
      ? [{ interface: w.interface, connected: w.connected === true, address: optStr(w.address) }]
      : [],
  );
  const wifi = parseWifi(v.wifi);
  const missing = wifi ? null : oneOf(v.wifiMissing, WIFI_MISSING);
  return {
    online: v.online === true,
    checkedAt: typeof v.checkedAt === 'string' ? v.checkedAt : null,
    wired,
    wifi,
    ...(missing ? { wifiMissing: missing } : {}),
    change: parseChange(v.change),
  };
}

export function parseNetworkAnswer(v: unknown): NetworkAnswer | null {
  if (!isObj(v)) return null;
  const network = parseNetwork(v.network);
  return network ? { network, mayChange: v.mayChange === true } : null;
}

export function parseNetworkSummary(v: unknown): NetworkSummary | null {
  if (!isObj(v)) return null;
  const via = oneOf(v.via, ['cable', 'wifi', 'none'] as const);
  if (!via) return null;
  return {
    online: v.online === true,
    via,
    ssid: via === 'wifi' && ssidValid(v.ssid) ? v.ssid : null,
    wifiMissing: oneOf(v.wifiMissing, WIFI_MISSING),
  };
}

export function parseInstallerWifi(v: unknown): InstallerWifi | null {
  if (!isObj(v)) return null;
  const adapter = v.adapter === true;
  return {
    adapter,
    wifiMissing: adapter ? null : (oneOf(v.wifiMissing, WIFI_MISSING) ?? 'no_adapter'),
    connected: adapter && ssidValid(v.connected) ? v.connected : null,
    networks: adapter ? networks(v.networks) : [],
  };
}

/* Rules ------------------------------------------------------------------------------------------------------------- */

/** Company (802.1X) and WEP networks are listed but can't be joined yet (HD-05). */
export const joinable = (s: WifiSecurity) => s === 'open' || s === 'psk';

/** Joining asks for a password: a secured network the box hasn't saved (a saved one joins without). */
export const needsPassword = (n: Pick<WifiNetwork, 'security' | 'saved'>) => n.security === 'psk' && !n.saved;

/** The sheet's list: the network in use first, then as the scan has them (strongest first). */
export function sortNetworks(list: readonly WifiNetwork[]): WifiNetwork[] {
  return [...list].sort((a, b) => Number(b.connected) - Number(a.connected));
}

/** A change still runs (the sheet asks again every 2 s while it does). */
export const changeRunning = (c: Pick<NetworkChange, 'phase'> | null | undefined) =>
  !!c && (c.phase === 'applying' || c.phase === 'confirming' || c.phase === 'reverting');

/** What the box uses now: a cable wins (HD-05). */
export function connectedVia(n: HostNetwork): 'cable' | 'wifi' | 'none' {
  if (n.wired.some((w) => w.connected)) return 'cable';
  return n.wifi?.state === 'connected' ? 'wifi' : 'none';
}

/** The network the box is on now (Wi-Fi), if any. */
export const currentSsid = (n: HostNetwork): string | null =>
  n.wifi?.state === 'connected' ? (n.wifi.ssid ?? null) : null;

/**
 * Whether a saved network may be forgotten from the screen: not the one the box depends on while nothing else works
 * (the runtime refuses that with `in_use`; the sheet doesn't offer it).
 */
export function mayForget(n: HostNetwork, ssid: string): boolean {
  return !(currentSsid(n) === ssid && connectedVia(n) === 'wifi');
}

/** The sheet idles shut after this long without a touch or a key, unless a change runs (CG-108). */
export const SHEET_IDLE_MS = 2 * 60_000;

/** How often the sheet asks the network again while it is open (the console server keeps it 2 s). */
export const NETWORK_POLL_MS = 2000;
