/**
 * Looks ahead's commands (docs/decisions/looks-ahead.md), all through the commit pipeline: a check begins (a quiet turn
 * of the assistant's, in a thread that is there only once it finds something), it reports (a finding is posted there
 * with a push, nothing leaves no trace), the person's word on a finding, the watcher's bookkeeping (failed checks, threads
 * of events that passed, old rows), and the setting.
 */
import {
  AHEAD_CHECKS_PER_DAY,
  AHEAD_FINDINGS_PER_DAY,
  AHEAD_KINDS,
  AHEAD_REPLIES,
  AHEAD_SOURCES_MAX,
  AHEAD_TEXT_MAX,
  type AheadKind,
  AheadReportInput,
  aheadHours,
  keepingDatesAndTimes,
  LooksAheadUpdate,
  newId,
} from '@whombat/core';
import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
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
/** A finding's thread settles this long after its event ended. */
export const SETTLE_AFTER_MS = 2 * 3600_000;
/** Checks are kept this long after their event, for the week's count and so a version isn't checked twice. */
export const CHECKS_KEEP_MS = 30 * 24 * 3600_000;

export const NOT_AN_AHEAD_CHECK =
  'This only works while Whombat has you check something on the person’s calendar ahead. Answer in the conversation instead.';
export const NOT_AN_AHEAD_THREAD =
  'ahead_feedback only works in the thread of something you told the person after checking their calendar ahead.';

/** The setting as stored, or the default (on, every default calendar, nothing stopped). */
export async function aheadSettingsOf(tx: Pick<Tx, 'select'>, burrowId: string): Promise<AheadSettings> {
  const [row] = await tx.select().from(looksAheadSettings).where(eq(looksAheadSettings.burrowId, burrowId));
  return row
    ? { on: row.on, calendarsOff: row.calendarsOff, calendarsOn: row.calendarsOn, stopped: row.stopped }
    : { on: true, calendarsOff: [], calendarsOn: [], stopped: [] };
}

async function saveSettings(ctx: ApplyContext, next: AheadSettings): Promise<void> {
  const values = {
    on: next.on,
    calendarsOff: [...next.calendarsOff],
    calendarsOn: [...next.calendarsOn],
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
  key: z.string().min(1).max(3200),
  version: z.string().min(1).max(16),
  /** Where it is read again before a finding is told. */
  connectionId: z.string().min(1).max(64),
  calendarId: z.string().min(1).max(1024),
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
});
export type AheadEventInput = z.infer<typeof AheadEventInput>;

/**
 * Begins one check: the row, and the assistant's quiet turn about it on the background model, for the person, in the
 * person's Chat, in a thread of its own whose first message (its id held by the row) is posted only when it finds
 * something. Nothing is posted now and nothing shows it at work.
 */
export const startAheadCheck = defineCommand({
  name: 'ahead.check_start',
  // A new turn: a lapsed appliance refuses it up front (LC-10).
  licence: 'agentTurn',
  schema: z.object({ event: AheadEventInput, personId: z.string().min(1).max(64) }),
  async apply(tx, ctx, input): Promise<{ checkId: string; dispatchId: string } | null> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the assistant checks ahead.');
    const { event } = input;
    // Never two checks of one version, nor one while another works.
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
    // The finding's thread: its first message gets this id when there is one to post.
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
    await tx.insert(aheadChecks).values({
      id,
      burrowId: ctx.burrow.id,
      agentId: agent.id,
      personId: person.id,
      eventKey: event.key,
      version: event.version,
      summary: event.summary,
      location: event.location,
      calendar: event.calendar,
      startAt: new Date(event.start),
      endAt: new Date(event.end),
      event: {
        start: event.start,
        end: event.end,
        description: event.description,
        timeZone: event.timeZone,
        connectionId: event.connectionId,
        calendarId: event.calendarId,
        eventId: event.eventId,
        guests: event.guests,
      },
      state: 'checking',
      dispatchId: woken.dispatchId,
      conversationId: chatId,
      threadRootId,
      startedAt: ctx.now,
    });
    // Signed without the event's words: what is on someone's calendar stays out of the log.
    await ctx.emit({
      type: 'ahead.check_started',
      kind: 'System',
      text: null,
      where: null,
      payload: { aheadCheckId: id, dispatchId: woken.dispatchId },
    });
    return { checkId: id, dispatchId: woken.dispatchId };
  },
});

/* Mail closes the web ------------------------------------------------------------------------------------------------ */

/**
 * A check is about to read mail: kept on its row before the mail reaches the model, so nothing more of it goes to the
 * web — not after a restart, nor in a later claim of the same turn.
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
 * The assistant's words as one plain paragraph that can hold no link, picture, site, address or phone number: markup
 * characters go first, then every address (`http:`, `https:`, `mailto:`, `data:`, `www.`, e-mail), bare sites and phone
 * numbers, again until nothing changes, so none can be put back together from what is left. Its sources are Whombat's.
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

/** A source as Whombat names it: the site with its link, or the mail's sender. */
export const NamedSourceInput = z.object({
  label: z.string().min(1).max(80),
  url: z.string().url().max(2048).optional(),
});

/** A finding's message: the assistant's words, then its sources on one line (a page as a link, a mail by name). */
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
 * The check's end. Nothing found: `quiet`, nothing posted. A finding: told in its own thread with a push and the quick
 * replies — unless Looks ahead or its calendar was switched off, the person stopped its kind, two were told today, it is
 * night, the event is about to start or already began, or the event changed or went meanwhile (`current`): then `quiet`,
 * its kind kept for the count. Once only.
 */
