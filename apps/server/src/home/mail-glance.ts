/**
 * A person's accounts on Home and in the sidebar's Connections (one-whombat-assistant.md ONE-DW29; connections-more-mail.md
 * CM-M12; accounts.md): their Google or Microsoft 365 account, whatever it brings, and their Email (IMAP) account, each a
 * connection like any other, by the account's name. One with mail says how many unread mails are in its inbox. The health poller counts them every 5 minutes with the person's own connection, one cheap call each (the
 * inbox's own unread count: Gmail's INBOX label, Graph's inbox folder, IMAP's STATUS UNSEEN; nothing is opened) and
 * keeps the count in memory — the connector rows have no glance column, and a count after a restart is one poll away.
 * Only its person sees it (PA-09).
 *
 * Its lines (quiet-notices.md QN-01, QN-03; QN-S12): signed out is only you (`conn.signin`, the reason on its card and
 * the desk), a count that failed is a heads-up (`mail.count`): its dot stays as it was. Both can be ignored on the desk.
 */
import { type ThingSummary, thingHref, thingId } from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { connections } from '../db/schema/index';
import type { PrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { accountUnreadCount } from '../things/accounts/reads';
import { withNotice } from '../things/quiet/connection';
import { registerChecks } from '../things/quiet/defaults';
import { glanceLine, verdict } from '../things/quiet/glance';
import { NO_QUIET, type QuietBook } from '../things/quiet/store';
import type { KindCheck, KindNotice } from '../things/quiet/types';

/** Past this many unread a count says “50+”: a number that big says only “a lot”. */
const COUNT_MAX = 50;

/** An unread count as Home and the screens say it: “3”, “50+”. */
export const unreadCountWords = (count: number) => (count >= COUNT_MAX ? `${COUNT_MAX}+` : String(count));

/** The providers whose inbox Home counts. */
export const COUNTED = ['google', 'microsoft', 'imap'] as const;

interface MailGlance {
  unread: number;
  at: Date;
  problem: boolean;
}

const glances = new WeakMap<Services, Map<string, MailGlance>>();

function glancesOf(services: Services): Map<string, MailGlance> {
  let m = glances.get(services);
  if (!m) {
    m = new Map();
    glances.set(services, m);
  }
  return m;
}

/** Counts unread inbox mail of every active Google, Microsoft and IMAP connection with mail (`home.connection-health`). */
export async function pollMailGlances(services: Services, now = services.clock()): Promise<number> {
  const providers = COUNTED.filter((p) => p !== 'google' || services.google.mode !== 'off');
  if (providers.length === 0) return 0;
  const rows = await services.db
    .select()
    .from(connections)
    .where(and(inArray(connections.provider, providers), eq(connections.status, 'active')));
  let counted = 0;
  for (const row of rows) {
    if (!row.services.includes('mail')) continue;
    try {
      const unread = await accountUnreadCount(services, row.accountId, row);
      glancesOf(services).set(row.id, { unread, at: now, problem: false });
      counted++;
    } catch {
      const before = glancesOf(services).get(row.id);
      glancesOf(services).set(row.id, { unread: before?.unread ?? 0, at: now, problem: true });
    }
  }
  return counted;
}

/** The health pass's last count of a mail connection: when, how many, whether it failed; null before the first. */
export function lastMailCount(services: Services, connectionId: string): Readonly<MailGlance> | null {
  return glancesOf(services).get(connectionId) ?? null;
}

/** Whether the last count of a mail connection failed (its `mail.count` line). */
export function mailCountFailed(services: Services, connectionId: string): boolean {
  return glancesOf(services).get(connectionId)?.problem ?? false;
}

/** What Whombat watches on a mail account (QN-15). */
export const MAIL_CHECKS: readonly KindCheck[] = [
  {
    check: 'conn.signin',
    name: 'Whether it’s still signed in',
    nature: 'you',
    perItem: false,
    startsOn: true,
  },
  { check: 'mail.count', name: 'Counting unread mail', nature: 'fyi', perItem: false, startsOn: false },
];
registerChecks(MAIL_CHECKS);

/**
 * Where an account's thing opened before it had a page: its page on the Connections tab (web and phone read
 * `connection=`). An app too old for account pages still gets it (`things/older-apps.ts`).
 */
export function mailThingHref(provider: (typeof COUNTED)[number] | 'github'): string {
  return `/settings?tab=connections&connection=${provider}`;
}

/** An account as the person knows it: “Google”, “Microsoft 365”, “Email”. */
export function accountName(provider: (typeof COUNTED)[number]): string {
  return provider === 'imap' ? 'Email' : provider === 'microsoft' ? 'Microsoft 365' : 'Google';
}

/** An account shows as a connection: Google and Microsoft 365 whatever they bring, Email (IMAP) for its mail. */
export function isAccountThing(row: Pick<typeof connections.$inferSelect, 'provider' | 'services'>): boolean {
  return row.provider === 'google' || row.provider === 'microsoft' || row.services.includes('mail');
}

/** A mail account's lines (QN-S12): signed out (only you), or its count failed (a heads-up). */
export function mailLines(
  row: Pick<typeof connections.$inferSelect, 'provider' | 'status'>,
  problem: boolean,
): KindNotice[] {
  const imap = row.provider === 'imap';
  const name = accountName(row.provider as (typeof COUNTED)[number]);
  if (row.status !== 'active')
    return [
      {
        id: 'reconnect',
        tone: 'bad',
        icon: 'key',
        title: imap ? 'Email needs a new password' : `${name} needs you to sign in again`,
        nature: 'you',
        check: 'conn.signin',
        ignore: { lifts: 'fixed', words: 'Until you sign in again.' },
        badge: imap ? 'Needs a new password' : 'Needs you to sign in again',
      },
    ];
  if (problem)
    return [
      {
        id: 'count',
        tone: 'warn',
        icon: 'warn',
        title: 'Whombat couldn’t count the unread mail just now',
        nature: 'fyi',
        check: 'mail.count',
        ignore: { lifts: 'fixed', words: 'Until it can count again.' },
      },
    ];
  return [];
}

/** The viewer's accounts as things (their own only), their dot with what is quiet now (QN-14). */
export async function mailThings(
  services: Services,
  db: Db,
  viewer: PrincipalRow,
  quiet: { book: QuietBook; now: Date } = { book: { of: () => NO_QUIET }, now: new Date() },
): Promise<ThingSummary[]> {
  if (!viewer.accountId) return [];
  const rows = await db
    .select()
    .from(connections)
    .where(and(eq(connections.accountId, viewer.accountId), inArray(connections.provider, [...COUNTED])));
  return rows.filter(isAccountThing).map((r) => {
    const provider = r.provider;
    const glance = r.services.includes('mail') ? glancesOf(services).get(r.id) : undefined;
    const id = thingId('connection', r.id);
    const base = {
      id,
      kind: 'connection' as const,
      catalogId: provider,
      name: accountName(provider),
      // Google's mark, Microsoft's, Email (IMAP)'s (marks.md MK-02, CM-28); a client without it draws the envelope.
      icon: provider,
      // Its own page (`things/accounts/`).
      href: thingHref('connection', r.id),
    };
    const v = verdict(
      mailLines(r, glance?.problem ?? false).map((l) => glanceLine(l)),
      quiet.book.of(id),
      quiet.now,
    );
    if (r.status !== 'active')
      return withNotice(
        {
          ...base,
          status: v.status,
          line: provider === 'imap' ? 'Needs a new password' : 'Needs you to sign in again',
          ...(v.reason ? { reason: v.reason } : {}),
          facts: [],
        },
        v.notice,
      );
    // Without mail there is nothing to count: signed in is all it says.
    if (!r.services.includes('mail'))
      return { ...base, status: 'ok' as const, line: r.email.slice(0, 160), facts: [] };
    if (!glance) return { ...base, status: 'unknown' as const, line: r.email.slice(0, 160), facts: [] };
    const value = unreadCountWords(glance.unread);
    return {
      ...base,
      status: 'ok' as const,
      line: `${value} unread · ${r.email}`.slice(0, 160),
      facts: [{ label: 'Unread', value }],
    };
  });
}
