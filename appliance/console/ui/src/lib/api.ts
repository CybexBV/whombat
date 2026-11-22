/**
 * The JSON the local Go servers send (docs/decisions/console-gui.md: Console API CG-06, Installer API CG-11, the desk
 * CG-37).
 * The servers validate everything they read; `parseState` still checks the shape so a surprise never crashes the
 * page: anything it doesn't understand becomes `null` (the page keeps the last good screen).
 */

import { type BluetoothSummary, parseBluetoothSummary } from './bluetooth';
import { type DeskState, parseDesk } from './desk';
import { type NetworkSummary, parseNetworkSummary } from './network';
import { parseSignIn, type SignIn } from './signIn';

export const CLAIM_STATES = ['starting', 'waiting', 'claimable', 'backoff', 'claimed'] as const;
export type ClaimStateName = (typeof CLAIM_STATES)[number];

export interface Burrows {
  first: string;
  more: number;
}

export interface ClaimState {
  state: ClaimStateName;
  code: string;
  claimUrl: string;
  appUrl: string;
  retryAt: string | null;
  burrows: Burrows | null;
  /** A device waiting to sign in at this screen (BX-06, CG-150): claimed only; left out when there is none. */
  signIn?: SignIn | null;
  /** The claim link is the box's Tailscale name: the screen says to open it on the tailnet (CG-402). */
  onTailnet?: boolean;
  /**
   * The address to type in the Whombat app on this network: the box has no address a person can open but one
   * there, so the claim screen shows the code with it. Claimable only; left out otherwise.
   */
  inApp?: string;
  /**
   * The box's network gave it only IPv6 addresses, which the app can't take: the screen says an IPv4 address is
   * another way. Claimable without an address, and waiting (a box that could name none of those addresses).
   */
  ipv6Only?: boolean;
  /**
   * The letters were asked for at this screen and stay until then (RFC 3339, the server's clock), whatever is tried.
   * Claimable only; left out when they change after a wrong try.
   */
  lettersUntil?: string;
  /** The screen may offer New letters (POST /api/claim/letters). Claimable and backoff only. */
  newLetters?: boolean;
  /**
   * Another way to the claim, for when the claim link doesn't open: the box's own address is on the internet, where
   * others can keep it busy. The box's page on its tailnet name, or its address on this network to type in the
   * Whombat app. Claimable with a claim link only; at most one, left out when there is none.
   */
  fallbackTailnet?: string;
  fallbackInApp?: string;
  /** Why the first start can't finish (CG-409): starting only; left out when there is none. */
  start?: StartProblem;
  /**
   * The claim link as a QR code (rows of '#' dark and '.' light, see `qrRows`), beside the link with its code: the https
   * address only, never the letters. Claimable only; left out when there is none.
   */
  qr?: string[];
  /** The claim is the second of two numbered steps, after what Tailscale needs (the note above says “1 · ”). */
  second?: boolean;
}

/** The start problems the server sends (consoleapi `Start`, screen/start.go). */
export const START_PROBLEMS = ['release-missing', 'offline', 'failed'] as const;
export type StartProblemKind = (typeof START_PROBLEMS)[number];

export interface StartProblem {
  problem: StartProblemKind;
  /** The release the box was installed with; '' when there is none to show. */
  release: string;
}

export interface ConsoleState {
  mode: 'console';
  now: string;
  claim: ClaimState | null;
  footer: string;
  /** The desk display (CG-37): null when the box has none or the page doesn't understand it. */
  desk: DeskState | null;
  /** How the box is connected (CG-101): null without a desk socket or an answer (no chip, no Wi-Fi sheet). */
  network?: NetworkSummary | null;
  /** The box's Bluetooth (CG-201): null without a desk socket, an answer or an adapter (no chip, no Bluetooth sheet). */
  bluetooth?: BluetoothSummary | null;
  /** A warning over every console screen (contracts 4.3, CG-400); left out when there is none. */
  alert?: ConsoleAlert;
  /** Whombat Link and Tailscale, as the text console shows them (CG-402, CG-404); left out when there is nothing. */
  reach?: ConsoleReach;
}

/**
 * The Link states the server sends (consoleapi `ReachLink`): `on` only while an unclaimed box waits for its web address
 * (`waitingForAddress`); the others show nothing on the screen.
 */
export const REACH_LINK_STATES = ['starting', 'on', 'grace', 'ended'] as const;
export type ReachLinkState = (typeof REACH_LINK_STATES)[number];

