/**
 * Settings → Screens' words and lines (3.6; Whombat desk-display.md DK-128…DK-147), shared by the web and the phone:
 * a screen's lines in the list (what it is, its grid, its pages; what pops up and how it locks), the editor's words,
 * and the refusals in plain words. The contract's own (`DESK_SCREEN_WORDS`) are used where it has them.
 */

import { deskScreenWords, deskWords } from '@whombat/core/domain';
import { screenGrid } from '@whombat/screen';
import { ARRANGE_WORDS, arrangeWords } from '../home/arrange';
import { clientTree } from '../i18n/catalog';
import { DESK_SCREENS_WORDS } from '../i18n/messages/deskScreens';
import { OperationError } from '../session/managed-ops';
import {
  DESK_SCREEN_WORDS,
  DESK_WORDS,
  type DeskLockAgain,
  type DeskLockedView,
  type DeskScreenDetail,
  type DeskScreenSummary,
  type DeskWidgetType,
  fillDeskWords,
} from './contract';
import type { EditorRefusal, SizePresetKey } from './editor';
import { deskErrorCode } from './model';

/**
 * The words of Settings → Screens and the editor in a locale (English when none is given), beyond the contract's: the
 * desk's and the overview's own where they have them.
 */
export function deskScreensText(locale?: string | null) {
  const { fallback: _fallback, errors: _errors, ...own } = clientTree(locale, DESK_SCREENS_WORDS);
  const arrange = locale === undefined || locale === null ? ARRANGE_WORDS : arrangeWords(locale);
  const screenWords = locale === undefined || locale === null ? DESK_SCREEN_WORDS : deskScreenWords(locale);
  return {
    ...own,
    editor: {
      ...own.editor,
      shows: arrange.shows,
      reading: arrange.reading,
      couldntRead: arrange.couldntRead,
      shapes: {
        small: arrange.sizes.s,
        normal: screenWords.sizes.normal,
        wide: arrange.sizes.w,
        tall: own.editor.shapes.tall,
        large: arrange.sizes.l,
      } satisfies Record<SizePresetKey, string>,
    },
  };
}

/** Settings → Screens' words in English. */
export type DeskScreensWords = ReturnType<typeof deskScreensText>;

export const DESK_SCREENS_TEXT: DeskScreensWords = deskScreensText('en');

/** The English words without building them again; another locale's when one is given. */
function textIn(locale?: string | null): DeskScreensWords {
  return locale === undefined || locale === null || locale === 'en'
    ? DESK_SCREENS_TEXT
    : deskScreensText(locale);
}

/** “8 × 5”. */
export const gridText = (cols: number, rows: number, locale?: string | null) =>
  fillDeskWords(textIn(locale).grid, { cols, rows });
/** “3 pages”, “1 page”. */
export const pagesText = (n: number, locale?: string | null) => {
  const pages = textIn(locale).pages;
  return n === 1 ? pages.one : fillDeskWords(pages.many, { n });
};

/** What a screen is, in a few words: “Built in”, “DELL U2720Q”, “Plugged into this Whombat”, “iPad · Safari”. */
export function screenWhat(
  screen: Pick<DeskScreenSummary, 'kind' | 'device'>,
  box?: { builtIn: boolean; name: string | null } | null,
  locale?: string | null,
): string {
  const T = textIn(locale);
  if (screen.kind === 'box') return box?.builtIn ? T.builtIn : (box?.name ?? T.boxScreen);
  if (screen.kind === 'output') return T.output;
  return screen.device ?? T.device;
}

/** The screen's grid as it last said its size (else the default 1280 × 800), at its layout's Size. */
export function screenShape(screen: Pick<DeskScreenDetail, 'size' | 'layout'>): {
  cols: number;
  rows: number;
} {
  const size = screen.size ?? { width: 1280, height: 800 };
  const g = screenGrid(size.width, size.height, screen.layout.size);
  return { cols: g.cols, rows: g.rows };
}

