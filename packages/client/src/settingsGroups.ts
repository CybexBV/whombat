/**
 * Settings in five groups (settings-groups.md, sidebar-tabs.md), the same on the web and the phone: **You** (your
 * profile, notifications, devices and passkeys), **the assistant by its name** (its name and face, the AI sign-in,
 * what it remembers, and what it may do), **Connections** (what this Whombat is signed in to, and how), **This
 * Whombat** (backups, updates, the screen, network, Bluetooth, voice, About) and **Advanced**, a list of the expert
 * pages that stays folded until one is opened. Every setting that was in Settings before is in one of them. Pure: the
 * groups, their parts, their words, and where an old address goes.
 */
import { agentWords } from './agentName';

export type SettingsGroup = 'you' | 'agent' | 'connections' | 'appliance' | 'advanced';

/** The groups in their order. */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  'you',
  'agent',
  'connections',
  'appliance',
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

export const SETTINGS_GROUP_TEXT = {
  title: 'Settings',
  /** The page's line under its title. */
  subtitle: (agent: string) =>
    `You, ${agentWords(agent).Name} and this Whombat. Expert settings are under Advanced.`,
  groups: (agent: string): Record<SettingsGroup, string> => ({
    you: 'You',
    agent: agentWords(agent).Name,
    connections: 'Connections',
    appliance: 'This Whombat',
    advanced: 'Advanced',
  }),
  you: {
    profile: 'Profile',
    notifications: 'Notifications',
    devices: 'Devices',
    links: 'Shared links',
    prompts: 'Prompts',
  } satisfies Record<YouPart, string>,
  /** The assistant's parts, by its name. */
  agent: (agent: string): Record<AgentGroupPart, string> => ({
    profile: 'Name and face',
    ai: 'AI sign-in',
    memory: 'Memory',
    may: `What ${agentWords(agent).Name} may do`,
    ahead: 'Looks ahead',
    council: 'Council',
  }),
  /** The parts' group, for screen readers. */
  partsLabel: (group: string) => `Parts of ${group}`,
  advanced: {
    intro:
      'Settings for people who like to look under the hood. Nothing here needs changing for Whombat to work.',
    sections: (agent: string): Record<AdvancedSection, string> => {
      const N = agentWords(agent).Name.toUpperCase();
      return {
        ai: `${N}’S AI`,
        work: `${N}’S WORK`,
        whombat: 'THIS WHOMBAT',
      };
    },
    back: 'Advanced',
  },
} as const;

/**
 * The Settings home (the final design, docs/decisions/final-settings-vault-files-usage.md; settings-phone-link.md):
 * **Often used** first — Notifications, Phone app and Theme — then the groups in this order everywhere: You, the
 * assistant by its name, Connections (what this Whombat is signed in to, central to it, not an expert page), This
 * Whombat, Screens and Advanced.
 */
export type SettingsHomeGroup = 'you' | 'agent' | 'connections' | 'appliance' | 'screens' | 'advanced';
export const SETTINGS_HOME_GROUPS: readonly SettingsHomeGroup[] = [
  'you',
  'agent',
  'connections',
  'appliance',
  'screens',
  'advanced',
];

