/**
 * Getting one thing back from a backup (Whombat docs/decisions/backup-look.md): the box opens one backup for reading (the
 * backup service's peek), lists what is in it by category, and brings back what the person picks through the backup
 * file's restorer, which only adds. One look at a time; it closes when the person is done, after two hours unused and
 * when the box stops.
 *
 *   backup.look          {checkpointId}                       → BackupLook (opening, then ready)
 *   backup.lookContents  {lookId, category?, query?, cursor?} → the look, its categories with counts, a page of items
 *   backup.lookBring     {lookId, items? | categories?}       → the look with how the bring-back went
 *   backup.lookClose     {lookId}                             → the look, closed
 */
import { z } from 'zod';
import { LocalIdent, Rfc3339 } from './backup.js';

/**
 * What a look lists, by the backup file's categories: chats (`messages`), files, automations, connections, the Vault,
 * memories (the assistant's notes and what it remembers) and its skills. The agent's own settings, Whombat's settings,
 * the servers and the repositories come back with the whole Whombat, not one by one.
 */
export const BACKUP_LOOK_CATEGORIES = [
  'messages',
  'files',
  'automations',
  'connections',
  'vault',
  'memories',
  'skills',
] as const;
export const BackupLookCategory = z.enum(BACKUP_LOOK_CATEGORIES);
export type BackupLookCategory = z.infer<typeof BackupLookCategory>;

/** Items one page of `backup.lookContents` lists. */
export const BACKUP_LOOK_PAGE = 50;
/** Items one bring-back takes (a whole category is `categories`). */
export const BACKUP_LOOK_BRING_MAX = 200;
/** How long a look stays open without being used (the backup service closes a peek two hours after it is ready). */
export const BACKUP_LOOK_IDLE_MS = 2 * 60 * 60_000;

export const BackupLookId = z.string().regex(/^bkl_[A-Za-z0-9_-]{8,40}$/);

/**
 * An item's id within a look: its kind and the backup's own id (`thread:msg_…`, `chat:cnv_…`, `file:att_…`,
 * `automation:aut_…`, `connection:con_…`, `vault:vlt_…`), or one of the few things there is one of (`notes`,
 * `home:person`, `home:outside`, `skills`).
 */
export const BackupLookItemId = z
  .string()
  .min(4)
  .max(120)
  .regex(/^(?:[a-z]+:[A-Za-z0-9_:.-]{1,100}|notes|skills)$/);

/**
 * Why a look can't open or bring something back, for the words people read:
 * - `no_room`: the backup doesn't fit next to everything else (`needBytes`, `freeBytes`);
 * - `busy`: another backup is open, or a backup or a check is running;
 * - `not_supported`: this Whombat's backup service can't open a backup for reading yet (an older box);
 * - `not_found`: the backup isn't there any more;
 * - `failed`: opening it went wrong (`message`);
 * - `closed`: the look closed (two hours unused, or the box restarted).
 */
export const BACKUP_LOOK_PROBLEMS = [
  'no_room',
  'busy',
  'not_supported',
  'not_found',
  'failed',
  'closed',
] as const;
export const BackupLookProblemCode = z.enum(BACKUP_LOOK_PROBLEMS);
export type BackupLookProblemCode = z.infer<typeof BackupLookProblemCode>;

export const BackupLookProblem = z.object({
  code: BackupLookProblemCode,
  /** In plain words, ready to show. */
  message: z.string().max(500),
  needBytes: z.number().int().min(0).optional(),
  freeBytes: z.number().int().min(0).optional(),
});
export type BackupLookProblem = z.infer<typeof BackupLookProblem>;

