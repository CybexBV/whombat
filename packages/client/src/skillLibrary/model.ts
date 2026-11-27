/**
 * Settings → Skills as a model (Whombat hermes-skills.md HSK-04…HSK-13, hermes-engine.md HE-41; contracts 3.0
 * CT-1570…CT-1572; app hermes-skills.md AP-5522…AP-5527, one-person.md AP-5658): the title's count, the one list (the
 * person's Hermes profile's skills: Hermes's built-ins, what was added from Hermes's hub and what the agent learned)
 * with its groups and the folds at its end, each row's status words, where it came from and what it needs, the open
 * skill's lines and actions, and Add skills' words (Hermes's hub, its scan and its policy). Pure, so the web and the
 * phone draw the same list.
 *
 * Hermes's categories by their titles (HSK-13), those of built-in skills first, then those only added skills are in,
 * then those only learned ones are in (HSK-12); added skills without a category and learned ones without one each have
 * a group after them. Inside a group by name. Off and Removed fold at the end; Removed only when it can be restored.
 */

import { interpolate } from '@whombat/core/i18n';
import {
  SCAN_VERDICT_TEXT,
  type ScanVerdict,
  SKILL_HUB_SOURCES,
  SKILL_TRUST_TEXT,
  type SkillHubSource,
  scanCategoryText,
  skillBody,
  skillCategoryTitle,
  skillNeedsText,
  skillPolicyReasonText,
} from '@whombat/core/skills';
import { daysAgo, formatDate, formatWeekday } from '@whombat/core/text';
import { clientTree } from '../i18n/catalog';
import { SKILLS_AREA_WORDS } from '../i18n/messages/chatWork/skills';
import type {
  SkillCategoryInfo,
  SkillFileChange,
  SkillHubPreview,
  SkillHubResult,
  SkillLibrary,
  SkillLibraryItem,
  SkillLibrarySkill,
} from './contract';

export type SkillFoldId = 'off' | 'removed';
export type SkillTone = 'ok' | 'warn' | 'mut';

export interface SkillRow {
  item: SkillLibraryItem;
  /** Its name: one skill per name (CT-1571). */
  key: string;
  /** “On”, “Needs NOTION_API_KEY”, “Changed”, “Update available”, “Learned today”. */
  status: string;
  tone: SkillTone;
  /** Where it came from when it isn't one of Hermes's own (“Added from GitHub”, “Learned by Dusty”), else null. */
  origin: string | null;
  /** The switch's state. */
  on: boolean;
  /** It can be switched (not a removed one): otherwise the row has no switch. */
  canSwitch: boolean;
}

export interface SkillGroup {
  id: string;
  /** Hermes's category's title (“Productivity”), “Added by you”, “Learned by Dusty”. */
  label: string;
  /** Hermes's own words for the category (its `DESCRIPTION.md`), or null. */
  description: string | null;
  rows: SkillRow[];
}

export interface SkillFold {
  id: SkillFoldId;
  /** “Off · 3”. */
  label: string;
  rows: SkillRow[];
}

export interface SkillLibraryView {
  /** How many skills the agent has (removed ones not counted). */
  count: number;
  /** “Skills · 42”. */
  title: string;
  /** The list's groups, in order. */
  groups: SkillGroup[];
  /** Off and Removed, at the end. */
  folds: SkillFold[];
  /** Said when the agent has no skills at all (not while a search narrows the list). */
  empty: string | null;
  /** A search narrows the list: the folds show open. */
  filtering: boolean;
  /** Nothing to show for this search. */
  nothingMatches: boolean;
}

export interface SkillViewOptions {
  query?: string;
  now: Date | number;
  timeZone: string;
  /** Hub skills Hermes's last update check found a newer version of (`skills.hubUpdates`), beside the rows' own mark. */
  updates?: ReadonlySet<string>;
  /** The words' language (English when none). */
  locale?: string | null;
}

/** A hub source by a short name (Add skills' filter, a row's “Added from …”). */
export const SKILL_HUB_SOURCE_NAME: Readonly<Record<SkillHubSource, string>> = {
  official: 'Hermes',
  github: 'GitHub',
  'skills-sh': 'skills.sh',
};

const words = (locale?: string | null) => clientTree(locale, SKILLS_AREA_WORDS);

