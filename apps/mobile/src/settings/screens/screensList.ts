/**
 * Settings → Screens on the phone (Whombat desk-display.md DK-128, DK-137, DK-146, DK-149; desk-display-android.md
 * AP-6000…AP-6009): whether the Whombat has screens of widgets or the older *Screen* page, the list's rows (the shared
 * lines, `screenLines`), the Settings list's line, *Add a screen*'s six letters and name, and *What pops up*'s three
 * choices. Pure.
 */
import {
  DEFAULT_DESK_SHOW,
  DESK_SCREEN_CODE_RE,
  DESK_SCREEN_WORDS,
  DESK_SCREENS_TEXT,
  DESK_WORDS,
  type DeskLockAgain,
  type DeskLockedView,
  type DeskPopups,
  type DeskScreen,
  type DeskScreenDetail,
  type DeskScreenSummary,
  type DeskScreensList,
  deskErrorCode,
  fillDeskWords,
  gridText,
  pagesText,
  screenLines,
  screenShape,
} from '@whombat/client/desk';
import { formatRecent } from '@whombat/core';

/**
 * What Settings shows for the box's screen (DK-149): *Screens* where the runtime answers `desk.screens`, the older
 * *Screen* page where it doesn't know the op (a runtime before 3.6, even with an earlier answer still kept: a box
 * restored to an older runtime), nothing yet while it's asked, and a failure to say when no answer came.
 */
export function screensOffered(q: {
  data?: DeskScreensList | undefined;
  error?: unknown;
  isLoading?: boolean;
}): 'screens' | 'older' | 'loading' | 'failed' {
  if (q.error && deskErrorCode(q.error) === 'unknown_op') return 'older';
  if (q.data) return 'screens';
  if (q.error) return 'failed';
  return q.isLoading === false ? 'failed' : 'loading';
}

/** The Settings list's line for *Screens*: the box's own alone, or how many there are. */
export function screensRowLine(list: DeskScreensList): string {
  const n = list.screens.length;
  if (n <= 1) return DESK_SCREEN_WORDS.box;
  return `${n} screens`;
}

export interface ScreenRowView {
  id: string;
  kind: DeskScreenSummary['kind'];
  name: string;
  what: string;
  how: string;
  /** For one that isn't showing now: since when. */
  status: string | null;
  /** All of it, for TalkBack. */
  spoken: string;
}

/**
 * A screen's row: its name and the shared lines, from its own read when there (the grid needs its Size) or from the
 * list's summary while that loads.
 */
export function screenRow(
  screen: DeskScreenSummary,
  detail: DeskScreenDetail | undefined,
  context: {
    box?: { builtIn: boolean; name: string | null } | null;
    lockAgain?: DeskLockAgain | null;
    lockedView?: DeskLockedView | null;
    now: number;
    timeZone: string;
  },
): ScreenRowView {
  // Until its own read is there, the list's summary at Normal (its pages are counted already).
  const full: DeskScreenDetail = {
    ...screen,
    layout: detail?.layout ?? { pages: [], turn: 'touch', size: 'normal' },
    show: detail?.show ?? DEFAULT_DESK_SHOW,
  };
  const when = (iso: string) => {
    const s = formatRecent(iso, context.now, context.timeZone);
    return s === 'Yesterday' ? 'yesterday' : s;
  };
  const lines = screenLines(full, { ...context, when });
  return {
    id: screen.id,
    kind: screen.kind,
    name: screen.name,
    what: lines.what,
    how: lines.how,
    status: lines.status,
    spoken: [screen.name, lines.what, lines.how, lines.status].filter(Boolean).join('. '),
  };
}

/** *Edit layout*'s line on a screen's page: “3 pages · 8 × 5”. */
export function layoutLine(screen: Pick<DeskScreenDetail, 'size' | 'layout'>): string {
  const { cols, rows } = screenShape(screen);
  return fillDeskWords(DESK_SCREENS_TEXT.page.layoutLine, {
    pages: pagesText(screen.layout.pages.length),
    grid: gridText(cols, rows),
  });
}

/** *What pops up*'s three, in their order, with the contract's words. */
export function popupOptions(): { value: DeskPopups; label: string }[] {
  return (['all', 'problems', 'none'] as const).map((value) => ({
    value,
    label: DESK_SCREEN_WORDS.popups[value],
  }));
}

/** The letters as typed: capitals only, at most six (a space or a dot from the screen's “KTR · MWP” dropped). */
export function screenLetters(typed: string): string {
  return typed
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 6);
}

/** Why the six letters can't be sent yet, or null when they can. */
export function lettersProblem(letters: string): 'short' | 'io' | null {
  if (letters.length < 6) return 'short';
  return DESK_SCREEN_CODE_RE.test(letters) ? null : 'io';
}

/** A screen's name as typed: one line, spaces run together, at most 40 characters; null when nothing is left. */
export function screenName(typed: string): string | null {
  const flat = [
    ...typed
      .replace(/[\s\p{Z}]+/gu, ' ')
      .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '')
      .trim(),
  ];
  return flat.length ? flat.slice(0, 40).join('').trimEnd() : null;
}

/** The box's own screen's parts beyond its layout, as tabs: the top bar first, then the older page's three. */
export const BOX_PARTS = ['bar', 'lock', 'night', 'talk'] as const;
export type BoxPart = (typeof BOX_PARTS)[number];
export const BOX_PART_LABELS: Record<BoxPart, string> = {
  bar: DESK_WORDS.settings.bar,
  lock: DESK_WORDS.settings.parts.lock,
  night: DESK_WORDS.settings.parts.night,
  talk: DESK_WORDS.settings.parts.talk,
};

/** None until the box's screen is paired (the switch card with *Pair the screen* says it all), as the older page. */
export function boxParts(screen: Pick<DeskScreen, 'paired'>): BoxPart[] {
  return screen.paired ? [...BOX_PARTS] : [];
}
