/**
 * What the person sees of a 1Password vault kept in step with the Vault (docs/decisions/onepassword-sync.md): the
 * connection page's 1Password part, the answers it and the Inbox take, the checks of What Whombat watches, and the
 * words of the Vault's rows and pages. The page reads what the last pass stored; nothing here calls 1Password.
 */
import { z } from 'zod';
import { Count, Timestamp } from '../domain/common.js';
import type { NoticeNature } from '../domain/quiet.js';
import { ConnectionId, VaultEntryId } from '../ids.js';
import { type DateInput, formatAgo, formatClock } from '../text/time.js';
import {
  ONEPASSWORD_NOT_IN_VAULT_MAX,
  ONEPASSWORD_SKIP_TEXT,
  OnePasswordItemId,
  OnePasswordSkipReason,
} from './onepassword.js';
import { VAULT_ENTRIES_MAX, VAULT_NAME_MAX, type VaultEntrySource } from './schemas.js';

/* The connection page's part ----------------------------------------------------------------------- */

/**
 * The key of the 1Password connection's own tab, which its page opens on: the apps draw the part below there, from
 * `connections.onePassword`, not from panels. The Connection tab keeps only the connection's own details.
 */
export const ONEPASSWORD_TAB = 'onepassword';

/**
 * How the last pass ended: `ok`; `paused` (the guard holds removals for the person); `waiting` (1Password's limit, until
 * `nextTryAt`); `failing` (it couldn't finish: `problem` says why).
 */
export const ONEPASSWORD_PASS_OUTCOMES = ['ok', 'paused', 'waiting', 'failing'] as const;
export const OnePasswordPassOutcome = z.enum(ONEPASSWORD_PASS_OUTCOMES);
export type OnePasswordPassOutcome = z.infer<typeof OnePasswordPassOutcome>;

/** An item under “Not in your Vault”: its title as 1Password shows it and why it stays there. */
export const OnePasswordNotInVault = z.object({
  itemId: OnePasswordItemId,
  title: z.string().max(200),
  reason: OnePasswordSkipReason,
});
export type OnePasswordNotInVault = z.infer<typeof OnePasswordNotInVault>;

/**
 * The removals the guard holds: the entries whose items 1Password says are gone. `token` names this set; an answer
 * carries it back, so it never applies to a set the person didn't see.
 */
export const OnePasswordRemovals = z.object({
  token: z.string().min(1).max(100),
  entries: z
    .array(z.object({ entryId: VaultEntryId, name: z.string().max(VAULT_NAME_MAX) }))
    .min(1)
    .max(VAULT_ENTRIES_MAX),
  since: Timestamp,
});
export type OnePasswordRemovals = z.infer<typeof OnePasswordRemovals>;

/** A 1Password connection's page part (`connections.onePassword`). */
export const OnePasswordSyncView = z.object({
  connectionId: ConnectionId,
  /** The vault's name in 1Password; null before the first check named it. */
  vaultTitle: z.string().max(200).nullable(),
  /** Entries kept in step now. */
  kept: Count,
  /** Entries waiting to go to 1Password (made since the last pass, or being created). */
  pending: Count,
  /** Entries the person chose to keep only in Whombat (at linking, or “Keep them here”). */
  localOnly: Count,
  /** When the last pass ended; null before the first. */
  checkedAt: Timestamp.nullable(),
  /** How it ended; null before the first. */
  outcome: OnePasswordPassOutcome.nullable(),
  /** `failing`: why, in the person's words. */
  problem: z.string().max(300).nullable(),
  /** `waiting`: when the next pass tries. */
  nextTryAt: Timestamp.nullable(),
  /**
   * The sync is failing now: the second pass in a row (or more) couldn't finish. One alone is usually a blip, so only
   * this turns its line red.
   */
  failing: z.boolean(),
  /** A push found that the token can only read; pulling goes on. */
  readOnly: z.boolean(),
  /** A pass is running or asked for. */
  syncing: z.boolean(),
  notInVault: z.array(OnePasswordNotInVault).max(ONEPASSWORD_NOT_IN_VAULT_MAX),
  /** `paused`: what waits for the person. */
  removals: OnePasswordRemovals.nullable(),
});
export type OnePasswordSyncView = z.infer<typeof OnePasswordSyncView>;

/** Sync now: a pass soon, whatever the time since the last. */
export const OnePasswordSyncBody = z.object({});
export type OnePasswordSyncBody = z.infer<typeof OnePasswordSyncBody>;

/**
 * The answer to the guard: `remove` removes those entries here too; `keep` keeps them only in Whombat, never pushed
 * back (an item the person removed on purpose isn't revived).
 */
export const ONEPASSWORD_REMOVAL_ANSWERS = ['remove', 'keep'] as const;
export const OnePasswordRemovalAnswer = z.enum(ONEPASSWORD_REMOVAL_ANSWERS);
export type OnePasswordRemovalAnswer = z.infer<typeof OnePasswordRemovalAnswer>;

export const OnePasswordRemovalsBody = z.object({
  answer: OnePasswordRemovalAnswer,
  /** `OnePasswordRemovals.token` of the set shown. */
  token: z.string().min(1).max(100),
});
export type OnePasswordRemovalsBody = z.infer<typeof OnePasswordRemovalsBody>;

/**
 * Disconnecting 1Password: the entries it brought stay in the Vault as Whombat entries (`keep`, the default) or go
 * (`remove`). 1Password is never changed by it.
 */
