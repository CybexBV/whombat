/**
 * This Whombat on the phone in parts (this-whombat-sections-android.md AP-1240…AP-1255): what the Overview's lists are
 * made from (`overviewInput`, from what the screens read), where each NEEDS YOU step and each AT A GLANCE row goes on
 * the phone (Backups, Devices, About; the phone has no Agents’ access part), and a way into every part even
 * when nothing at a glance links to it. The lists and every word are the shared model's (`whombatOverview`,
 * `THIS_WHOMBAT_TEXT`, Whombat this-whombat-sections.md AP-1223…AP-1225). Pure.
 */

import { AGENT_FALLBACK_NAME } from '@whombat/client';
import {
  type PasskeySetupView,
  thisWhombatText,
  type WhombatAction,
  type WhombatOverview,
  type WhombatOverviewInput,
  type WhombatPart,
} from '@whombat/client/managed';
import type { ApplianceStatus, EndpointSummary } from '@whombat/client/session';

type Dot = 'ok' | 'warn' | 'bad' | 'mut';

/** Where on Devices a step lands (AP-1247). */
export type DevicesAt = 'passkeys';

/**
 * Where a NEEDS YOU button or an AT A GLANCE row goes: the recovery kit's flow, the passkey's touch for the backups
 * (run where it is tapped), or a part's screen.
 */
export type WhombatStep =
  | { to: 'kit'; params?: undefined }
  | { to: 'passkey'; params?: undefined }
  | { to: 'WhombatBackups'; params?: { setUp: true } }
  | { to: 'Devices'; params?: { at: DevicesAt } }
  | { to: 'WhombatAbout'; params?: undefined };

/** The parts the phone has, after the Overview (AP-1240): the agent's access is the web's only. */
export const PHONE_PARTS = ['backups', 'devices', 'about'] as const;
export type PhonePart = (typeof PHONE_PARTS)[number];

const isPhonePart = (part: WhombatPart): part is PhonePart =>
  (PHONE_PARTS as readonly string[]).includes(part);

/** A part's screen (AP-1240). */
export function partStep(part: PhonePart): WhombatStep {
  return part === 'backups'
    ? { to: 'WhombatBackups' }
    : part === 'devices'
      ? { to: 'Devices' }
      : { to: 'WhombatAbout' };
}

/**
 * What a NEEDS YOU button does (AP-1243): Set up backups opens Backups with the destination form open, Save a
 * recovery kit the kit's flow at once; the devices' steps open Devices, at PASSKEYS for setup.
 */
export function actionStep(action: WhombatAction): WhombatStep {
  switch (action) {
    case 'setUpBackups':
      return { to: 'WhombatBackups', params: { setUp: true } };
    case 'openBackups':
      return { to: 'WhombatBackups' };
    case 'saveKit':
      return { to: 'kit' };
    case 'openDevices':
      return { to: 'Devices' };
    case 'setUpPasskey':
      return { to: 'passkey' };
  }
}

/** What the Overview read (AP-1241); each list is null until it answers, or when it can't be read. */
export interface OverviewFacts {
  status: ApplianceStatus;
  /** `endpoints.list`: your devices. */
  endpoints: readonly Pick<EndpointSummary, 'revocation'>[] | null;
  /** `passkeys.list`, read only where passkeys are offered (the Whombat has them and this phone can make them). */
  passkeys: PasskeySetupView | null;
  /** This app's version, for a Whombat without an update row. */
  app: string | null;
  timeZone?: string;
  locale?: string;
  /** The agent's name, for AT A GLANCE's lines (AP-4905, AP-4998); “your agent” where it isn't known. */
  agent?: string;
}

/** The shared Overview's input from what the phone read (AP-1241). */
export function overviewInput(f: OverviewFacts): WhombatOverviewInput {
  return {
    status: f.status,
    devices: f.endpoints ? f.endpoints.filter((e) => e.revocation === 'none').length : null,
    passkeys: f.passkeys,
    access: null,
    versions: f.app ? { app: f.app, runtime: f.status.appliance.runtimeVersion ?? null } : null,
    ...(f.timeZone ? { timeZone: f.timeZone } : {}),
    ...(f.locale ? { locale: f.locale } : {}),
    agent: f.agent ?? AGENT_FALLBACK_NAME,
  };
}

/** A NEEDS YOU row on the phone: its dot, words, the button's label and where it goes. */
export interface NeedsRow {
  key: string;
  dot: Dot;
  title: string;
  meta: string | null;
  button: string;
  step: WhombatStep;
}

export function needsRows(overview: WhombatOverview, locale?: string | null): NeedsRow[] {
  const { actions } = thisWhombatText(locale);
  return overview.needsYou.flatMap((item) =>
    item.action
      ? [
          {
            key: item.key,
            dot: item.dot,
            title: item.title,
            meta: item.meta ?? null,
            button: item.actionLabel ?? actions[item.action],
            step: actionStep(item.action),
          },
        ]
      : [],
  );
}

/** An AT A GLANCE row on the phone: a link to its part, read as its title and line. */
export interface GlanceRow {
  key: string;
  part: PhonePart;
  dot: Dot | null;
  title: string;
  meta: string | null;
  label: string;
  step: WhombatStep;
}

/**
 * The AT A GLANCE rows (AP-1244): the shared ones whose part the phone has, then — so every part stays one tap away —
 * a row named after each part nothing above links to (Backups while both its rows need you, Devices while the
 * devices can't be read).
 */
export function glanceRows(overview: WhombatOverview, locale?: string | null): GlanceRow[] {
  const { parts } = thisWhombatText(locale);
  const rows: GlanceRow[] = [];
  for (const item of overview.glance) {
    if (!isPhonePart(item.part)) continue;
    rows.push({
      key: item.key,
      part: item.part,
      dot: item.dot,
      title: item.title,
      meta: item.meta ?? null,
      label: glanceLabel(item.title, item.meta),
      step: partStep(item.part),
    });
  }
  for (const part of PHONE_PARTS)
    if (!rows.some((r) => r.part === part)) {
      const title = parts[part];
      rows.push({
        key: `part:${part}`,
        part,
        dot: null,
        title,
        meta: null,
        label: title,
        step: partStep(part),
      });
    }
  return rows;
}

/** A glance row's TalkBack name: its title and line (“Backed up, Last backup 3 hours ago”). */
export function glanceLabel(title: string, meta: string | null | undefined): string {
  return meta ? `${title}, ${meta}` : title;
}

/** What a diagnostics scope holds, in the app's plain words (AP-1249); the contract's list only for a newer scope. */
export function diagnosticScopeLine(scope: string, contract: string, locale?: string | null): string {
  return thisWhombatText(locale).diagnostics.scopes[scope] ?? contract;
}
