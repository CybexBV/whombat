/**
 * The box's network and Wi-Fi (0.102, CT-564…CT-572; Whombat docs/decisions/hardware-support.md HD-05…HD-07, HD-10):
 * how the box is connected (cables, the Wi-Fi card, whether it reached Whombat), the Wi-Fi networks around it, and the
 * guarded changes an owner makes — join, switch, forget. The appliance's manager answers it (`POST /v1/network/state`,
 * `/v1/network/wifi/scan|join|forget` of `@whombat/control-contracts/local`, Go `protocol.HostNetwork`, …); the runtime
 * hands the same shapes to owners through the session ops `host.network`, `host.wifi.scan`, `host.wifi.join` and
 * `host.wifi.forget` (Settings → This Whombat → Overview → Network), and to the box's screen through the desk socket.
 *
 * A join that leaves the box unable to reach Whombat (when it could before) is undone after the confirm time: the new
 * network is forgotten and the previous one comes back (HD-06; the guard of MG-15). Kinds, states and failures cross the
 * wire, never words (HD-11). A passphrase is a secret: never logged, never in an answer, an error or the audit log.
 */
import type { ErrorCode } from '@whombat/core/contracts';
import { z } from 'zod';
import { utf8Encode } from '../bytes.js';
import { Rfc3339 } from './backup.js';
import { IpAddress } from './direct.js';
import { HOST_TEXT_RES, InterfaceName } from './hardware.js';

/* Names and secrets (CT-564) ------------------------------------------------------------------------------------- */

/** The most UTF-8 bytes in a network's name (IEEE 802.11). */
export const SSID_MAX_BYTES = 32;

/** The pattern of `Ssid`: displayable text of 1…32 code points (`HOST_TEXT_RES`). */
export const SSID_RE = HOST_TEXT_RES.find((r) => r.source.endsWith('{1,32}$')) as RegExp;

/**
 * A Wi-Fi network's name as people read it: displayable text (one line, nothing invisible) of 1…32 code points. A name
 * must also be at most `SSID_MAX_BYTES` UTF-8 bytes, which one cross-language pattern can't say: `ssidValid` (Go
 * `local.SsidValid`) checks both. Networks whose name isn't displayable are left out of every list.
 */
export const Ssid = z.string().regex(SSID_RE);
export type Ssid = z.infer<typeof Ssid>;

/** Whether `s` is a displayable network name of at most 32 UTF-8 bytes (CT-564). */
export function ssidValid(s: string): boolean {
  return SSID_RE.test(s) && utf8Encode(s).length <= SSID_MAX_BYTES;
}

/**
 * A WPA2/WPA3 Personal passphrase: 8…63 printable ASCII characters, or the 64 hex digits of the key itself. A secret:
 * never logged, never echoed.
 */
export const WifiPassphrase = z.string().regex(/^([\x20-\x7e]{8,63}|[0-9A-Fa-f]{64})$/);

/** A guarded change's id (`c-` and 8…32 lower-case letters and digits). */
export const NetworkChangeId = z.string().regex(/^c-[a-z0-9]{8,32}$/);

/**
 * A network card's hardware address, lower case with colons (`ae:00:00:16:47:58`, 3.13, CT-1639): what a router's
 * fixed-address setting asks for (network-move.md NM-08).
 */
export const MacAddress = z.string().regex(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/);
export type MacAddress = z.infer<typeof MacAddress>;

/** How many leading bits of an address name its network (`24` in 10.100.1.81/24; 0…128, CT-1639). */
export const PrefixLength = z.number().int().min(0).max(128);

/* Networks (CT-565) ---------------------------------------------------------------------------------------------- */

/**
 * How a network is secured: `open`; `psk` (WPA2/WPA3 Personal, a passphrase); `enterprise` (802.1X: listed, can't be
 * joined yet, HD-05); `other` (WEP and the like: listed, can't be joined).
 */