export const reportAhead = defineCommand({
  name: 'ahead.report',
  schema: z.object({
    dispatchId: z.string().min(1).max(64),
    report: AheadReportInput,
    /** The finding's sources as Whombat named them, checked against what the turn saw. */
    sources: z.array(NamedSourceInput).max(AHEAD_SOURCES_MAX),
    /** The event is still as the check began it. */
    current: z.boolean(),
  }),
  async apply(tx, ctx, input): Promise<{ told: boolean }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the assistant says what it found.');
    const row = await checkOfTurn(tx, ctx.burrow.id, input.dispatchId);
    if (!row || row.agentId !== ctx.actor.id) throw forbidden(NOT_AN_AHEAD_CHECK);
    if (row.state !== 'checking') throw forbidden('You already said what you found for this check.');
    const { report } = input;
    const settings = await aheadSettingsOf(tx, ctx.burrow.id);
    const calendarOff = settings.calendarsOff.includes(
      calendarKey(row.event.connectionId, row.event.calendarId),
    );
    // Its words as they would be posted: nothing left of them (only links or markup) is nothing to tell.
    const words = report.text ? findingWords(report.text) : '';
    const tellable =
      report.found &&
      report.kind &&
      words.length > 0 &&
      input.sources.length > 0 &&
      input.current &&
      settings.on &&
      !calendarOff &&
      !settings.stopped.includes(report.kind) &&
      aheadHours(ctx.now, ctx.burrow.timeZone) &&
      row.startAt.getTime() - ctx.now.getTime() >= TELL_LEAD_MS &&
      (await findingsSince(tx, ctx.burrow.id, startOfLocalDay(ctx.now, ctx.burrow.timeZone))) <
        AHEAD_FINDINGS_PER_DAY;
    let told = false;
    if (tellable) {
      const conversation = await loadConversationRow(tx, row.conversationId);
      if (conversation) {
        await postMessage(ctx, {
          conversation,
          id: row.threadRootId,
          text: findingText(words, input.sources),
          suggestions: AHEAD_REPLIES,
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
        text: told ? words : null,
        reportedAt: ctx.now,
      })
      .where(eq(aheadChecks.id, row.id));
    await ctx.emit({
      type: 'ahead.reported',
      kind: 'System',
      text: null,
      where: null,
      payload: { aheadCheckId: row.id, told, ...(told && report.kind ? { kind: report.kind } : {}) },
    });
    return { told };
  },
});

/* The person's word on a finding ------------------------------------------------------------------------------------- */

/** The told check whose thread a turn is in, or null. */
export async function toldCheckOfThread(
  tx: Pick<Tx, 'select'>,
  burrowId: string,
  threadRootId: string | null,
) {
  if (!threadRootId) return null;
  const [row] = await tx
    .select()
    .from(aheadChecks)
    .where(
      and(
        eq(aheadChecks.burrowId, burrowId),
        eq(aheadChecks.threadRootId, threadRootId),
        eq(aheadChecks.state, 'told'),
      ),
    );
  return row ?? null;
}

/**
 * The person said a finding wasn't useful, or to stop checking for its kind (in their own turn in its thread, through
 * the assistant). Stopping adds the kind to the setting, where Settings shows it to turn back on.
 */
export const aheadFeedback = defineCommand({
  name: 'ahead.feedback',
  schema: z.object({ dispatchId: z.string().min(1).max(64), verdict: z.enum(['not_useful', 'stop_kind']) }),
  async apply(tx, ctx, input): Promise<{ kind: AheadKind }> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the assistant notes this.');
    const [dispatch] = await tx.select().from(dispatches).where(eq(dispatches.id, input.dispatchId));
    if (!dispatch || dispatch.burrowId !== ctx.burrow.id || dispatch.agentId !== ctx.actor.id)
      throw forbidden(NOT_AN_AHEAD_THREAD);
    // Only the person's own turn: their word, not a stranger's.
    if (!dispatch.onBehalfOfAccountId || dispatch.trigger === 'ahead') throw forbidden(NOT_AN_AHEAD_THREAD);
    const row = await toldCheckOfThread(tx, ctx.burrow.id, dispatch.threadRootId);
    if (!row?.kind) throw forbidden(NOT_AN_AHEAD_THREAD);
    await tx.update(aheadChecks).set({ feedback: input.verdict }).where(eq(aheadChecks.id, row.id));
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
 * its event ended, when the person didn't write in it; rows go a month after their event.
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
    // Threads of events that passed: settled as resolved when the person didn't write in them.
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
      const wrote = new Set(
        (
          await tx
            .select({ root: messages.threadRootId })
            .from(messages)
            .where(
              and(
                inArray(
                  messages.threadRootId,
                  passed.map((p) => p.threadRootId),
                ),
                inArray(
                  messages.authorId,
                  passed.map((p) => p.personId),
                ),
              ),
            )
        ).map((m) => m.root),
      );
      const byChat = new Map<string, string[]>();
      for (const p of passed) {
        if (wrote.has(p.threadRootId)) continue;
        byChat.set(p.conversationId, [...(byChat.get(p.conversationId) ?? []), p.threadRootId]);
      }
      for (const [chat, roots] of byChat) settled += await settleResolvedThreads(ctx, chat, roots);
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

/** `looksAhead.update`: the person switches Looks ahead, one calendar or one kind; signed without calendar names. */
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
      // Kept as a change from the default: on where it is off by default, off where it is on.
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
