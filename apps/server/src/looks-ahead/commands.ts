/**
 * Looks ahead's commands (docs/decisions/looks-ahead.md), all through the commit pipeline: a check begins (a quiet turn
 * of the assistant's, in a thread that is there only once it finds something), it reports (a finding is posted in its
 * event's thread — or as a reply if an earlier stage already started one — with a push and optional one-tap action
 * chip; nothing leaves no trace, though an optional factual note stays for later stages), the person's word on a
 * finding (with optional reason), the watcher's bookkeeping (failed checks, threads of events that passed, old rows),
 * and the setting (switch, calendars, incoming mail, standing rules, stopped kinds).
 */
import {
  AHEAD_ACTION_MAX,
  AHEAD_CHECKS_PER_DAY,
  AHEAD_FEEDBACK_REASON_MAX,
  AHEAD_FINDINGS_PER_DAY,
  AHEAD_KINDS,
  AHEAD_NOTE_MAX,
  AHEAD_REPLIES,
  AHEAD_RULES_MAX,
  AHEAD_SOURCES_MAX,
  AHEAD_TEXT_MAX,
  type AheadKind,
  AheadMailContext,
  AheadReportInput,
  AheadScheduleEntry,
  AheadStage,
  AheadTriggerSource,
  aheadHours,
  keepingDatesAndTimes,
  LooksAheadUpdate,
  newId,
} from '@whombat/core';
import { and, desc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { settleResolvedThreads } from '../chats/settle';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import type { Tx } from '../db/client';
import { aheadChecks, dispatches, looksAheadSettings, messages } from '../db/schema/index';
import { postMessage } from '../domain/messages';
import { ensurePersonalDm } from '../domain/personal-dm';
import { isThePerson } from '../domain/the-person';
import { wakeQuietly } from '../domain/wake';
import { startOfLocalDay } from '../home/time';
import { forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadPrincipalRow } from '../read/principals';
import { dropSessions, endedAheadSessions } from '../runtime/sessions';
import { type AheadSettings, calendarKey } from './calendars';

/** A check whose turn never ran this long after it began failed (no runner took it). */
export const CHECKING_MAX_MS = 2 * 3600_000;
/** A finding's thread settles this long after its event ended (or 48 h after posting for a mail finding). */
export const SETTLE_AFTER_MS = 2 * 3600_000;
/** Mail findings settle this long after posting when the person didn't reply. */
export const MAIL_SETTLE_AFTER_MS = 48 * 3600_000;
/** Checks are kept this long after their event, for the week's count and so a version isn't checked twice. */
export const CHECKS_KEEP_MS = 30 * 24 * 3600_000;

export const NOT_AN_AHEAD_CHECK =
  'This only works while Whombat has you check ahead. Answer in the conversation instead.';
export const NOT_AN_AHEAD_THREAD =
  'ahead_feedback only works in the thread of something you told the person after checking ahead.';

/** The setting as stored, or the default (on, incoming mail on, every default calendar, no rules, nothing stopped). */
export async function aheadSettingsOf(tx: Pick<Tx, 'select'>, burrowId: string): Promise<AheadSettings> {
  const [row] = await tx.select().from(looksAheadSettings).where(eq(looksAheadSettings.burrowId, burrowId));
  return row
    ? {
        on: row.on,
        mailOn: row.mailOn,
        calendarsOff: row.calendarsOff,
        calendarsOn: row.calendarsOn,
        rules: row.rules,
        stopped: row.stopped,
      }
    : { on: true, mailOn: true, calendarsOff: [], calendarsOn: [], rules: [], stopped: [] };
}

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

/** Findings told since the start of the burrow's day. */
export async function findingsSince(tx: Pick<Tx, 'select'>, burrowId: string, since: Date): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(aheadChecks)
    .where(
      and(
        eq(aheadChecks.burrowId, burrowId),
        eq(aheadChecks.state, 'told'),
        gte(aheadChecks.reportedAt, since),
      ),
    );
  return row?.n ?? 0;
}

/* Beginning a check -------------------------------------------------------------------------------------------------- */

