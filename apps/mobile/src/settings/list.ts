/**
 * The Settings tab's list: the web's groups (`groups.ts`). You is the profile card above the list and the theme a
 * switch in it; then a row per group — the assistant by its name, Connections, This Whombat, News and weather where the
 * Whombat answers it, the box's screen where it has one (Screens where the Whombat has screens of widgets), and Advanced
 * — each with one line on how that part is
 * doing, a tone when something there isn't fine, and the tab's dot. Pure: the screen and the bar read the facts.
 */

import { settingsGroupText } from '@whombat/client';
import { updateStateWords } from '@whombat/client/managed';
import { type AgentProvider, deskWords, newsWords, providerLabels } from '@whombat/core';
import { formatLocaleList } from '@whombat/core/i18n';
import type { AppMode } from '../data/config';
import { mobileTranslator } from '../i18n/translate';
import type { AiProviderCardView } from './ai';

/** A row of the list: the assistant, Connections, This Whombat, News and weather, the box's screen and Advanced. */
export type SettingsRowKey = 'agent' | 'connections' | 'appliance' | 'news' | 'screen' | 'advanced';

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
  /** Where the row goes when its line is about one page of the part (`ApplianceLine.opens`). */
  opens?: 'about';
}

export function settingsText(locale?: string) {
  const { t } = mobileTranslator(locale);
  const groups = settingsGroupText(locale);
  const news = newsWords(locale);
  return {
    title: groups.title,
    theme: t('list.settingsText.theme'),
    rows: {
      connections: groups.groups('').connections,
      appliance: t('list.settingsText.rows.appliance'),
      news: news.page,
      screen: deskWords(locale).settings.tab,
      advanced: groups.groups('').advanced,
    } satisfies Record<Exclude<SettingsRowKey, 'agent'>, string>,
    /** Advanced's line: the expert pages it holds, folded away from the rest. */
    advancedLine: t('list.settingsText.advancedLine'),
    /** The tab's TalkBack words while its dot shows (AP-2624). */
    needsYou: t('list.settingsText.needsYou'),
    updateReady: t('list.settingsText.updateReady'),
    demo: t('list.settingsText.demo'),
    /** The row's name where the Whombat has screens of widgets (AP-6000). */
    screens: t('list.settingsText.screens'),
    /** News and weather's line. */
    newsLine: news.homeLine,
  } as const;
}
export const SETTINGS_TEXT = settingsText();

/** The rows' order: the groups as the web has them, News and weather after This Whombat. */
const ROW_ORDER: readonly SettingsRowKey[] = [
  'agent',
  'connections',
  'appliance',
  'news',
  'screen',
  'advanced',
];

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
  /** The Whombat answers the place and the news (`placeNewsShown`): News and weather has a row. */
  news?: boolean;
}

/** A row's line (AP-2626): what needs the viewer first, else how it is. */
export interface ApplianceLine {
  value: string;
  tone: SettingsTone | null;
  /** The line is about This Whombat → About (an update waiting for the owner's yes): the row opens it there. */
  opens?: 'about';
}

/**
 * A sign-in in trouble (expired, revoked, out of quota) by its name and state; none signed in at all says so; else who is
 * signed in (“Claude Code signed in”). A second provider nobody uses isn't a problem.
 */
export function aiLine(
  cards: NonNullable<SettingsFacts['ai']>,
  locale?: string | null,
): ApplianceLine | null {
  const { t } = mobileTranslator(locale);
  const trouble = cards.find((c) => c.trouble);
  if (trouble)
    return { value: `${trouble.name}: ${trouble.status}`, tone: trouble.tone === 'bad' ? 'bad' : 'warn' };
  const ready = cards.filter((c) => c.tone === 'ok').map((c) => c.name);
  if (cards.length > 0 && ready.length === 0) return { value: t('settings2.list.notSignedIn'), tone: 'warn' };
  if (ready.length === 0) return null;
  return { value: t('settings2.list.signedIn', { names: formatLocaleList(ready, locale) }), tone: null };
}

/**
 * The assistant's line: its AI sign-in in trouble first (its AI sign-in is on its page), else what it runs on
 * (“Claude Code”, “A model on your network”).
 */
export function assistantLine(
  f: Pick<SettingsFacts, 'agent' | 'ai'>,
  locale?: string | null,
): ApplianceLine | null {
  const ai = f.ai ? aiLine(f.ai, locale) : null;
  if (ai?.tone) return ai;
  return f.agent ? { value: providerLabels(locale)[f.agent.provider], tone: null } : null;
}

/** The list's rows, in order; the box's screen only where it has one. */
export function settingsRows(f: SettingsFacts, locale?: string): SettingsRowView[] {
  const copy = settingsText(locale);
  const line = (key: SettingsRowKey): ApplianceLine | null => {
    switch (key) {
      case 'agent':
        return assistantLine(f, locale);
      case 'connections':
        return f.connections ?? null;
      case 'appliance':
        return f.appliance ?? null;
      case 'news':
        return { value: copy.newsLine, tone: null };
      case 'screen':
        return f.screen ?? null;
      case 'advanced':
        return { value: copy.advancedLine, tone: null };
    }
  };
  const title = (key: SettingsRowKey): string => {
    if (key === 'agent') return settingsGroupText(locale).groups(f.agent?.name ?? '').agent;
    if (key === 'screen' && f.screens) return copy.screens;
    return copy.rows[key];
  };
  const shown = (key: SettingsRowKey) => (key === 'screen' ? !!f.screen : key === 'news' ? !!f.news : true);
  return ROW_ORDER.filter(shown).map((key) => {
    const t = title(key);
    const l = line(key);
    return {
      key,
      title: t,
      value: l?.value ?? null,
      tone: l?.tone ?? null,
      label: l ? `${t}, ${l.value}` : t,
      ...(l?.opens && { opens: l.opens }),
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
 * isn't fine, else its update and backups (“Up to date · Backed up”). An update that waits for the owner's yes
 * (`ready`, the release `updateReady` names) says “Update ready” and opens About, where Update now is: only something
 * broken comes before it, and the line says it once.
 */
export function managedApplianceLine(
  overview: {
    needsYou: readonly { dot: OverviewDot; title: string }[];
    glance: readonly { key: string; dot: OverviewDot; title: string; state?: string }[];
  },
  ready: string | null = null,
  locale?: string | null,
): ApplianceLine {
  // The About row's title names the page; its `state` says how the updates stand.
  const said = (g: { title: string; state?: string }) => g.state ?? g.title;
  const broken = [...overview.needsYou, ...overview.glance].some((item) => item.dot === 'bad');
  if (ready && !broken) return { value: updateStateWords(locale).ready, tone: 'warn', opens: 'about' };
  const off = overview.needsYou[0] ?? overview.glance.find((g) => g.dot === 'bad' || g.dot === 'warn');
  if (off) return { value: said(off), tone: off.dot === 'bad' ? 'bad' : 'warn' };
  const parts = ['update', 'backups'].flatMap((key) => {
    const g = overview.glance.find((item) => item.key === key);
    return g ? said(g) : [];
  });
  return {
    value: parts.length ? parts.join(' · ') : mobileTranslator(locale).t('settings2.list.allFine'),
    tone: null,
  };
}

/** The demo world's line (it has no Whombat to ask). */
export function demoApplianceLine(mode: AppMode, locale?: string | null): ApplianceLine | null {
  return mode === 'fixtures' ? { value: settingsText(locale ?? undefined).demo, tone: null } : null;
}
