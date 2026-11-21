/**
 * Notification email (docs/decisions/essentials-people.md EP-15; contracts CT-175): on a Whombat with SMTP (the
 * community edition, hermes-engine.md HE-56), what stayed unread for 30 minutes — direct messages, mentions, replies and needs-you items — goes out in one short
 * plain email per person, at most one an hour (`hourly`, the default) or one a day at 08:00 in their zone (`daily`),
 * never during Do not disturb or quiet hours, each item once. A box without SMTP has no mail: the capability is false
 * and the worker never starts.
 */
import {
  type BootstrapCapabilities,
  EMAIL_DAILY_AT,
  EMAIL_HOURLY_MS,
  EMAIL_UNREAD_AFTER_MS,
  isQuietNow,
  type LinkRef,
  linkPath,
  type NotificationKind,
  type NotificationPreferences,
  notificationPreferencesOf,
  zonedInstant,
  zonedParts,
} from '@whombat/core';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { webOrigin } from '../commands/burrows';
import { accounts, burrows, notifications, principals } from '../db/schema/index';
import { zoneOf } from '../domain/notify';
import type { PushSender } from '../push/sender';
import { shortName } from '../read/principals';
import type { Services } from '../services';
import type { BoxMail } from './box';
import { renderEmailHtml, sentBy } from './template';

/** Whether this Whombat can email notifications: a mail server, configured or the person's own (HE-56, HE-S225). */
export function emailNotificationsAvailable(mail: Pick<BoxMail, 'availableNow'>): boolean {
  return mail.availableNow();
}

/**
 * Whether browsers can get this box's own web push: a VAPID pair, configured or the community box's own (HE-56,
 * HE-S220; a commercial box tells browsers through control).
 */
export function webPushAvailable(push: Pick<PushSender, 'vapid'>): boolean {
  return push.vapid() !== null;
}

/** `Bootstrap.capabilities` (CT-175, CT-1307): Settings → Notifications shows only what works on this Whombat. */
export function notificationCapabilities(
  services: Pick<Services, 'boxMail' | 'push'>,
): BootstrapCapabilities {
  return {
    emailNotifications: emailNotificationsAvailable(services.boxMail),
    webPush: webPushAvailable(services.push),
  };
}

/** How far back the email looks: a day, so the daily email covers everything since the one before (EP-15). */
export const EMAIL_LOOKBACK_MS = 24 * 3600_000;
/** Items listed in one email; the rest are counted (“…and 3 more”). */
export const EMAIL_ITEMS_MAX = 10;
/** How often the worker looks. */
export const EMAIL_WORKER_MS = 5 * 60_000;

/**
 * Whether an email may go to this person now (EP-15): not `off`, not in Do not disturb or quiet hours, and an hour
 * since the last one (`hourly`) or, `daily`, at or after 08:00 in their zone with none since then.
 */
export function digestDue(input: {
  prefs: NotificationPreferences;
  now: Date;
  timeZone: string;
  lastEmailedAt: Date | null;
}): boolean {
  const { prefs, now, timeZone, lastEmailedAt } = input;
  if (prefs.email === 'off') return false;
  if (isQuietNow(prefs, now, timeZone)) return false;
  if (prefs.email === 'hourly')
    return !lastEmailedAt || now.getTime() - lastEmailedAt.getTime() >= EMAIL_HOURLY_MS;
  const at = zonedInstant(zonedParts(now, timeZone), EMAIL_DAILY_AT, timeZone);
  if (now.getTime() < at.getTime()) return false;
  return !lastEmailedAt || lastEmailedAt.getTime() < at.getTime();
}

export interface DigestItem {
  kind: NotificationKind;
  actorName: string;
  where: string;
  text: string;
  /** Absolute link to the item. */
  url: string;
  /** The item is in a direct conversation or a DM (“wrote to you”). */
  toYou: boolean;
}

/** One line saying what happened: “Joris mentioned you in #billing-v2”. */
export function digestLine(item: DigestItem): string {
  switch (item.kind) {
    case 'needs_you':
      return `Needs you · ${item.where}`;
    case 'mention':
      return `${item.actorName} mentioned you in ${item.where}`;
    case 'reply':
      return `${item.actorName} replied in ${item.where}`;
    case 'agent_update':
      return item.toYou ? `${item.actorName} wrote to you` : `${item.actorName} wrote in ${item.where}`;
  }
}

const quoteOf = (text: string) => {
  const one = text.replace(/\s+/g, ' ').trim();
  if (!one) return null;
  return `“${one.length > 160 ? `${one.slice(0, 159).trimEnd()}…` : one}”`;
};

