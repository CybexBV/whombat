/**
 * The words of shared links (docs/decisions/share-links.md), the same on the web and the phone: the Share sheet's
 * choices and notes, a link's line in Settings, and what the warnings say. Pure.
 */
import type { SharedLink, SharePreview, ShareWarning } from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import type { ShareExpiry } from '@whombat/core/share';
import { clientTree } from './i18n/catalog';
import { ASKS_AREA_WORDS } from './i18n/messages/chatWork/asks';

const words = (locale?: string | null) => clientTree(locale, ASKS_AREA_WORDS).shares;

/** How long a link works, the Share sheet's choices, in a locale (English when none). */
export function shareExpiryOptions(locale?: string | null): readonly { value: ShareExpiry; label: string }[] {
  const e = words(locale).expiry;
  return [
    { value: '1d', label: e.day },
    { value: '7d', label: e.week },
    { value: '30d', label: e.month },
    { value: 'never', label: e.never },
  ];
}

export const SHARE_EXPIRY_OPTIONS: readonly { value: ShareExpiry; label: string }[] = shareExpiryOptions();

/** The Share sheet's and Settings' words for shared links, in a locale (English when none). */
export function shareText(locale?: string | null) {
  const w = words(locale);
  return {
    title: w.title,
    fromHere: w.fromHere,
    shareMenu: w.shareMenu,
    shareFromMenu: w.shareFromMenu,
    pictures: w.pictures,
    expiry: w.expiryLabel,
    create: w.create,
    creating: w.creating,
    copy: w.copy,
    copied: w.copied,
    done: w.done,
    cancel: w.cancel,
    stop: w.stop,
    stopping: w.stopping,
    stopAll: w.stopAll,
    readyTitle: w.readyTitle,
    privacy: w.privacy,
    frozen: w.frozen,
    leftOutNote: (n: number) => (n === 1 ? w.leftOutOne : interpolate(w.leftOutMany, { n })),
    lookFirst: w.lookFirst,
    noPicturesFit: w.noPicturesFit,
    tooBig: w.tooBig,
    settingsTitle: w.settingsTitle,
    settingsEmpty: w.settingsEmpty,
    settingsNote: w.settingsNote,
    failed: w.failed,
  };
}

export const SHARE_TEXT = shareText();

/** “3 messages and 2 pictures” — what the copy holds, for the sheet's first line. */
export function shareContents(
  preview: Pick<SharePreview, 'messages' | 'pictures'>,
  pictures: boolean,
  locale?: string | null,
): string {
  const w = words(locale);
  const m = w.messages(preview.messages);
  if (!pictures || preview.pictures === 0) return m;
  return interpolate(w.and, { messages: m, pictures: w.picturesCount(preview.pictures) });
}

/** One warning in words. */
export function shareWarningText(w: ShareWarning, locale?: string | null): string {
  const t = words(locale);
  const vars = { example: w.example };
  switch (w.kind) {
    case 'address':
      return t.address(w.messages, vars);
    case 'email':
      return t.email(w.messages, vars);
    case 'secret':
      return t.secret(w.messages, vars);
  }
}

const day = (iso: string, timeZone?: string, locale?: string | null) =>
  new Intl.DateTimeFormat(locale?.toLowerCase().startsWith('nl') ? 'nl-NL' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    ...(timeZone ? { timeZone } : {}),
  })
    .format(new Date(iso))
    .replace(/\.$/, '');

/** A link's line under its title: “Works until 12 Nov · Opened 3 times”, “Stopped”, “Ran out on 4 Nov”. */
export function shareLinkLine(link: SharedLink, timeZone?: string, locale?: string | null): string {
  const w = words(locale);
  if (link.state === 'stopped') return link.stopping ? w.stoppedDeleting : w.stopped;
  if (link.state === 'expired')
    return link.expiresAt
      ? interpolate(w.ranOutOn, { date: day(link.expiresAt, timeZone, locale) })
      : w.ranOut;
  const until = link.expiresAt
    ? interpolate(w.worksUntil, { date: day(link.expiresAt, timeZone, locale) })
    : w.worksUntilStop;
  if (link.views === null) return until;
  const opened =
    link.views === 0
      ? w.notOpened
      : link.views === 1
        ? w.openedOnce
        : interpolate(w.openedTimes, { n: link.views });
  return `${until} · ${opened}`;
}

/** The sheet's line after a link was made: how long it works. */
export function shareReadyLine(
  link: Pick<SharedLink, 'expiresAt'>,
  timeZone?: string,
  locale?: string | null,
): string {
  const w = words(locale);
  return link.expiresAt
    ? interpolate(w.ready, { date: day(link.expiresAt, timeZone, locale) })
    : w.readyNoEnd;
}
