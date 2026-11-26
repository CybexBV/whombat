/**
 * Looks ahead's commands (docs/decisions/looks-ahead.md), all through the commit pipeline: a check, a follow-up of a
 * matter or a triage pass begins (a quiet turn of the assistant's, in a thread that is there only once it finds
 * something), a check reports (a finding is posted in its event's or matter's thread with a push and optional one-tap
 * action chip; nothing leaves no trace, though an optional factual note stays for later stages, and a mail check may
 * open, update or close a matter), the person's word on a finding (with optional reason), the watcher's bookkeeping
 * (failed checks, threads that passed, old rows, matters without news), and the setting (switch, calendars, incoming
 * mail, standing rules, stopped kinds, matters). The triage pass's end and `ahead_watch`'s commands live beside the
 * pass and the matters (`triage.ts`, `matters.ts`).
 */
import {
  AHEAD_ACTION_MAX,
  AHEAD_CHECKS_PER_DAY,
  AHEAD_FEEDBACK_REASON_MAX,
  AHEAD_FINDINGS_PER_DAY,
  AHEAD_KINDS,
  AHEAD_MATTER_KEEP_AFTER_DUE_MS,
  AHEAD_MATTER_KEEP_MS,
  AHEAD_MATTER_TITLE_MAX,
  AHEAD_MATTER_WHO_MAX,
  AHEAD_MATTERS_MAX,
  AHEAD_MATTERS_OPENED_PER_DAY,
  AHEAD_NOTE_MAX,
  AHEAD_REPLIES,
  AHEAD_RULES_MAX,
  AHEAD_SOURCES_MAX,
  AHEAD_TITLE_MAX,
  AHEAD_TRIAGE_GAP_MS,
  AHEAD_TRIAGE_MAIL_MAX,
  AHEAD_TRIAGE_PER_DAY,
  AheadCheckId,
  type AheadKind,
  AheadMailContext,
  AheadMatterReason,
  AheadNamedSource,
  AheadReportInput,
  AheadScheduleEntry,
  AheadStage,
  AheadTriggerSource,
  aheadHours,
  aheadMatterExpired,
  LooksAheadUpdate,
  needsYouItemHref,
  newId,
} from '@whombat/core';
import { and, desc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { settleResolvedThreads } from '../chats/settle';
import { applyContext } from '../commit/pipeline';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import type { Tx } from '../db/client';
import {
  type AheadCheckRow,
  type AheadMatterRow,
  aheadChecks,
  aheadMatters,
  dispatches,
  looksAheadSettings,
  messages,
  needsYouSnoozes,
  notifications,
} from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { publishNotificationsRead } from '../domain/notification-read';
import { notifyInCommit } from '../domain/notify';
import { ensurePersonalDm } from '../domain/personal-dm';
import { GENERIC_PUSH_TITLE } from '../domain/push-preview';
import { isThePerson } from '../domain/the-person';
import { wakeQuietly } from '../domain/wake';
import { publishHomeChanged } from '../home/notify';
import { startOfLocalDay } from '../home/time';
import { forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadPrincipalRow, toActor } from '../read/principals';
import { dropSessions, endedAheadSessions } from '../runtime/sessions';
import { type AheadSettings, calendarKey } from './calendars';
import {
  closeMatterIn,
  matterDueAt,
  matterForUpdate,
  mattersOpenedByChecks,
  matterThreadRoot,
  senderAddress,
  startAheadMatter,
  stopAheadMatter,
} from './matters';
import { aheadSettingsOf, checkOfTurn, cleanShortLabel, findingsSince, findingWords } from './store';
import { TRIAGE_ONLY, triageAhead } from './triage';

export { aheadSettingsOf, cleanShortLabel, findingsSince, findingWords };

/** A check whose turn never ran this long after it began failed (no runner took it). */
export const CHECKING_MAX_MS = 2 * 3600_000;
/** A finding's thread settles this long after its event ended (or 48 h after posting for a mail finding). */
export const SETTLE_AFTER_MS = 2 * 3600_000;
/** Mail findings settle this long after posting when the person didn't reply. */
export const MAIL_SETTLE_AFTER_MS = 48 * 3600_000;
/** Checks are kept this long after their event, for the week's count and so a version isn't checked twice. */
export const CHECKS_KEEP_MS = 30 * 24 * 3600_000;
/** Closed matters are kept this long, then removed. */
export const MATTERS_CLOSED_KEEP_MS = 30 * 24 * 3600_000;

export const NOT_AN_AHEAD_CHECK =
  'This only works while Whombat has you check ahead. Answer in the conversation instead.';
export const NOT_AN_AHEAD_THREAD =
  'ahead_feedback only works in the thread of something you told the person after checking ahead.';

async function saveSettings(ctx: ApplyContext, next: AheadSettings): Promise<void> {
  const values = {
    on: next.on,
    mailOn: next.mailOn,
    calendarsOff: [...next.calendarsOff],
    calendarsOn: [...next.calendarsOn],
    rules: next.rules.slice(0, AHEAD_RULES_MAX),
    stopped: AHEAD_KINDS.filter((k) => next.stopped.includes(k)),
    updatedAt: ctx.now,
  };
  await ctx.tx
    .insert(looksAheadSettings)
    .values({ burrowId: ctx.burrow.id, ...values })
    .onConflictDoUpdate({ target: looksAheadSettings.burrowId, set: values });
}

/* Beginning a check -------------------------------------------------------------------------------------------------- */

/** One mail of a triage pass as its row keeps it (`TriageMail`). */
const TriageMailInput = z.object({
  ref: z.string().min(2).max(8),
  connectionId: z.string().min(1).max(64),
  provider: z.enum(['google', 'microsoft', 'imap']),
  account: z.string().max(120),
  messageId: z.string().min(1).max(1024),
  threadId: z.string().max(200),
  from: z.string().max(320),
  subject: z.string().max(300),
  date: z.string().max(64),
  snippet: z.string().max(600),
  unread: z.boolean().optional(),
  address: z.string().max(254).optional(),
});

export const AheadEventInput = z.object({
  source: AheadTriggerSource.default('calendar'),
  stage: AheadStage.default('eve'),
  key: z.string().min(1).max(3200),
  /** Stage-qualified version hash (`aheadStageVersion`). */
  version: z.string().min(1).max(32),
  /** Where a calendar event is read again before a finding is told, or the mailbox of a mail check; empty otherwise. */
  connectionId: z.string().max(64),
  calendarId: z.string().max(1024).default(''),
  eventId: z.string().max(1024),
  /** Its guests' names and addresses: never search words. */
  guests: z.array(z.string().max(320)).max(100).default([]),
  summary: z.string().max(300),
  location: z.string().max(500),
  description: z.string().max(2000),
  calendar: z.string().max(120),
  start: z.string().max(40),
  end: z.string().max(40),
  timeZone: z.string().max(64),
  allDay: z.boolean().optional(),
  /** Same-day accepted schedule (calendar) or next 14 days (mail, follow-up, triage). */
  daySchedule: z.array(AheadScheduleEntry).max(30).optional(),
  /**
   * Incoming mail payload when `source === 'mail'`, with the thread a matter is matched by and the sender's address read
   * from the whole From line.
   */
  mail: AheadMailContext.extend({
    threadId: z.string().max(200).optional(),
    address: z.string().max(254).optional(),
  }).optional(),
  /** The matter a mail check is about (a mail that matched it, or a triage pick that named it). */
  matterId: z.string().min(1).max(64).optional(),
  /** The mail really matches that matter (not only a triage pass's say-so). */
  matterMatched: z.boolean().optional(),
  /** A follow-up: the matter and why it is followed up now. */
  matter: z.object({ id: z.string().min(1).max(64), reason: AheadMatterReason }).optional(),
  /** A triage pass: what it covers, the mails it lists and the matters it is shown (`k1`… → id). */
  triage: z
    .object({
      since: z.string().max(40),
      /** When the inboxes it lists were read: the next pass covers mail from here (less an overlap). */
      sweptAt: z.string().max(40).optional(),
      count: z.number().int().min(0),
      mails: z.array(TriageMailInput).max(AHEAD_TRIAGE_MAIL_MAX),
      matters: z
        .array(z.object({ ref: z.string().max(8), id: z.string().min(1).max(64) }))
        .max(AHEAD_MATTERS_MAX),
    })
    .optional(),
});
export type AheadEventInput = z.infer<typeof AheadEventInput>;

/** Safe timestamp for `startAt`/`endAt` (handles all-day `YYYY-MM-DD` dates cleanly). */
function parseTime(raw: string, fallback: Date): Date {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) ? new Date(`${raw.trim()}T00:00:00Z`) : new Date(raw);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

/** Rows begun since `since`: the checks (triage passes left out), or only the triage passes. */
async function begunSince(tx: Pick<Tx, 'select'>, burrowId: string, since: Date, triage: boolean) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(aheadChecks)
    .where(
      and(
        eq(aheadChecks.burrowId, burrowId),
        gte(aheadChecks.startedAt, since),
        triage ? eq(aheadChecks.source, 'triage') : ne(aheadChecks.source, 'triage'),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Begins one check, follow-up or triage pass: the row, and the assistant's quiet turn about it on the background model,
 * for the person, in the person's Chat, in a thread of its own whose first message (its id held by the row) is posted
 * only when it finds something. Everything that isn't a calendar check starts with `mailReadAt` set, so the web is
 * closed for good. A follow-up marks its reason as followed up, so it runs once.
 */
export const startAheadCheck = defineCommand({
  name: 'ahead.check_start',
  // A new turn: a lapsed appliance refuses it up front (LC-10).
  licence: 'agentTurn',
  schema: z.object({
    event: AheadEventInput,
    personId: z.string().min(1).max(64),
    /** “Check now”: a triage pass needn't wait for the gap since the last one. */
    fresh: z.boolean().optional(),
  }),
  async apply(tx, ctx, input): Promise<{ checkId: string; dispatchId: string } | null> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the assistant checks ahead.');
    const { event } = input;
    // Never two checks of one version+stage, nor one while another works.
    const [same] = await tx
      .select({ id: aheadChecks.id })
      .from(aheadChecks)
      .where(
        and(
          eq(aheadChecks.burrowId, ctx.burrow.id),
          sql`(${aheadChecks.state} = 'checking' or (${aheadChecks.eventKey} = ${event.key} and ${aheadChecks.version} = ${event.version}))`,
        ),
      )
      .limit(1);
    if (same) return null;
    // Switched off, or the day's checks (or triage passes) used, since the watcher read it.
    const settings = await aheadSettingsOf(tx, ctx.burrow.id);
    if (!settings.on) return null;
    if (event.source !== 'calendar' && !settings.mailOn) return null;
    const triage = event.source === 'triage';
    if (triage && !event.triage) return null;
    const dayStart = startOfLocalDay(ctx.now, ctx.burrow.timeZone);
    const begun = await begunSince(tx, ctx.burrow.id, dayStart, triage);
    if (begun >= (triage ? AHEAD_TRIAGE_PER_DAY : AHEAD_CHECKS_PER_DAY)) return null;
    // Two watcher passes that read the rows at once can't start two triage passes minutes apart: the gap since the last
    // pass that didn't fail holds here too, unless the person pressed “Check now”.
    if (triage && !input.fresh) {
      const [recent] = await tx
        .select({ id: aheadChecks.id })
        .from(aheadChecks)
        .where(
          and(
            eq(aheadChecks.burrowId, ctx.burrow.id),
            eq(aheadChecks.source, 'triage'),
            ne(aheadChecks.state, 'failed'),
            gt(aheadChecks.startedAt, new Date(ctx.now.getTime() - AHEAD_TRIAGE_GAP_MS)),
          ),
        )
        .limit(1);
      if (recent) return null;
    }
    // The matter it is about must still be open; a follow-up runs once per reason (marked when it reports).
    let matterId: string | null = null;
    const aboutId = event.source === 'matter' ? event.matter?.id : event.matterId;
    if (aboutId) {
      const matter = await matterForUpdate(tx, ctx.burrow.id, aboutId);
      if (matter?.state === 'open') matterId = matter.id;
      if (event.source === 'matter') {
        const reason = event.matter?.reason;
        if (!matter || !matterId || !reason || matter.followedUp.includes(reason)) return null;
      }
    } else if (event.source === 'matter') return null;
    const agent = await loadPrincipalRow(tx, ctx.actor.id);
    const person = await loadPrincipalRow(tx, input.personId);
    if (!agent || person?.kind !== 'person' || person.burrowId !== ctx.burrow.id || !person.accountId)
      return null;
    const chatId = await ensurePersonalDm(ctx, agent, person);
    const id = newId('aheadCheck');
    // Unique message id reserved for this check's finding (either new thread root or reply in existing event thread).
    const threadRootId = newId('message');
    const woken = await wakeQuietly(ctx, {
      agentId: agent.id,
      conversationId: chatId,
      threadRootId,
      person: person.accountId,
      trigger: 'ahead',
      coalesce: false,
      own: true,
      background: true,
    });
    if (!woken) throw notFound('Chat');
    const startAt = parseTime(event.start, ctx.now);
    const fromMail = event.source !== 'calendar';
    const endAt = fromMail
      ? new Date(ctx.now.getTime() + MAIL_SETTLE_AFTER_MS)
      : parseTime(event.end, startAt);
    await tx.insert(aheadChecks).values({
      id,
      burrowId: ctx.burrow.id,
      agentId: agent.id,
      personId: person.id,
      source: event.source,
      stage: event.stage,
      eventKey: event.key,
      version: event.version,
      summary: event.summary,
      location: event.location,
      calendar: event.calendar,
      startAt,
      endAt,
      event: {
        start: event.start,
        end: event.end,
        description: event.description,
        timeZone: event.timeZone,
        ...(event.allDay ? { allDay: true } : {}),
        connectionId: event.connectionId,
        calendarId: event.calendarId,
        eventId: event.eventId,
        guests: event.guests,
        ...(event.daySchedule?.length ? { daySchedule: event.daySchedule } : {}),
        ...(event.mail ? { mail: event.mail } : {}),
        ...(event.triage ? { triage: event.triage } : {}),
        ...(event.source === 'matter' && matterId && event.matter
          ? { matter: { id: matterId, reason: event.matter.reason } }
          : matterId
            ? { matter: { id: matterId, ...(event.matterMatched ? { matched: true } : {}) } }
            : {}),
      },
      state: 'checking',
      dispatchId: woken.dispatchId,
      conversationId: chatId,
      threadRootId,
      startedAt: ctx.now,
      // Everything but a calendar check starts with the web closed: untrusted mail can never steer outbound web calls.
      mailReadAt: fromMail ? ctx.now : null,
      matterId,
    });
    // Signed without the event's or mail's words: what is on someone's calendar or inbox stays out of the log.
    await ctx.emit({
      type: 'ahead.check_started',
      kind: 'System',
      text: null,
      where: null,
      payload: {
        aheadCheckId: id,
        dispatchId: woken.dispatchId,
        source: event.source,
        stage: event.stage,
        ...(matterId ? { aheadMatterId: matterId } : {}),
        ...(event.triage ? { count: event.triage.count } : {}),
      },
    });
    return { checkId: id, dispatchId: woken.dispatchId };
  },
});

/* Private reads close the web ---------------------------------------------------------------------------------------- */

/**
 * A check is about to read private data (mail, files or docs): kept on its row before the data reaches the model,
 * so nothing more of it goes to the web — not after a restart, nor in a later claim of the same turn.
 */
export const markAheadMailRead = defineCommand({
  name: 'ahead.mail_read',
  schema: z.object({ dispatchId: z.string().min(1).max(64) }),
  async apply(tx, ctx, input): Promise<{ ok: true }> {
    if (ctx.actor.kind !== 'agent') throw forbidden(NOT_AN_AHEAD_CHECK);
    const row = await checkOfTurn(tx, ctx.burrow.id, input.dispatchId);
    if (!row || row.agentId !== ctx.actor.id) throw forbidden(NOT_AN_AHEAD_CHECK);
    if (!row.mailReadAt)
      await tx.update(aheadChecks).set({ mailReadAt: ctx.now }).where(eq(aheadChecks.id, row.id));
    return { ok: true };
  },
});

/* The report --------------------------------------------------------------------------------------------------------- */

/** A source as Whombat names it: the site with its link, or a mail/file/doc/calendar label. */
export const NamedSourceInput = AheadNamedSource;

/** Dedup key and push group for one Inbox finding's notification. */
export const aheadNoticeDedupKey = (checkId: string) => `ahead-finding:${checkId}`;
export const aheadPushGroup = (checkId: string) => `ahead-finding:${checkId}`;

/**
 * Short plain title for a finding: the model's scrubbed `title` when it gave one, else the opening sentence of its
 * words, else the event or matter name.
 */
export function findingTitle(rawTitle: string | undefined, words: string, fallback: string): string {
  const own = cleanShortLabel(rawTitle, AHEAD_TITLE_MAX);
  if (own) return own;
  const first = words.split(/(?<=[.!?])\s+/)[0]?.trim() ?? '';
  if (first.length >= 2) {
    const clipped =
      first.length <= AHEAD_TITLE_MAX ? first : `${first.slice(0, AHEAD_TITLE_MAX - 1).trimEnd()}…`;
    return clipped.replace(/\.$/, '');
  }
  return cleanShortLabel(fallback, AHEAD_TITLE_MAX) ?? 'Looks ahead';
}

/**
 * A finding's Chat message: optional bold title on its own line (so Chat's thread list shows the short headline),
 * the assistant's plain words, then its verified sources on one line.
 */
export function findingText(
  text: string,
  sources: readonly z.infer<typeof NamedSourceInput>[],
  title?: string | null,
): string {
  const flat = (s: string) =>
    s
      .replace(/[[\]\n\r*_`]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const body = findingWords(text);
  const head = title ? cleanShortLabel(title, AHEAD_TITLE_MAX) : null;
  const withHead =
    head && !body.toLowerCase().startsWith(head.toLowerCase()) ? `**${head}**\n\n${body}` : body;
  if (!sources.length) return withHead;
  const line = sources
    .map((s) =>
      s.url
        ? `[${flat(s.label)}](${s.url.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)})`
        : flat(s.label),
    )
    .join(' · ');
  return `${withHead}\n\n${line}`;
}

/** Marks Inbox finding notifications read (and removes them when dismissed/promoted/expired) and clears phone pushes. */
export async function settleAheadNotices(
  ctx: ApplyContext,
  checkIds: readonly string[],
  how: 'read' | 'remove',
): Promise<number> {
  if (!checkIds.length) return 0;
  const keys = checkIds.map(aheadNoticeDedupKey);
  const read = await ctx.tx
    .update(notifications)
    .set({ readAt: ctx.now })
    .where(
      and(
        eq(notifications.burrowId, ctx.burrow.id),
        inArray(notifications.dedupKey, keys),
        isNull(notifications.readAt),
      ),
    )
    .returning({
      id: notifications.id,
      principalId: notifications.principalId,
      dedupKey: notifications.dedupKey,
    });
  if (how === 'remove')
    await ctx.tx
      .delete(notifications)
      .where(and(eq(notifications.burrowId, ctx.burrow.id), inArray(notifications.dedupKey, keys)));
  if (!read.length) return 0;
  const byPerson = new Map<string, string[]>();
  for (const r of read) byPerson.set(r.principalId, [...(byPerson.get(r.principalId) ?? []), r.id]);
  for (const [principalId, ids] of byPerson) await publishNotificationsRead(ctx, principalId, { ids });
  const control = ctx.services.push.control;
  if (control) {
    const slug = ctx.burrow.slug;
    const clears = new Set(read.map((r) => `${r.principalId}|${r.dedupKey ?? ''}`));
    ctx.background('ahead finding push cleared', async () => {
      for (const clear of clears) {
        const [principalId = '', group = ''] = clear.split('|');
        if (!principalId || !group) continue;
        await control(
          [principalId],
          {
            burrow: slug,
            notificationId: null,
            kind: 'agent_update',
            title: GENERIC_PUSH_TITLE,
            body: '',
            path: `/${slug}`,
          },
          { group, clear: true },
        ).catch(() => {});
      }
    });
  }
  return read.length;
}

/** The least time before an event a finding is still worth telling. */
const TELL_LEAD_MS = 30 * 60_000;

/**
 * News on a matter the person asked for came at night: the row goes, so the same mail (or the same follow-up) is checked
 * again in the morning instead of being lost.
 */
async function checkAgainInTheMorning(
  ctx: ApplyContext,
  row: AheadCheckRow,
  matter: AheadMatterRow,
): Promise<{ told: boolean }> {
  await ctx.tx.delete(aheadChecks).where(eq(aheadChecks.id, row.id));
  const reason = row.source === 'matter' ? row.event.matter?.reason : undefined;
  if (reason)
    await ctx.tx
      .update(aheadMatters)
      .set({ followedUp: matter.followedUp.filter((r) => r !== reason), updatedAt: ctx.now })
      .where(eq(aheadMatters.id, matter.id));
  await ctx.emit({
    type: 'ahead.reported',
    kind: 'System',
    text: null,
    where: null,
    payload: { aheadCheckId: row.id, told: false, again: true, source: row.source, stage: row.stage },
  });
  return { told: false };
}

/**
 * A mail check opens a matter (`ahead_report`'s `matter` without `ref`): only when the check has none, fewer than
 * `AHEAD_MATTERS_MAX` are open and checks opened fewer than `AHEAD_MATTERS_OPENED_PER_DAY` today; otherwise nothing,
 * silently. Its words are scrubbed like a finding's, and it is matched only by what Whombat knows of the mail it checked
 * (its thread and its sender's address, read from the whole From line when it came), never by words the model chose. A
 * date that isn't from today to a year ahead is left out. When an open matter has that title already, no second one
 * opens and that one stays exactly as it is: a title is the model's words, and words from a mail must not decide which
 * later mail a matter takes, least of all one the person asked for. Its id, or null.
 */
async function openMatterFromCheck(
  ctx: ApplyContext,
  row: AheadCheckRow,
  wanted: NonNullable<AheadReportInput['matter']>,
  thread: { rootId: string; conversationId: string } | null,
): Promise<string | null> {
  const { tx } = ctx;
  if (row.source !== 'mail' || !wanted.waitingOn) return null;
  const title = cleanShortLabel(wanted.title, AHEAD_MATTER_TITLE_MAX);
  if (!title) return null;
  const mail = row.event.mail;
  const mailThread =
    mail?.threadId && row.event.connectionId
      ? { connectionId: row.event.connectionId, threadId: mail.threadId }
      : null;
  const [same] = await tx
    .select({ id: aheadMatters.id })
    .from(aheadMatters)
    .where(
      and(
        eq(aheadMatters.burrowId, ctx.burrow.id),
        eq(aheadMatters.state, 'open'),
        sql`lower(${aheadMatters.title}) = ${title.toLowerCase()}`,
      ),
    )
    .limit(1);
  if (same) return null;
  const [open] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(aheadMatters)
    .where(and(eq(aheadMatters.burrowId, ctx.burrow.id), eq(aheadMatters.state, 'open')));
  if ((open?.n ?? 0) >= AHEAD_MATTERS_MAX) return null;
  const dayStart = startOfLocalDay(ctx.now, ctx.burrow.timeZone);
  if ((await mattersOpenedByChecks(tx, ctx.burrow.id, dayStart)) >= AHEAD_MATTERS_OPENED_PER_DAY) return null;
  const sender = senderAddress(mail?.address);
  const id = newId('aheadMatter');
  await tx.insert(aheadMatters).values({
    id,
    burrowId: ctx.burrow.id,
    personId: row.personId,
    origin: 'check',
    title,
    who: cleanShortLabel(wanted.who, AHEAD_MATTER_WHO_MAX) ?? '',
    waitingOn: wanted.waitingOn,
    dueAt: matterDueAt(wanted.due, ctx.burrow.timeZone, ctx.now),
    note: cleanShortLabel(wanted.note, AHEAD_NOTE_MAX),
    match: {
      threads: mailThread ? [mailThread] : [],
      senders: sender ? [sender] : [],
      words: [],
    },
    state: 'open',
    conversationId: thread?.conversationId ?? row.conversationId,
    threadRootId: thread?.rootId ?? null,
    followedUp: [],
    lastNewsAt: ctx.now,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  // Signed without its words, as a finding's are.
  await ctx.emit({
    type: 'ahead.matter_opened',
    kind: 'System',
    text: null,
    where: null,
    payload: { aheadMatterId: id, origin: 'check', aheadCheckId: row.id },
  });
  return id;
}

/**
 * The check's end. Nothing found: `quiet`, nothing posted (optional `note` kept for later stages). A finding: told in
 * its matter's thread, or its event's (replying where an earlier stage already posted), or a thread of its own, with a
 * push, optional one-tap action chip and feedback replies — unless switched off, stopped, budget reached, night, too
 * close, or event changed meanwhile. News on a matter the person asked for is told whatever the kinds and the day's
 * findings say, never at night. A mail check or a follow-up may open, update or close a matter as well. Once only.
 */
export const reportAhead = defineCommand({
  name: 'ahead.report',
  schema: z.object({
    dispatchId: z.string().min(1).max(64),
    report: AheadReportInput,
    /** The finding's sources as Whombat named them, checked against what the turn saw. */
    sources: z.array(NamedSourceInput).max(AHEAD_SOURCES_MAX),
    /** The event is still as the check began it (always true for mail-triggered checks). */
    current: z.boolean(),
  }),
  async apply(tx, ctx, input): Promise<{ told: boolean }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the assistant says what it found.');
    const row = await checkOfTurn(tx, ctx.burrow.id, input.dispatchId);
    if (!row || row.agentId !== ctx.actor.id) throw forbidden(NOT_AN_AHEAD_CHECK);
    if (row.source === 'triage') throw forbidden(TRIAGE_ONLY);
    if (row.state !== 'checking') throw forbidden('You already said what you found for this check.');
    const { report } = input;
    const timeZone = ctx.burrow.timeZone;
    const settings = await aheadSettingsOf(tx, ctx.burrow.id);
    const fromMail = row.source !== 'calendar';
    const given = row.matterId ? await matterForUpdate(tx, ctx.burrow.id, row.matterId) : null;
    const matter = given?.state === 'open' ? given : null;
    const daytime = aheadHours(ctx.now, timeZone);
    // News the person asked for: their matter's follow-up, or mail that really matches it. A triage pick linked to it
    // whose mail doesn't match is checked with it as context, but its finding follows the ordinary rules.
    const theirs =
      matter?.origin === 'person' && (row.source === 'matter' || row.event.matter?.matched === true);
    // News the person asked for is never told at night, and never lost to it.
    if (matter && theirs && !daytime) return checkAgainInTheMorning(ctx, row, matter);
    // A check that was given a matter reports on it, unless it says its finding is about something else: a watched
    // sender also writes about other things, and those are told as any other mail's finding.
    const about = matter && !(row.source === 'mail' && report.found && report.unrelated) ? matter : null;
    // They asked for it: told whatever the kinds and the day's count say.
    const asked = !!about && theirs;
    const calendarOff =
      !fromMail && settings.calendarsOff.includes(calendarKey(row.event.connectionId, row.event.calendarId));
    const mailOff = fromMail && !settings.mailOn;
    const extraKinds = (report.extraKinds ?? []).filter((k) => k !== report.kind);
    const allKinds = report.kind ? [report.kind, ...extraKinds] : [];
    // If every reported kind was stopped by the person, keep quiet.
    const anyAllowedKind = allKinds.some((k) => !settings.stopped.includes(k));
    // Its words as they would be posted: nothing left of them (only links or markup) is nothing to tell.
    const words = report.text ? findingWords(report.text) : '';
    const title = words ? findingTitle(report.title, words, about?.title ?? row.summary) : null;
    const actionLabel = cleanShortLabel(report.action, AHEAD_ACTION_MAX);
    const note = cleanShortLabel(report.note, AHEAD_NOTE_MAX);
    const leadOk = fromMail || row.event.allDay || row.startAt.getTime() - ctx.now.getTime() >= TELL_LEAD_MS;
    const tellable =
      report.found &&
      report.kind &&
      (asked || anyAllowedKind) &&
      words.length > 0 &&
      input.sources.length > 0 &&
      input.current &&
      settings.on &&
      !calendarOff &&
      !mailOff &&
      daytime &&
      leadOk &&
      (asked ||
        (await findingsSince(tx, ctx.burrow.id, startOfLocalDay(ctx.now, timeZone))) <
          AHEAD_FINDINGS_PER_DAY);
    let told = false;
    let promotedAt: Date | null = null;
    let conversationId = row.conversationId;
    // The thread a matter's finding joins: its matter's, while that message is still there.
    const matterThread = about ? await matterThreadRoot(tx, about) : null;
    if (tellable) {
      // Otherwise an earlier stage's thread of the same event (only if it was already opened in Chat).
      const eventRoot = about ? null : await existingEventThreadRoot(tx, row);
      const thread =
        matterThread ?? (eventRoot ? { rootId: eventRoot, conversationId: row.conversationId } : null);
      // What the person explicitly asked Whombat to watch, or an event/matter that already has a Chat thread, posts
      // right into Chat. Everything else lands calmly in the person's Inbox until they choose to act or reply.
      const goToChat = asked || thread !== null;
      if (goToChat) {
        const where = thread?.conversationId ?? about?.conversationId ?? row.conversationId;
        const conversation =
          (await loadConversationRow(tx, where)) ?? (await loadConversationRow(tx, row.conversationId));
        if (conversation) {
          const suggestions = actionLabel ? [actionLabel, ...AHEAD_REPLIES] : [...AHEAD_REPLIES];
          await postMessage(ctx, {
            conversation,
            id: row.threadRootId,
            ...(thread && thread.conversationId === conversation.id ? { threadRootId: thread.rootId } : {}),
            text: findingText(words, input.sources, title),
            suggestions,
            // The person's Chat tells them, inbox and push, as any message of the assistant's there.
            dispatch: false,
            linkPreviews: false,
          });
          told = true;
          promotedAt = ctx.now;
          conversationId = conversation.id;
        }
      } else {
        told = true;
        const noticeText =
          title && !words.toLowerCase().startsWith(title.toLowerCase()) ? `${title} — ${words}` : words;
        await notifyInCommit(ctx, {
          burrowId: ctx.burrow.id,
          burrowSlug: ctx.burrow.slug,
          principalId: row.personId,
          kind: 'agent_update',
          actorId: row.agentId,
          where: 'Direct',
          text: noticeText,
          link: { type: 'external', url: needsYouItemHref(`ahead:${row.id}`) },
          createdAt: ctx.now,
          dedupKey: aheadNoticeDedupKey(row.id),
          group: aheadPushGroup(row.id),
        });
        publishHomeChanged(ctx, [row.personId], ['needsYou']);
      }
    }
    // Where the finding started a Chat thread of its own, that is the matter's thread from now on.
    const startedThread =
      told && promotedAt !== null && !(matterThread && matterThread.conversationId === conversationId)
        ? { rootId: row.threadRootId, conversationId }
        : null;
    // A finding that isn't about the matter its mail matched stands on its own, with its own thread and replies, and
    // its mail isn't one a later follow-up of that matter is pointed at.
    let matterId = !about && (told || matter) ? null : row.matterId;
    // E. With Looks ahead or incoming mail switched off meanwhile, a report opens and changes nothing.
    const change = fromMail && settings.on && !mailOff ? report.matter : undefined;
    // A follow-up counts once it reported, whatever it found: one whose turn failed may be tried once more.
    const followed = row.source === 'matter' ? row.event.matter?.reason : undefined;
    if (followed && given && !given.followedUp.includes(followed))
      await tx
        .update(aheadMatters)
        .set({ followedUp: [...given.followedUp, followed], updatedAt: ctx.now })
        .where(eq(aheadMatters.id, given.id));
    if (about) {
      const byRef = change?.ref ? change : undefined;
      const matterNote = cleanShortLabel(byRef?.note, AHEAD_NOTE_MAX);
      // A date outside today to a year ahead is ignored; the rest of the change stands.
      const due = byRef?.due ? matterDueAt(byRef.due, timeZone, ctx.now) : null;
      const set: Partial<AheadMatterRow> = {
        ...(matterNote ? { note: matterNote } : {}),
        ...(due ? { dueAt: due } : {}),
        ...(byRef?.waitingOn ? { waitingOn: byRef.waitingOn } : {}),
        // A told finding or a note on where it stands is news: a follow-up for no answer counts from here.
        ...(told || matterNote ? { lastNewsAt: ctx.now } : {}),
        ...(startedThread
          ? { threadRootId: startedThread.rootId, conversationId: startedThread.conversationId }
          : {}),
      };
      if (Object.keys(set).length)
        await tx
          .update(aheadMatters)
          .set({ ...set, updatedAt: ctx.now })
          .where(eq(aheadMatters.id, about.id));
      // A check closes what the person asked for only together with a finding it told them; one it opened itself it
      // may close quietly.
      if (byRef?.close && (about.origin !== 'person' || told)) await closeMatterIn(ctx, about, 'done');
    } else if (change && !change.ref && !row.matterId) {
      matterId = await openMatterFromCheck(ctx, row, change, startedThread);
    }
    await tx
      .update(aheadChecks)
      .set({
        // A mail check that got its turn at night could read nothing: it failed, and is tried once more in the morning.
        state: told ? 'told' : row.source === 'mail' && !daytime && !report.found ? 'failed' : 'quiet',
        kind: report.found ? (report.kind ?? null) : null,
        extraKinds: report.found ? extraKinds : [],
        title: told ? title : null,
        text: told ? words : null,
        sources: told ? input.sources : [],
        actionLabel: told ? actionLabel : null,
        note,
        reportedAt: ctx.now,
        promotedAt: told ? promotedAt : null,
        conversationId,
        matterId,
      })
      .where(eq(aheadChecks.id, row.id));
    await ctx.emit({
      type: 'ahead.reported',
      kind: 'System',
      text: null,
      where: null,
      payload: {
        aheadCheckId: row.id,
        told,
        inbox: told && promotedAt === null,
        source: row.source,
        stage: row.stage,
        ...(told && report.kind ? { kind: report.kind } : {}),
        ...(matterId ? { aheadMatterId: matterId } : {}),
      },
    });
    return { told };
  },
});

/** Finds an existing live finding thread root for the same event so multi-stage findings stay in one thread. */
async function existingEventThreadRoot(tx: Tx, row: AheadCheckRow): Promise<string | null> {
  if (row.source !== 'calendar') return null;
  const earlier = await tx
    .select({ threadRootId: aheadChecks.threadRootId })
    .from(aheadChecks)
    .where(
      and(
        eq(aheadChecks.burrowId, row.burrowId),
        eq(aheadChecks.eventKey, row.eventKey),
        eq(aheadChecks.state, 'told'),
        ne(aheadChecks.id, row.id),
      ),
    )
    .orderBy(aheadChecks.startedAt)
    .limit(5);
  for (const prev of earlier) {
    const [msg] = await tx
      .select({ id: messages.id, threadRootId: messages.threadRootId })
      .from(messages)
      .where(eq(messages.id, prev.threadRootId));
    if (msg) return msg.threadRootId ?? msg.id;
  }
  return null;
}

/* The person's word on a finding ------------------------------------------------------------------------------------- */

/**
 * The latest told finding posted in a thread, or null: the thread's first message or a reply in it. Several stages of
 * one event share a thread, so does everything told about one matter (whose thread may be one the person began by
 * asking), and several matters may share one: “Not useful” and “Stop checking for this” act on the finding said last
 * there, and on that finding's own matter.
 */
export async function toldCheckOfThread(
  tx: Pick<Tx, 'select'>,
  burrowId: string,
  threadRootId: string | null,
) {
  if (!threadRootId) return null;
  const [latest] = await tx
    .select({ check: aheadChecks })
    .from(aheadChecks)
    .innerJoin(messages, eq(messages.id, aheadChecks.threadRootId))
    .where(
      and(
        eq(aheadChecks.burrowId, burrowId),
        eq(aheadChecks.state, 'told'),
        or(eq(messages.id, threadRootId), eq(messages.threadRootId, threadRootId)),
      ),
    )
    .orderBy(desc(aheadChecks.reportedAt), desc(aheadChecks.startedAt))
    .limit(1);
  return latest?.check ?? null;
}

/**
 * The person said a finding wasn't useful (with optional reason), or to stop checking for this (in their own turn in
 * its thread, through the assistant). Stopping stops the finding's kind, or, under a finding about a matter, stops
 * keeping an eye on that matter; `not_useful` + reason calibrates future checks.
 */
export const aheadFeedback = defineCommand({
  name: 'ahead.feedback',
  schema: z.object({
    dispatchId: z.string().min(1).max(64),
    verdict: z.enum(['not_useful', 'stop_kind']),
    reason: z.string().trim().min(1).max(AHEAD_FEEDBACK_REASON_MAX).optional(),
  }),
  async apply(tx, ctx, input): Promise<{ kind: AheadKind }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the assistant notes this.');
    const [dispatch] = await tx.select().from(dispatches).where(eq(dispatches.id, input.dispatchId));
    if (!dispatch || dispatch.burrowId !== ctx.burrow.id || dispatch.agentId !== ctx.actor.id)
      throw forbidden(NOT_AN_AHEAD_THREAD);
    // Only the person's own turn: their word, not a stranger's.
    if (!dispatch.onBehalfOfAccountId || dispatch.trigger === 'ahead') throw forbidden(NOT_AN_AHEAD_THREAD);
    const row = await toldCheckOfThread(tx, ctx.burrow.id, dispatch.threadRootId);
    if (!row?.kind) throw forbidden(NOT_AN_AHEAD_THREAD);
    const reason = cleanShortLabel(input.reason, AHEAD_FEEDBACK_REASON_MAX);
    await tx
      .update(aheadChecks)
      .set({ feedback: input.verdict, ...(reason ? { feedbackNote: reason } : {}) })
      .where(eq(aheadChecks.id, row.id));
    let stopped: 'kind' | 'matter' | null = null;
    if (input.verdict === 'stop_kind') {
      if (row.matterId) {
        // A finding about a matter: “Stop checking for this” means that matter, not the kind.
        const matter = await matterForUpdate(tx, ctx.burrow.id, row.matterId);
        if (matter) await closeMatterIn(ctx, matter, 'removed');
        stopped = 'matter';
      } else {
        const settings = await aheadSettingsOf(tx, ctx.burrow.id);
        if (!settings.stopped.includes(row.kind))
          await saveSettings(ctx, { ...settings, stopped: [...settings.stopped, row.kind] });
        stopped = 'kind';
      }
    }
    await ctx.emit({
      type: 'ahead.feedback',
      kind: 'System',
      text:
        stopped === 'kind'
          ? 'Stopped a kind of Looks ahead check'
          : stopped === 'matter'
            ? 'Stopped keeping an eye on something'
            : null,
      where: null,
      payload: {
        aheadCheckId: row.id,
        verdict: input.verdict,
        kind: row.kind,
        ...(stopped === 'matter' && row.matterId ? { aheadMatterId: row.matterId } : {}),
      },
    });
    return { kind: row.kind };
  },
});

/**
 * Promotes a Looks ahead Inbox finding into a Chat thread so the person can act on it or reply.
 * When `text` is supplied (a one-tap action or a direct reply), it is posted as the person's reply in that thread
 * and wakes the assistant with full finding context. Already-promoted findings open their existing thread idempotently.
 */
export const promoteAheadFinding = defineCommand({
  name: 'ahead.promote',
  schema: z.object({
    checkId: AheadCheckId,
    text: z.string().trim().min(1).max(4000).optional(),
  }),
  async apply(tx, ctx, input): Promise<{ conversationId: string; messageId: string }> {
    if (ctx.actor.kind !== 'person' || !(await isThePerson(tx, ctx.burrow.id, ctx.actor.id)))
      throw forbidden('Only you can open this finding in Chat.');
    if (input.text) ctx.services.licence.assertNotLapsed();
    const [row] = await tx
      .select()
      .from(aheadChecks)
      .where(and(eq(aheadChecks.burrowId, ctx.burrow.id), eq(aheadChecks.id, input.checkId)))
      .for('update');
    if (row?.state !== 'told' || row.personId !== ctx.actor.id || !row.text) throw notFound('Finding');

    // Already in Chat (promoted before, or posted directly): open that thread and post any reply there.
    const [existingMsg] = await tx
      .select({
        id: messages.id,
        threadRootId: messages.threadRootId,
        conversationId: messages.conversationId,
      })
      .from(messages)
      .where(and(eq(messages.id, row.threadRootId), isNull(messages.deletedAt)));
    if (existingMsg) {
      const rootId = existingMsg.threadRootId ?? existingMsg.id;
      const conversation = await loadConversationRow(tx, existingMsg.conversationId);
      if (!conversation) throw notFound('Chat');
      if (!row.promotedAt)
        await tx.update(aheadChecks).set({ promotedAt: ctx.now }).where(eq(aheadChecks.id, row.id));
      await tx
        .delete(needsYouSnoozes)
        .where(
          and(
            eq(needsYouSnoozes.personId, row.personId),
            eq(needsYouSnoozes.refKind, 'ahead'),
            eq(needsYouSnoozes.refId, row.id),
          ),
        );
      await settleAheadNotices(ctx, [row.id], 'remove');
      publishHomeChanged(ctx, [row.personId], ['needsYou']);
      if (input.text) {
        const reply = await postMessage(ctx, {
          conversation,
          threadRootId: rootId,
          text: input.text,
          dispatch: true,
        });
        return { conversationId: conversation.id, messageId: reply.id };
      }
      return { conversationId: conversation.id, messageId: rootId };
    }

    const agent = await loadPrincipalRow(tx, row.agentId);
    const person = await loadPrincipalRow(tx, row.personId);
    if (!agent || !person) throw notFound('Chat');
    const matter = row.matterId ? await matterForUpdate(tx, ctx.burrow.id, row.matterId) : null;
    const matterThread = matter ? await matterThreadRoot(tx, matter) : null;
    const eventRoot = matter ? null : await existingEventThreadRoot(tx, row);
    const existingThread =
      matterThread ?? (eventRoot ? { rootId: eventRoot, conversationId: row.conversationId } : null);

    // If this finding is open (unmarked) and belongs to a calendar event or matter that has other open unpromoted
    // findings, pull them into the same thread in chronological order so the whole story lives in one place.
    const [rowMark] = await tx
      .select({ refId: needsYouSnoozes.refId })
      .from(needsYouSnoozes)
      .where(
        and(
          eq(needsYouSnoozes.personId, row.personId),
          eq(needsYouSnoozes.refKind, 'ahead'),
          eq(needsYouSnoozes.refId, row.id),
        ),
      )
      .limit(1);
    let batch: AheadCheckRow[] = [row];
    if (!rowMark && !row.settledAt && !row.feedback) {
      const siblingWhere =
        row.source === 'calendar'
          ? eq(aheadChecks.eventKey, row.eventKey)
          : row.matterId
            ? eq(aheadChecks.matterId, row.matterId)
            : null;
      if (siblingWhere) {
        const siblings = await tx
          .select()
          .from(aheadChecks)
          .where(
            and(
              eq(aheadChecks.burrowId, ctx.burrow.id),
              eq(aheadChecks.personId, row.personId),
              eq(aheadChecks.state, 'told'),
              isNull(aheadChecks.promotedAt),
              isNull(aheadChecks.settledAt),
              isNull(aheadChecks.feedback),
              siblingWhere,
              ne(aheadChecks.id, row.id),
              sql`not exists (select 1 from ${messages} m where m.id = ${aheadChecks.threadRootId})`,
              sql`not exists (select 1 from ${needsYouSnoozes} s where s.person_id = ${row.personId} and s.ref_kind = 'ahead' and s.ref_id = ${aheadChecks.id})`,
            ),
          );
        if (siblings.length) {
          batch = [...siblings, row].sort(
            (a, b) =>
              (a.reportedAt ?? a.startedAt).getTime() - (b.reportedAt ?? b.startedAt).getTime() ||
              a.id.localeCompare(b.id),
          );
        }
      }
    }

    const where = existingThread?.conversationId ?? matter?.conversationId ?? row.conversationId;
    const conversation =
      (await loadConversationRow(tx, where)) ??
      (await loadConversationRow(tx, await ensurePersonalDm(ctx, agent, person)));
    if (!conversation) throw notFound('Chat');

    const asAgent = applyContext(ctx, {
      burrow: ctx.burrow,
      actor: toActor(agent),
      now: ctx.now,
      at: ctx.at,
      decision: null,
      requirement: null,
      approvalId: null,
      onBehalfOf: {},
    });

    let rootId: string | null =
      existingThread && existingThread.conversationId === conversation.id ? existingThread.rootId : null;
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i] as AheadCheckRow;
      if (!item.text) continue;
      const isLast = i === batch.length - 1;
      const suggestions =
        isLast && !input.text
          ? item.actionLabel
            ? [item.actionLabel, ...AHEAD_REPLIES]
            : [...AHEAD_REPLIES]
          : [];
      const posted = await postMessage(asAgent, {
        conversation,
        id: item.threadRootId,
        ...(rootId ? { threadRootId: rootId } : {}),
        text: findingText(item.text, item.sources ?? [], item.title),
        suggestions,
        mentions: [],
        dispatch: false,
        notify: false,
        linkPreviews: false,
      });
      if (!rootId) rootId = posted.id;
    }
    if (!rootId) throw notFound('Finding');

    const batchIds = batch.map((b) => b.id);
    await tx
      .update(aheadChecks)
      .set({ promotedAt: ctx.now, conversationId: conversation.id })
      .where(inArray(aheadChecks.id, batchIds));

    if (matter && !matterThread) {
      await tx
        .update(aheadMatters)
        .set({ threadRootId: rootId, conversationId: conversation.id, updatedAt: ctx.now })
        .where(eq(aheadMatters.id, matter.id));
    }

    await tx
      .delete(needsYouSnoozes)
      .where(
        and(
          eq(needsYouSnoozes.personId, row.personId),
          eq(needsYouSnoozes.refKind, 'ahead'),
          inArray(needsYouSnoozes.refId, batchIds),
        ),
      );
    await settleAheadNotices(ctx, batchIds, 'remove');
    publishHomeChanged(ctx, [row.personId], ['needsYou']);

    let returnMessageId = rootId;
    if (input.text) {
      const reply = await postMessage(ctx, {
        conversation,
        threadRootId: rootId,
        text: input.text,
        dispatch: true,
      });
      returnMessageId = reply.id;
    }

    await ctx.emit({
      type: 'ahead.promoted',
      kind: 'System',
      text: null,
      where: null,
      payload: { aheadCheckId: row.id, threadRootId: rootId, replied: Boolean(input.text) },
    });
    return { conversationId: conversation.id, messageId: returnMessageId };
  },
});

/**
 * Direct feedback on a Looks ahead finding from the Inbox (“Not useful” or “Stop checking for this”), without
 * opening a Chat thread. Records calibration feedback (or stops the kind / closes the matter) and removes it from Inbox.
 */
export const aheadInboxFeedback = defineCommand({
  name: 'ahead.inbox_feedback',
  schema: z.object({
    checkId: AheadCheckId,
    verdict: z.enum(['not_useful', 'stop_kind']),
    reason: z.string().trim().min(1).max(AHEAD_FEEDBACK_REASON_MAX).optional(),
  }),
  async apply(tx, ctx, input): Promise<{ ok: true; kind: AheadKind; stopped: 'kind' | 'matter' | null }> {
    if (ctx.actor.kind !== 'person' || !(await isThePerson(tx, ctx.burrow.id, ctx.actor.id)))
      throw forbidden('Only you can mark Looks ahead findings.');
    const [row] = await tx
      .select()
      .from(aheadChecks)
      .where(and(eq(aheadChecks.burrowId, ctx.burrow.id), eq(aheadChecks.id, input.checkId)))
      .for('update');
    if (row?.state !== 'told' || !row.kind || row.personId !== ctx.actor.id) throw notFound('Finding');

    const reason = cleanShortLabel(input.reason, AHEAD_FEEDBACK_REASON_MAX);
    const settledIds = [row.id];
    await tx
      .update(aheadChecks)
      .set({
        feedback: input.verdict,
        ...(reason ? { feedbackNote: reason } : {}),
        settledAt: row.settledAt ?? ctx.now,
      })
      .where(eq(aheadChecks.id, row.id));

    let stopped: 'kind' | 'matter' | null = null;
    if (input.verdict === 'stop_kind') {
      if (row.matterId) {
        const matter = await matterForUpdate(tx, ctx.burrow.id, row.matterId);
        if (matter) await closeMatterIn(ctx, matter, 'removed');
        // Clear any other open unpromoted Inbox findings of the stopped matter too.
        const others = await tx
          .update(aheadChecks)
          .set({ settledAt: ctx.now })
          .where(
            and(
              eq(aheadChecks.burrowId, ctx.burrow.id),
              eq(aheadChecks.matterId, row.matterId),
              eq(aheadChecks.state, 'told'),
              isNull(aheadChecks.promotedAt),
              isNull(aheadChecks.settledAt),
              ne(aheadChecks.id, row.id),
            ),
          )
          .returning({ id: aheadChecks.id });
        for (const o of others) settledIds.push(o.id);
        stopped = 'matter';
      } else {
        const settings = await aheadSettingsOf(tx, ctx.burrow.id);
        if (!settings.stopped.includes(row.kind))
          await saveSettings(ctx, { ...settings, stopped: [...settings.stopped, row.kind] });
        stopped = 'kind';
      }
    }

    await tx
      .delete(needsYouSnoozes)
      .where(
        and(
          eq(needsYouSnoozes.personId, row.personId),
          eq(needsYouSnoozes.refKind, 'ahead'),
          inArray(needsYouSnoozes.refId, settledIds),
        ),
      );
    await settleAheadNotices(ctx, settledIds, 'remove');
    publishHomeChanged(ctx, [row.personId], ['needsYou']);

    await ctx.emit({
      type: 'ahead.feedback',
      kind: 'System',
      text:
        stopped === 'kind'
          ? 'Stopped a kind of Looks ahead check'
          : stopped === 'matter'
            ? 'Stopped keeping an eye on something'
            : null,
      where: null,
      payload: {
        aheadCheckId: row.id,
        verdict: input.verdict,
        kind: row.kind,
        ...(stopped === 'matter' && row.matterId ? { aheadMatterId: row.matterId } : {}),
      },
    });
    return { ok: true, kind: row.kind, stopped };
  },
});

/* The watcher's bookkeeping ------------------------------------------------------------------------------------------ */

/** Open matters that ran out by `now` (`aheadMatterExpired`), as a query. */
export function mattersExpiredBy(now: Date) {
  return and(
    eq(aheadMatters.state, 'open'),
    lt(aheadMatters.lastNewsAt, new Date(now.getTime() - AHEAD_MATTER_KEEP_MS)),
    or(
      isNull(aheadMatters.dueAt),
      lt(aheadMatters.dueAt, new Date(now.getTime() - AHEAD_MATTER_KEEP_AFTER_DUE_MS + 1)),
    ),
  );
}

/**
 * Once a pass: checks whose turn ended without a report, or never ran, failed; a finding's thread settles a while after
 * its event ended (or 48h after a mail or matter finding), when the person didn't write in it and no newer finding there
 * is still waiting for its own time; rows go a month after their event; matters without news for a month (and two weeks
 * past their date, when they have one) close, and closed ones go a month later.
 */
export const tidyAhead = defineCommand({
  name: 'ahead.tidy',
  schema: z.object({}),
  async apply(tx, ctx): Promise<{ failed: number; settled: number }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the assistant tidies its checks.');
    const now = ctx.now.getTime();
    const checking = await tx
      .select({ id: aheadChecks.id, dispatchId: aheadChecks.dispatchId, startedAt: aheadChecks.startedAt })
      .from(aheadChecks)
      .where(and(eq(aheadChecks.burrowId, ctx.burrow.id), eq(aheadChecks.state, 'checking')));
    const turns = checking.flatMap((c) => (c.dispatchId ? [c.dispatchId] : []));
    const ended = new Set(
      turns.length
        ? (
            await tx
              .select({ id: dispatches.id })
              .from(dispatches)
              .where(
                and(
                  inArray(dispatches.id, turns),
                  inArray(dispatches.state, ['done', 'failed', 'cancelled']),
                ),
              )
          ).map((d) => d.id)
        : [],
    );
    const failed = checking
      .filter(
        (c) => (c.dispatchId && ended.has(c.dispatchId)) || now - c.startedAt.getTime() >= CHECKING_MAX_MS,
      )
      .map((c) => c.id);
    if (failed.length) {
      await tx
        .update(aheadChecks)
        .set({ state: 'failed', reportedAt: ctx.now })
        .where(and(inArray(aheadChecks.id, failed), eq(aheadChecks.state, 'checking')));
      // A check no runner took in time is over: its turn never runs late (at night, after the event moved).
      const stale = checking.flatMap((c) => (failed.includes(c.id) && c.dispatchId ? [c.dispatchId] : []));
      if (stale.length)
        await tx
          .update(dispatches)
          .set({ state: 'cancelled', finishedAt: ctx.now, error: 'expired' })
          .where(and(inArray(dispatches.id, stale), eq(dispatches.state, 'queued')));
    }
    // Threads of events that passed (and mail findings past 48h): settled as resolved when the person didn't write in them.
    const passed = await tx
      .select()
      .from(aheadChecks)
      .where(
        and(
          eq(aheadChecks.burrowId, ctx.burrow.id),
          eq(aheadChecks.state, 'told'),
          isNull(aheadChecks.settledAt),
          lt(aheadChecks.endAt, new Date(now - SETTLE_AFTER_MS)),
        ),
      );
    let settled = 0;
    if (passed.length) {
      // A thread with a newer finding whose time hasn't passed yet waits for that one.
      const pending = await tx
        .select({ threadRootId: aheadChecks.threadRootId })
        .from(aheadChecks)
        .where(
          and(
            eq(aheadChecks.burrowId, ctx.burrow.id),
            eq(aheadChecks.state, 'told'),
            isNull(aheadChecks.settledAt),
            gte(aheadChecks.endAt, new Date(now - SETTLE_AFTER_MS)),
          ),
        );
      // Resolve actual root message ids (multi-stage replies point to their thread root).
      const msgRows = await tx
        .select({ id: messages.id, threadRootId: messages.threadRootId })
        .from(messages)
        .where(
          inArray(messages.id, [...passed.map((p) => p.threadRootId), ...pending.map((p) => p.threadRootId)]),
        );
      const rootOf = new Map(msgRows.map((m) => [m.id, m.threadRootId ?? m.id]));
      const inChat = passed.filter((p) => rootOf.has(p.threadRootId));
      const inInbox = passed.filter((p) => !rootOf.has(p.threadRootId));
      const waiting = new Set(pending.map((p) => rootOf.get(p.threadRootId) ?? p.threadRootId));
      // Only a thread a finding of its own began is Looks ahead's to settle: one the person began (their ask, where a
      // matter they asked for is told) is their conversation.
      const replyRoots = [
        ...new Set(
          inChat.flatMap((p) => {
            const root = rootOf.get(p.threadRootId);
            return root && root !== p.threadRootId ? [root] : [];
          }),
        ),
      ];
      const ownRoots = new Set(
        replyRoots.length
          ? (
              await tx
                .select({ id: aheadChecks.threadRootId })
                .from(aheadChecks)
                .where(
                  and(eq(aheadChecks.burrowId, ctx.burrow.id), inArray(aheadChecks.threadRootId, replyRoots)),
                )
            ).map((r) => r.id)
          : [],
      );
      const began = (p: AheadCheckRow) => {
        const root = rootOf.get(p.threadRootId);
        return root === p.threadRootId || (root !== undefined && ownRoots.has(root));
      };
      const actualRoots = [...new Set(inChat.map((p) => rootOf.get(p.threadRootId) ?? p.threadRootId))];
      const wrote = new Set(
        actualRoots.length
          ? (
              await tx
                .select({ root: messages.threadRootId })
                .from(messages)
                .where(
                  and(
                    inArray(messages.threadRootId, actualRoots),
                    inArray(
                      messages.authorId,
                      inChat.map((p) => p.personId),
                    ),
                  ),
                )
            ).map((m) => m.root)
          : [],
      );
      const byChat = new Map<string, Set<string>>();
      for (const p of inChat) {
        const rootId = rootOf.get(p.threadRootId) ?? p.threadRootId;
        if (!began(p) || wrote.has(rootId) || waiting.has(rootId)) continue;
        const set = byChat.get(p.conversationId) ?? new Set<string>();
        set.add(rootId);
        byChat.set(p.conversationId, set);
      }
      for (const [chat, roots] of byChat) settled += await settleResolvedThreads(ctx, chat, [...roots]);
      // Unpromoted Inbox findings whose event passed (or 48 h elapsed for mail) leave the Inbox quietly.
      if (inInbox.length) {
        const inboxIds = inInbox.map((p) => p.id);
        await tx
          .delete(needsYouSnoozes)
          .where(and(eq(needsYouSnoozes.refKind, 'ahead'), inArray(needsYouSnoozes.refId, inboxIds)));
        await settleAheadNotices(ctx, inboxIds, 'remove');
        const people = [...new Set(inInbox.map((p) => p.personId))];
        publishHomeChanged(ctx, people, ['needsYou']);
        settled += inInbox.length;
      }
      await tx
        .update(aheadChecks)
        .set({ settledAt: ctx.now })
        .where(
          inArray(
            aheadChecks.id,
            passed.map((p) => p.id),
          ),
        );
    }
    await tx
      .delete(aheadChecks)
      .where(
        and(eq(aheadChecks.burrowId, ctx.burrow.id), lt(aheadChecks.endAt, new Date(now - CHECKS_KEEP_MS))),
      );
    // Matters without news for a month go (one with a date not before two weeks past it); closed ones are kept a month
    // for the record, then removed.
    const stale = await tx
      .select()
      .from(aheadMatters)
      .where(and(eq(aheadMatters.burrowId, ctx.burrow.id), mattersExpiredBy(ctx.now)))
      .for('update');
    let expired = 0;
    for (const matter of stale)
      if (aheadMatterExpired(matter, ctx.now) && (await closeMatterIn(ctx, matter, 'expired'))) expired++;
    await tx
      .delete(aheadMatters)
      .where(
        and(
          eq(aheadMatters.burrowId, ctx.burrow.id),
          eq(aheadMatters.state, 'closed'),
          lt(aheadMatters.closedAt, new Date(now - MATTERS_CLOSED_KEEP_MS)),
        ),
      );
    // What ended checks read goes from the person's Hermes home: no later turn finds it in its past sessions.
    await dropSessions(ctx, await endedAheadSessions(tx, ctx.burrow.id));
    if (failed.length || settled || expired)
      await ctx.emit({
        type: 'ahead.tidied',
        kind: 'System',
        text: null,
        where: null,
        payload: { failed: failed.length, settled, expired },
      });
    return { failed: failed.length, settled };
  },
});

/* The setting -------------------------------------------------------------------------------------------------------- */

/**
 * `looksAhead.update`: switch Looks ahead, incoming mail, a calendar, a kind, add/remove a standing rule, or stop keeping
 * an eye on something.
 */
export const updateLooksAhead = defineCommand({
  name: 'looks_ahead.update',
  schema: LooksAheadUpdate,
  async apply(tx, ctx, input): Promise<{ ok: true }> {
    if (ctx.actor.kind !== 'person' || !(await isThePerson(tx, ctx.burrow.id, ctx.actor.id)))
      throw forbidden('Only you can change what Looks ahead checks.');
    if ('removeMatter' in input) {
      // Not a setting: the matter itself closes, and its row stays a month for the record.
      const matter = await matterForUpdate(tx, ctx.burrow.id, input.removeMatter);
      if (!matter) throw notFound('That');
      await closeMatterIn(ctx, matter, 'removed');
      return { ok: true };
    }
    const settings = await aheadSettingsOf(tx, ctx.burrow.id);
    let next: AheadSettings = settings;
    let text: string;
    if ('calendar' in input) {
      const without = (list: readonly string[]) => list.filter((k) => k !== input.calendar);
      next = {
        ...settings,
        calendarsOff: input.on
          ? without(settings.calendarsOff)
          : [...without(settings.calendarsOff), input.calendar],
        calendarsOn: input.on
          ? [...without(settings.calendarsOn), input.calendar]
          : without(settings.calendarsOn),
      };
      text = input.on ? 'Looks ahead reads a calendar again' : 'Looks ahead stopped reading a calendar';
    } else if ('kind' in input) {
      next = {
        ...settings,
        stopped: input.on
          ? settings.stopped.filter((k) => k !== input.kind)
          : [...settings.stopped, input.kind],
      };
      text = input.on
        ? 'Looks ahead checks a kind of finding again'
        : 'Looks ahead stopped a kind of finding';
    } else if ('mailOn' in input) {
      next = { ...settings, mailOn: input.mailOn };
      text = input.mailOn ? 'Turned incoming mail checks on' : 'Turned incoming mail checks off';
    } else if ('addRule' in input) {
      const rule = input.addRule.trim();
      const lower = rule.toLowerCase();
      const exists = settings.rules.some((r) => r.toLowerCase() === lower);
      const rules = exists ? settings.rules : [...settings.rules, rule].slice(-AHEAD_RULES_MAX);
      next = { ...settings, rules };
      text = 'Added a Looks ahead rule';
    } else if ('removeRule' in input) {
      const target = input.removeRule.trim().toLowerCase();
      next = { ...settings, rules: settings.rules.filter((r) => r.toLowerCase() !== target) };
      text = 'Removed a Looks ahead rule';
    } else {
      next = { ...settings, on: input.on };
      text = input.on ? 'Turned Looks ahead on' : 'Turned Looks ahead off';
    }
    await saveSettings(ctx, next);
    await ctx.emit({ type: 'looks_ahead.updated', kind: 'System', text, where: null, payload: {} });
    return { ok: true };
  },
});

export const AHEAD_COMMANDS = [
  startAheadCheck,
  markAheadMailRead,
  reportAhead,
  aheadFeedback,
  promoteAheadFinding,
  aheadInboxFeedback,
  tidyAhead,
  updateLooksAhead,
  triageAhead,
  startAheadMatter,
  stopAheadMatter,
];
