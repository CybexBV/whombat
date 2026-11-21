/**
 * What the assistant says when the person asks to talk an Inbox item over (docs/decisions/inbox.md IBX-07): the item in
 * a sentence or two, named by its thing, then an open question, as a colleague would start the conversation. What the
 * assistant found out, when it did, takes the place of the item's own words. Pure.
 */
import type { NeedsYouItem } from '@whombat/core';

const sentence = (s: string) => (/[.?!…]$/.test(s) ? s : `${s}.`);

export function discussOpener(item: Pick<NeedsYouItem, 'title' | 'body' | 'subject' | 'research'>): string {
  const found = item.research?.state === 'found' || item.research?.state === 'fixed';
  const title = (found && item.research?.title) || item.title;
  const name = item.subject?.name.trim();
  const head = name && !title.includes(name) ? `${name}: ${title}` : title;
  const detail = ((found && item.research?.summary) || item.body).trim();
  const about = [sentence(head.trim()), detail ? sentence(detail) : ''].filter(Boolean).join(' ');
  return `${about}\n\nWhat would you like to know or do about it?`;
}
