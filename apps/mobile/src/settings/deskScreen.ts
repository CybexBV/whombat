/**
 * Settings → Screen on the phone (Whombat desk-display.md DK-102…DK-111, DK-119, DK-123, DK-124;
 * desk-display-android.md AP-5860…): which parts the page has, the rows of *What it shows* from the box's
 * `showOptions` and the person's choices, the servers' order as Move up / Move down and a drag change it, the scenario
 * chips, what TalkBack reads for the preview, and the Whombat's name the phone gives the screen. Every word is
 * `DESK_WORDS`'. Pure: the page and its tests read it.
 */
import {
  DESK_BAR_ITEMS,
  DESK_PREVIEW_SCENARIOS,
  DESK_WORDS,
  type DeskBarItem,
  type DeskClock,
  type DeskPreview,
  type DeskPreviewScenario,
  type DeskScreen,
  type DeskShow,
  type DeskShowLevel,
  type DeskShowOption,
  deskShowLevel,
  fillDeskWords,
} from '@whombat/client/desk';
import { DeskWhombatName } from '@whombat/core';

const S = DESK_WORDS.settings;

/** The page's four parts, in their order (DK-123). */
export const DESK_SCREEN_PARTS = ['shows', 'lock', 'night', 'talk'] as const;
export type DeskScreenPart = (typeof DESK_SCREEN_PARTS)[number];

export const DESK_SCREEN_PART_LABELS: Record<DeskScreenPart, string> = S.parts;

/**
 * The parts this screen has: none until it is paired (the switch and Pair the screen say it all), *What it shows* only
 * where the box lists what can be chosen (a runtime from before the calm glance doesn't, DK-125).
 */
export function deskScreenParts(screen: Pick<DeskScreen, 'paired' | 'showOptions'>): DeskScreenPart[] {
  if (!screen.paired) return [];
  return DESK_SCREEN_PARTS.filter((p) => p !== 'shows' || screen.showOptions !== undefined);
}

/** A part a link names (`?part=night`), if this screen has it; else the first. */
export function resolveDeskScreenPart(
  asked: string | undefined,
  parts: readonly DeskScreenPart[],
): DeskScreenPart | null {
  const named = parts.find((p) => p === asked);
  return named ?? parts[0] ?? null;
}

/** The three words of a choice (DK-103), in their order. */
export function deskLevelOptions(): { value: DeskShowLevel; label: string }[] {
  return (['always', 'matters', 'off'] as const).map((value) => ({ value, label: S.levels[value] }));
}

/** One thing to choose for: its key, name and line, its mark (or first letter), and the choice. */
export interface DeskChoiceRow {
  key: string;
  name: string;
  line: string;
  mark: string | null;
  level: DeskShowLevel;
}

export interface DeskBarRow {
  item: DeskBarItem;
  name: string;
  line: string;
  level: DeskShowLevel;
}

export interface DeskMiddleGroup {
  group: 'assistant' | 'connection' | 'widget';
  title: string;
  rows: DeskChoiceRow[];
}

/** *What it shows*: the top bar, the middle by group, the servers in the strip's order, This Whombat, around it. */
export interface DeskShowsView {
  bar: DeskBarRow[];
  middle: DeskMiddleGroup[];
  servers: (DeskChoiceRow & { id: string })[];
  box: DeskChoiceRow | null;
  clock: DeskClock;
  welcomeBack: boolean;
  doneToday: boolean;
}

/** The assistant's own rows have no line of their own from the box: Settings' words say what they show. */
function rowOf(o: DeskShowOption, show: DeskShow, assistant: string): DeskChoiceRow {
  const fill = (s: string) => fillDeskWords(s, { assistant });
  const own = o.key === 'work' ? S.work : o.key === 'coming' ? S.coming : o.key === 'box' ? S.box : null;
  return {
    key: o.key,
    name: own ? fill(own.name) : o.name,
    line: o.line || (own ? fill(own.line) : ''),
    mark: o.mark ?? null,
    level: deskShowLevel(show, o.key),
  };
}