/** Whombat Link on the screen: only what the text console shows at the same moment (the server decides). */
export interface ReachLink {
  state: ReachLinkState;
  /** Starting, while the code is live: XXXX-XXXX, and the page to type it at (without the scheme); else ''. */
  code: string;
  url: string;
  /** The Link page with the code in its address as a QR code (`qrRows`), beside a live code; else []. */
  qr: string[];
  /** When the code changes (RFC 3339, the server's clock), only when the screen says so; else null. */
  expiresAt: string | null;
  waitingForAddress: boolean;
  /** Grace: the day it ends as the text console says it (“25 November”); else ''. */
  graceEndsOn: string;
}

/** What Tailscale needs from the person: its sign-in page (without the scheme, shown as text) and HTTPS. */
export interface ReachTailscale {
  loginUrl: string;
  needsHttps: boolean;
  /** The sign-in page as a QR code (`qrRows`); [] when there is none. */
  loginQr: string[];
  /** Tailscale's note is the first of two numbered steps, the claim under it the second. */
  first: boolean;
}

export interface ConsoleReach {
  link?: ReachLink;
  tailscale?: ReachTailscale;
}

/** The alert kinds the page has words for (contracts 4.3 `ConsoleAlertKind`). */
export const CONSOLE_ALERT_KINDS = ['own_address_foreign'] as const;
export type ConsoleAlertKind = (typeof CONSOLE_ALERT_KINDS)[number];

export interface ConsoleAlert {
  kind: ConsoleAlertKind;
  /** RFC 3339, as the server sent it. */
  since: string;
}

export const CHECK_IDS = [
  'uefi',
  'cpu',
  'memory',
  'disk',
  'network',
  'reach-api',
  'reach-updates',
  'reach-relay',
  'reach-login',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];
export type CheckStatus = 'running' | 'ok' | 'warn' | 'fail';

export interface Check {
  id: CheckId;
  status: CheckStatus;
  value: string;
}

export type DiskReason = '' | 'too-small' | 'installer-medium' | 'in-use' | 'usb';
export const DISK_REASONS = ['', 'too-small', 'installer-medium', 'in-use', 'usb'] as const;

export interface Disk {
  path: string;
  name: string;
  model: string;
  sizeBytes: number;
  eligible: boolean;
  reason: DiskReason;
  /** No partitions and no file system: erasing it loses nothing (absent from an older server: not known to be). */
  empty?: boolean;
  /** What is on a disk that isn't empty: its partitions, or its own file system. */
  parts?: DiskPart[];
}

/** A partition (or a disk's own file system) as blkid found it; "" for a label or type it has none of. */
export interface DiskPart {
  label: string;
  fsType: string;
  sizeBytes: number;
}

export const INSTALL_STEPS = ['partition', 'filesystems', 'copy', 'boot', 'finish'] as const;
export type InstallStep = (typeof INSTALL_STEPS)[number];
export type InstallStatus = 'idle' | 'running' | 'done' | 'failed';

export interface InstallerState {
  mode: 'installer';
  platform: 'self-installed' | 'factory';
  storage: 'host-encrypted' | 'luks-tpm2';
  environment: 'prod' | 'dev';
  /** A community image has no Whombat Link (NX-445); left out by an older server (commercial). */
  edition?: 'commercial' | 'community';
  release: string | null;
  appUrl: string;
  preflight: {
    status: 'running' | 'done';
    checks: Check[];
    disks: Disk[];
  };
  install: {
    status: InstallStatus;
    disk: string | null;
    step: InstallStep | null;
    percent: number;
    log: string[];
    error: string;
  };
  /** A cable's interface had an address at the last network check (null: not checked yet): else the Wi-Fi step. */
  wired?: boolean | null;
}

/** How the owner will reach the box (Whombat LNK-12), as the installer's server takes it. */
export interface ReachChoice {
  link: boolean;
  tailscale: boolean;
  /** Tailscale only: the owner's own login server (Headscale); left out for Tailscale's own. */
  loginServer?: string;
}

/**
 * `POST /api/install` (CG-11): `reach` is left out when the page has none to send. No environment: every box starts in
 * the image's own, production (ONE-02).
 */
export interface InstallRequest {
  disk: string;
  confirm: string;
  reach?: ReachChoice;
}

export type ServerState = ConsoleState | InstallerState;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const bool = (v: unknown): boolean => v === true;
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []);
const oneOf = <T extends string>(v: unknown, values: readonly T[], fallback: T): T =>
  values.includes(v as T) ? (v as T) : fallback;
