/**
 * Incoming mail as a Looks ahead source (docs/decisions/looks-ahead.md): reads the newest inbox mail of every active
 * Google, Microsoft 365 and Email (IMAP) mailbox at most every 15 minutes (unless `fresh`), up to
 * `AHEAD_MAIL_SWEEP_LIMIT` a mailbox so a busy day loses nothing, and leaves out the person's own mail before any AI reads
 * it. Plain bulk mail is marked (`aheadMailBulk`): a look through new mail leaves it out, while it may still be news on a
 * thing the person asked to keep an eye on. Which of the rest is checked is the triage pass's choice, or a matter's.
 */
import {
  AHEAD_MAIL_SWEEP_LIMIT,
  aheadMailBulk,
  aheadMailOwn,
  type MailSummary,
  mailFromAddress,
} from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import { providerMode, providerWorkspace } from '../connectors/providers';
import type { Db, Tx } from '../db/client';
import { connections } from '../db/schema/index';
import type { Services } from '../services';
import { withAccountToken } from '../things/accounts/reads';

export interface MailAccount {
  connectionId: string;
  accountId: string;
  provider: 'google' | 'microsoft' | 'imap';
  email: string;
}

/** How long recent inbox headers are kept between watcher passes. */
const MAIL_KEEP_MS = 15 * 60_000;
/** Only mail received in the last 48 hours: the longest a triage pass looks back. */
const MAIL_MAX_AGE_MS = 48 * 3600_000;

const mailCache = new WeakMap<Services, Map<string, { at: number; items: MailSummary[] }>>();

/** Every active mail account of the person's (Google, Microsoft 365, Email/IMAP). */
export async function mailAccounts(
  services: Services,
  db: Db | Tx,
  accountId: string,
): Promise<MailAccount[]> {
  const rows = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.accountId, accountId),
        inArray(connections.provider, ['google', 'microsoft', 'imap']),
      ),
    );
  return rows.flatMap((r) => {
    if (r.status !== 'active' || !r.services.includes('mail')) return [];
    const provider = r.provider as 'google' | 'microsoft' | 'imap';
    if (providerMode(services, provider) === 'off') return [];
    return [{ connectionId: r.id, accountId, provider, email: r.email }];
  });
}

/** Stable eventKey for one email in `ahead_checks`. */
export function mailEventKey(connectionId: string, messageId: string): string {
  return `mail:${connectionId}:${messageId}`;
}

/** Stable 8-char FNV-1a version hash for a message id. */
export function mailVersion(messageId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < messageId.length; i++) {
    hash ^= messageId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Provider-appropriate query for recent inbox messages (Microsoft reads its Inbox folder for `in:inbox`). */
function inboxQuery(provider: 'google' | 'microsoft' | 'imap'): string {
  if (provider === 'google') return 'in:inbox newer_than:2d';
  if (provider === 'imap') return 'in:INBOX';
  return 'in:inbox';
}

/** The newest inbox mail of one mailbox and when it was read (a kept read can be up to 15 minutes old). */
async function recentInbox(
  services: Services,
  account: MailAccount,
  now: Date,
  fresh = false,
): Promise<{ at: number; items: MailSummary[] }> {
  let kept = mailCache.get(services);
  if (!kept) {
    kept = new Map();
    mailCache.set(services, kept);
  }
  const held = kept.get(account.connectionId);
  if (!fresh && held && now.getTime() - held.at < MAIL_KEEP_MS) return held;
  const items = await withAccountToken(services, account.accountId, account.provider, (token) =>
    providerWorkspace(services, account.provider).mailSearch(token, {
      query: inboxQuery(account.provider),
      limit: AHEAD_MAIL_SWEEP_LIMIT,
    }),
  );
  const read = { at: now.getTime(), items };
  kept.set(account.connectionId, read);
  return read;
}

/** One new inbox mail the watcher may hand to a triage pass, a matter or a check. */
export interface SweptMail {
  /** `mail:<connection>:<message>`. */
  key: string;
  /** Once-only version of the mail (`mailVersion`). */
  version: string;
  /** When it came (ISO). */
  start: string;
  account: MailAccount;
  message: MailSummary;
  /**
   * The sender's address, read from the whole From line when it came (`mailFromAddress`), or null when it has none for
   * sure: what a matter is matched and opened by, never a cut-down copy of the line.
   */
  address: string | null;
  /** Plain bulk mail (`aheadMailBulk`): never in a look through new mail. */
  bulk: boolean;
}

/** What one sweep found, and when the inboxes it used were read. */
export interface Sweep {
  mails: SweptMail[];
  /** The oldest read among the mailboxes it used: mail that came later isn't in it yet. */
  readAt: Date;
  /** A mailbox couldn't be read this time: its mail since `readAt` may be missing. */
  partial: boolean;
}

/**
 * The newest inbox mail of the last 48 hours across all connected mailboxes, newest first, without the person's own
 * mail, bulk mail marked. A mailbox that can't be read is skipped this time (`partial`).
 */
export async function sweepMail(
  services: Services,
  accounts: readonly MailAccount[],
  now: Date,
  fresh = false,
): Promise<Sweep> {
  const ownAddresses = accounts.map((a) => a.email).filter(Boolean);
  const cutoff = now.getTime() - MAIL_MAX_AGE_MS;
  const out: SweptMail[] = [];
  const seen = new Set<string>();
  let readAt = now.getTime();
  let partial = false;
  for (const account of accounts) {
    const read = await recentInbox(services, account, now, fresh).catch((err) => {
      services.log.warn(
        { err: String(err), connectionId: account.connectionId, provider: account.provider },
        'looks ahead: mail unread',
      );
      return null;
    });
    if (!read) {
      partial = true;
      continue;
    }
    readAt = Math.min(readAt, read.at);
    for (const m of read.items) {
      const key = mailEventKey(account.connectionId, m.id);
      if (seen.has(key)) continue;
      seen.add(key);
      const at = m.date ? Date.parse(m.date) : Number.NaN;
      if (Number.isFinite(at) && at < cutoff) continue;
      if (aheadMailOwn({ from: m.from, ownAddresses })) continue;
      out.push({
        key,
        version: mailVersion(m.id),
        start: Number.isFinite(at) ? new Date(at).toISOString() : now.toISOString(),
        account,
        message: m,
        address: mailFromAddress(m.from),
        bulk: aheadMailBulk({ subject: m.subject, snippet: m.snippet }),
      });
    }
  }
  return {
    mails: out.sort((a, b) => Date.parse(b.start) - Date.parse(a.start)),
    readAt: new Date(readAt),
    partial,
  };
}