export function deskShowsView(
  options: readonly DeskShowOption[],
  show: DeskShow,
  assistant: string,
): DeskShowsView {
  const groupTitle = (g: DeskMiddleGroup['group']) => fillDeskWords(S.groups[g], { assistant });
  const middle = (['assistant', 'connection', 'widget'] as const)
    .map((group) => ({
      group,
      title: groupTitle(group),
      rows: options.filter((o) => o.group === group).map((o) => rowOf(o, show, assistant)),
    }))
    .filter((g) => g.rows.length > 0);
  const box = options.find((o) => o.group === 'box');
  return {
    bar: DESK_BAR_ITEMS.map((item) => ({ item, ...S.barItems[item], level: show.bar[item] })),
    middle,
    servers: options
      .filter((o) => o.group === 'server')
      .map((o) => ({ ...rowOf(o, show, assistant), id: o.key.slice('server:'.length) })),
    box: box ? rowOf(box, show, assistant) : null,
    clock: show.clock,
    welcomeBack: show.welcomeBack,
    doneToday: show.doneToday,
  };
}

/**
 * The strip's order after moving `id` by `by` places (−1 Move up, +1 Move down, more for a drag), from the servers as
 * listed (DK-108): the whole list becomes the order, so what the person sees is what the screen keeps. Null when it
 * doesn't move (the first up, the last down, an id not there).
 */
export function deskMoveServer(ids: readonly string[], id: string, by: number): string[] | null {
  const from = ids.indexOf(id);
  if (from < 0) return null;
  const to = Math.min(ids.length - 1, Math.max(0, from + Math.round(by)));
  if (to === from) return null;
  const next = ids.filter((x) => x !== id);
  next.splice(to, 0, id);
  return next;
}

/** How many rows a drag of `dy` dp moves a row of `rowHeight` dp: half a row is enough to change places. */
export function deskDragPlaces(dy: number, rowHeight: number): number {
  if (rowHeight <= 0) return 0;
  return Math.trunc((dy + Math.sign(dy) * rowHeight * 0.5) / rowHeight);
}

/** The scenario chips (DK-123): Now · Something’s wrong · {assistant} at work. */
export function deskScenarioOptions(assistant: string): { value: DeskPreviewScenario; label: string }[] {
  return DESK_PREVIEW_SCENARIOS.map((value) => ({
    value,
    label: fillDeskWords(S.scenarios[value], { assistant }),
  }));
}

/** *Try “Something’s wrong” on the screen* (DK-124). */
export function deskTryLabel(scenario: DeskPreviewScenario, assistant: string): string {
  return fillDeskWords(S.tryOnScreen, { scenario: fillDeskWords(S.scenarios[scenario], { assistant }) });
}

/** What TalkBack reads for the preview, a picture to the eye: the name, the sentence, the hero's title. */
export function deskPreviewSpoken(preview: DeskPreview): string {
  const c = preview.calm;
  return [S.preview, preview.name, c.headline.text, c.headline.more, c.hero?.title]
    .filter((s): s is string => Boolean(s))
    .join('. ');
}

/**
 * The name the phone gives the screen's top bar (DK-119), or null: only where the box keeps one (a runtime from before
 * it has no `whombatName`), only when the phone's name for this Whombat differs from the box's, cut to what the top
 * bar takes (one line, 40 characters).
 */
export function deskNameToGive(
  known: string | null | undefined,
  screen: Pick<DeskScreen, 'whombatName'> | undefined,
): string | null {
  if (!known || !screen || screen.whombatName === undefined) return null;
  const clean = Array.from(
    known
      .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '')
      .replace(/\p{Z}+|\s+/gu, ' ')
      .trim(),
  )
    .slice(0, 40)
    .join('')
    .trim();
  if (!clean || clean === screen.whombatName) return null;
  return DeskWhombatName.safeParse(clean).success ? clean : null;
}