export const WIFI_SECURITIES = ['open', 'psk', 'enterprise', 'other'] as const;
export const WifiSecurity = z.enum(WIFI_SECURITIES);
export type WifiSecurity = z.infer<typeof WifiSecurity>;

/** Signal bars, 0…4 (`wifiSignalFromDbm`). */
export const WifiSignal = z.number().int().min(0).max(4);
export type WifiSignal = z.infer<typeof WifiSignal>;

/**
 * The bars for a signal strength in dBm (CT-565; Go `local.WifiSignalFromDBm`): ≥ −55 → 4, ≥ −67 → 3, ≥ −75 → 2,
 * ≥ −85 → 1, else 0. iwd reports hundredths of a dBm: divide first.
 */
export function wifiSignalFromDbm(dbm: number): WifiSignal {
  return dbm >= -55 ? 4 : dbm >= -67 ? 3 : dbm >= -75 ? 2 : dbm >= -85 ? 1 : 0;
}

/** A network the Wi-Fi card sees, as a scan lists it. */
export const WifiNetwork = z.object({
  ssid: Ssid,
  security: WifiSecurity,
  signal: WifiSignal,
  /** The box knows its password (or it is open and was joined before). */
  saved: z.boolean(),
  connected: z.boolean(),
});
export type WifiNetwork = z.infer<typeof WifiNetwork>;

export const WIFI_SCAN_MAX = 64;

/** The networks around the box, strongest first (hidden ones aren't in it: they are joined by name). */
export const WifiScan = z.object({
  networks: z.array(WifiNetwork).max(WIFI_SCAN_MAX),
  scannedAt: Rfc3339,
});
export type WifiScan = z.infer<typeof WifiScan>;

/* The box's connection (CT-566) ---------------------------------------------------------------------------------- */

/**
 * A cable's interface: whether it is used (a link and an address), and the address it uses. 3.13 (CT-1639, NM-01,
 * NM-08): `plugged`, whether a cable has a link, also while it is switched off (Wi-Fi only) or has no address; `mac`, the
 * card's hardware address; `prefixLength` of `address`, only with one. Absent from older managers.
 */
export const HostWired = z.object({
  interface: InterfaceName,
  connected: z.boolean(),
  address: IpAddress.optional(),
  plugged: z.boolean().optional(),
  mac: MacAddress.optional(),
  prefixLength: PrefixLength.optional(),
});
export type HostWired = z.infer<typeof HostWired>;

export const WIFI_STATES = ['disconnected', 'connecting', 'connected'] as const;
export const WifiState = z.enum(WIFI_STATES);
export type WifiState = z.infer<typeof WifiState>;

/** A network the box knows the password of. */
export const WifiSaved = z.object({ ssid: Ssid, security: WifiSecurity });
export type WifiSaved = z.infer<typeof WifiSaved>;

export const WIFI_SAVED_MAX = 32;

/**
 * The Wi-Fi card: its interface, what it is doing, the network (`ssid` while connecting or connected), the bars and the
 * address (while connected), and the saved networks (`hostNetworkValid`). 3.13 (CT-1639): the card's `mac`, and the
 * `prefixLength` of `address` (only while connected).
 */
export const HostWifi = z.object({
  interface: InterfaceName,
  state: WifiState,
  ssid: Ssid.optional(),
  signal: WifiSignal.optional(),
  address: IpAddress.optional(),
  saved: z.array(WifiSaved).max(WIFI_SAVED_MAX),
  mac: MacAddress.optional(),
  prefixLength: PrefixLength.optional(),
});
export type HostWifi = z.infer<typeof HostWifi>;

/**
 * Why there is no Wi-Fi: `no_adapter` (the machine has no Wi-Fi card), `no_driver` (it has one, without a driver or its
 * firmware), `disabled` (rfkill-blocked or switched off).
 */
export const WIFI_MISSING = ['no_adapter', 'no_driver', 'disabled'] as const;
export const WifiMissing = z.enum(WIFI_MISSING);
export type WifiMissing = z.infer<typeof WifiMissing>;