/** Words of Settings → Skills shared by the web and the phone, the agent's name given, in a locale (English when none). */
export function skillLibraryText(locale?: string | null) {
  const w = words(locale).library;
  return {
    title: (count: number) => interpolate(w.title, { count }),
    help: (agent: string) => interpolate(w.help, { agent }),
    search: w.search,
    add: w.add,
    /** The groups after Hermes's categories. */
    addedGroup: w.addedGroup,
    learnedGroup: (agent: string) => interpolate(w.learnedGroup, { agent }),
    otherGroup: w.otherGroup,
    /** Where a skill came from, when it isn't one of Hermes's own. */
    addedFrom: (source: SkillHubSource) =>
      interpolate(w.addedFrom, { source: SKILL_HUB_SOURCE_NAME[source] }),
    learnedBy: (agent: string) => interpolate(w.learnedBy, { agent }),
    /** A built-in you changed. */
    changed: w.changed,
    originalChanged: w.originalChanged,
    learned: (day: string) => interpolate(w.learned, { day }),
    changedOn: (day: string) => interpolate(w.changedOn, { day }),
    addedOn: (day: string) => interpolate(w.addedOn, { day }),
    on: w.on,
    off: w.off,
    removedStatus: w.removedStatus,
    updateAvailable: w.updateAvailable,
    updateLine: w.updateLine,
    folds: { off: w.folds.off, removed: w.folds.removed } satisfies Record<SkillFoldId, string>,
    empty: (agent: string) => interpolate(w.empty, { agent }),
    noMatch: (query: string) => interpolate(w.noMatch, { query }),

    /* The open skill's actions. */
    uses: (agent: string) => interpolate(w.uses, { agent }),
    restore: w.restore,
    restoreAsk: (skill: string) => interpolate(w.restoreAsk, { skill }),
    restoreRemovedAsk: (skill: string, agent: string) => interpolate(w.restoreRemovedAsk, { skill, agent }),
    restored: (skill: string) => interpolate(w.restored, { skill }),
    update: w.update,
    updateAsk: (skill: string) => interpolate(w.updateAsk, { skill }),
    updated: (skill: string) => interpolate(w.updated, { skill }),
    remove: w.remove,
    removeAskBuiltin: (skill: string, agent: string) => interpolate(w.removeAskBuiltin, { skill, agent }),
    removeAskHub: (skill: string, agent: string) => interpolate(w.removeAskHub, { skill, agent }),
    removeAskLearned: (skill: string, agent: string) => interpolate(w.removeAskLearned, { skill, agent }),
    removed: (skill: string) => interpolate(w.removed, { skill }),
    compare: w.compare,
  };
}

export const SKILL_LIBRARY_TEXT = skillLibraryText();

/** How a file of a changed built-in differs from Hermes's (Compare's list), in a locale (English when none). */
export function skillFileChangeText(
  locale?: string | null,
): Readonly<Record<SkillFileChange['status'], string>> {
  return { ...words(locale).fileChange };
}

export const SKILL_FILE_CHANGE_TEXT = skillFileChangeText();

/** “a”, “a and b”, “a, b and c”. */
function and(items: readonly string[], locale?: string | null): string {
  if (items.length <= 1) return items[0] ?? '';
  return interpolate(words(locale).and, { first: items.slice(0, -1).join(', '), last: items.at(-1) ?? '' });
}

/** When something happened, after “Learned” or “Changed”: “today”, “yesterday”, “on Thursday”, “on 3 Oct”. */
export function dayWords(at: string, now: Date | number, timeZone: string, locale?: string | null): string {
  const w = words(locale).day;
  const days = daysAgo(at, now, timeZone);
  if (days <= 0) return w.today;
  if (days === 1) return w.yesterday;
  if (days < 7) return interpolate(w.on, { day: formatWeekday(at, timeZone, locale) });
  return interpolate(w.on, { day: formatDate(at, timeZone, { now: new Date(now) }, locale) });
}

interface Ctx {
  now: Date | number;
  timeZone: string;
  agent: string;
  updates?: ReadonlySet<string> | undefined;
  locale?: string | null | undefined;
}

/** A hub skill with a newer version: its row says so, or Hermes's last update check does (HSK-09). */
export function skillHasUpdate(
  item: Pick<SkillLibraryItem, 'name' | 'origin' | 'hub'>,
  updates?: ReadonlySet<string>,
): boolean {
  if (item.origin !== 'hub' || !item.hub) return false;
  return item.hub.updateAvailable || (updates?.has(item.name) ?? false);
}

