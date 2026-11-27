/**
 * Settings → Screen: the tab's parts and which of them show, the choices grouped as *What it shows* lists them, the
 * strip's order as the person moves a server, the scenario's name, and whether the app should give the box the
 * Whombat's name for the screen's top bar. Pure, so it is tested without a page.
 */
import {
  type DeskPreviewScenario,
  type DeskScreen,
  DeskSetNameInput,
  type DeskShowOption,
  deskSectionShown,
  fillDeskWords,
} from '@whombat/client/desk';
import { deskWords } from '@whombat/core';
import { currentLocale } from '../../i18n/provider';

/** The parts under the switch, in their order. */
export const SCREEN_PARTS = ['shows', 'lock', 'night', 'talk'] as const;
/**
 * A part: those, or *Top bar* (`bar`), which takes *What it shows*' place on the box's own page in Settings → Screens
 * (3.6), where the middle and the strip became widgets.
 */
export type ScreenPart = (typeof SCREEN_PARTS)[number] | 'bar';

/** `&part=` of `?tab=screen`: a part other than *What it shows*; anything else is dropped. */
export function validateScreenPart(raw: unknown): Exclude<ScreenPart, 'shows'> | undefined {
  return raw === 'lock' || raw === 'night' || raw === 'talk' ? raw : undefined;
}

/** The tab shows where This Whombat's SCREEN section did: a screen is connected, or one is paired. */
export function screenTabShown(screen: Pick<DeskScreen, 'paired' | 'display'> | null | undefined): boolean {
  return screen ? deskSectionShown(screen) : false;
}

/**
 * The parts that show: none until the screen is paired (the switch and pairing say it all), and *What it shows* only
 * where the runtime lists what can be chosen (an older one doesn't). With screens of widgets (`widgets`), *Top bar*
 * in its place.
 */
export function screenParts(
  screen: Pick<DeskScreen, 'paired' | 'showOptions'>,
  widgets = false,
): ScreenPart[] {
  if (!screen.paired) return [];
  if (widgets) return ['bar', 'lock', 'night', 'talk'];
  return SCREEN_PARTS.filter((p) => p !== 'shows' || screen.showOptions !== undefined);
}

/** The part to open: the one asked for when it shows, else the first. */
export function screenPartOpen(
  parts: readonly ScreenPart[],
  asked: ScreenPart | undefined,
): ScreenPart | null {
  if (asked && parts.includes(asked)) return asked;
  return parts[0] ?? null;
}

/** *What it shows*' lists: the assistant's, the connections', Home's widgets, the servers in the strip's order, the box. */
export interface ShowGroups {
  assistant: DeskShowOption[];
  connection: DeskShowOption[];
  widget: DeskShowOption[];
  server: DeskShowOption[];
  box: DeskShowOption | null;
}

export function showGroups(options: readonly DeskShowOption[]): ShowGroups {
  const of = (group: DeskShowOption['group']) => options.filter((o) => o.group === group);
  return {
    assistant: of('assistant'),
    connection: of('connection'),
    widget: of('widget'),
    server: of('server'),
    box: options.find((o) => o.group === 'box') ?? null,
  };
}

/** A server's hosts id from its choice key (`server:pve-01` → `pve-01`). */
export function serverIdOf(key: string): string {
  return key.startsWith('server:') ? key.slice('server:'.length) : key;
}

/**
 * The servers in the strip's order: the person's order first (`show.order`, ids no longer listed skipped), then the
 * rest as the runtime lists them. The runtime lists them so too; this shows a move before its answer.
 */
export function stripOrder(listed: readonly string[], order: readonly string[]): string[] {
  const known = new Set(listed);
  const first = order.filter((id, i) => known.has(id) && order.indexOf(id) === i);
  const placed = new Set(first);
  return [...first, ...listed.filter((id) => !placed.has(id))];
}

/** The order after putting `id` at `to` (clamped), every other server keeping its place relative to the rest. */
export function placeServer(ids: readonly string[], id: string, to: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  const rest = ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** The order after *Move up* (−1) or *Move down* (+1); at an end it stays as it is. */
export function moveServer(ids: readonly string[], id: string, by: -1 | 1): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  return placeServer(ids, id, from + by);
}

/** Whether two orders are the same. */
export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** A scenario's name: “Now”, “Something’s wrong”, “Neo at work”. */
export function scenarioName(scenario: DeskPreviewScenario, assistant: string): string {
  const DESK_WORDS = deskWords(currentLocale());
  return fillDeskWords(DESK_WORDS.settings.scenarios[scenario], { assistant });
}

/** The longest name the screen's top bar takes. */
const NAME_MAX = 40;

/**
 * The name to give the box for its top bar, or null when there's nothing to give: the runtime doesn't know names (no
 * `whombatName` in its answer), the directory has no name, or the box already has this one. The directory allows 80
 * characters on any line; the top bar takes one line of 40, so spaces run together and a longer name ends in “…”.
 */
export function deskNameToGive(
  directory: string | null | undefined,
  screen: Pick<DeskScreen, 'whombatName'>,
): string | null {
  if (screen.whombatName === undefined || !directory) return null;
  const flat = [
    ...directory
      .replace(/[\s\p{Z}]+/gu, ' ')
      .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '')
      .trim(),
  ];
  const name =
    flat.length > NAME_MAX
      ? `${flat
          .slice(0, NAME_MAX - 1)
          .join('')
          .trimEnd()}…`
      : flat.join('');
  if (!DeskSetNameInput.safeParse({ name }).success) return null;
  return name === screen.whombatName ? null : name;
}