/* A guarded change (CT-567) -------------------------------------------------------------------------------------- */

export const NETWORK_CHANGE_KINDS = ['join', 'forget'] as const;
export const NetworkChangeKind = z.enum(NETWORK_CHANGE_KINDS);
export type NetworkChangeKind = z.infer<typeof NetworkChangeKind>;

/**
 * The guard's phases (MG-15's `NetworkPhase` and `failed`): `applying` (joining, or forgetting); `confirming` (joined,
 * checking the box still reaches Whombat until `deadline`); `committed`; `reverting` → `reverted` (it didn't, so the
 * previous network came back); `failed` (nothing changed: a wrong password, the network gone, …).
 */
export const NETWORK_CHANGE_PHASES = [
  'applying',
  'confirming',
  'committed',
  'reverting',
  'reverted',
  'failed',
] as const;
export const NetworkChangePhase = z.enum(NETWORK_CHANGE_PHASES);
export type NetworkChangePhase = z.infer<typeof NetworkChangePhase>;

/** A change's phase is final: nothing more happens to it. */
export function networkChangeDone(phase: NetworkChangePhase): boolean {
  return phase === 'committed' || phase === 'reverted' || phase === 'failed';
}

/**
 * Why a change failed or was undone: `wrong_password` (it fails at once and keeps nothing); `not_found` (no such network
 * in range); `no_address` (joined, but got no address); `no_internet` (joined, but Whombat couldn't be reached there);
 * `failed` (anything else).
 */
export const NETWORK_CHANGE_FAILURES = [
  'wrong_password',
  'not_found',
  'no_address',
  'no_internet',
  'failed',
] as const;
export const NetworkChangeFailure = z.enum(NETWORK_CHANGE_FAILURES);
export type NetworkChangeFailure = z.infer<typeof NetworkChangeFailure>;

/**
 * A join or a forget and where it is (HD-06). `deadline`: until when a join is confirmed or undone (while `applying`,
 * when the attempt gives up). `previous`: the network the box used before a join, which comes back on a revert (absent:
 * none). `failure` exactly in `reverting`, `reverted` and `failed` (`networkChangeValid`).
 */
export const NetworkChange = z.object({
  id: NetworkChangeId,
  kind: NetworkChangeKind,
  ssid: Ssid,
  phase: NetworkChangePhase,
  deadline: Rfc3339,
  previous: Ssid.optional(),
  failure: NetworkChangeFailure.optional(),
});
export type NetworkChange = z.infer<typeof NetworkChange>;

/** `failure` exactly in `reverting`, `reverted` and `failed` (CT-567; Go `local.NetworkChangeValid`). */
export function networkChangeValid(c: { phase: string; failure?: string }): boolean {
  const undone = c.phase === 'reverting' || c.phase === 'reverted' || c.phase === 'failed';
  return undone === (c.failure !== undefined);
}

/* Wi-Fi only: the cable switched off (3.13, CT-1640; network-move.md NM-01…NM-03) ------------------------------ */

/**
 * What a cable change makes the box use: `wifi` — Wi-Fi only, the cable is switched off (its link stays up, it takes no
 * address) until someone chooses the cable again; `cable` — the cable again.
 */
export const CABLE_USES = ['wifi', 'cable'] as const;
export const CableUse = z.enum(CABLE_USES);
export type CableUse = z.infer<typeof CableUse>;

/** Who made a cable change: a `person` (guarded, NM-02), or the box itself trying its cable as the `backup` when Wi-Fi only lost Whombat (NM-03, NM-13). */
export const CABLE_CHANGE_BY = ['person', 'backup'] as const;
export const CableChangeBy = z.enum(CABLE_CHANGE_BY);
export type CableChangeBy = z.infer<typeof CableChangeBy>;