export const ONEPASSWORD_DISCONNECT_CHOICES = ['keep', 'remove'] as const;
export const OnePasswordDisconnectChoice = z.enum(ONEPASSWORD_DISCONNECT_CHOICES);
export type OnePasswordDisconnectChoice = z.infer<typeof OnePasswordDisconnectChoice>;

/* What Whombat watches ---------------------------------------------------------------------------------- */

/** A check of What Whombat watches, as `KindCheck` takes it. */
export interface OnePasswordWatchCheck {
  readonly check: string;
  readonly name: string;
  readonly nature: NoticeNature;
  readonly perItem: boolean;
  readonly startsOn: boolean;
}

/**
 * The sync's checks. The guard's pause and an unreachable 1Password start on: the Vault stops following, and the
 * person can act (only they can: the assistant doesn't use this connection, so there is nothing to ask it). The limit
 * starts off: it ends by itself.
 */
export const ONEPASSWORD_WATCH_CHECKS = [
  {
    check: 'onepassword.paused',
    name: '1Password sync needs you',
    nature: 'you',
    perItem: false,
    startsOn: true,
  },
  {
    check: 'onepassword.unreachable',
    name: 'Whombat can’t reach 1Password',
    nature: 'you',
    perItem: false,
    startsOn: true,
  },
  {
    check: 'onepassword.limit',
    name: 'Waiting for 1Password’s limit',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
] as const satisfies readonly OnePasswordWatchCheck[];

/* Words ---------------------------------------------------------------------------------------------------- */

export const ONEPASSWORD_WORDS = {
  /** A synced entry's row. */
  tag: '1Password',
  syncNow: 'Sync now',
  notInVault: 'Not in your Vault',
  notChecked: 'Not checked yet',
  readOnly: 'This token can only read. Make one that can read and write the vault.',
  stopped: '1Password sync stopped unexpectedly',
  unreachable: 'Whombat can’t reach 1Password.',
  pending: 'Waiting to go to 1Password',
  removeHere: 'Remove them here too',
  keepHere: 'Keep them here',
  disconnectKeep: 'Keep the entries in your Vault',
  disconnectRemove: 'Remove them too',
  /** Said when removing a synced entry: the item isn't deleted there, only archived. */
  removeArchives: 'Its item in 1Password goes to 1Password’s archive.',
} as const;

/** Why an item isn't in the Vault, in the person's words. */
export function onePasswordSkipText(reason: OnePasswordSkipReason): string {
  return ONEPASSWORD_SKIP_TEXT[reason];
}

/** “12 logins and API tokens kept in step”. */
export function onePasswordKeptLine(kept: number): string {
  if (kept <= 0) return 'No logins or API tokens kept in step yet';
  if (kept === 1) return '1 login or API token kept in step';
  return `${kept} logins and API tokens kept in step`;
}

/** “Last checked 3 min ago”, or “Not checked yet”. */
export function onePasswordCheckedLine(checkedAt: string | null, now: DateInput, timeZone: string): string {
  return checkedAt === null
    ? ONEPASSWORD_WORDS.notChecked
    : `Last checked ${formatAgo(checkedAt, now, timeZone)}`;
}

/** The guard's card and line: “1Password says 4 items are gone”. */
export function onePasswordGoneTitle(count: number): string {
  return count === 1 ? '1Password says 1 item is gone' : `1Password says ${count} items are gone`;
}

/** The entries the guard holds, by name: “Bank”, “Bank and Mail”, “Bank, Mail and Shop”, “Bank, Mail, Shop and 2 more”. */
export function onePasswordHeldNames(names: readonly string[]): string {
  if (names.length > 3) return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The guard's Inbox card: which entries Whombat kept, and the two ways on. */
export function onePasswordRemovalsBody(names: readonly string[]): string {
  const them = names.length === 1 ? 'it' : 'them';
  return `Whombat kept ${onePasswordHeldNames(names)} in your Vault for now. Remove ${them} here too, or keep ${them} only in Whombat.`;
}

/** “Waiting for 1Password’s limit. Next try at 14:20.” */
export function onePasswordWaitingLine(nextTryAt: string, timeZone: string): string {
  return `Waiting for 1Password’s limit. Next try at ${formatClock(nextTryAt, timeZone)}.`;
}

/**
 * The page's lines about the last pass, below the counts: the waiting, failing or paused line, and the read-only
 * token's. Empty when all is well.
 */
export function onePasswordStatusLines(
  view: Pick<OnePasswordSyncView, 'outcome' | 'problem' | 'nextTryAt' | 'readOnly' | 'removals'>,
  timeZone: string,
): string[] {
  const lines: string[] = [];
  if (view.outcome === 'waiting' && view.nextTryAt !== null)
    lines.push(onePasswordWaitingLine(view.nextTryAt, timeZone));
  else if (view.outcome === 'failing') lines.push(view.problem ?? ONEPASSWORD_WORDS.unreachable);
  else if (view.outcome === 'paused' && view.removals)
    lines.push(onePasswordGoneTitle(view.removals.entries.length));
  if (view.readOnly) lines.push(ONEPASSWORD_WORDS.readOnly);
  return lines;
}

/** A synced entry's page: “Kept in step with 1Password · 2 min ago”, the waiting line, or the problem. */
export function onePasswordEntryLine(source: VaultEntrySource, now: DateInput, timeZone: string): string {
  if (source.state === 'problem') return source.problem ?? ONEPASSWORD_WORDS.unreachable;
  if (source.state === 'pending') return ONEPASSWORD_WORDS.pending;
  return source.syncedAt === null
    ? 'Kept in step with 1Password'
    : `Kept in step with 1Password · ${formatAgo(source.syncedAt, now, timeZone)}`;
}
