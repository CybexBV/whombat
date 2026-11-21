/**
 * The Settings tab's list: the web's groups (`groups.ts`). You is the profile card above the list and the theme a
 * switch in it; then a row per group — the assistant by its name, Connections, This Whombat, the box's screen where it
 * has one (Screens where the Whombat has screens of widgets), and Advanced — each with one line on how that part is
 * doing, a tone when something there isn't fine, and the tab's dot. Pure: the screen and the bar read the facts.
 */
import { SETTINGS_GROUP_TEXT } from '@whombat/client';
import { type AgentProvider, DESK_WORDS, PROVIDER_LABELS } from '@whombat/core';
import type { AppMode } from '../data/config';
import type { AiProviderCardView } from './ai';

/** A row of the list: the assistant, Connections, This Whombat, the box's screen and Advanced. */
export type SettingsRowKey = 'agent' | 'connections' | 'appliance' | 'screen' | 'advanced';

/** Something in a part isn't fine: the row's line in this colour, and a dot beside it. */
export type SettingsTone = 'warn' | 'bad';

export interface SettingsRowView {
  key: SettingsRowKey;
  title: string;
  /** The one line under the title (“Claude Code”); null while unknown or when there is nothing to say. */
  value: string | null;
  tone: SettingsTone | null;
  /** What TalkBack reads for the row. */
  label: string;
}

export const SETTINGS_TEXT = {
  title: SETTINGS_GROUP_TEXT.title,
  theme: 'Theme',
  rows: {
    connections: SETTINGS_GROUP_TEXT.groups('').connections,
    appliance: 'This Whombat',
    screen: DESK_WORDS.settings.tab,
    advanced: 'Advanced',
  } satisfies Record<Exclude<SettingsRowKey, 'agent'>, string>,
  /** Advanced's line: the expert pages it holds, folded away from the rest. */
  advancedLine: 'Model, keys, skills, usage and more',
  /** The tab's TalkBack words while its dot shows (AP-2624). */
  needsYou: 'something needs you',
  updateReady: 'a newer app is ready',
  demo: 'Demo world on this phone',
  /** The row's name where the Whombat has screens of widgets (AP-6000). */
  screens: 'Screens',
} as const;

/** The rows' order: the groups, the box's screen beside This Whombat. */
const ROW_ORDER: readonly SettingsRowKey[] = ['agent', 'connections', 'appliance', 'screen', 'advanced'];

/** What the list read; a part's facts are undefined while they load and null where they can't be read. */
export interface SettingsFacts {
  mode: AppMode;
  /** The assistant's name and what it runs on, undefined until the bootstrap has it. */
  agent?: { name: string; provider: AgentProvider } | null;
  ai?: readonly Pick<AiProviderCardView, 'name' | 'tone' | 'status' | 'trouble'>[] | null;
  appliance?: ApplianceLine | null;
  /** Connections' line (`connectionsLine`): what needs the viewer, else how many are connected. */
  connections?: ApplianceLine | null;
  /** The box's screen (the screen line, “Built-in screen”); the row shows only where it has one (AP-5860). */
  screen?: ApplianceLine | null;
  /**
   * The Whombat has screens of widgets (it answers `desk.screens`, desk-display-android.md AP-6000): the row is
   * *Screens*, shown with or without a screen on the box (a tablet elsewhere can be one).
   */
  screens?: boolean;
}

/** A row's line (AP-2626): what needs the viewer first, else how it is. */
export interface ApplianceLine {
  value: string;
  tone: SettingsTone | null;
}

/**
 * A sign-in in trouble (expired, revoked, out of quota) by its name and state; none signed in at all says so; else who is
 * signed in (“Claude Code signed in”). A second provider nobody uses isn't a problem.
 */