/** The email (EP-15): plain, short, with a link per item and the way to change or stop it. */
export function renderDigest(input: {
  name: string;
  items: readonly DigestItem[];
  cadence: 'hourly' | 'daily';
  openUrl: string;
  settingsUrl: string;
}): { subject: string; text: string; html: string } {
  const listed = input.items.slice(0, EMAIL_ITEMS_MAX);
  const more = input.items.length - listed.length;
  const first = input.items[0];
  const subject =
    input.items.length === 1 && first
      ? digestLine(first)
      : `${input.items.length} things waiting for you in Whombat`;
  const lines = [`Hi ${input.name},`, '', 'While you were away:', ''];
  for (const item of listed) {
    lines.push(`· ${digestLine(item)}`);
    const quote = quoteOf(item.text);
    if (quote) lines.push(`  ${quote}`);
    lines.push(`  ${item.url}`, '');
  }
  if (more > 0) lines.push(`…and ${more} more in your inbox.`, '');
  lines.push(
    `Open Whombat: ${input.openUrl}`,
    '',
    `You get this ${input.cadence === 'daily' ? 'once a day' : 'at most once an hour'} when something waits for you. Change it or turn it off in Settings → Notifications:`,
    input.settingsUrl,
    '',
  );
  const cadence = input.cadence === 'daily' ? 'once a day' : 'at most once an hour';
  const html = renderEmailHtml({
    label: 'Notifications',
    preheader: first ? digestLine(first) : undefined,
    title:
      input.items.length === 1
        ? 'Something is waiting for you'
        : `${input.items.length} things are waiting for you`,
    blocks: [
      `Hi ${input.name}, while you were away:`,
      { items: listed.map((i) => ({ title: digestLine(i), quote: quoteOf(i.text), href: i.url })) },
      ...(more > 0 ? [{ note: `…and ${more} more in your inbox.` }] : []),
      { button: { href: input.openUrl, label: 'Open Whombat' } },
    ],
    footer: [
      {
        text: `You get this ${cadence} when something waits for you.`,
        link: { href: input.settingsUrl, label: 'Change it or turn it off in Settings → Notifications' },
      },
    ],
    sender: sentBy(input.openUrl),
  });
  return { subject, text: lines.join('\n'), html };
}

interface Candidate {
  id: string;
  kind: NotificationKind;
  where: string;
  text: string;
  link: LinkRef;
  actorId: string;
  accountId: string;
  burrowSlug: string;
  burrowZone: string;
}