export const AheadEventInput = z.object({
  source: AheadTriggerSource.default('calendar'),
  stage: AheadStage.default('eve'),
  key: z.string().min(1).max(3200),
  /** Stage-qualified version hash (`aheadStageVersion`). */
  version: z.string().min(1).max(32),
  /** Where a calendar event is read again before a finding is told (empty for mail checks). */
  connectionId: z.string().min(1).max(64),
  calendarId: z.string().max(1024).default(''),
  eventId: z.string().min(1).max(1024),
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
  /** Same-day accepted schedule (calendar) or next 14 days (mail). */
  daySchedule: z.array(AheadScheduleEntry).max(30).optional(),
  /** Incoming mail payload when `source === 'mail'`. */
  mail: AheadMailContext.optional(),
});
export type AheadEventInput = z.infer<typeof AheadEventInput>;

/** Safe timestamp for `startAt`/`endAt` (handles all-day `YYYY-MM-DD` dates cleanly). */
function parseTime(raw: string, fallback: Date): Date {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) ? new Date(`${raw.trim()}T00:00:00Z`) : new Date(raw);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

/**
 * Begins one check: the row, and the assistant's quiet turn about it on the background model, for the person, in the
 * person's Chat, in a thread of its own whose first message (its id held by the row) is posted only when it finds
 * something. Mail-triggered checks stamp `mailReadAt` immediately so the web is permanently closed.
 */
