/**
 * Settings → This Whombat in five parts (docs/decisions/this-whombat-sections.md AP-1221…AP-1234): Overview, Backups,
 * Devices, Agents’ access and About — which ones a Whombat shows, the words of the parts, and the Overview's
 * two lists: NEEDS YOU (what is wrong, each with its step) and AT A GLANCE (one line for
 * everything else, a link to its part). Shared by the web's parts and the phone's This Whombat screens. Pure.
 */
import type { ApplianceStatus, LicenceView } from '../session/managed-ops';
import { backupPasskeyAsked } from './backup-options';
import { COPY } from './copy';
import { licenceSummary, licenceUsage } from './licence';
import { PASSKEY_SETUP_TEXT, type PasskeySetupView } from './passkey-setup';
import { ago, MANAGED_TEXT } from './status-copy';
import { updateView } from './updates';

export type WhombatPart = 'overview' | 'backups' | 'devices' | 'access' | 'about';

/** The parts in their order (AP-1221). */
export const WHOMBAT_PARTS: readonly WhombatPart[] = ['overview', 'backups', 'devices', 'access', 'about'];

type Dot = 'ok' | 'warn' | 'bad' | 'mut';

/** The step a NEEDS YOU row's button takes (AP-1224). */
export type WhombatAction =
  | 'setUpBackups'
  | 'openBackups'
  /** Not a NEEDS YOU step since BX-01 (no kit is quiet); kept for the phone's mapping of older rows. */
  | 'saveKit'
  | 'openDevices'
  | 'setUpPasskey';

/**
 * About → VERSION's “Hermes Agent” row (contracts 3.8 `ApplianceInfo.hermes`; Whombat hermes-updates.md HU-02; app
 * chat-settle.md AP-6159), after “Whombat”, on the web and the phone: what the assistant runs on, its version in mono or
 * that no runner has said yet.
 */
export const HERMES_WORDS = {
  title: 'Hermes Agent',
  meta: 'What your assistant runs on',
  unknown: 'Not known yet',
} as const;

export const THIS_WHOMBAT_TEXT = {
  parts: {
    overview: 'Overview',
    backups: 'Backups',
    devices: 'Devices',
    access: 'Agents’ access',
    about: 'About',
  } as Record<WhombatPart, string>,
  /** The parts' group, for screen readers. */
  partsLabel: 'Parts of This Whombat',
  /** A segment's accessible name with its badge (AP-1226). */
  partNeeds: (part: string, n: number) => `${part}, ${n} need${n === 1 ? 's' : ''} you`,
  needsYou: 'NEEDS YOU',
  glance: 'AT A GLANCE',
  showCharts: 'Show charts',
  hideCharts: 'Hide charts',
  actions: {
    setUpBackups: 'Set up backups',
    openBackups: 'Open backups',
    saveKit: MANAGED_TEXT.kitMake,
    openDevices: 'Open devices',
    setUpPasskey: PASSKEY_SETUP_TEXT.finish,
  } as Record<WhombatAction, string>,
  /** A NEEDS YOU or AT A GLANCE dot's name for screen readers. */
  dotLabels: { ok: 'Fine', warn: 'Needs a look', bad: 'Not working', mut: 'Waiting' } as Record<Dot, string>,
  /** Bringing it back, part of being backed up (Whombat backup-passkey.md BPK-08). */
  broughtBack: 'Can be brought back',
  backupsOff: 'Backups aren’t set up',
  backupsOffMeta: 'If this Whombat breaks, its data can’t be restored.',
  backedUp: 'Backed up',
  devices: (n: number) => (n === 1 ? '1 device' : `${n} devices`),
  /**
   * The agent by its name (less-is-more.md AP-1806; one-agent.md AP-4905): the part named after it, “Dusty’s access”,
   * and what it may reach.
   */
  accessFor: (agent: string) => `${capital(agent)}’s access`,
  lanOpenFor: (agent: string) => `${capital(agent)} may reach your local network`,
  lanClosedFor: (agent: string, n: number) =>
    n === 0
      ? `Your local network is closed to ${agent}`
      : `${n} local network${n === 1 ? '' : 's'} open to ${agent}`,
  version: (app: string, runtime: string | null) =>
    runtime ? `App ${app} · Whombat ${runtime}` : `App ${app}`,
  /** The AT A GLANCE row that opens About: named after the page it opens, its state on the line under it. */
  aboutTitle: 'About',
  /** The agent's access with nothing in it (AP-1230). */
  nothingHere: 'Nothing to set here on this Whombat.',
  /** What a managed Whombat turns off (was “NOT ON A MANAGED WHOMBAT”; AP-1230). */
  turnedOff: 'TURNED OFF HERE',
  /** Was SUBSCRIPTION (AP-1231). */
  plan: 'PLAN',
  devicesLabel: 'DEVICES',
  addDevice: 'Add a device',
  addDeviceMeta: 'A phone scans a code with the Whombat app. Another computer opens a link.',
  /** To the Mobile app page, where a phone signs in by QR code (AP-523). */
  addPhone: 'Add a phone',
  addComputer: 'Add a computer',
  /** A new device already shows a code: only the field to type it. */
  enterCode: 'Have a code already?',
  /** “Add a computer”: what to do, in order. */
  addComputerSteps: [
    'Open this link on the other computer.',
    'Sign in there with the same email you use here. It then shows a code.',
    'Type that code here, then check its fingerprint before you let it in.',
  ],
  showLink: 'Show the link',
  /** The code field under Add a computer's steps (step 3 says what to do). */
  codeFromComputer: 'Type the code the other computer shows, like 1234-5678.',
  /** Letting a device in from Devices: the Mobile app page's card, with words for any device. */
  confirmLabel: 'A DEVICE IS ASKING TO COME IN',
  confirmTitle: (name: string) => `Let ${name} in?`,
  confirmInto: 'It gets the same access to this Whombat as this browser.',
  sameOnDevice: 'Check that the other device shows',
  compareDevice: 'If they don’t match, choose “Not my device”.',
  notMyDevice: 'Not my device',
  addNetwork: 'Add network',
  cancel: 'Cancel',
  diagnostics: {
    make: 'Make a file for support…',
    dialogTitle: 'Make a file for support',
    /** What each part of a diagnostic file holds, in plain words (AP-1232); the contract's list is for developers. */
    scopes: {
      versions: 'Which versions of Whombat and its parts are running.',
      health:
        'Whether each part works, how long it’s been running and whether AI sign-ins work. Not whose they are.',
      updates: 'What’s running, what’s next, and why an update waited or failed.',
      backup: 'Whether backups work and when the last one ran. Not where they go, and nothing from them.',
      connectivity: 'How well this Whombat stayed connected over the last 7 days.',
      errors:
        'How often something went wrong over the last 7 days, counted by kind. Nothing from your conversations.',
    } as Record<string, string>,
  },
  backupFile: {
    download: 'Download a backup…',
    restore: 'Restore from a file…',
    show: 'Show',
    making: (pct: number | null) => (pct === null ? 'Making the file…' : `Making the file · ${pct} %`),
    ready: (size: string) => `Ready · ${size}`,
    uploading: (pct: number | null) => (pct === null ? 'Uploading…' : `Uploading · ${pct} %`),
    opening: 'Waiting for its password',
    preview: 'Choose what to bring back',
    restoring: 'Restoring…',
    restored: 'Restored',
    failed: 'The restore didn’t finish',
  },
} as const;

