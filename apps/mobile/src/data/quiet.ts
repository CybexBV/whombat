/**
 * Quiet notices on the phone (Whombat quiet-notices.md QN-10…QN-15, QN-21; quiet-notices-mobile.md AP-4860…): the
 * phone's words and arrangements around the shared parts (`@whombat/client`'s `quietMenu`, `thingWatchView`,
 * `needsYouIgnoreDone`, `useQuietActions`) — What Whombat watches folded on a server's Summary, a check named in quotes
 * in its toasts, and the toasts' Undo. Pure; the screens are `screens/thing/QuietMenu.tsx` and
 * `screens/thing/WhatWhombatWatches.tsx`.
 */
import type { ThingWatchView, WatchCheckView } from '@whombat/client';
import type { QuietNote } from '@whombat/client/react';
import { quietWords } from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';

export function quietCopy(locale?: string) {
  const { t } = mobileTranslator(locale);
  const w = quietWords(locale);
  return {
    watchTitle: w.watchTitle,
    watchNot: w.watchNot,
    undo: w.undo,
    loading: t('data.quiet.loading'),
    failed: t('data.quiet.failed'),
    /** Look only and guests: the rows without switches, each saying whether it is on. */
    on: t('data.quiet.on'),
    off: t('data.quiet.off'),
    readOnly: t('data.quiet.readOnly'),
    showMore: (n: number) => t('data.quiet.showMore', { n }),
    showFewer: t('data.quiet.showFewer'),
    /** A check's limit's button. */
    change: t('data.quiet.change'),
  };
}

export const QUIET_COPY = quietCopy();

/** How many checks a server's Summary shows before “Show N more” (its card sits under everything else). */
export const WATCH_FIRST = 6;

/**
 * A check as its toast names it when its switch is pressed: in quotes, as written (AP-4805: its lower-cased name would
 * spoil the product names in it). “Whombat stopped watching “Access points and switches going offline”.”
 */
export function checkToastName(name: string): string {
  return `“${name}”`;
}

/** The rows shown: all of them, or the first `first` with how many wait behind “Show N more” (open: all). */
export function foldWatchRows(
  view: Pick<ThingWatchView, 'rows'>,
  first: number | null,
  open: boolean,
): { shown: WatchCheckView[]; more: number } {
  if (first === null || open || view.rows.length <= first) return { shown: view.rows, more: 0 };
  return { shown: view.rows.slice(0, first), more: view.rows.length - first };
}

/** A check's switch as TalkBack reads it (the switch's own label is the shared `switchLabel`), with its exceptions. */
export function watchRowSpoken(row: WatchCheckView, mayChange: boolean, locale?: string): string {
  const copy = quietCopy(locale);
  const state = mayChange ? null : row.on ? copy.on : copy.off;
  return [row.name, state, row.offLine].filter(Boolean).join('. ');
}

/** An exception's words on its line and for TalkBack: “Garage AP until it’s back”. */
export function exceptionText(e: { name: string; words: string }): string {
  return [e.name, e.words].filter(Boolean).join(' ');
}

/**
 * The quiet actions' note (`useQuietActions`' `note`) as the phone says it: the toast with Undo where there is one; a
 * refusal or failure in the server's words, without.
 */
export function quietNote(show: (text: string, options: { undo?: (() => void) | null }) => void): QuietNote {
  return (message, options) => show(message, { undo: options?.failed ? null : (options?.undo ?? null) });
}