export const startAheadCheck = defineCommand({
  name: 'ahead.check_start',
  // A new turn: a lapsed appliance refuses it up front (LC-10).
  licence: 'agentTurn',
  schema: z.object({ event: AheadEventInput, personId: z.string().min(1).max(64) }),
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
    // Switched off, or the day's checks used, since the watcher read it.
    const settings = await aheadSettingsOf(tx, ctx.burrow.id);
    if (!settings.on) return null;
    if (event.source === 'mail' && !settings.mailOn) return null;
    const [today] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(aheadChecks)
      .where(
        and(
          eq(aheadChecks.burrowId, ctx.burrow.id),
          gte(aheadChecks.startedAt, startOfLocalDay(ctx.now, ctx.burrow.timeZone)),
        ),
      );
    if ((today?.n ?? 0) >= AHEAD_CHECKS_PER_DAY) return null;
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
    const endAt =
      event.source === 'mail'
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
      },
      state: 'checking',
      dispatchId: woken.dispatchId,
      conversationId: chatId,
      threadRootId,
      startedAt: ctx.now,
      // Mail-triggered checks start with the web closed: untrusted incoming mail can never steer outbound web calls.
      mailReadAt: event.source === 'mail' ? ctx.now : null,
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

/** The check a Looks ahead turn works on, locked, or null. */
async function checkOfTurn(tx: Tx, burrowId: string, dispatchId: string) {
  const [row] = await tx
    .select()
    .from(aheadChecks)
    .where(and(eq(aheadChecks.burrowId, burrowId), eq(aheadChecks.dispatchId, dispatchId)))
    .for('update');
  return row ?? null;
}

/**
 * The assistant's words as plain text that can hold no link, picture, site, address or phone number: markup characters
 * go first, then every address (`http:`, `https:`, `mailto:`, `data:`, `www.`, e-mail), bare sites and phone numbers,
 * again until nothing changes, so none can be put back together from what is left. Its sources are Whombat's.
 */
export function findingWords(text: string): string {
  let words = text;
  for (let i = 0; i < 5; i++) {
    const next = keepingDatesAndTimes(words, (text) =>
      text
        .replace(/<[^>]*>/g, ' ')
        .replace(/!(?=\[)/g, '')
        .replace(/[`*_#>|~[\]]/g, '')
        .replace(/\S*(?:https?:|mailto:|data:|www\.|@)\S*/gi, ' ')
        // A bare site (“tickets-rebook.example”) and a phone number aren't for it to give: its sources are.
        .replace(/\b[\p{L}\d-]+(?:\.[\p{L}\d-]+)*\.[a-z]{2,}\b\/?\S*/giu, ' ')
        .replace(/\+?\d[\d\s().-]{7,}\d/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
    if (next === words) break;
    words = next;
  }
  return words.slice(0, AHEAD_TEXT_MAX);
}

/** Scrubs a short action chip label or stage note with the same no-link/no-markup rules. */
export function cleanShortLabel(text: string | undefined, max: number): string | null {
  if (!text) return null;
  const cleaned = findingWords(text).slice(0, max).trim();
  return cleaned.length >= 2 ? cleaned : null;
}

/** A source as Whombat names it: the site with its link, or a mail/file/doc/calendar label. */
export const NamedSourceInput = z.object({
  label: z.string().min(1).max(80),
  url: z.string().url().max(2048).optional(),
});

/** A finding's message: the assistant's words, then its sources on one line (a page as a link, private sources by name). */
export function findingText(text: string, sources: readonly z.infer<typeof NamedSourceInput>[]): string {
  const flat = (s: string) =>
    s
      .replace(/[[\]\n\r*_`]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const line = sources
    .map((s) =>
      s.url
        ? `[${flat(s.label)}](${s.url.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)})`
        : flat(s.label),
    )
    .join(' · ');
  return `${findingWords(text)}\n\n${line}`;
}

/** The least time before an event a finding is still worth telling. */
const TELL_LEAD_MS = 30 * 60_000;

/**
 * The check's end. Nothing found: `quiet`, nothing posted (optional `note` kept for later stages). A finding: told in
 * its event's thread (replying in the existing thread if an earlier stage already posted one) with a push, optional
 * one-tap action chip and feedback replies — unless switched off, stopped, budget reached, night, too close, or event
 * changed meanwhile. Once only.
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
    if (row.state !== 'checking') throw forbidden('You already said what you found for this check.');
    const { report } = input;
    const settings = await aheadSettingsOf(tx, ctx.burrow.id);
    const isMail = row.source === 'mail';
    const calendarOff =
      !isMail && settings.calendarsOff.includes(calendarKey(row.event.connectionId, row.event.calendarId));
    const mailOff = isMail && !settings.mailOn;
    const extraKinds = (report.extraKinds ?? []).filter((k) => k !== report.kind);
    const allKinds = report.kind ? [report.kind, ...extraKinds] : [];
    // If every reported kind was stopped by the person, keep quiet.
    const anyAllowedKind = allKinds.some((k) => !settings.stopped.includes(k));
    // Its words as they would be posted: nothing left of them (only links or markup) is nothing to tell.
    const words = report.text ? findingWords(report.text) : '';
    const actionLabel = cleanShortLabel(report.action, AHEAD_ACTION_MAX);
    const note = cleanShortLabel(report.note, AHEAD_NOTE_MAX);
    const leadOk = isMail || row.event.allDay || row.startAt.getTime() - ctx.now.getTime() >= TELL_LEAD_MS;
    const tellable =
      report.found &&
      report.kind &&
      anyAllowedKind &&
      words.length > 0 &&
      input.sources.length > 0 &&
      input.current &&
      settings.on &&
      !calendarOff &&
      !mailOff &&
      aheadHours(ctx.now, ctx.burrow.timeZone) &&
      leadOk &&
      (await findingsSince(tx, ctx.burrow.id, startOfLocalDay(ctx.now, ctx.burrow.timeZone))) <
        AHEAD_FINDINGS_PER_DAY;
    let told = false;
    if (tellable) {
      const conversation = await loadConversationRow(tx, row.conversationId);
      if (conversation) {
        // Reuse the event's existing thread if an earlier stage already posted a finding that still exists.
        const existingThread = await existingEventThreadRoot(tx, row);
        const suggestions = actionLabel ? [actionLabel, ...AHEAD_REPLIES] : [...AHEAD_REPLIES];
        await postMessage(ctx, {
          conversation,
          id: row.threadRootId,
          ...(existingThread ? { threadRootId: existingThread } : {}),
          text: findingText(words, input.sources),
          suggestions,
          // The person's Chat tells them, inbox and push, as any message of the assistant's there.
          dispatch: false,
          linkPreviews: false,
        });
        told = true;
      }
    }
    await tx
      .update(aheadChecks)
      .set({
        state: told ? 'told' : 'quiet',
        kind: report.found ? (report.kind ?? null) : null,
        extraKinds: report.found ? extraKinds : [],
        text: told ? words : null,
        actionLabel: told ? actionLabel : null,
        note,
        reportedAt: ctx.now,
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
        source: row.source,
        stage: row.stage,
        ...(told && report.kind ? { kind: report.kind } : {}),
      },
    });
    return { told };
  },
});

/** Finds an existing live finding thread root for the same event so multi-stage findings stay in one thread. */
async function existingEventThreadRoot(tx: Tx, row: typeof aheadChecks.$inferSelect): Promise<string | null> {
  if (row.source === 'mail') return null;
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

/** The latest told check whose thread a turn is in (supports multi-stage findings in one event thread), or null. */
export async function toldCheckOfThread(
  tx: Pick<Tx, 'select'>,
  burrowId: string,
  threadRootId: string | null,
) {
  if (!threadRootId) return null;
  const [root] = await tx
    .select()
    .from(aheadChecks)
    .where(
      and(
        eq(aheadChecks.burrowId, burrowId),
        eq(aheadChecks.threadRootId, threadRootId),
        eq(aheadChecks.state, 'told'),
      ),
    );
  if (!root) return null;
  // If a later stage posted a reply in this same event's thread, return the newest told check for that event.
  const [latest] = await tx
    .select()
    .from(aheadChecks)
    .where(
      and(
        eq(aheadChecks.burrowId, burrowId),
        eq(aheadChecks.eventKey, root.eventKey),
        eq(aheadChecks.state, 'told'),
      ),
    )
    .orderBy(desc(aheadChecks.reportedAt))
    .limit(1);
  return latest ?? root;
}

/**
 * The person said a finding wasn't useful (with optional reason), or to stop checking for its kind (in their own turn
 * in its thread, through the assistant). Stopping adds the kind to the setting; `not_useful` + reason calibrates
 * future checks.
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
    if (input.verdict === 'stop_kind') {
      const settings = await aheadSettingsOf(tx, ctx.burrow.id);
      if (!settings.stopped.includes(row.kind))
        await saveSettings(ctx, { ...settings, stopped: [...settings.stopped, row.kind] });
    }
    await ctx.emit({
      type: 'ahead.feedback',
      kind: 'System',
      text: input.verdict === 'stop_kind' ? 'Stopped a kind of Looks ahead check' : null,
      where: null,
      payload: { aheadCheckId: row.id, verdict: input.verdict, kind: row.kind },
    });
    return { kind: row.kind };
  },
});

/* The watcher's bookkeeping ------------------------------------------------------------------------------------------ */

/**
 * Once a pass: checks whose turn ended without a report, or never ran, failed; a finding's thread settles a while after
 * its event ended (or 48h after a mail finding), when the person didn't write in it; rows go a month after their event.
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
      // Resolve actual root message ids (multi-stage replies point to their thread root).
      const msgRows = await tx
        .select({ id: messages.id, threadRootId: messages.threadRootId })
        .from(messages)
        .where(
          inArray(
            messages.id,
            passed.map((p) => p.threadRootId),
          ),
        );
      const rootOf = new Map(msgRows.map((m) => [m.id, m.threadRootId ?? m.id]));
      const actualRoots = [...new Set(passed.map((p) => rootOf.get(p.threadRootId) ?? p.threadRootId))];
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
                      passed.map((p) => p.personId),
                    ),
                  ),
                )
            ).map((m) => m.root)
          : [],
      );
      const byChat = new Map<string, Set<string>>();
      for (const p of passed) {
        const rootId = rootOf.get(p.threadRootId) ?? p.threadRootId;
        if (wrote.has(rootId)) continue;
        const set = byChat.get(p.conversationId) ?? new Set<string>();
        set.add(rootId);
        byChat.set(p.conversationId, set);
      }
      for (const [chat, roots] of byChat) settled += await settleResolvedThreads(ctx, chat, [...roots]);
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
    // What ended checks read goes from the person's Hermes home: no later turn finds it in its past sessions.
    await dropSessions(ctx, await endedAheadSessions(tx, ctx.burrow.id));
    if (failed.length || settled)
      await ctx.emit({
        type: 'ahead.tidied',
        kind: 'System',
        text: null,
        where: null,
        payload: { failed: failed.length, settled },
      });
    return { failed: failed.length, settled };
  },
});

/* The setting -------------------------------------------------------------------------------------------------------- */

/** `looksAhead.update`: switch Looks ahead, incoming mail, a calendar, a kind, or add/remove a standing rule. */
export const updateLooksAhead = defineCommand({
  name: 'looks_ahead.update',
  schema: LooksAheadUpdate,
  async apply(tx, ctx, input): Promise<{ ok: true }> {
    if (ctx.actor.kind !== 'person' || !(await isThePerson(tx, ctx.burrow.id, ctx.actor.id)))
      throw forbidden('Only you can change what Looks ahead checks.');
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
  tidyAhead,
  updateLooksAhead,
];