function capital(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** A part's name; the agent's part by its name, “Dusty’s access” (AP-1806, AP-4905). */
export function whombatPartLabel(part: WhombatPart, agent: string): string {
  return part === 'access' ? THIS_WHOMBAT_TEXT.accessFor(agent) : THIS_WHOMBAT_TEXT.parts[part];
}

/** Reads `?section=`: one of the parts, else the Overview (AP-1221). */
export function whombatPart(value: unknown): WhombatPart {
  return typeof value === 'string' && (WHOMBAT_PARTS as readonly string[]).includes(value)
    ? (value as WhombatPart)
    : 'overview';
}

/** The parts a Whombat shows, in order (AP-1222). */
export function whombatParts(here: { managed: boolean; backupFile: boolean }): WhombatPart[] {
  const shown: Record<WhombatPart, boolean> = {
    overview: true,
    backups: here.managed || here.backupFile,
    devices: here.managed,
    access: true,
    about: true,
  };
  return WHOMBAT_PARTS.filter((p) => shown[p]);
}

/** One row of NEEDS YOU or AT A GLANCE. */
export interface WhombatItem {
  key: string;
  part: WhombatPart;
  dot: Dot;
  title: string;
  meta?: string;
  /** NEEDS YOU only: the button's step. */
  action?: WhombatAction;
  actionLabel?: string;
}

export interface WhombatOverviewInput {
  /** A managed Whombat's `appliance.status`; null elsewhere or until it answers. */
  status: (Pick<ApplianceStatus, 'backup' | 'recovery' | 'update'> & { licence?: LicenceView | null }) | null;
  /** Devices that aren't removed (`endpoints.list`); null until known or elsewhere. */
  devices: number | null;
  /** The viewer's own passkeys, where passkeys are offered on this device; null otherwise or until known. */
  passkeys: PasskeySetupView | null;
  /** What the agent may reach: the local network (open, or how many listed networks). */
  access: { lan: 'open' | number | null } | null;
  /** The versions, for a Whombat without an update row (AP-1225). */
  versions?: { app: string; runtime: string | null } | null;
  /** The agent by its name: AT A GLANCE says what it may reach (AP-1806, AP-4905). */
  agent: string;
  timeZone?: string;
}

export interface WhombatOverview {
  needsYou: WhombatItem[];
  glance: WhombatItem[];
  /** How many NEEDS YOU rows each part has (AP-1226); parts without any are left out. */
  badges: Partial<Record<WhombatPart, number>>;
}

const WORST: Record<Dot, number> = { bad: 0, warn: 1, mut: 2, ok: 3 };

/**
 * The Overview's two lists (AP-1223…AP-1225). What is wrong goes to NEEDS YOU, worst first;
 * the rest is one glance row each, in the part order of AP-1225, only when known.
 */
export function whombatOverview(input: WhombatOverviewInput): WhombatOverview {
  const needsYou: WhombatItem[] = [];
  const glance: WhombatItem[] = [];
  const s = input.status;
  const T = THIS_WHOMBAT_TEXT;

  if (s) {
    const update = updateView(s).rows[0];
    if (update)
      glance.push({
        key: 'update',
        part: 'about',
        dot: update.dot ?? 'mut',
        // “About” over “Up to date · Software …”: the row says where it goes, the line how the updates stand.
        title: T.aboutTitle,
        meta: update.meta ? `${update.title} · ${update.meta}` : update.title,
      });
    if (s.licence) {
      // “Whombat plan · Active” over “Valid until 24 October 2026 · Connectors 3 of 50” (AP-1225).
      const plan = licenceSummary(s.licence, input.timeZone);
      const name = s.licence.plan ? COPY.licence.plan(s.licence.plan) : null;
      const usage = licenceUsage(s.licence).map((u) => u.text);
      const meta = [...plan.meta.split(' · ').filter((p) => p && p !== name), ...usage].join(' · ');
      glance.push({
        key: 'plan',
        part: 'about',
        dot: plan.dot,
        title: name ? `${name} · ${plan.title}` : plan.title,
        ...(meta ? { meta } : {}),
      });
    }

    const b = s.backup;
    const last = b.lastSuccessAt ? MANAGED_TEXT.backup.last(ago(b.lastSuccessAt)) : MANAGED_TEXT.backup.none;
    if (b.state === 'unprotected')
      needsYou.push({
        key: 'backups',
        part: 'backups',
        dot: 'warn',
        title: T.backupsOff,
        meta: T.backupsOffMeta,
        action: 'setUpBackups',
      });
    else if (b.state === 'failing' || b.state === 'stale')
      needsYou.push({
        key: 'backups',
        part: 'backups',
        dot: b.state === 'failing' ? 'bad' : 'warn',
        title: MANAGED_TEXT.backup[b.state],
        meta: [last, b.lastFailure?.reason].filter(Boolean).join(' · '),
        action: 'openBackups',
      });
    else {
      // “Can be brought back” is part of being backed up (the passkey or the paper copy holds the key).
      const way =
        b.bringBack?.state === 'ready' || b.bringBack?.state === 'paper_only' ? T.broughtBack : null;
      glance.push({
        key: 'backups',
        part: 'backups',
        dot: b.state === 'protected' ? 'ok' : 'mut',
        title: b.state === 'protected' ? T.backedUp : MANAGED_TEXT.backup.pending,
        meta: [last, way].filter(Boolean).join(' · '),
      });
    }

    // A Whombat from before the passkey keeps its quiet recovery-kit line.
    if (!b.bringBack)
      glance.push(
        s.recovery.kitVerified
          ? {
              key: 'kit',
              part: 'backups',
              dot: 'ok',
              title: MANAGED_TEXT.kitSaved,
              meta: MANAGED_TEXT.kitSavedMeta,
            }
          : {
              key: 'kit',
              part: 'backups',
              dot: 'mut',
              title: MANAGED_TEXT.kitMissing,
              meta: s.recovery.rotationPending
                ? MANAGED_TEXT.kitRotationPending
                : MANAGED_TEXT.kitMissingMeta,
            },
      );
  }

  const passkey = input.passkeys;
  if (passkey && passkey.phase !== 'ready')
    needsYou.push({
      key: 'passkey',
      part: 'devices',
      dot: 'mut',
      title: passkey.title,
      meta: passkey.meta,
      action: 'setUpPasskey',
      actionLabel: passkey.action ?? undefined,
    });
  else if (passkey)
    glance.push({ key: 'passkey', part: 'devices', dot: 'ok', title: passkey.title, meta: passkey.meta });
  else if (s && backupPasskeyAsked(s.backup))
    needsYou.push({
      key: 'passkey',
      part: 'devices',
      dot: 'mut',
      title: PASSKEY_SETUP_TEXT.empty,
      meta: PASSKEY_SETUP_TEXT.intro,
      action: 'setUpPasskey',
      actionLabel: PASSKEY_SETUP_TEXT.setup,
    });
  if (input.devices !== null && input.devices > 0)
    glance.push({ key: 'devices', part: 'devices', dot: 'ok', title: T.devices(input.devices) });

  const a = input.access;
  if (a && a.lan !== null) {
    const who = input.agent;
    glance.push({
      key: 'access',
      part: 'access',
      dot: 'ok',
      title: a.lan === 'open' ? T.lanOpenFor(who) : T.lanClosedFor(who, a.lan),
    });
  }

  if (!s?.update && input.versions)
    glance.push({
      key: 'version',
      part: 'about',
      dot: 'ok',
      title: T.aboutTitle,
      meta: T.version(input.versions.app, input.versions.runtime),
    });

  needsYou.sort((x, y) => WORST[x.dot] - WORST[y.dot]);
  const badges: Partial<Record<WhombatPart, number>> = {};
  for (const item of needsYou) badges[item.part] = (badges[item.part] ?? 0) + 1;
  return { needsYou, glance, badges };
}