/**
 * A screen's lines in the list (the mockups' `f-screens`): “Built in · 8 × 5 · 3 pages” (“, turning every 30 s”),
 * “Pops up for questions and problems · locks after 2 minutes” (the box's own by its *Lock again*, a screen elsewhere
 * by what a locked screen shows), and for one that isn't showing, since when.
 */
export function screenLines(
  screen: DeskScreenDetail,
  context: {
    box?: { builtIn: boolean; name: string | null } | null;
    lockAgain?: DeskLockAgain | null;
    lockedView?: DeskLockedView | null;
    /** “14:02”, “yesterday”: the last seen time in words. */
    when?: (iso: string) => string;
    locale?: string | null;
  } = {},
): { what: string; how: string; status: string | null } {
  const { locale } = context;
  const T = textIn(locale);
  const { cols, rows } = screenShape(screen);
  const turn = screen.layout.turn === 'touch' ? '' : `, ${T.turning[screen.layout.turn]}`;
  const what = [
    screenWhat(screen, context.box, locale),
    gridText(cols, rows, locale),
    `${pagesText(screen.pages, locale)}${turn}`,
  ].join(' · ');
  const lock =
    screen.kind === 'box'
      ? context.lockAgain
        ? T.locks[context.lockAgain]
        : null
      : context.lockedView
        ? T.lockedViews[context.lockedView]
        : null;
  const how = [T.popups[screen.popups], lock].filter(Boolean).join(' · ');
  let status: string | null = null;
  if (!screen.online && screen.kind !== 'box')
    status = screen.lastSeenAt
      ? fillDeskWords(T.lastSeen, {
          when: context.when ? context.when(screen.lastSeenAt) : screen.lastSeenAt,
        })
      : T.notSeen;
  return { what, how, status };
}

/** A widget's name in the editor's words (its view's title, else its type's name). */
export function ownWidgetName(
  type: DeskWidgetType,
  assistant: string,
  locale?: string | null,
): string | null {
  const words = locale === undefined || locale === null ? DESK_SCREEN_WORDS : deskScreenWords(locale);
  const own = (words.own as Record<string, { name: string } | undefined>)[type];
  return own ? fillDeskWords(own.name, { assistant }) : null;
}

/** An editor refusal in words; `size` the widget's smallest or largest (“2 × 1”). */
export function refusalText(
  why: EditorRefusal,
  size?: { w: number; h: number },
  grow = false,
  locale?: string | null,
): string {
  const r = textIn(locale).editor.refused;
  if (why === 'noRoom') return grow ? r.grow : r.noRoom;
  if (why === 'tooSmall' || why === 'tooBig')
    return fillDeskWords(r[why], { size: size ? gridText(size.w, size.h, locale) : '' });
  return r[why];
}

/** A refusal of a `desk.screen.*` op in words: the desk's code (`unknown_screen`, `bad_layout`, …), else a fallback. */
export function screensErrorText(error: unknown, fallback?: string, locale?: string | null): string {
  const code = deskErrorCode(error);
  const words = code ? (screenErrors(locale) as Record<string, string | undefined>)[code] : undefined;
  if (words) return words;
  if (error instanceof OperationError && error.code === 'revoked') return textIn(locale).page.removed;
  return fallback ?? clientTree(locale, DESK_SCREENS_WORDS).fallback;
}

/** The desk codes a `desk.screen.*` op refuses with, in words. */
function screenErrors(locale?: string | null): Record<string, string> {
  const own = clientTree(locale, DESK_SCREENS_WORDS).errors;
  const desk = locale === undefined || locale === null ? DESK_WORDS : deskWords(locale);
  return {
    not_paired: own.not_paired,
    unknown_screen: desk.errors.unknown_screen,
    screens_full: desk.errors.screens_full,
    bad_layout: desk.errors.bad_layout,
    wrong_code: own.wrong_code,
    pairing_expired: own.pairing_expired,
  };
}