/** Where a skill came from in a few words, when it isn't one of Hermes's own: null otherwise. */
export function skillOriginWords(
  item: Pick<SkillLibraryItem, 'origin' | 'hub'>,
  agent: string,
  locale?: string | null,
): string | null {
  const T = skillLibraryText(locale);
  if (item.origin === 'hub' && item.hub) return T.addedFrom(item.hub.source);
  if (item.origin === 'learned') return T.learnedBy(agent);
  return null;
}

/**
 * A row's status words and their tone (CT-1410): on, off or removed, and while on what is worth knowing first — when
 * the agent learned it, a newer version, a changed built-in, what it needs (HSK-10: in words, not a warning, since
 * whether a need is met shows when the skill runs), else “On”.
 */
export function skillStatus(item: SkillLibraryItem, ctx: Ctx): { text: string; tone: SkillTone } {
  const T = skillLibraryText(ctx.locale);
  if (item.status === 'off') return { text: T.off, tone: 'mut' };
  if (item.status === 'removed') return { text: T.removedStatus, tone: 'mut' };
  if (item.origin === 'learned')
    return item.updatedAt
      ? { text: T.learned(dayWords(item.updatedAt, ctx.now, ctx.timeZone, ctx.locale)), tone: 'ok' }
      : { text: T.on, tone: 'ok' };
  if (skillHasUpdate(item, ctx.updates)) return { text: T.updateAvailable, tone: 'warn' };
  if (item.changed && item.originalChanged)
    return { text: `${T.changed} · ${words(ctx.locale).library.originalChangedShort}`, tone: 'warn' };
  if (item.changed) return { text: T.changed, tone: 'ok' };
  const needs = skillNeedsText(item.needs)[0];
  if (needs) return { text: needs, tone: 'mut' };
  return { text: T.on, tone: 'ok' };
}

function row(item: SkillLibraryItem, ctx: Ctx): SkillRow {
  const { text, tone } = skillStatus(item, ctx);
  return {
    item,
    key: item.name,
    status: text,
    tone,
    origin: skillOriginWords(item, ctx.agent, ctx.locale),
    on: item.status === 'on',
    canSwitch: item.can.switch && item.status !== 'removed',
  };
}

const byName = (a: SkillLibraryItem, b: SkillLibraryItem) => a.name.localeCompare(b.name);

function foldOf(item: SkillLibraryItem): SkillFoldId | null {
  if (item.status === 'removed') return 'removed';
  if (item.status === 'off') return 'off';
  return null;
}

/** Every word of the search is in the name or the description (no case). */
export function matchesSkillQuery(
  item: Pick<SkillLibraryItem, 'name' | 'description'>,
  query: string,
): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${item.name} ${item.description}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The rank of a skill's origin (HSK-12): Hermes's built-ins, then added, then learned. */
const ORIGIN_RANK: Readonly<Record<SkillLibraryItem['origin'], number>> = {
  builtin: 0,
  hub: 1,
  learned: 2,
};

/** A category's title and Hermes's words for it: the library's, else from its folder name (HSK-13). */
export function skillCategoryInfo(
  categories: readonly SkillCategoryInfo[],
  category: string,
): { title: string; description: string | null } {
  const info = categories.find((c) => c.category === category);
  return { title: info?.title ?? skillCategoryTitle(category), description: info?.description ?? null };
}

/**
 * The group a skill is listed in (HSK-12, HSK-13): its category; without one, added skills and learned ones each have
 * a group of their own after the categories of their kind.
 */
function groupOf(
  item: SkillLibraryItem,
  categories: readonly SkillCategoryInfo[],
  agent: string,
  locale?: string | null,
): { id: string; label: string; description: string | null; rank: number; uncategorized: boolean } {
  const T = skillLibraryText(locale);
  const rank = ORIGIN_RANK[item.origin];
  if (item.category) {
    const { title, description } = skillCategoryInfo(categories, item.category);
    return { id: `category:${item.category}`, label: title, description, rank, uncategorized: false };
  }
  if (item.origin === 'hub')
    return { id: 'added', label: T.addedGroup, description: null, rank, uncategorized: true };
  if (item.origin === 'learned')
    return { id: 'learned', label: T.learnedGroup(agent), description: null, rank, uncategorized: true };
  return { id: 'other', label: T.otherGroup, description: null, rank: 3, uncategorized: true };
}

