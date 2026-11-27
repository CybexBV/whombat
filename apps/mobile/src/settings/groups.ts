/**
 * Settings on the phone in the web's groups (the shared `settingsGroups` of `@whombat/client`): **You** — the profile
 * card: your photo, your notifications, how Chat settles and, on a Whombat, your devices — **the assistant by its
 * name** — its name and face, the AI sign-in, Memory and What it may do (its keys a page under it) — **Connections**,
 * **This Whombat**, **Screens** as a row of its own where the Whombat has a screen, and **Advanced**: the expert pages
 * the phone has a screen for. Where an old Settings place opens now. Pure.
 */
import {
  type AdvancedPart,
  type AdvancedRow,
  type AgentGroupPart,
  advancedRowsHere,
  agentPartPlace,
  isAdvancedPart,
  isAgentGroupPart,
  isMovedAdvancedPart,
  type MovedAdvancedPart,
  type YouPart,
  youParts,
} from '@whombat/client';
import { andList } from '@whombat/client/managed';
import type { AppMode } from '../data/config';
import { mobileTranslator } from '../i18n/translate';

/** What the Spend page is called now: Usage (docs/decisions/phone-shell-final.md). */
export const USAGE_TITLE = mobileTranslator().t('settings2.groups.usage');

/** What the phone shows depends on whether it is on a Whombat or in the demo world. */
export interface SettingsHere {
  mode: AppMode;
}

/**
 * You's parts on the phone: your profile always; Notifications (Do not disturb, quiet hours, push on this phone) and
 * Devices only on a Whombat — the demo world has no account to keep them; Prompts where the Whombat keeps them
 * (`prompts` false: it doesn't know them, or hasn't said yet).
 */
export function youPartsHere(here: SettingsHere & { prompts?: boolean }): YouPart[] {
  const managed = here.mode === 'managed';
  return youParts({ managed }).filter(
    (p) => (p !== 'notifications' || managed) && (p !== 'prompts' || here.prompts !== false),
  );
}

const YOU_WORDS = {
  profile: 'settings.you.photo',
  notifications: 'settings.you.notifications',
  devices: 'settings.you.devices',
  links: 'settings.you.links',
  prompts: 'settings.you.prompts',
} as const satisfies Record<YouPart, string>;

/** The profile card's line under your name: what You holds here (“Your photo, notifications and devices”). */
export function youLine(parts: readonly YouPart[], locale?: string | null): string {
  const { t } = mobileTranslator(locale);
  const words = [t(YOU_WORDS.profile), ...parts.filter((p) => p !== 'profile').map((p) => t(YOU_WORDS[p]))];
  return andList(words, locale);
}

/**
 * The pages the phone draws itself at `settings/advanced/:part`: Advanced's parts of the assistant's profile and the AI on
 * this Whombat, and the keys — a page under What it may do, at the address its links always had.
 */
export type AdvancedPagePart = 'model' | 'ai' | 'keys' | 'running';
export const ADVANCED_PAGE_PARTS: readonly AdvancedPagePart[] = ['model', 'ai', 'keys', 'running'];

export function isAdvancedPagePart(value: unknown): value is AdvancedPagePart {
  return typeof value === 'string' && (ADVANCED_PAGE_PARTS as readonly string[]).includes(value);
}

/** Where an Advanced row, or an old Advanced address, opens: one of its own pages, or the screen the phone has for it. */
export type AdvancedRoute =
  | { name: 'SettingsAdvancedPart'; params: { part: AdvancedPagePart; key?: string } }
  | { name: 'Spend' | 'Skills' | 'AuditLog' | 'WhombatAbout' | 'Connections' | 'Vault'; params?: undefined }
  | { name: 'ConnectAccount'; params: { page: 'github' | 'feedback' } }
  | { name: 'Tabs'; params: { screen: 'Automations' } };

/**
 * An Advanced part's screen on the phone, or where a page that moved out of Advanced is now: the keys a page under
 * What it may do, GitHub and Website feedback their connection pages, the assistant's schedules the Automations tab, the
 * home network ranges the Vault's list. Null where it has none: the diagnostics file is a Whombat's (About has it).
 */
export function advancedRoute(
  part: AdvancedPart | MovedAdvancedPart,
  here: SettingsHere,
  key?: string,
): AdvancedRoute | null {
  switch (part) {
    case 'model':
    case 'ai':
    case 'running':
      return { name: 'SettingsAdvancedPart', params: { part } };
    case 'keys':
      return { name: 'SettingsAdvancedPart', params: key ? { part, key } : { part } };
    case 'schedules':
      return { name: 'Tabs', params: { screen: 'Automations' } };
    case 'spend':
      return { name: 'Spend' };
    // Connections, a group on the Settings home now; an old Advanced link still opens it.
    case 'accounts':
      return { name: 'Connections' };
    case 'skills':
      return { name: 'Skills' };
    case 'github':
    case 'feedback':
      return { name: 'ConnectAccount', params: { page: part } };
    case 'audit':
      return { name: 'AuditLog' };
    case 'diagnostics':
      return here.mode === 'managed' ? { name: 'WhombatAbout' } : null;
    case 'network':
      return { name: 'Vault' };
  }
}

/** An Advanced row the phone shows: the shared row, where it opens and what TalkBack reads. */
export interface AdvancedRowView extends AdvancedRow {
  route: AdvancedRoute;
  label: string;
}

/**
 * Advanced's rows on the phone, in the shared order and folds: those it has a screen for. Running shows once the host
 * answered (it says what runs, or why nothing can), Spend unless the Whombat refuses it.
 */
export function advancedRowsOnPhone(
  agent: string,
  here: SettingsHere & { services?: boolean; spend?: boolean },
  locale?: string | null,
): AdvancedRowView[] {
  const usage = mobileTranslator(locale).t('settings2.groups.usage');
  return advancedRowsHere(
    agent,
    {
      managed: here.mode === 'managed',
      ...(here.services === undefined ? {} : { services: here.services }),
      ...(here.spend === undefined ? {} : { spend: here.spend }),
    },
    locale,
  ).flatMap((row) => {
    const route = advancedRoute(row.key, here);
    // Spend is shown as Usage, the one name of that page on the phone (Places, Search, its title).
    const named = row.key === 'spend' ? { ...row, title: usage } : row;
    return route ? [{ ...named, route, label: `${named.title}. ${named.line}` }] : [];
  });
}

/** Where a part of the assistant's page sends a link (`whombat://settings/agent?part=…`): its own part, or Advanced. */
export type AgentPartTarget =
  | { kind: 'part'; part: AgentGroupPart }
  | { kind: 'elsewhere'; route: AdvancedRoute };

/**
 * An old part of Settings → Agent opens where it went: Notes is in Memory; the keys their page under What it may do;
 * the model, what it runs, spend and skills are Advanced's; schedules are in Automations. Anything else unknown is Name
 * and face.
 */
export function agentPartTarget(raw: unknown, here: SettingsHere, key?: string): AgentPartTarget {
  // The keys keep their page on the phone, with the row a link points at.
  if (raw === 'keys') return { kind: 'elsewhere', route: advancedRoute('keys', here, key) as AdvancedRoute };
  const place = agentPartPlace(typeof raw === 'string' ? raw : undefined);
  if (place.group === 'advanced' && (isAdvancedPart(place.part) || isMovedAdvancedPart(place.part))) {
    const route = advancedRoute(place.part, here, key);
    if (route) return { kind: 'elsewhere', route };
  }
  return { kind: 'part', part: isAgentGroupPart(place.part) ? place.part : 'profile' };
}