/** How the last bring-back of a look went: what came back, what was here already, what couldn't come back. */
export const BackupLookBringResult = z.object({
  state: z.enum(['bringing', 'done', 'failed']),
  /** Things picked. */
  picked: z.number().int().min(0),
  back: z.number().int().min(0),
  already: z.number().int().min(0),
  notBack: z.number().int().min(0),
  /** The first few that came back, by title (what Whombat tells the person). */
  titles: z.array(z.string().max(120)).max(10),
  /** Connections that came back and need the person to sign in again. */
  signIn: z.array(z.string().max(200)).max(10),
  /** A failed bring-back, in plain words. */
  error: z.string().max(500).nullable(),
  finishedAt: Rfc3339.nullable(),
});
export type BackupLookBringResult = z.infer<typeof BackupLookBringResult>;

export const BackupLook = z.object({
  lookId: BackupLookId,
  checkpointId: LocalIdent(),
  /** When the backup was made (null when the list doesn't say). */
  madeAt: Rfc3339.nullable(),
  state: z.enum(['opening', 'ready', 'failed', 'closed']),
  /** When it closes by itself unless it is used. */
  expiresAt: Rfc3339.nullable(),
  problem: BackupLookProblem.nullable(),
  /** The last bring-back, while the look is open. */
  bring: BackupLookBringResult.nullable(),
});
export type BackupLook = z.infer<typeof BackupLook>;

export const BackupLookCategoryCount = z.object({
  id: BackupLookCategory,
  count: z.number().int().min(0),
});
export type BackupLookCategoryCount = z.infer<typeof BackupLookCategoryCount>;

/** One thing in the backup, as people know it. */
export const BackupLookItem = z.object({
  id: BackupLookItemId,
  category: BackupLookCategory,
  /** Its name or title (a chat's title or its first words, a file's name, an automation's name). */
  title: z.string().max(200),
  /** When it last changed (a chat's last message, a file's day), null when unknown. */
  at: Rfc3339.nullable(),
  /** A few more words: where a chat was, a file's size, how many messages. */
  detail: z.string().max(200).nullable(),
  /** Whether it is here already (null when the box can't tell before bringing it back). */
  here: z.boolean().nullable(),
});
export type BackupLookItem = z.infer<typeof BackupLookItem>;

export const BackupLookInput = z.strictObject({ checkpointId: LocalIdent() });
export const BackupLookOutput = BackupLook;

export const BackupLookContentsInput = z.strictObject({
  lookId: BackupLookId,
  /** Its items; without, the categories only. */
  category: BackupLookCategory.optional(),
  /** Words that must all be in an item's title (and, for chats, in their messages). */
  query: z.string().trim().max(200).optional(),
  cursor: z.string().max(200).optional(),
});
export const BackupLookContentsOutput = z.object({
  look: BackupLook,
  /** While it is ready: every category the backup has something in, with how many. */
  categories: z.array(BackupLookCategoryCount).max(BACKUP_LOOK_CATEGORIES.length),
  category: BackupLookCategory.nullable(),
  items: z.array(BackupLookItem).max(BACKUP_LOOK_PAGE),
  nextCursor: z.string().max(200).nullable(),
});
export type BackupLookContentsOutput = z.infer<typeof BackupLookContentsOutput>;

export const BackupLookBringInput = z
  .strictObject({
    lookId: BackupLookId,
    items: z.array(BackupLookItemId).min(1).max(BACKUP_LOOK_BRING_MAX).optional(),
    /** Everything of these categories (only what isn't here comes back). */
    categories: z.array(BackupLookCategory).min(1).max(BACKUP_LOOK_CATEGORIES.length).optional(),
  })
  .refine((i) => (i.items?.length ?? 0) + (i.categories?.length ?? 0) > 0, {
    message: 'Pick something to bring back.',
    path: ['items'],
  });
export const BackupLookBringOutput = z.object({
  look: BackupLook,
  /**
   * One or two plain sentences of what happened (“Your chat “Roof leak” is back.”), for the assistant to pass on; the
   * screens make their own from `look.bring`.
   */
  say: z.string().max(500),
});
export type BackupLookBringOutput = z.infer<typeof BackupLookBringOutput>;

export const BackupLookCloseInput = z.strictObject({ lookId: BackupLookId });
export const BackupLookCloseOutput = BackupLook;