/** The worker: every few minutes, one email per person who is due and has items (EP-15). */
export class EmailDigest {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    private readonly services: Services,
    private readonly everyMs = EMAIL_WORKER_MS,
  ) {}

  start(): void {
    // Always ticking: the person may set a mail server later (HE-S225); each pass checks there is one.
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.runOnce()
        .catch((err) => this.services.log.warn({ err: String(err) }, 'notification email failed'))
        .finally(() => {
          this.running = null;
        });
    }, this.everyMs);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass (tests call it with a fake clock). Returns how many emails and items went out. */
  async runOnce(now: Date = this.services.clock()): Promise<{ emails: number; items: number }> {
    if (!(await this.services.boxMail.available())) return { emails: 0, items: 0 };
    const candidates = await this.candidates(now);
    const byAccount = new Map<string, Candidate[]>();
    for (const c of candidates) byAccount.set(c.accountId, [...(byAccount.get(c.accountId) ?? []), c]);
    let emails = 0;
    let items = 0;
    for (const [accountId, list] of byAccount) {
      const sent = await this.emailAccount(accountId, list, now);
      if (sent > 0) {
        emails += 1;
        items += sent;
      }
    }
    return { emails, items };
  }

  /** Unread rows old enough, not emailed, still meaningful (EP-15). */
  private async candidates(now: Date): Promise<Candidate[]> {
    const db = this.services.db;
    const rows = await db
      .select({
        id: notifications.id,
        kind: notifications.kind,
        where: notifications.where,
        text: notifications.text,
        link: notifications.link,
        actorId: notifications.actorId,
        accountId: principals.accountId,
        burrowSlug: burrows.slug,
        burrowZone: burrows.timeZone,
      })
      .from(notifications)
      .innerJoin(principals, eq(principals.id, notifications.principalId))
      .innerJoin(burrows, eq(burrows.id, notifications.burrowId))
      .where(
        and(
          isNull(notifications.readAt),
          isNull(notifications.emailedAt),
          lte(notifications.createdAt, new Date(now.getTime() - EMAIL_UNREAD_AFTER_MS)),
          gt(notifications.createdAt, new Date(now.getTime() - EMAIL_LOOKBACK_MS)),
          isNotNull(principals.accountId),
          // Mentions, replies and needs-you items; the agent's message only from the person's own room.
          or(
            inArray(notifications.kind, ['mention', 'reply', 'needs_you']),
            and(
              eq(notifications.kind, 'agent_update'),
              sql`(${notifications.link}->>'type' = 'dm' or ${notifications.link}->'in'->>'type' = 'dm')`,
            ),
          ),
          // A request someone decided meanwhile waits for nobody.
          or(
            isNull(notifications.approvalId),
            sql`exists (select 1 from approvals a where a.id = ${notifications.approvalId} and a.state = 'pending')`,
          ),
          // A message still there (not deleted, essentials-conversations.md EC-02) that they haven't read there.
          or(
            isNull(notifications.messageId),
            sql`exists (
              select 1 from messages m
                left join read_states rs
                  on rs.conversation_id = m.conversation_id and rs.principal_id = ${notifications.principalId}
               where m.id = ${notifications.messageId}
                 and m.deleted_at is null
                 and (m.thread_root_id is not null or rs.last_read_ord is null or rs.last_read_ord < m.ord))`,
          ),
        ),
      )
      .orderBy(asc(notifications.createdAt))
      .limit(2000);
    return rows.map((r) => ({ ...r, accountId: r.accountId as string }));
  }

  private async emailAccount(accountId: string, list: readonly Candidate[], now: Date): Promise<number> {
    const services = this.services;
    const [account] = await services.db.select().from(accounts).where(eq(accounts.id, accountId));
    const first = list[0];
    if (!account || !first) return 0;
    const prefs = notificationPreferencesOf(account.preferences);
    const timeZone = zoneOf(account.preferences.timeZone, first.burrowZone);
    const due = (last: Date | null) => digestDue({ prefs, now, timeZone, lastEmailedAt: last });
    if (!due(account.notificationsEmailedAt)) return 0;
    // Claim the rows and the hour together: a second process (or a second pass) sends none of them again.
    const claimed = await services.pipeline.transactAccount(async (tx) => {
      const [locked] = await tx
        .select({ last: accounts.notificationsEmailedAt })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .for('update');
      if (!locked || !due(locked.last)) return [] as string[];
      const rows = await tx
        .update(notifications)
        .set({ emailedAt: now })
        .where(
          and(
            inArray(
              notifications.id,
              list.map((c) => c.id),
            ),
            isNull(notifications.emailedAt),
            isNull(notifications.readAt),
          ),
        )
        .returning({ id: notifications.id });
      if (rows.length)
        await tx.update(accounts).set({ notificationsEmailedAt: now }).where(eq(accounts.id, accountId));
      return rows.map((r) => r.id);
    });
    if (claimed.length === 0) return 0;
    const chosen = list.filter((c) => claimed.includes(c.id));
    const actors = await services.db
      .select()
      .from(principals)
      .where(inArray(principals.id, [...new Set(chosen.map((c) => c.actorId))]));
    const actorName = (id: string) => {
      const row = actors.find((a) => a.id === id);
      return row ? shortName(row) : 'Someone';
    };
    const origin = webOrigin(services);
    const items: DigestItem[] = chosen.map((c) => {
      const inType = c.link.type === 'message' ? c.link.in.type : c.link.type;
      return {
        kind: c.kind,
        actorName: actorName(c.actorId),
        where: c.where,
        text: c.text,
        url: `${origin}${linkPath(c.burrowSlug, c.link)}`,
        toYou: inType === 'dm',
      };
    });
    const name = (account.name || account.email.split('@')[0] || 'there').split(/\s+/)[0] ?? 'there';
    const { subject, text, html } = renderDigest({
      name,
      items,
      cadence: prefs.email === 'daily' ? 'daily' : 'hourly',
      openUrl: `${origin}/${first.burrowSlug}`,
      settingsUrl: `${origin}/${first.burrowSlug}/settings?tab=notifications`,
    });
    await services.mailer.send({ to: account.email, subject, text, html });
    return claimed.length;
  }
}

const digests = new WeakMap<Services, EmailDigest>();

/** The service container's email worker (started by the server's boot, never in a read-only start). */
export function emailDigestFor(services: Services): EmailDigest {
  let d = digests.get(services);
  if (!d) {
    d = new EmailDigest(services);
    digests.set(services, d);
  }
  return d;
}
