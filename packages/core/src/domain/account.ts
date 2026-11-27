import { z } from 'zod';
import { LocaleTag } from '../i18n/locale.js';
import { AccountId, BurrowId, PrincipalId } from '../ids.js';
import { Email, Timestamp } from './common.js';
import { AssistantPreferences } from './guides.js';
import { NotificationPreferences } from './notify.js';

/**
 * The person's account (Whombat one-person.md OP-01): the one person whose Whombat it is. `name` is empty until the
 * person tells us (the sign-up name step); `title` is optional ("Engineering lead"). The claim creates the account's
 * person with both.
 */
export const Account = z.object({
  id: AccountId,
  email: Email,
  name: z.string().max(80),
  /** Empty when not given. */
  title: z.string().max(80),
  createdAt: Timestamp,
});
export type Account = z.infer<typeof Account>;

/** The Whombat's burrow and the person's principal in it, for the post-login redirect. */
export const Membership = z.object({
  burrowId: BurrowId,
  burrowSlug: z.string(),
  burrowName: z.string(),
  principalId: PrincipalId,
});
export type Membership = z.infer<typeof Membership>;

export const ThemePreference = z.enum(['light', 'dark', 'system']);
export type ThemePreference = z.infer<typeof ThemePreference>;

/**
 * How the person's threads in Chat and Feedback settle by themselves (3.8; Whombat chat-settle.md). Absent =
 * {@link DEFAULT_CHAT_PREFERENCES}. Never a thread the assistant works on or one that waits for the person.
 */
export const ChatPreferences = z.object({
  /** Days without a message after which a thread settles by itself; null: never. */
  settleQuietDays: z.number().int().min(1).max(90).nullable(),
  /** A thread settles when the pull request its work opened merges or closes, after the person's last message in it. */
  settleMerged: z.boolean(),
});
export type ChatPreferences = z.infer<typeof ChatPreferences>;

export const DEFAULT_CHAT_PREFERENCES: ChatPreferences = { settleQuietDays: 3, settleMerged: true };

/** Per-user preferences (theme persists per user; first load follows `prefers-color-scheme`). */
export const Preferences = z.object({
  theme: ThemePreference,
  /** IANA zone for times; null = burrow zone / device zone. */
  timeZone: z.string().min(1).nullable(),
  /** BCP-47 locale for UI, server messages and the assistant (e.g. `en-GB`, `nl-NL`); absent/null = default English. */
  locale: LocaleTag.nullable().optional(),
  /**
   * The agent's occasional suggestions to this person (assistant-guides.md AG-12). Absent = the defaults
   * (`DEFAULT_ASSISTANT_PREFERENCES`); `me.updatePreferences` replaces it whole.
   */
  assistant: AssistantPreferences.optional(),
  /**
   * Do not disturb, quiet hours, email and thread replies (0.26, CT-175). Absent = the defaults
   * (`DEFAULT_NOTIFICATION_PREFERENCES`); `me.updatePreferences` replaces it whole.
   */
  notifications: NotificationPreferences.optional(),
  /** When threads settle by themselves (3.8). Absent = the defaults; `me.updatePreferences` replaces it whole. */
  chat: ChatPreferences.optional(),
});
export type Preferences = z.infer<typeof Preferences>;

/** True until the person has told us their name (the sign-up name step shows then). */
export function needsName(account: Pick<Account, 'name'>): boolean {
  return account.name.trim() === '';
}

export const DEFAULT_PREFERENCES: Preferences = { theme: 'system', timeZone: null };
