/**
 * Settings in five groups (settings-groups.md, sidebar-tabs.md), the same on the web and the phone: **You** (your
 * profile, notifications, devices and passkeys), **the assistant by its name** (its name and face, the AI sign-in,
 * what it remembers, and what it may do), **Connections** (what this Whombat is signed in to, and how), **This
 * Whombat** (backups, updates, the screen, network, Bluetooth, voice, About), **News and weather** (where the Whombat
 * is and the news it reads) and **Advanced**, a list of the expert
 * pages that stays folded until one is opened. Every setting that was in Settings before is in one of them. Pure: the
 * groups, their parts, their words, and where an old address goes.
 */
import { agentWords } from './agentName';
import { clientTranslator } from './i18n/catalog';

export type SettingsGroup = 'you' | 'agent' | 'connections' | 'appliance' | 'news' | 'advanced';

/** The groups in their order. */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  'you',
  'agent',
  'connections',
  'appliance',
  'news',
  'advanced',
];

/** You: Profile by default. */
export type YouPart = 'profile' | 'notifications' | 'devices' | 'links' | 'prompts';
export const YOU_PARTS: readonly YouPart[] = ['profile', 'notifications', 'devices', 'links', 'prompts'];

/** The assistant's group: its name and face by default. */
export type AgentGroupPart = 'profile' | 'ai' | 'memory' | 'may' | 'ahead' | 'council';
export const AGENT_GROUP_PARTS: readonly AgentGroupPart[] = [
  'profile',
  'ai',
  'memory',
  'may',
  'ahead',
  'council',
];

/** The assistant's parts this Whombat has: Looks ahead only where it answers `looksAhead.*` (`hasLooksAhead`). */
export function agentGroupParts(here: Pick<SettingsHere, 'looksAhead'>): AgentGroupPart[] {
  return AGENT_GROUP_PARTS.filter((p) => p !== 'ahead' || here.looksAhead !== false);
}

/** Advanced's pages; without one, the list. */
export type AdvancedPart = 'model' | 'ai' | 'spend' | 'running' | 'skills' | 'audit' | 'diagnostics';

/** Advanced's list in its folds: what the assistant runs on, its work, this Whombat. */
export type AdvancedSection = 'ai' | 'work' | 'whombat';

export interface AdvancedRow {
  key: AdvancedPart;
  section: AdvancedSection;
  title: string;
  /** One line under the title, in plain words. */
  line: string;
}

/** Advanced's pages in order. */
export const ADVANCED_PARTS: readonly AdvancedPart[] = [
  'model',
  'ai',
  'spend',
  'running',
  'skills',
  'audit',
  'diagnostics',
];

/**
 * Advanced's pages that live elsewhere now; an old address (`?tab=advanced&part=keys`) still lands there. Connections
 * (`accounts`) is a group on the home, GitHub and Website feedback are connections on it, the keys and the always allowed
 * commands are in What the assistant may do, the home network ranges under its local network switch there, and the
 * assistant's schedules are in Automations.
 */
export type MovedAdvancedPart = 'accounts' | 'keys' | 'network' | 'schedules' | 'github' | 'feedback';
export const MOVED_ADVANCED_PARTS: readonly MovedAdvancedPart[] = [
  'accounts',
  'keys',
  'network',
  'schedules',
  'github',
  'feedback',
];