/** The rows the list shows: every skill but a removed one that can't be brought back. */
function shownItems(library: SkillLibrary): SkillLibraryItem[] {
  return library.items.filter((i) => i.status !== 'removed' || i.can.restore);
}

/** The tab's list (HSK-12): count, the groups and folds, for this search. */
export function skillLibraryView(library: SkillLibrary, options: SkillViewOptions): SkillLibraryView {
  const T = skillLibraryText(options.locale);
  const agent = library.agentName;
  const ctx: Ctx = {
    now: options.now,
    timeZone: options.timeZone,
    agent,
    updates: options.updates,
    locale: options.locale,
  };
  const query = (options.query ?? '').trim();
  const items = shownItems(library);
  const live = items.filter((i) => i.status !== 'removed');
  const filtering = query.length > 0;
  const shown = items.filter((i) => matchesSkillQuery(i, query));

  type Building = SkillGroup & { rank: number; uncategorized: boolean; items: SkillLibraryItem[] };
  const groups = new Map<string, Building>();
  const folded: Record<SkillFoldId, SkillLibraryItem[]> = { off: [], removed: [] };
  for (const item of shown) {
    const fold = foldOf(item);
    if (fold) {
      folded[fold].push(item);
      continue;
    }
    const where = groupOf(item, library.categories, agent, options.locale);
    const group = groups.get(where.id) ?? { ...where, rows: [], items: [] };
    group.rank = Math.min(group.rank, where.rank);
    group.items.push(item);
    groups.set(where.id, group);
  }
  const ordered = [...groups.values()].sort(
    (a, b) =>
      a.rank - b.rank || Number(a.uncategorized) - Number(b.uncategorized) || a.label.localeCompare(b.label),
  );
  const count = live.length;
  return {
    count,
    title: T.title(count),
    groups: ordered.map((g) => ({
      id: g.id,
      label: g.label,
      description: g.description,
      rows: g.items.sort(byName).map((i) => row(i, ctx)),
    })),
    folds: (['off', 'removed'] as const)
      .filter((id) => folded[id].length > 0)
      .map((id) => ({
        id,
        label: `${T.folds[id]} · ${folded[id].length}`,
        rows: folded[id].sort(byName).map((i) => row(i, ctx)),
      })),
    empty: items.length || filtering ? null : T.empty(agent),
    filtering,
    nothingMatches: shown.length === 0,
  };
}

/* The open skill (CT-1410…CT-1415) ------------------------------------------------------------------------------- */

/** A SKILL.md's front matter and body (the part people read and edit). */
export function splitSkillText(text: string): { frontMatter: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { frontMatter: '', body: text };
  return { frontMatter: m[1] ?? '', body: text.slice(m[0].length).replace(/^\s*\n/, '') };
}

/** A body without a first `# name` heading (the panel's title says it already). */
export function withoutNameHeading(text: string, name: string): string {
  const body = text.replace(/^\s*\n/, '');
  const m = /^#[ \t]+(.+?)[ \t]*(?:\r?\n|$)/.exec(body);
  const heading = m?.[1]?.trim().toLowerCase();
  // Hermes's skills title themselves with their name, often in other words (“# GIF search” for gif-search).
  const same = heading === name.toLowerCase() || heading === name.toLowerCase().replace(/[-_]+/g, ' ');
  return m && same ? body.slice(m[0].length).replace(/^\s*\n/, '') : body;
}

/**
 * What Remove does, and so what it asks first: a built-in (it stays removed until restored), a hub skill (uninstalled;
 * it can be added again), or one the agent learned (forgotten).
 */
export type SkillRemoveKind = 'builtin' | 'hub' | 'learned';