export function aiLine(cards: NonNullable<SettingsFacts['ai']>): ApplianceLine | null {
  const trouble = cards.find((c) => c.trouble);
  if (trouble)
    return { value: `${trouble.name}: ${trouble.status}`, tone: trouble.tone === 'bad' ? 'bad' : 'warn' };
  const ready = cards.filter((c) => c.tone === 'ok').map((c) => c.name);
  if (cards.length > 0 && ready.length === 0) return { value: 'Not signed in', tone: 'warn' };
  if (ready.length === 0) return null;
  return { value: `${ready.join(' and ')} signed in`, tone: null };
}

/**
 * The assistant's line: its AI sign-in in trouble first (its AI sign-in is on its page), else what it runs on
 * (“Claude Code”, “A model on your network”).
 */
export function assistantLine(f: Pick<SettingsFacts, 'agent' | 'ai'>): ApplianceLine | null {
  const ai = f.ai ? aiLine(f.ai) : null;
  if (ai?.tone) return ai;
  return f.agent ? { value: PROVIDER_LABELS[f.agent.provider], tone: null } : null;
}

/** The list's rows, in order; the box's screen only where it has one. */
export function settingsRows(f: SettingsFacts): SettingsRowView[] {
  const line = (key: SettingsRowKey): ApplianceLine | null => {
    switch (key) {
      case 'agent':
        return assistantLine(f);
      case 'connections':
        return f.connections ?? null;
      case 'appliance':
        return f.appliance ?? null;
      case 'screen':
        return f.screen ?? null;
      case 'advanced':
        return { value: SETTINGS_TEXT.advancedLine, tone: null };
    }
  };
  const title = (key: SettingsRowKey): string => {
    if (key === 'agent') return SETTINGS_GROUP_TEXT.groups(f.agent?.name ?? '').agent;
    if (key === 'screen' && f.screens) return SETTINGS_TEXT.screens;
    return SETTINGS_TEXT.rows[key];
  };
  return ROW_ORDER.filter((key) => key !== 'screen' || !!f.screen).map((key) => {
    const t = title(key);
    const l = line(key);
    return {
      key,
      title: t,
      value: l?.value ?? null,
      tone: l?.tone ?? null,
      label: l ? `${t}, ${l.value}` : t,
    };
  });
}

/**
 * The Settings tab's dot (AP-2624): `bad` or `warn` when the assistant's AI sign-in or This Whombat needs the viewer
 * (Connections and Watch have their own tabs for what they look after), else `ok` while a newer app is ready, else none.
 */
export function settingsTabDot(input: {
  agent: ApplianceLine | null;
  appliance: ApplianceLine | null;
  update: boolean;
}): 'ok' | SettingsTone | null {
  const tones = [input.agent?.tone, input.appliance?.tone];
  if (tones.includes('bad')) return 'bad';
  if (tones.includes('warn')) return 'warn';
  return input.update ? 'ok' : null;
}

type OverviewDot = 'ok' | 'warn' | 'bad' | 'mut';

/**
 * A managed Whombat's line from the shared Overview (AP-2626): the first thing that needs the viewer, else one that
 * isn't fine, else its update and backups (“Up to date · Backed up”).
 */
export function managedApplianceLine(overview: {
  needsYou: readonly { dot: OverviewDot; title: string }[];
  glance: readonly { key: string; dot: OverviewDot; title: string }[];
}): ApplianceLine {
  const off = overview.needsYou[0] ?? overview.glance.find((g) => g.dot === 'bad' || g.dot === 'warn');
  if (off) return { value: off.title, tone: off.dot === 'bad' ? 'bad' : 'warn' };
  const parts = ['update', 'backups'].flatMap(
    (key) => overview.glance.find((g) => g.key === key)?.title ?? [],
  );
  return { value: parts.length ? parts.join(' · ') : 'All fine', tone: null };
}

/** The demo world's line (it has no Whombat to ask). */
export function demoApplianceLine(mode: AppMode): ApplianceLine | null {
  return mode === 'fixtures' ? { value: SETTINGS_TEXT.demo, tone: null } : null;
}