/**
 * A cable change and where it is: the guard's phases and failures of a Wi-Fi join (`NetworkChange`): `applying`,
 * `confirming` until `deadline` (the box must reach Whombat again), `committed`, or `reverting` → `reverted` with
 * `no_internet`; `failed` when nothing changed. `failure` exactly in `reverting`, `reverted` and `failed`
 * (`networkChangeValid`). A backup change is guarded too: kept only when the cable reaches Whombat, else `reverted` and
 * Wi-Fi only stays. Older managers made it `committed` at once.
 */
export const CableChange = z.object({
  id: NetworkChangeId,
  use: CableUse,
  by: CableChangeBy,
  phase: NetworkChangePhase,
  deadline: Rfc3339,
  failure: NetworkChangeFailure.optional(),
});
export type CableChange = z.infer<typeof CableChange>;

export const HOST_WIRED_MAX = 8;

/**
 * How the box is connected (HD-05, HD-10). `online`: the manager reached control's endpoint in its last check, at most
 * 60 s ago (`checkedAt`; null before the first). `wired`: the cable interfaces. `wifi`: the Wi-Fi card, or null with
 * `wifiMissing` saying why. `change`: the latest guarded change while it runs and for a while after (null: none).
 * 3.13 (CT-1640): `wifiOnly`, the cables are switched off by choice (absent: false, or an older manager);
 * `cableChange`, the latest cable change while it runs and for 5 minutes after (absent: none).
 */
export const HostNetwork = z.object({
  online: z.boolean(),
  checkedAt: Rfc3339.nullable(),
  wired: z.array(HostWired).max(HOST_WIRED_MAX),
  wifi: HostWifi.nullable(),
  wifiMissing: WifiMissing.optional(),
  change: NetworkChange.nullable(),
  wifiOnly: z.boolean().optional(),
  cableChange: CableChange.optional(),
});
export type HostNetwork = z.infer<typeof HostNetwork>;

/**
 * What the schema can't say (CT-566; Go `local.HostNetworkValid`): `wifiMissing` only without `wifi`; the Wi-Fi card's
 * `ssid` exactly while connecting or connected, `signal`, `address` and `prefixLength` only while connected; a cable's
 * `prefixLength` only with its `address`; consistent changes (3.13, CT-1640: `cableChange` too).
 */
export function hostNetworkValid(n: HostNetwork): boolean {
  if (n.wifi !== null && n.wifiMissing !== undefined) return false;
  if (n.wifi !== null) {
    const w = n.wifi;
    if ((w.state !== 'disconnected') !== (w.ssid !== undefined)) return false;
    if (
      w.state !== 'connected' &&
      (w.signal !== undefined || w.address !== undefined || w.prefixLength !== undefined)
    )
      return false;
  }
  if (n.wired.some((c) => c.prefixLength !== undefined && c.address === undefined)) return false;
  if (n.cableChange && !networkChangeValid(n.cableChange)) return false;
  return n.change === null || networkChangeValid(n.change);
}

/**
 * Whether two addresses are on one local network (CT-1641, network-move.md NM-11): both IPv4 (or both IPv6) and equal in
 * the first `prefixLength` bits (the shorter of the two when they differ). Unknown or unparsable: null.
 */
export function sameSubnet(
  a: { address?: string; prefixLength?: number },
  b: { address?: string; prefixLength?: number },
): boolean | null {
  if (!a.address || !b.address || a.prefixLength === undefined || b.prefixLength === undefined) return null;
  const x = ipBits(a.address);
  const y = ipBits(b.address);
  if (!x || !y || x.length !== y.length) return null;
  const bits = Math.min(a.prefixLength, b.prefixLength, x.length);
  for (let i = 0; i < bits; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** An address as its bits (32 for IPv4, 128 for IPv6), or null. */
function ipBits(ip: string): number[] | null {
  const bytes: number[] = [];
  if (ip.includes(':')) {
    const [head = '', tail, extra] = ip.split('::');
    if (extra !== undefined) return null;
    const words = (part: string) => (part === '' ? [] : part.split(':'));
    const h = words(head);
    const t = tail === undefined ? [] : words(tail);
    const fill = 8 - h.length - t.length;
    if (tail === undefined ? fill !== 0 : fill < 1) return null;
    const all = [...h, ...Array(fill).fill('0'), ...t];
    for (const w of all) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(w)) return null;
      const n = Number.parseInt(w, 16);
      bytes.push(n >> 8, n & 0xff);
    }
  } else {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    for (const p of parts) {
      if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
      bytes.push(Number(p));
    }
  }
  return bytes.flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (b >> i) & 1));
}