export interface SkillPanelModel {
  name: string;
  /** “Productivity · Changed”, “Productivity · Added from Hermes”, “Learned by Dusty”. */
  tag: string;
  description: string;
  /** What it needs, in words (“Needs NOTION_API_KEY”), then the update line, when. */
  lines: string[];
  /** “Hermes’s version changed since this one was made.”, or null. */
  originalChanged: string | null;
  /** The body without its front matter (what Edit starts from). */
  body: string;
  /** The body as the panel shows it: without a first heading that only repeats the name. */
  shownBody: string;
  /** Compare: Hermes's version of a changed or removed built-in. */
  canCompare: boolean;
  /** The Compare button's words. */
  compareLabel: string;
  /** How each file but SKILL.md differs from Hermes's (Compare's list). */
  fileChanges: { path: string; change: string }[];
  canEdit: boolean;
  canSwitch: boolean;
  /** Restore Hermes's (a changed or removed built-in). */
  canRestore: boolean;
  /** Update (a hub skill with a newer version; HSK-09). */
  canUpdate: boolean;
  /** Remove, and what it asks; null when it can't be removed. */
  removeKind: SkillRemoveKind | null;
  /** The switch's state. */
  on: boolean;
}

export interface SkillPanelContext {
  now: Date | number;
  timeZone: string;
  /** The library's categories (their titles). */
  categories?: readonly SkillCategoryInfo[];
  /** Hub skills Hermes's last update check found a newer version of. */
  updates?: ReadonlySet<string>;
  /** The agent's name (“Learned by Dusty”). */
  agent: string;
  /** The words' language (English when none). */
  locale?: string | null;
}

/** “Learned on Thursday”, “Changed today”, “Added on 3 Oct”; null when nothing says when. */
function whenLine(
  item: SkillLibraryItem,
  now: Date | number,
  timeZone: string,
  locale?: string | null,
): string | null {
  const T = skillLibraryText(locale);
  if (!item.updatedAt) return null;
  const day = dayWords(item.updatedAt, now, timeZone, locale);
  if (item.origin === 'learned') return T.learned(day);
  if (item.changed) return T.changedOn(day);
  if (item.origin === 'hub') return T.addedOn(day);
  return null;
}

/** The open skill's head, lines, body and what can be done with it. */
export function skillPanel(detail: SkillLibrarySkill, ctx: SkillPanelContext): SkillPanelModel {
  const T = skillLibraryText(ctx.locale);
  const { item } = detail;
  const category = item.category ? skillCategoryInfo(ctx.categories ?? [], item.category).title : null;
  const tag =
    [category, skillOriginWords(item, ctx.agent, ctx.locale), item.changed ? T.changed : null]
      .filter(Boolean)
      .join(' · ') || T.otherGroup;
  const { body } = splitSkillText(detail.text);
  const when = whenLine(item, ctx.now, ctx.timeZone, ctx.locale);
  const update = skillHasUpdate(item, ctx.updates);
  const removed = item.status === 'removed';
  const lines = [
    ...skillNeedsText(item.needs),
    ...(update && !removed ? [T.updateLine] : []),
    ...(when ? [when] : []),
  ];
  const removeKind: SkillRemoveKind | null = !item.can.remove ? null : item.origin;
  return {
    name: item.name,
    tag,
    description: item.description,
    lines,
    originalChanged: item.originalChanged && detail.original && !removed ? T.originalChanged : null,
    body,
    shownBody: withoutNameHeading(body, item.name),
    canCompare: detail.original !== null && !removed,
    compareLabel: T.compare,
    fileChanges: (detail.original?.changes ?? [])
      .filter((c) => c.path !== 'SKILL.md')
      .map((c) => ({ path: c.path, change: skillFileChangeText(ctx.locale)[c.status] })),
    canEdit: item.can.edit && !removed,
    canSwitch: item.can.switch && !removed,
    canRestore: item.can.restore,
    canUpdate: !removed && update,
    removeKind: removed ? null : removeKind,
    on: item.status === 'on',
  };
}

/** What Remove asks first. */
export function removeAsk(
  kind: SkillRemoveKind,
  skill: string,
  agent: string,
  locale?: string | null,
): string {
  const T = skillLibraryText(locale);
  if (kind === 'learned') return T.removeAskLearned(skill, agent);
  if (kind === 'builtin') return T.removeAskBuiltin(skill, agent);
  return T.removeAskHub(skill, agent);
}

/** A file's size in words: “820 B”, “4.2 KB”. */
export function fileBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}

/* Add skills: Hermes's hub (HSK-06…HSK-09, CT-1413…CT-1415) ------------------------------------------------------- */

