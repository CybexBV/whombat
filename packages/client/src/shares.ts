/**
 * The words of shared links (docs/decisions/share-links.md), the same on the web and the phone: the Share sheet's
 * choices and notes, a link's line in Settings, and what the warnings say. Pure.
 */
import type { SharedLink, SharePreview, ShareWarning } from '@whombat/core';
import type { ShareExpiry } from '@whombat/core/share';

export const SHARE_EXPIRY_OPTIONS: readonly { value: ShareExpiry; label: string }[] = [
  { value: '1d', label: '1 day' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'never', label: 'No end' },
];

export const SHARE_TEXT = {
  title: 'Share this thread',
  fromHere: 'Share from here',
  shareMenu: 'Share…',
  shareFromMenu: 'Share from here…',
  pictures: 'Include pictures',
  expiry: 'Link works for',
  create: 'Create link',
  creating: 'Creating link…',
  copy: 'Copy link',
  copied: 'Link copied.',
  done: 'Done',
  cancel: 'Cancel',
  stop: 'Stop sharing',
  stopping: 'Stopping…',
  stopAll: 'Stop all links',
  readyTitle: 'Your link is ready',
  privacy: 'Anyone with the link can read this copy. Copies people make of it can’t be taken back.',
  frozen: 'It’s a copy of the thread as it is now. Later messages aren’t in it.',
  leftOutNote: (n: number) =>
    n === 1
      ? 'One thing here isn’t shared: approvals, other cards, files and details stay in Whombat.'
      : `${n} things here aren’t shared: approvals, other cards, files and details stay in Whombat.`,
  lookFirst: 'Have a look first',
  noPicturesFit: 'With its pictures this thread is too big to share. It can be shared without them.',
  tooBig: 'This thread is too big to share.',
  settingsTitle: 'Shared links',
  settingsEmpty: 'You haven’t shared anything yet. Share a thread from its menu in Chat.',
  settingsNote: 'Links to copies of your threads. Anyone with a link can read its copy until it stops.',
  failed: 'Couldn’t create the link. Try again in a moment.',
} as const;

/** “3 messages and 2 pictures” — what the copy holds, for the sheet's first line. */
export function shareContents(
  preview: Pick<SharePreview, 'messages' | 'pictures'>,
  pictures: boolean,
): string {
  const m = preview.messages === 1 ? '1 message' : `${preview.messages} messages`;
  if (!pictures || preview.pictures === 0) return m;
  return `${m} and ${preview.pictures === 1 ? '1 picture' : `${preview.pictures} pictures`}`;
}

/** One warning in words. */
export function shareWarningText(w: ShareWarning): string {
  const where = w.messages === 1 ? '1 message' : `${w.messages} messages`;
  switch (w.kind) {
    case 'address':
      return `${where} ${w.messages === 1 ? 'mentions' : 'mention'} a network address (${w.example}).`;
    case 'email':
      return `${where} ${w.messages === 1 ? 'has' : 'have'} an email address (${w.example}).`;
    case 'secret':
      return `${where} ${w.messages === 1 ? 'has' : 'have'} something that looks like a password or key (${w.example}).`;
  }
}

const day = (iso: string, timeZone?: string) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));

/** A link's line under its title: “Works until 12 Nov · Opened 3 times”, “Stopped”, “Ran out on 4 Nov”. */
export function shareLinkLine(link: SharedLink, timeZone?: string): string {
  if (link.state === 'stopped')
    return link.stopping ? 'Stopped · Whombat’s servers delete the copy as soon as they can' : 'Stopped';
  if (link.state === 'expired')
    return link.expiresAt ? `Ran out on ${day(link.expiresAt, timeZone)}` : 'Ran out';
  const until = link.expiresAt ? `Works until ${day(link.expiresAt, timeZone)}` : 'Works until you stop it';
  if (link.views === null) return until;
  const opened =
    link.views === 0 ? 'Not opened yet' : link.views === 1 ? 'Opened once' : `Opened ${link.views} times`;
  return `${until} · ${opened}`;
}

/** The sheet's line after a link was made: how long it works. */
export function shareReadyLine(link: Pick<SharedLink, 'expiresAt'>, timeZone?: string): string {
  return link.expiresAt
    ? `It works until ${day(link.expiresAt, timeZone)}. You can stop it in Settings → You → Shared links.`
    : 'It works until you stop it in Settings → You → Shared links.';
}
