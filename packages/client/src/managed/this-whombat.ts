/**
 * Settings → This Whombat in five parts (docs/decisions/this-whombat-sections.md AP-1221…AP-1234): Overview, Backups,
 * Devices, Agents’ access and About — which ones a Whombat shows, the words of the parts, and the Overview's
 * two lists: NEEDS YOU (what is wrong, each with its step) and AT A GLANCE (one line for
 * everything else, a link to its part). Shared by the web's parts and the phone's This Whombat screens. Pure.
 */
import { interpolate } from '@whombat/core/i18n';
import { clientTranslator, clientTree } from '../i18n/catalog';
import { HERMES_WORDS_TREE, THIS_WHOMBAT_WORDS } from '../i18n/messages/thisWhombat';
import type { ApplianceStatus, LicenceView } from '../session/managed-ops';
import { backupPasskeyAsked } from './backup-options';
import { licenceSummary, licenceUsage } from './licence';
import { type PasskeySetupView, passkeySetupText } from './passkey-setup';
import { ago, managedText } from './status-copy';
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
export function hermesWords(locale?: string | null) {
  return clientTree(locale, HERMES_WORDS_TREE);
}

export const HERMES_WORDS = hermesWords('en');

/** Settings → This Whombat's words in a locale (English when none is given). */
export function thisWhombatText(locale?: string | null) {
  const {
    lanClosedNone,
    versionApp,
    addComputerSteps,
    actions,
    backupFile: file,
    ...w
  } = clientTree(locale, THIS_WHOMBAT_WORDS);
  const { makingStart, uploadingStart, ...backupFile } = file;
  const f = interpolate;
  return {
    ...w,
    parts: w.parts as Record<WhombatPart, string>,
    /** A segment's accessible name with its badge. */
    partNeeds: (part: string, n: number) => w.partNeeds(n, { part }),
    actions: {
      ...actions,
      saveKit: managedText(locale).kitMake,
      setUpPasskey: passkeySetupText(locale).finish,
    } as Record<WhombatAction, string>,
    /** A NEEDS YOU or AT A GLANCE dot's name for screen readers. */
    dotLabels: w.dotLabels as Record<Dot, string>,
    devices: (n: number) => w.devices(n),
    /** The agent by its name: the part named after it, “Dusty’s access”, and what it may reach. */
    accessFor: (agent: string) => f(w.accessFor, { Agent: capital(agent) }),
    lanOpenFor: (agent: string) => f(w.lanOpenFor, { Agent: capital(agent) }),
    lanClosedFor: (agent: string, n: number) =>
      n === 0 ? f(lanClosedNone, { agent }) : w.lanClosedFor(n, { agent }),
    version: (app: string, runtime: string | null) =>
      runtime ? f(w.version, { app, runtime }) : f(versionApp, { app }),
    /** “Add a computer”: what to do, in order. */
    addComputerSteps: [addComputerSteps.first, addComputerSteps.second, addComputerSteps.third],
    confirmTitle: (name: string) => f(w.confirmTitle, { name }),
    diagnostics: {
      ...w.diagnostics,
      /** What each part of a diagnostic file holds, in plain words; the contract's list is for developers. */
      scopes: w.diagnostics.scopes as Record<string, string>,
    },
    backupFile: {
      ...backupFile,
      making: (pct: number | null) => (pct === null ? makingStart : f(backupFile.making, { pct })),
      ready: (size: string) => f(backupFile.ready, { size }),
      uploading: (pct: number | null) => (pct === null ? uploadingStart : f(backupFile.uploading, { pct })),
    },
  };
}

export const THIS_WHOMBAT_TEXT = thisWhombatText('en');

function capital(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** A part's name; the agent's part by its name, “Dusty’s access” (AP-1806, AP-4905). */
export function whombatPartLabel(part: WhombatPart, agent: string, locale?: string | null): string {
  const T = thisWhombatText(locale);
  return part === 'access' ? T.accessFor(agent) : T.parts[part];
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
  /** How it stands in a word or two where the title names the part instead (About's “Up to date”), for summary lines. */
  state?: string;
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
  /** The words' language; English when not given. */
  locale?: string | null;
}

export interface WhombatOverview {
  needsYou: WhombatItem[];
  glance: WhombatItem[];
  /** How many NEEDS YOU rows each part has (AP-1226); parts without any are left out. */
  badges: Partial<Record<WhombatPart, number>>;
}

/** “Founder plan”: the plan's id as a name. */
function planName(plan: string, locale?: string | null): string {
  const name = `${plan.charAt(0).toUpperCase()}${plan.slice(1).replace(/-/g, ' ')}`;
  return clientTranslator(locale).t('managed.licence.plan', { plan: name });
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
  const locale = input.locale;
  const T = thisWhombatText(locale);
  const M = managedText(locale);
  const P = passkeySetupText(locale);

  if (s) {
    const update = updateView(s, { locale }).rows[0];
    if (update)
      glance.push({
        key: 'update',
        part: 'about',
        dot: update.dot ?? 'mut',
        // “About” over “Up to date · Software …”: the row says where it goes, the line how the updates stand.
        title: T.aboutTitle,
        meta: update.meta ? `${update.title} · ${update.meta}` : update.title,
        state: update.title,
      });
    if (s.licence) {
      // “Whombat plan · Active” over “Valid until 24 October 2026 · Connectors 3 of 50” (AP-1225).
      const plan = licenceSummary(s.licence, input.timeZone, locale);
      const name = s.licence.plan ? planName(s.licence.plan, locale) : null;
      const usage = licenceUsage(s.licence, locale).map((u) => u.text);
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
    const last = b.lastSuccessAt ? M.backup.last(ago(b.lastSuccessAt, locale)) : M.backup.none;
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
        title: M.backup[b.state],
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
        title: b.state === 'protected' ? T.backedUp : M.backup.pending,
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
              title: M.kitSaved,
              meta: M.kitSavedMeta,
            }
          : {
              key: 'kit',
              part: 'backups',
              dot: 'mut',
              title: M.kitMissing,
              meta: s.recovery.rotationPending ? M.kitRotationPending : M.kitMissingMeta,
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
      title: P.empty,
      meta: P.intro,
      action: 'setUpPasskey',
      actionLabel: P.setup,
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
