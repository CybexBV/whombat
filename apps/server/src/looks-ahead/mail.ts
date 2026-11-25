/**
 * Incoming mail as a Looks ahead source (docs/decisions/looks-ahead.md): reads the newest inbox mail of every active
 * Google, Microsoft 365 and Email (IMAP) mailbox at most every 15 minutes (unless `fresh`), up to
 * `AHEAD_MAIL_SWEEP_LIMIT` a mailbox so a busy day loses nothing, and leaves out the person's own mail and plain bulk mail
 * (`aheadMailNoise`) before any AI reads it. Which of the rest is checked is the triage pass's choice, or a matter's.
 */
import { AHEAD_MAIL_SWEEP_LIMIT, aheadMailNoise, type MailSummary } from '@whombat/core';
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

/** Provider-appropriate query for recent inbox messages. */
function inboxQuery(provider: 'google' | 'microsoft' | 'imap'): string {
  if (provider === 'google') return 'in:inbox newer_than:2d';
  if (provider === 'imap') return 'in:INBOX';
  return '';
}

async function recentInbox(
  services: Services,
  account: MailAccount,
  now: Date,
  fresh = false,
): Promise<MailSummary[]> {
  let kept = mailCache.get(services);
  if (!kept) {
    kept = new Map();
    mailCache.set(services, kept);
  }
  const held = kept.get(account.connectionId);
  if (!fresh && held && now.getTime() - held.at < MAIL_KEEP_MS) return held.items;
  const items = await withAccountToken(services, account.accountId, account.provider, (token) =>
    providerWorkspace(services, account.provider).mailSearch(token, {
      query: inboxQuery(account.provider),
      limit: AHEAD_MAIL_SWEEP_LIMIT,
    }),
  );
  kept.set(account.connectionId, { at: now.getTime(), items });
  return items;
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
}

/**
 * The newest inbox mail of the last 48 hours across all connected mailboxes, newest first, without the person's own
 * mail and plain bulk mail. A mailbox that can't be read is skipped this time.
 */
export async function sweepMail(
  services: Services,
  accounts: readonly MailAccount[],
  now: Date,
  fresh = false,
): Promise<SweptMail[]> {
  const ownAddresses = accounts.map((a) => a.email).filter(Boolean);
  const cutoff = now.getTime() - MAIL_MAX_AGE_MS;
  const out: SweptMail[] = [];
  const seen = new Set<string>();
  for (const account of accounts) {
    const items = await recentInbox(services, account, now, fresh).catch((err) => {
      services.log.warn(
        { err: String(err), connectionId: account.connectionId, provider: account.provider },
        'looks ahead: mail unread',
      );
      return [];
    });
    for (const m of items) {
      const key = mailEventKey(account.connectionId, m.id);
      if (seen.has(key)) continue;
      seen.add(key);
      const at = m.date ? Date.parse(m.date) : Number.NaN;
      if (Number.isFinite(at) && at < cutoff) continue;
      if (aheadMailNoise({ from: m.from, subject: m.subject, snippet: m.snippet, ownAddresses })) continue;
      out.push({
        key,
        version: mailVersion(m.id),
        start: Number.isFinite(at) ? new Date(at).toISOString() : now.toISOString(),
        account,
        message: m,
      });
    }
  }
  return out.sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
}
