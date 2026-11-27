/**
 * Getting one thing back from a backup, the words and the view model web and phone share (Whombat backup-look.md; app
 * backup-look.md AP-6940…): the backup's page offers “Bring things back from this backup”; the flow opens it (a short
 * wait that says so), shows its categories with how many things each has, a category's things (searchable, each with
 * when and where it was and whether it is here already), lets the person pick, brings them back and says how it went
 * (“3 things are back. 1 was already here.”), then closes it. Pure.
 */
import { backupLookCategoryNames, backupLookDoneLine } from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import type {
  BackupLook,
  BackupLookBringResult,
  BackupLookCategory,
  BackupLookCategoryCount,
  BackupLookItem,
} from '@whombat/protocol/session';
import { clientTree } from '../i18n/catalog';
import { BACKUP_LOOK_WORDS } from '../i18n/messages/backupLook';
import { relativeDay } from './backup-options';

/** The flow's words in a locale (English when none is given). */
export function backupLookText(locale?: string | null) {
  const { bringNone, ...w } = clientTree(locale, BACKUP_LOOK_WORDS);
  return {
    ...w,
    search: (category: string) => interpolate(w.search, { category: category.toLowerCase() }),
    bring: (n: number) => (n === 0 ? bringNone : w.bring(n)),
  };
}

export const BACKUP_LOOK_TEXT = backupLookText('en');

/** What a category is called. */
export function lookCategoryName(id: BackupLookCategory, locale?: string | null): string {
  return backupLookCategoryNames(locale)[id];
}

/** A category's row: its name and how many things it has. */
export function lookCategoryRows(
  categories: readonly BackupLookCategoryCount[],
  locale?: string | null,
): { id: BackupLookCategory; name: string; count: string }[] {
  return categories.map((c) => ({ id: c.id, name: lookCategoryName(c.id, locale), count: String(c.count) }));
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
  locale?: string | null,
): string | null {
  if (!look || look.state === 'opening' || look.state === 'ready') return null;
  if (look.problem?.message) return look.problem.message;
  const T = backupLookText(locale);
  return look.state === 'closed' ? T.closed : T.failedOpen;
}

/** An item's second line: when it last changed and where it was (“yesterday · In Chat · 4 replies”). */
export function lookItemMeta(
  item: Pick<BackupLookItem, 'at' | 'detail'>,
  now = new Date(),
  locale?: string | null,
): string {
  const when = item.at ? relativeDay(item.at, now, locale) : null;
  return [when ? when.charAt(0).toUpperCase() + when.slice(1) : null, item.detail]
    .filter(Boolean)
    .join(' · ');
}

/** The line a finished (or running, or failed) bring-back shows. */
export function lookDoneLine(
  bring: BackupLookBringResult | null | undefined,
  locale?: string | null,
): string | null {
  if (!bring) return null;
  const T = backupLookText(locale);
  if (bring.state === 'bringing') return T.bringing;
  if (bring.state === 'failed') return bring.error ?? T.failedOpen;
  return backupLookDoneLine(
    {
      back: bring.back,
      already: bring.already,
      notBack: bring.notBack,
      titles: bring.titles,
      signIn: bring.signIn,
    },
    locale,
  );
}

/** The picked set after toggling one item. */
export function togglePick(picked: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(picked);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