export const SETTINGS_HOME_TEXT = {
  title: 'Settings',
  subtitle: (agent: string) => `You, ${agentWords(agent).Name} and this Whombat.`,
  oftenUsed: 'Often used',
  allSettings: 'All settings',
  notifications: { title: 'Notifications', line: 'When this device alerts you' },
  theme: { title: 'Theme', line: 'Light and dark on this device' },
  /** The theme row once it knows which one is on (the web: “Light on this device”). */
  themeNow: (name: string) => `${name} on this device`,
  /** Often used's way to the Mobile app page: by QR code where the box signs phones in, else the download. */
  phoneApp: {
    title: 'Phone app',
    line: (qr: boolean) => (qr ? 'Sign your phone in with a QR code' : 'Get Whombat on your phone'),
    /** On a phone's own screen, which can't scan its own code. */
    lineHere: 'Get the app here, or sign in another phone',
    /** Once phones are signed in: which, or how many. */
    signedIn: (phones: readonly string[]) =>
      phones.length === 1 ? `${phones[0]} is signed in` : `${phones.length} phones are signed in`,
    /** What Search also finds it by. */
    terms: 'phone mobile app QR code Android iPhone sign in download',
  },
  /** This Whombat's row while its Overview has something under NEEDS YOU: the first, and how many more. */
  needsYou: (first: string, more: number) => (more > 0 ? `${first} · ${more} more` : first),
  /** A group's page: the way back to the home. */
  back: 'Back to Settings',
  /** This Whombat's Screen part, opened from the home's Screens row, by that name. */
  screensTitle: 'Screens',
  loading: 'Loading settings…',
  failedTitle: 'Couldn’t read your settings',
  failedLine: 'There’s no saved copy to show on this device yet.',
  retry: 'Try again',
} as const;

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
): SettingsHomeRow[] {
  const N = agentWords(agent).Name;
  const rows: Record<SettingsHomeGroup, Omit<SettingsHomeRow, 'key'>> = {
    you: { title: 'You', line: you.map((p) => SETTINGS_GROUP_TEXT.you[p]).join(' · ') },
    // Every part the assistant's page has, as You's line names its parts.
    agent: { title: N, line: agentParts.map((p) => SETTINGS_GROUP_TEXT.agent(agent)[p]).join(' · ') },
    // What This Whombat's parts hold: the Overview is how it's doing and its network; Screen has a row of its own.
    connections: { title: 'Connections', line: 'Accounts and services this Whombat uses' },
    appliance: { title: 'This Whombat', line: 'How it’s doing · Network · Backups · About' },
    screens: { title: 'Screens', line: 'Displays linked to this Whombat' },
    advanced: { title: 'Advanced', line: 'Expert settings' },
  };
  return SETTINGS_HOME_GROUPS.map((key) => ({ key, ...rows[key] }));
}

/** Advanced's rows, in order, with the assistant by its name. */
export function advancedRows(agent: string): AdvancedRow[] {
  const N = agentWords(agent).Name;
  const rows: Record<AdvancedPart, Omit<AdvancedRow, 'key'>> = {
    model: {
      section: 'ai',
      title: 'Model and effort',
      line: `Which AI model ${N} uses and how hard it thinks.`,
    },
    ai: {
      section: 'ai',
      title: 'AI on this Whombat',
      line: 'The AI programs installed here, the AI gateway, a custom AI model and web search.',
    },
    // The Spend report, called Usage everywhere (docs/decisions/final-settings-vault-files-usage.md).
    spend: { section: 'ai', title: 'Usage', line: `What it cost and how much ${N} worked.` },
    running: { section: 'work', title: 'Running', line: `What ${N} keeps running on this Whombat.` },
    skills: { section: 'work', title: 'Skills', line: `What ${N} knows how to do, skill by skill.` },
    audit: {
      section: 'whombat',
      title: 'Audit log and signing keys',
      line: 'Everything signed on this Whombat, your signing key and its fingerprint.',
    },
    diagnostics: {
      section: 'whombat',
      title: 'Diagnostics',
      line: 'A file for support when something’s wrong.',
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
export function advancedRowsHere(agent: string, here: SettingsHere): AdvancedRow[] {
  return advancedRows(agent).filter((row) => {
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
export function agentKeysText(agent: string): { title: string; line: string } {
  const N = agentWords(agent).Name;
  return {
    title: 'Keys and allowed commands',
    line: `Exactly what ${N} may do, key by key, and the commands you always allow.`,
  };
}

/** Where an old This Whombat part went: Devices is You's, the assistant's access its What it may do. */
export function whombatSectionPlace(section: string | undefined): SettingsPlace | null {
  if (section === 'devices') return { group: 'you', part: 'devices' };
  if (section === 'access') return { group: 'agent', part: 'may' };
  return null;
}

/** The title of a group's part for a heading or a back link: “Dusty”, “Advanced · Spend”. */
export function settingsPlaceTitle(place: SettingsPlace, agent: string): string {
  const groups = SETTINGS_GROUP_TEXT.groups(agent);
  if (place.group === 'advanced' && isAdvancedPart(place.part)) {
    const row = advancedRows(agent).find((r) => r.key === place.part);
    return row ? `${groups.advanced} · ${row.title}` : groups.advanced;
  }
  return capital(groups[place.group]);
}