/** Add skills' words, shared by the web and the phone, in a locale (English when none). */
export function skillHubText(locale?: string | null) {
  const w = words(locale).hub;
  return {
    title: w.title,
    help: (agent: string) => interpolate(w.help, { agent }),
    search: w.search,
    searchPlaceholder: w.searchPlaceholder,
    sources: w.sources,
    all: w.all,
    browsing: w.browsing,
    results: w.results,
    nothingFound: w.nothingFound,
    installed: w.installed,
    install: w.install,
    installing: w.installing,
    back: w.back,
    close: w.close,
    findings: w.findings,
    needs: w.needs,
    files: w.files,
    nameTaken: (skill: string) => interpolate(w.nameTaken, { skill }),
    alreadyInstalled: w.alreadyInstalled,
    added: (skill: string) => interpolate(w.added, { skill }),
    unavailable: w.unavailable,
    notRead: w.notRead,
    notAdded: w.notAdded,
    more: (n: number) => w.more(n),
  };
}

export const SKILL_HUB_TEXT = skillHubText();

/** Add skills' source filter: every source, or one (`undefined` asks all three). */
export type SkillHubFilter = 'all' | SkillHubSource;

/** The filter's choices: All, Hermes, GitHub, skills.sh, in a locale (English when none). */
export function skillHubFilters(locale?: string | null): readonly { value: SkillHubFilter; label: string }[] {
  return [
    { value: 'all', label: words(locale).hub.all },
    ...SKILL_HUB_SOURCES.map((source) => ({ value: source, label: SKILL_HUB_SOURCE_NAME[source] })),
  ];
}

export const SKILL_HUB_FILTERS = skillHubFilters();

/** “1,240 installs”, “12.4k installs”; null when the source doesn't count them. */
export function hubInstallsWords(installs: number | null, locale?: string | null): string | null {
  if (installs === null) return null;
  const w = words(locale).hub;
  if (installs >= 1000) {
    const k = (installs / 1000).toFixed(1).replace(/\.0$/, '');
    return interpolate(w.installsK, { k: locale?.toLowerCase().startsWith('nl') ? k.replace('.', ',') : k });
  }
  return w.installs(installs);
}

/**
 * A hub result's source and trust in words (HSK-06, CT-1406): “From Hermes” (its own optional skills), “GitHub ·
 * Trusted”, “skills.sh · Community · 412 installs”.
 */
export function hubResultMeta(
  result: Pick<SkillHubResult, 'source' | 'trust' | 'installs'>,
  locale?: string | null,
): string {
  const where =
    result.trust === 'builtin'
      ? SKILL_TRUST_TEXT.builtin
      : `${SKILL_HUB_SOURCE_NAME[result.source]} · ${SKILL_TRUST_TEXT[result.trust]}`;
  return [where, hubInstallsWords(result.installs, locale)].filter(Boolean).join(' · ');
}

/** “skills.sh didn’t answer, so its skills are missing.”, or null when every source answered. */
export function hubUnreachableWords(
  sources: readonly SkillHubSource[],
  locale?: string | null,
): string | null {
  if (!sources.length) return null;
  const w = words(locale).hub;
  const names = and(
    sources.map((s) => SKILL_HUB_SOURCE_NAME[s]),
    locale,
  );
  return interpolate(sources.length === 1 ? w.unreachableOne : w.unreachableMany, { names });
}

const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  linux: 'Linux',
  macos: 'macOS',
  darwin: 'macOS',
  windows: 'Windows',
};

export type ScanTone = 'ok' | 'warn' | 'bad';
/** A finding's tone: critical red, high amber, the rest muted (not green: something was still found). */
export type FindingTone = 'warn' | 'bad' | 'mut';

export interface HubFindingRow {
  /** What kind of thing it is, in words (“Sends data out”). */
  kind: string;
  /** Hermes's own description of it, with a capital. */
  description: string;
  /** Where: “scripts/sync.sh, line 7”, “the folder”. */
  where: string;
  /** The text it matched (secrets redacted), or null. */
  match: string | null;
  tone: FindingTone;
}