export function isMovedAdvancedPart(value: unknown): value is MovedAdvancedPart {
  return typeof value === 'string' && (MOVED_ADVANCED_PARTS as readonly string[]).includes(value);
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function settingsGroupText(locale?: string | null) {
  const tr = clientTranslator(locale);
  return {
    title: tr.t('settings.title'),
    subtitle: (agent: string) => tr.t('settings.subtitle', { Name: agentWords(agent, locale).Name }),
    groups: (agent: string): Record<SettingsGroup, string> => ({
      you: tr.t('settings.group.you'),
      agent: agentWords(agent, locale).Name,
      connections: tr.t('settings.group.connections'),
      appliance: tr.t('settings.group.appliance'),
      news: tr.t('settings.group.news'),
      advanced: tr.t('settings.group.advanced'),
    }),
    you: {
      profile: tr.t('settings.you.profile'),
      notifications: tr.t('settings.you.notifications'),
      devices: tr.t('settings.you.devices'),
      links: tr.t('settings.you.links'),
      prompts: tr.t('settings.you.prompts'),
    } satisfies Record<YouPart, string>,
    agent: (agent: string): Record<AgentGroupPart, string> => ({
      profile: tr.t('settings.agent.profile'),
      ai: tr.t('settings.agent.ai'),
      memory: tr.t('settings.agent.memory'),
      may: tr.t('settings.agent.may', { Name: agentWords(agent, locale).Name }),
      ahead: tr.t('settings.agent.ahead'),
      council: tr.t('settings.agent.council'),
    }),
    partsLabel: (group: string) => tr.t('settings.partsLabel', { group }),
    advanced: {
      intro: tr.t('settings.advanced.intro'),
      sections: (agent: string): Record<AdvancedSection, string> => {
        const NAME = agentWords(agent, locale).Name.toUpperCase();
        return {
          ai: tr.t('settings.advanced.section.ai', { NAME }),
          work: tr.t('settings.advanced.section.work', { NAME }),
          whombat: tr.t('settings.advanced.section.whombat'),
        };
      },
      back: tr.t('settings.group.advanced'),
    },
  };
}

export const SETTINGS_GROUP_TEXT = settingsGroupText();

/**
 * The Settings home (the final design, docs/decisions/final-settings-vault-files-usage.md; settings-phone-link.md):
 * **Often used** first — Notifications, Phone app and Theme — then the groups in this order everywhere: You, the
 * assistant by its name, Connections (what this Whombat is signed in to, central to it, not an expert page), This
 * Whombat, News and weather, Screens and Advanced.
 */
export type SettingsHomeGroup =
  | 'you'
  | 'agent'
  | 'connections'
  | 'appliance'
  | 'news'
  | 'screens'
  | 'advanced';
export const SETTINGS_HOME_GROUPS: readonly SettingsHomeGroup[] = [
  'you',
  'agent',
  'connections',
  'appliance',
  'news',
  'screens',
  'advanced',
];

export function settingsHomeText(locale?: string | null) {
  const tr = clientTranslator(locale);
  return {
    title: tr.t('settings.title'),
    subtitle: (agent: string) => tr.t('settings.homeSubtitle', { Name: agentWords(agent, locale).Name }),
    oftenUsed: tr.t('settings.oftenUsed'),
    allSettings: tr.t('settings.allSettings'),
    notifications: { title: tr.t('settings.notifications.title'), line: tr.t('settings.notifications.line') },
    theme: { title: tr.t('settings.theme.title'), line: tr.t('settings.theme.line') },
    themeNow: (name: string) => tr.t('settings.theme.now', { name }),
    language: { title: tr.t('settings.language.title'), line: tr.t('settings.language.line') },
    phoneApp: {
      title: tr.t('settings.phoneApp.title'),
      line: (qr: boolean) => tr.t(qr ? 'settings.phoneApp.lineQr' : 'settings.phoneApp.lineDownload'),
      lineHere: tr.t('settings.phoneApp.lineHere'),
      signedIn: (phones: readonly string[]) =>
        phones.length === 1
          ? tr.t('settings.phoneApp.signedInOne', { phone: phones[0] ?? '' })
          : tr.tp('settings.phoneApp.signedInMany', phones.length),
      terms: tr.t('settings.phoneApp.terms'),
    },
    needsYou: (first: string, more: number) =>
      more > 0 ? tr.t('settings.needsYouMore', { first, more }) : first,
    back: tr.t('settings.back'),
    screensTitle: tr.t('settings.group.screens'),
    loading: tr.t('settings.loading'),
    failedTitle: tr.t('settings.failedTitle'),
    failedLine: tr.t('settings.failedLine'),
    retry: tr.t('settings.retry'),
  };
}

export const SETTINGS_HOME_TEXT = settingsHomeText();

/** A group's row on the home: its name and what it holds, in one line. */
export interface SettingsHomeRow {
  key: SettingsHomeGroup;
  title: string;
  line: string;
}

/**
 * The home's groups with what each holds (You's parts as they show here: Devices on a box; the assistant's as this
 * Whombat has them).
 */
export function settingsHomeRows(
  agent: string,
  you: readonly YouPart[],
  agentParts: readonly AgentGroupPart[] = AGENT_GROUP_PARTS,
  locale?: string | null,
): SettingsHomeRow[] {
  const tr = clientTranslator(locale);
  const text = settingsGroupText(locale);
  const N = agentWords(agent, locale).Name;
  const rows: Record<SettingsHomeGroup, Omit<SettingsHomeRow, 'key'>> = {
    you: { title: tr.t('settings.group.you'), line: you.map((p) => text.you[p]).join(' · ') },
    agent: { title: N, line: agentParts.map((p) => text.agent(agent)[p]).join(' · ') },
    connections: {
      title: tr.t('settings.group.connections'),
      line: tr.t('settings.homeLine.connections'),
    },
    appliance: { title: tr.t('settings.group.appliance'), line: tr.t('settings.homeLine.appliance') },
    news: { title: tr.t('settings.group.news'), line: tr.t('settings.homeLine.news') },
    screens: { title: tr.t('settings.group.screens'), line: tr.t('settings.homeLine.screens') },
    advanced: { title: tr.t('settings.group.advanced'), line: tr.t('settings.homeLine.advanced') },
  };
  return SETTINGS_HOME_GROUPS.map((key) => ({ key, ...rows[key] }));
}

/** Advanced's rows, in order, with the assistant by its name. */
export function advancedRows(agent: string, locale?: string | null): AdvancedRow[] {
  const tr = clientTranslator(locale);
  const N = agentWords(agent, locale).Name;
  const rows: Record<AdvancedPart, Omit<AdvancedRow, 'key'>> = {
    model: {
      section: 'ai',
      title: tr.t('settings.advanced.model.title'),
      line: tr.t('settings.advanced.model.line', { Name: N }),
    },
    ai: {
      section: 'ai',
      title: tr.t('settings.advanced.ai.title'),
      line: tr.t('settings.advanced.ai.line'),
    },
    spend: {
      section: 'ai',
      title: tr.t('settings.advanced.spend.title'),
      line: tr.t('settings.advanced.spend.line', { Name: N }),
    },
    running: {
      section: 'work',
      title: tr.t('settings.advanced.running.title'),
      line: tr.t('settings.advanced.running.line', { Name: N }),
    },
    skills: {
      section: 'work',
      title: tr.t('settings.advanced.skills.title'),
      line: tr.t('settings.advanced.skills.line', { Name: N }),
    },
    audit: {
      section: 'whombat',
      title: tr.t('settings.advanced.audit.title'),
      line: tr.t('settings.advanced.audit.line'),
    },
    diagnostics: {
      section: 'whombat',
      title: tr.t('settings.advanced.diagnostics.title'),
      line: tr.t('settings.advanced.diagnostics.line'),
    },
  };
  return ADVANCED_PARTS.map((key) => ({ key, ...rows[key] }));
}

/** What a Whombat has, for the parts that show only where they apply. */
export interface SettingsHere {
  /** A box reached through the encrypted session: devices, diagnostics. */
  managed: boolean;
  /** The host runs the assistant's services (`host.info` says so). */
  services?: boolean;
  /** The viewer may see the spend (`spend.overview` answered). */
  spend?: boolean;
  /** The Whombat has Looks ahead's setting (`hasLooksAhead`); false leaves its part out. */
  looksAhead?: boolean;
}

/** You's parts that show: Devices and Shared links only on a box (a link needs Whombat's servers). */
export function youParts(here: SettingsHere): YouPart[] {
  return YOU_PARTS.filter((p) => (p !== 'devices' && p !== 'links') || here.managed);
}

/** Advanced's rows that show (Running where the host runs services, Spend where it answers, Diagnostics on a box). */
export function advancedRowsHere(agent: string, here: SettingsHere, locale?: string | null): AdvancedRow[] {
  return advancedRows(agent, locale).filter((row) => {
    if (row.key === 'running') return here.services !== false;
    if (row.key === 'spend') return here.spend !== false;
    if (row.key === 'diagnostics') return here.managed;
    return true;
  });
}

export function isYouPart(value: unknown): value is YouPart {
  return typeof value === 'string' && (YOU_PARTS as readonly string[]).includes(value);
}
export function isAgentGroupPart(value: unknown): value is AgentGroupPart {
  return typeof value === 'string' && (AGENT_GROUP_PARTS as readonly string[]).includes(value);
}
export function isAdvancedPart(value: unknown): value is AdvancedPart {
  return typeof value === 'string' && (ADVANCED_PARTS as readonly string[]).includes(value);
}

/** Where a place in Settings is: its group and, inside it, its part (absent: the group's first). */
export interface SettingsPlace {
  group: SettingsGroup;
  part?: string;
  /** A place on the part's page (`#spend`). */
  hash?: string;
}

/**
 * Where an old Agent part went: Name and character is the assistant's Name and face, Notes is in Memory, the keys in
 * What it may do, the model, what it runs, spend and skills are Advanced's, and its schedules (Advanced's old page, which
 * sends them on to Automations).
 */
export function agentPartPlace(part: string | undefined): SettingsPlace {
  switch (part) {
    case 'notes':
      return { group: 'agent', part: 'memory' };
    case 'model':
      return { group: 'advanced', part: 'model' };
    case 'keys':
      return { group: 'agent', part: 'may' };
    case 'services':
      return { group: 'advanced', part: 'running' };
    case 'schedules':
      return { group: 'advanced', part: 'schedules' };
    case 'spend':
      return { group: 'advanced', part: 'spend' };
    case 'skills':
      return { group: 'advanced', part: 'skills' };
    default:
      return isAgentGroupPart(part) ? { group: 'agent', part } : { group: 'agent' };
  }
}

/** The keys' page, a part of What the assistant may do (the phone draws it as a page of its own, opened from there). */
export function agentKeysText(agent: string, locale?: string | null): { title: string; line: string } {
  const tr = clientTranslator(locale);
  const N = agentWords(agent, locale).Name;
  return {
    title: tr.t('settings.agentKeys.title'),
    line: tr.t('settings.agentKeys.line', { Name: N }),
  };
}

/** Where an old This Whombat part went: Devices is You's, the assistant's access its What it may do. */
export function whombatSectionPlace(section: string | undefined): SettingsPlace | null {
  if (section === 'devices') return { group: 'you', part: 'devices' };
  if (section === 'access') return { group: 'agent', part: 'may' };
  return null;
}

/** The title of a group's part for a heading or a back link: “Dusty”, “Advanced · Spend”. */
export function settingsPlaceTitle(place: SettingsPlace, agent: string, locale?: string | null): string {
  const groups = settingsGroupText(locale).groups(agent);
  if (place.group === 'advanced' && isAdvancedPart(place.part)) {
    const row = advancedRows(agent, locale).find((r) => r.key === place.part);
    return row ? `${groups.advanced} · ${row.title}` : groups.advanced;
  }
  return capital(groups[place.group]);
}

/**
 * The theme's three choices, the same words and order on the web and the phone: light, dark, or Auto, which follows the
 * device (the account's `system`).
 */
export const THEME_CHOICES = ['light', 'dark', 'system'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];
export function themeWords(locale?: string | null) {
  const tr = clientTranslator(locale);
  return {
    title: tr.t('settings.theme.title'),
    choices: {
      light: tr.t('settings.theme.light'),
      dark: tr.t('settings.theme.dark'),
      system: tr.t('settings.theme.system'),
    } satisfies Record<ThemeChoice, string>,
  };
}
export const THEME_WORDS = themeWords();