/* Refusals (CT-569) ---------------------------------------------------------------------------------------------- */

/**
 * Why a Wi-Fi op refused, in `error.details.code` of a session error and as `LocalError.code` from the manager and the
 * desk socket:
 * - `no_wifi`: the box has no working Wi-Fi card (`HostNetwork.wifiMissing` says why);
 * - `busy`: a change is running: wait for it to end;
 * - `in_use`: forgetting the network the box depends on while nothing else works;
 * - `not_saved`: forgetting a network the box doesn't know;
 * - `invalid_passphrase`: a passphrase that can't be one (`WifiPassphrase`), one for an open network, or none for a
 *   secured network the box doesn't know.
 */
export const WIFI_ERROR_CODES = ['no_wifi', 'busy', 'in_use', 'not_saved', 'invalid_passphrase'] as const;
export const WifiErrorCode = z.enum(WIFI_ERROR_CODES);
export type WifiErrorCode = z.infer<typeof WifiErrorCode>;

/**
 * Why a cable change refused (3.13, CT-1642), in `error.details.code` and as `LocalError.code` from the manager:
 * - `busy`: a network change (Wi-Fi or cable) is running;
 * - `no_wifi`: Wi-Fi only on a box without a working Wi-Fi card;
 * - `not_connected`: Wi-Fi only while the Wi-Fi isn't on a network;
 * - `no_cable`: the cable again while no cable is plugged in;
 * - `unchanged`: the box already uses what was asked.
 */
export const CABLE_ERROR_CODES = ['busy', 'no_wifi', 'not_connected', 'no_cable', 'unchanged'] as const;
export const CableErrorCode = z.enum(CABLE_ERROR_CODES);
export type CableErrorCode = z.infer<typeof CableErrorCode>;

/** The generic session `ErrorCode` each cable refusal rides on. */
export const CABLE_ERROR_STATUS: Readonly<Record<CableErrorCode, z.infer<typeof ErrorCode>>> = {
  busy: 'conflict',
  no_wifi: 'not_allowed',
  not_connected: 'conflict',
  no_cable: 'conflict',
  unchanged: 'conflict',
};

/** `error.details` of a cable refusal. */
export const CableErrorDetails = z.object({ code: CableErrorCode });
export type CableErrorDetails = z.infer<typeof CableErrorDetails>;

/** The generic session `ErrorCode` each refusal rides on. */
export const WIFI_ERROR_STATUS: Readonly<Record<WifiErrorCode, z.infer<typeof ErrorCode>>> = {
  no_wifi: 'not_allowed',
  busy: 'conflict',
  in_use: 'conflict',
  not_saved: 'not_found',
  invalid_passphrase: 'validation_failed',
};

/** `error.details` of a Wi-Fi refusal. */
export const WifiErrorDetails = z.object({ code: WifiErrorCode });
export type WifiErrorDetails = z.infer<typeof WifiErrorDetails>;

/* The session ops (CT-568) ------------------------------------------------------------------------------- */

export const HostNetworkInput = z.strictObject({});

/**
 * The servers moving with the box (3.13, CT-1643; network-move.md NM-05, NM-07, NM-08): from the start of a cable change
 * (or another change of the box's address) for 24 hours. `from`: the box's address before (absent: unknown); `to`: the
 * address the servers are asked to use now; `since`: when it started; `total`: the servers the hosts service knows;
 * `found`: those connected through `to`.
 */
