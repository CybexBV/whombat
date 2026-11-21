/**
 * Getting one thing back from a backup, the words and the view model web and phone share (Whombat backup-look.md; app
 * backup-look.md AP-6940…): the backup's page offers “Bring things back from this backup”; the flow opens it (a short
 * wait that says so), shows its categories with how many things each has, a category's things (searchable, each with
 * when and where it was and whether it is here already), lets the person pick, brings them back and says how it went
 * (“3 things are back. 1 was already here.”), then closes it. Pure.
 */
import { BACKUP_LOOK_CATEGORY_NAMES, backupLookDoneLine } from '@whombat/core';
import type {
  BackupLook,
  BackupLookBringResult,
  BackupLookCategory,
  BackupLookCategoryCount,
  BackupLookItem,
} from '@whombat/protocol/session';
import { relativeDay } from './backup-options';

export const BACKUP_LOOK_TEXT = {
  /** The one entry on a backup's page. */
  entry: 'Bring things back from this backup',
  entryLead: 'A chat, a file or anything else you lost. Nothing here is changed or overwritten.',
  title: 'Bring things back',
  opening: 'Opening this backup…',
  openingLead: 'It takes a minute. Whombat opens a copy of it beside everything else; nothing here changes.',
  inIt: 'What’s in it',
  pickLead: 'Pick a kind of thing, then what you want back.',
  back: 'Back',
  search: (category: string) => `Search ${category.toLowerCase()}`,
  searchLabel: 'Search',
  here: 'Already here',
  empty: 'Nothing of this kind in the backup.',
  noMatch: 'Nothing matches.',
  more: 'Show more',
  bring: (n: number) => (n === 0 ? 'Bring back' : n === 1 ? 'Bring back 1 thing' : `Bring back ${n} things`),
  bringing: 'Bringing them back…',
  pickMore: 'Bring back more',
  close: 'Close',
  tryAgain: 'Try again',
  closed: 'This backup closed after two hours. Open it again to bring more back.',
  failedOpen: 'The backup couldn’t be opened. Try again in a few minutes.',
  unknown: 'This Whombat can’t open a backup to look inside it yet. It can once its next update is in.',
} as const;

/** What a category is called. */
export function lookCategoryName(id: BackupLookCategory): string {
  return BACKUP_LOOK_CATEGORY_NAMES[id];
}

/** A category's row: its name and how many things it has. */
export function lookCategoryRows(
  categories: readonly BackupLookCategoryCount[],
): { id: BackupLookCategory; name: string; count: string }[] {
  return categories.map((c) => ({ id: c.id, name: lookCategoryName(c.id), count: String(c.count) }));
}

/** Where the flow is: the backup opening, ready to pick from, or stopped (closed, or it couldn't open). */
export type LookStage = 'opening' | 'ready' | 'stopped';

export function lookStage(look: Pick<BackupLook, 'state'> | null | undefined): LookStage {
  if (!look || look.state === 'opening') return 'opening';
  return look.state === 'ready' ? 'ready' : 'stopped';
}

/** What a stopped look says (why it couldn't open, or that it closed). */
export function lookProblemText(
  look: Pick<BackupLook, 'state' | 'problem'> | null | undefined,
): string | null {
  if (!look || look.state === 'opening' || look.state === 'ready') return null;
  if (look.problem?.message) return look.problem.message;
  return look.state === 'closed' ? BACKUP_LOOK_TEXT.closed : BACKUP_LOOK_TEXT.failedOpen;
}

/** An item's second line: when it last changed and where it was (“yesterday · In Chat · 4 replies”). */
export function lookItemMeta(item: Pick<BackupLookItem, 'at' | 'detail'>, now = new Date()): string {
  const when = item.at ? relativeDay(item.at, now) : null;
  return [when ? when.charAt(0).toUpperCase() + when.slice(1) : null, item.detail]
    .filter(Boolean)
    .join(' · ');
}

/** The line a finished (or running, or failed) bring-back shows. */
export function lookDoneLine(bring: BackupLookBringResult | null | undefined): string | null {
  if (!bring) return null;
  if (bring.state === 'bringing') return BACKUP_LOOK_TEXT.bringing;
  if (bring.state === 'failed') return bring.error ?? BACKUP_LOOK_TEXT.failedOpen;
  return backupLookDoneLine({
    back: bring.back,
    already: bring.already,
    notBack: bring.notBack,
    titles: bring.titles,
    signIn: bring.signIn,
  });
}

/** The picked set after toggling one item. */
export function togglePick(picked: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(picked);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