export interface HubPreviewModel {
  name: string;
  description: string;
  /** “GitHub · Trusted”. */
  meta: string;
  /** The SKILL.md as the preview shows it: no front matter, no heading that only repeats the name. */
  body: string;
  /** “Needs NOTION_API_KEY”, …; empty when nothing. */
  needs: string[];
  /** “Runs on macOS”, when its front matter names platforms; null for any. */
  platforms: string | null;
  /** Hermes's verdict in words (“Nothing risky found”) and its tone. */
  verdict: string;
  verdictTone: ScanTone;
  findings: HubFindingRow[];
  /** “And 3 more things.” when the scan found more than it carries; null otherwise. */
  moreFindings: string | null;
  /** Why the policy allows or blocks it, in plain words (`skillPolicyReasonText`). */
  reason: string;
  blocked: boolean;
  /** Why Install isn't there although the policy allows it (installed already, the name taken), or null. */
  notInstallable: string | null;
  /** Install shows: allowed, not installed, its name free. */
  canInstall: boolean;
}

const VERDICT_TONE: Readonly<Record<ScanVerdict, ScanTone>> = {
  safe: 'ok',
  caution: 'warn',
  dangerous: 'bad',
};

/**
 * A hub skill before Install (HSK-07, CT-1414): its text, what it needs and the platforms it names, Hermes's verdict and
 * findings, and the policy's decision in plain words. A blocked skill has no Install (there is no force); one installed
 * already or whose name a skill here has says so instead.
 */
export function hubPreviewModel(preview: SkillHubPreview, locale?: string | null): HubPreviewModel {
  const T = skillHubText(locale);
  const w = words(locale).hub;
  const { result, scan, policy } = preview;
  const blocked = policy.decision === 'block';
  const platforms = [...new Set(preview.platforms.map((p) => PLATFORM_NAMES[p.toLowerCase()] ?? p))];
  const notInstallable = blocked
    ? null
    : result.installed
      ? T.alreadyInstalled
      : preview.nameTaken
        ? T.nameTaken(result.name)
        : null;
  return {
    name: result.name,
    description: result.description,
    meta: hubResultMeta(result, locale),
    body: withoutNameHeading(splitSkillText(skillBody(preview.text)).body, result.name),
    needs: skillNeedsText(preview.needs),
    platforms: platforms.length ? interpolate(w.runsOn, { platforms: and(platforms, locale) }) : null,
    verdict: SCAN_VERDICT_TEXT[scan.verdict],
    verdictTone: VERDICT_TONE[scan.verdict],
    findings: scan.findings.map((f) => ({
      kind: scanCategoryText(f.category),
      description: f.description.charAt(0).toUpperCase() + f.description.slice(1),
      where: f.line > 0 ? interpolate(w.line, { file: f.file, line: f.line }) : f.file || w.folder,
      match: f.match || null,
      tone: f.severity === 'critical' ? 'bad' : f.severity === 'high' ? 'warn' : 'mut',
    })),
    moreFindings:
      scan.findingsTotal > scan.findings.length ? T.more(scan.findingsTotal - scan.findings.length) : null,
    reason: skillPolicyReasonText({ verdict: scan.verdict, trust: result.trust, decision: policy.decision }),
    blocked,
    notInstallable,
    canInstall: !blocked && !result.installed && !preview.nameTaken,
  };
}

/**
 * The application code of a refused skills write or read (`skill_blocked`, `skill_exists`, `skill_hub_unavailable`):
 * over the session it is the error's code, over HTTP its `details.code` (CT-21). Null for any other refusal.
 */
export function skillErrorCode(
  error: unknown,
): 'skill_blocked' | 'skill_exists' | 'skill_hub_unavailable' | null {
  const e = error as { code?: unknown; details?: { code?: unknown } } | null;
  for (const code of [e?.details?.code, e?.code])
    if (code === 'skill_blocked' || code === 'skill_exists' || code === 'skill_hub_unavailable') return code;
  return null;
}

/**
 * What a refused install or update says (HSK-07): blocked by Hermes's policy (the plain reason from its verdict), the name
 * taken, the hub away; null for any other refusal (the server's own words then).
 */
export function hubRefusalWords(error: unknown, skill: string, locale?: string | null): string | null {
  const code = skillErrorCode(error);
  const T = skillHubText(locale);
  if (code === 'skill_exists') return T.nameTaken(skill);
  if (code === 'skill_hub_unavailable') return T.unavailable;
  if (code === 'skill_blocked') {
    const details = (error as { details?: { verdict?: unknown } } | null)?.details;
    return details?.verdict === 'dangerous'
      ? skillPolicyReasonText({ verdict: 'dangerous', trust: 'community', decision: 'block' })
      : skillPolicyReasonText({ verdict: 'caution', trust: 'community', decision: 'block' });
  }
  return null;
}