const num = (v: unknown, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min;

function parseClaim(v: unknown): ClaimState | null {
  if (!isObj(v) || !CLAIM_STATES.includes(v.state as ClaimStateName)) return null;
  const b = v.burrows;
  return {
    state: v.state as ClaimStateName,
    code: str(v.code),
    claimUrl: str(v.claimUrl),
    appUrl: str(v.appUrl),
    retryAt: typeof v.retryAt === 'string' ? v.retryAt : null,
    burrows:
      isObj(b) && typeof b.first === 'string' && b.first !== ''
        ? { first: b.first, more: Math.floor(num(b.more, 0, 1e6)) }
        : null,
    ...signIn(v.state === 'claimed' ? v.signIn : null),
    ...(v.onTailnet === true ? { onTailnet: true } : {}),
    ...(v.state === 'claimable' && typeof v.inApp === 'string' && v.inApp !== '' ? { inApp: v.inApp } : {}),
    ...((v.state === 'claimable' || v.state === 'waiting') && v.ipv6Only === true ? { ipv6Only: true } : {}),
    ...(v.state === 'claimable' &&
    typeof v.lettersUntil === 'string' &&
    Number.isFinite(Date.parse(v.lettersUntil))
      ? { lettersUntil: v.lettersUntil }
      : {}),
    ...((v.state === 'claimable' || v.state === 'backoff') && v.newLetters === true
      ? { newLetters: true }
      : {}),
    ...fallback(v),
    ...start(v.state === 'starting' ? v.start : null),
    ...(v.state === 'claimable' && str(v.claimUrl) !== '' && str(v.code) !== '' && qrRows(v.qr).length
      ? { qr: qrRows(v.qr) }
      : {}),
    ...(v.state !== 'claimed' && v.state !== 'backoff' && v.second === true ? { second: true } : {}),
  };
}

/** The widest QR code the server sends (version 7): a denser one would be hard to read off the screen. */
const QR_MAX = 45;

/**
 * A QR code as the server sends it (screen.QRModules): rows of '#' (dark) and '.' (light), as many as each is long, a
 * size a QR code has (21, 25, … modules). Anything else is [], and the screen shows the address as words only.
 */
export function qrRows(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const n = v.length;
  if (n < 21 || n > QR_MAX || (n - 17) % 4 !== 0) return [];
  return v.every((r) => typeof r === 'string' && r.length === n && /^[#.]+$/.test(r)) ? (v as string[]) : [];
}

/** The claim's second way in, only beside a claim link to open: the tailnet page first, else the app's address. */
function fallback(v: Obj): Pick<ClaimState, 'fallbackTailnet' | 'fallbackInApp'> {
  if (v.state !== 'claimable' || str(v.claimUrl) === '') return {};
  if (typeof v.fallbackTailnet === 'string' && v.fallbackTailnet !== '')
    return { fallbackTailnet: v.fallbackTailnet };
  if (typeof v.fallbackInApp === 'string' && v.fallbackInApp !== '')
    return { fallbackInApp: v.fallbackInApp };
  return {};
}

/** The start problem when the server sent one the page knows on a starting box (left out otherwise). */
function start(v: unknown): { start?: StartProblem } {
  if (!isObj(v) || !START_PROBLEMS.includes(v.problem as StartProblemKind)) return {};
  return { start: { problem: v.problem as StartProblemKind, release: str(v.release) } };
}

/** The sign-in when the server sent one on a claimed box (left out otherwise, as from an older server). */
function signIn(v: unknown): { signIn?: SignIn } {
  const s = parseSignIn(v);
  return s ? { signIn: s } : {};
}

function parseConsole(v: Obj): ConsoleState {
  return {
    mode: 'console',
    now: str(v.now),
    claim: parseClaim(v.claim),
    footer: str(v.footer),
    desk: parseDesk(v.desk),
    ...network(v.network),
    ...bluetooth(v.bluetooth),
    ...alert(v.alert),
    ...reach(v.reach),
  };
}

/** The Link code's form (contracts `LinkCodePattern`): the claim alphabet, 4 + 4. */
const linkCodeRe = /^[ABCDEFGHJKMNPQRTVWXY]{4}-[ABCDEFGHJKMNPQRTVWXY]{4}$/;
/** A plain host/path, as the server shows addresses: never markup, a scheme or anything but these characters. */
const plainUrlRe = /^[A-Za-z0-9.[\]:-]+(?:\/[A-Za-z0-9._~/-]*)?$/;
const plainUrl = (v: unknown, max: number): string =>
  typeof v === 'string' && v.length <= max && plainUrlRe.test(v) ? v : '';

/** The reach when the server sent one the page can show (left out otherwise, as from an older server). */
function reach(v: unknown): { reach?: ConsoleReach } {
  if (!isObj(v)) return {};
  const out: ConsoleReach = {};
  const l = v.link;
  if (isObj(l) && REACH_LINK_STATES.includes(l.state as ReachLinkState)) {
    const url = plainUrl(l.url, 100);
    const code = typeof l.code === 'string' && linkCodeRe.test(l.code) && url ? l.code : '';
    out.link = {
      state: l.state as ReachLinkState,
      code,
      url: code ? url : '',
      qr: code ? qrRows(l.qr) : [],
      expiresAt: code && typeof l.expiresAt === 'string' ? l.expiresAt : null,
      waitingForAddress: l.waitingForAddress === true,
      graceEndsOn: typeof l.graceEndsOn === 'string' && l.graceEndsOn.length <= 40 ? l.graceEndsOn : '',
    };
  }
  const t = v.tailscale;
  if (isObj(t)) {
    const loginUrl = plainUrl(t.loginUrl, 500);
    const ts = {
      loginUrl,
      needsHttps: t.needsHttps === true,
      loginQr: loginUrl ? qrRows(t.loginQr) : [],
      first: t.first === true,
    };
    if (ts.loginUrl || ts.needsHttps) out.tailscale = ts;
  }
  return out.link || out.tailscale ? { reach: out } : {};
}

/** The alert when the server sent one the page knows (left out otherwise, as from an older server). */
function alert(v: unknown): { alert?: ConsoleAlert } {
  if (!isObj(v) || !CONSOLE_ALERT_KINDS.includes(v.kind as ConsoleAlertKind) || typeof v.since !== 'string')
    return {};
  return { alert: { kind: v.kind as ConsoleAlertKind, since: v.since } };
}

/** The network summary when the server sent one (left out otherwise: an older server's state reads as before). */
function network(v: unknown): { network?: NetworkSummary } {
  const n = parseNetworkSummary(v);
  return n ? { network: n } : {};
}

/** The Bluetooth summary when the server sent one (left out otherwise, as from an older server). */
function bluetooth(v: unknown): { bluetooth?: BluetoothSummary } {
  const b = parseBluetoothSummary(v);
  return b ? { bluetooth: b } : {};
}

function parseInstaller(v: Obj): InstallerState {
  const pre = isObj(v.preflight) ? v.preflight : {};
  const inst = isObj(v.install) ? v.install : {};
  const checks: Check[] = (Array.isArray(pre.checks) ? pre.checks : []).filter(isObj).flatMap((c) =>
    CHECK_IDS.includes(c.id as CheckId)
      ? [
          {
            id: c.id as CheckId,
            status: oneOf(c.status, ['running', 'ok', 'warn', 'fail'] as const, 'running'),
            value: str(c.value),
          },
        ]
      : [],
  );
  const disks: Disk[] = (Array.isArray(pre.disks) ? pre.disks : []).filter(isObj).flatMap((d) =>
    typeof d.path === 'string' && typeof d.name === 'string'
      ? [
          {
            path: d.path,
            name: d.name,
            model: str(d.model),
            sizeBytes: num(d.sizeBytes, 0, Number.MAX_SAFE_INTEGER),
            eligible: bool(d.eligible),
            reason: oneOf(d.reason, DISK_REASONS, ''),
            empty: bool(d.empty),
            parts: (Array.isArray(d.parts) ? d.parts : [])
              .filter(isObj)
              .slice(0, 16)
              .map((p) => ({
                label: str(p.label),
                fsType: str(p.fsType),
                sizeBytes: num(p.sizeBytes, 0, Number.MAX_SAFE_INTEGER),
              })),
          },
        ]
      : [],
  );
  return {
    mode: 'installer',
    platform: v.platform === 'self-installed' ? 'self-installed' : 'factory',
    storage: v.storage === 'host-encrypted' ? 'host-encrypted' : 'luks-tpm2',
    environment: v.environment === 'dev' ? 'dev' : 'prod',
    ...(v.edition === 'community' || v.edition === 'commercial' ? { edition: v.edition } : {}),
    release: typeof v.release === 'string' && v.release !== '' ? v.release : null,
    appUrl: str(v.appUrl),
    preflight: { status: pre.status === 'done' ? 'done' : 'running', checks, disks },
    install: {
      status: oneOf(inst.status, ['idle', 'running', 'done', 'failed'] as const, 'idle'),
      disk: typeof inst.disk === 'string' ? inst.disk : null,
      step: INSTALL_STEPS.includes(inst.step as InstallStep) ? (inst.step as InstallStep) : null,
      percent: Math.round(num(inst.percent, 0, 100)),
      log: strs(inst.log),
      error: str(inst.error),
    },
    ...(typeof v.wired === 'boolean' ? { wired: v.wired } : {}),
  };
}

/** The server's state, or null when it isn't one the page understands. */
export function parseState(v: unknown): ServerState | null {
  if (!isObj(v)) return null;
  if (v.mode === 'console') return parseConsole(v);
  if (v.mode === 'installer') return parseInstaller(v);
  return null;
}