export const ServerMove = z.object({
  from: IpAddress.optional(),
  to: IpAddress,
  since: Rfc3339,
  total: z.number().int().nonnegative(),
  found: z.number().int().nonnegative(),
});
export type ServerMove = z.infer<typeof ServerMove>;

/**
 * `network` null with a `reason`: `not_managed` (no manager to ask) or `unavailable` (it didn't answer). 3.13 (CT-1643):
 * `move`, the servers following the box's address (absent: no move in the last 24 hours, or no hosts service).
 */
export const HostNetworkOutput = z.object({
  network: HostNetwork.nullable(),
  reason: z.enum(['not_managed', 'unavailable']).optional(),
  move: ServerMove.optional(),
});
export type HostNetworkOutput = z.infer<typeof HostNetworkOutput>;

export const HostWifiScanInput = z.strictObject({});
/** `scan` null with a `reason`: as `host.network`, or `no_wifi`. */
export const HostWifiScanOutput = z.object({
  scan: WifiScan.nullable(),
  reason: z.enum(['not_managed', 'unavailable', 'no_wifi']).optional(),
});
export type HostWifiScanOutput = z.infer<typeof HostWifiScanOutput>;

/**
 * Join or switch to a network (secret: the passphrase). Without `passphrase`: an open network, or one the box saved.
 * `hidden`: a network that doesn't show in scans, joined by name.
 */
export const HostWifiJoinInput = z.strictObject({
  ssid: Ssid.refine(ssidValid, { message: 'at most 32 UTF-8 bytes' }),
  passphrase: WifiPassphrase.optional(),
  hidden: z.boolean().optional(),
});
export type HostWifiJoinInput = z.infer<typeof HostWifiJoinInput>;

/** Forget a saved network (its password goes). */
export const HostWifiForgetInput = z.strictObject({ ssid: Ssid });
export type HostWifiForgetInput = z.infer<typeof HostWifiForgetInput>;

/** The change as it starts: poll `host.network` (every 2 s) while it runs. */
export const HostWifiChangeOutput = z.object({ change: NetworkChange });
export type HostWifiChangeOutput = z.infer<typeof HostWifiChangeOutput>;

/**
 * Wi-Fi only, or the cable again (3.13, CT-1642; NM-01, NM-02): guarded like a join. Poll `host.network` while it runs;
 * the servers are asked to move with the box first (`move`).
 */
export const HostCableSetInput = z.strictObject({ use: CableUse });
export type HostCableSetInput = z.infer<typeof HostCableSetInput>;

/** The cable change as it starts. */
export const HostCableChangeOutput = z.object({ change: CableChange });
export type HostCableChangeOutput = z.infer<typeof HostCableChangeOutput>;

/* Audit (signed appliance log; CT-571) --------------------------------------------------------------------------- */

/** Who changed the Wi-Fi: an owner in the app, or someone at the box's screen. */
export const NETWORK_AUDIT_VIA = ['app', 'screen'] as const;

/**
 * Payload of `network.wifi_joined` / `network.wifi_forgotten`: the network, where the change came from, and the change's
 * id. Never a passphrase (parsing strips anything else).
 */
export const NetworkAuditPayload = z.object({
  ssid: Ssid,
  via: z.enum(NETWORK_AUDIT_VIA),
  changeId: NetworkChangeId,
});
export type NetworkAuditPayload = z.infer<typeof NetworkAuditPayload>;

/** Payload of `network.cable_set` (3.13, CT-1642): what the box uses now, who chose it, from where, and the change's id. */
export const CableAuditPayload = z.object({
  use: CableUse,
  by: CableChangeBy,
  via: z.enum(NETWORK_AUDIT_VIA),
  changeId: NetworkChangeId,
});
export type CableAuditPayload = z.infer<typeof CableAuditPayload>;
