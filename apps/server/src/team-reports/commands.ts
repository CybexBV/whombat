/**
 * Reports to the Whombat Team through the commit pipeline (docs/decisions/team-reports.md). Control keeps the reports;
 * the calls to it happen outside any transaction (`service.ts`), and these commands keep what it answered:
 *
 * - `team_report_keep`: a whole report as control answered it, and whether the person has read it now (its
 *   notifications are read then too);
 * - `team_report_seen`: control's list. A team change shows as unread; a report waiting for the person (a question or
 *   a fix to try) that the team changed is an Inbox item and a notification in fixed words, never the team's;
 * - `team_report_forget`: a report that is gone (withdrawn, or no longer at control) leaves the box at once, with its
 *   notifications;
 * - `team_reports_drop`: every copy goes (a backup restored onto new hardware, a box taken out of Link).
 *
 * The assistant drafts: `team_report_draft_save` keeps its draft and `team_report_draft_send` always asks the
 * person on a card that quotes exactly what goes, whatever the assistant's keys say; their yes sends it as them
 * (`sendDraftForAssistant`), and the card's Edit opens the form with the draft. Either way a send first reserves the
 * draft (`sending`, with the words it sends), so the card and the form never send it at once; a failed send gives it
 * back (`team_report_draft_release`). Sent from the form, the card that still asks about it is withdrawn
 * (`team_report_draft_done`).
 */
import { randomBytes } from 'node:crypto';
import {
  conversationLabel,
  TEAM_REPORT_DRAFT_ACTION,
  TEAM_REPORT_EXPECTED_MAX,
  TEAM_REPORT_TEXT_MAX,
  TEAM_REPORTS_LIST_MAX,
  TeamReport,
  TeamReportKind,
  type TeamReportStatus,
  TeamReportSummary,
  teamReportNeedsYou,
} from '@whombat/core/domain';
import { and, eq, inArray, isNull, lt, ne, notInArray, or, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { publishApproval, syncPlanSteps } from '../approvals/engine';
import { type ApplyContext, defineCommand, type KeyRequirement } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { approvals, notifications, teamReportCopies, teamReportDrafts } from '../db/schema/index';
import { publishNotificationsRead } from '../domain/notification-read';
import { notifyInCommit } from '../domain/notify';
import { GENERIC_PUSH_TITLE } from '../domain/push-preview';
import { thePerson } from '../domain/the-person';
import { homeAudience, publishHomeChanged } from '../home/notify';
import { ApiError, conflict, forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { toApproval } from '../read/work';
import { quoted } from '../trackers/reply';
import { TEAM_REPORT_WORDS } from './control';
import { noteDraftSending, teamReportsGeneration } from './in-flight';
import { sendDraftForAssistant } from './service';
import { teamReportWithdrawnLately } from './withdrawn';

export const TEAM_REPORT_SENT_EVENT = 'team_report.sent';
export const TEAM_REPORT_WITHDRAWN_EVENT = 'team_report.withdrawn';

/**
 * The key the assistant's ask names: what it sends goes to people outside this Whombat. It always asks whatever the
 * person set for it (the grants below), like a shared link, and the card offers no “Always allow”.
 */
export const TEAM_REPORT_KEY_ID = 'messages.external';
/**
 * The approval action's name, which the apps' card reads to offer Edit (the form with `data.draftId`) and to show the
 * draft's words (`data.text`, `data.expected`).
 */
export const TEAM_REPORT_ACTION = TEAM_REPORT_DRAFT_ACTION;

/** The page of one report in the apps, under the burrow. */
export const teamReportHref = (reportId: string) => `/reports/${encodeURIComponent(reportId)}`;

/** The form with the assistant's draft (its card's Edit), under the burrow. */
export const teamReportDraftHref = (draftId: string) => `/reports/new?draft=${encodeURIComponent(draftId)}`;

/**
 * The fixed words for a report that waits for the person: the push, the notification and the Inbox item say
 * only these, never the team's words.
 */
export const TEAM_REPORT_NOTICE_WORDS = {
  needs_information: {
    title: 'The Whombat Team asked about your report',
    body: (n: number) => `Open report #${n} to answer.`,
  },
  available: {
    title: 'A fix for your report is ready to try',
    body: (n: number) => `Try it, then say in report #${n} whether it works.`,
  },
  open: 'Open the report',
} as const;

/** The fixed title for a status that waits for the person; null for any other. */
export function teamReportNoticeTitle(status: TeamReportStatus): string | null {
  return status === 'needs_information' || status === 'available'
    ? TEAM_REPORT_NOTICE_WORDS[status].title
    : null;
}

const at = (seconds: number) => new Date(seconds * 1000);

type CopyRow = typeof teamReportCopies.$inferSelect;
type Summary = z.output<typeof TeamReportSummary>;

/** The columns a summary sets on a copy. */
function summaryColumns(s: Summary) {
  return {
    number: s.number,
    kind: s.kind,
    title: s.title,
    status: s.status,
    createdAt: at(s.createdAt),
    updatedAt: at(s.updatedAt),
  };
}

/**
 * Whether what control answered is older than the copy: answers can cross (a reply's answer, then a read that left
 * before it), and a lower revision, or the same one changed earlier, would move the copy back.
 */
export function teamReportOlderThanCopy(
  had: Pick<CopyRow, 'revision' | 'updatedAt'>,
  s: Pick<Summary, 'revision' | 'updatedAt'>,
): boolean {
  return s.revision < had.revision || (s.revision === had.revision && at(s.updatedAt) < had.updatedAt);
}

/** Whether a copy already says what control's summary says (or more: the summary is older). */
export function sameTeamReportSummary(
  had: Pick<CopyRow, 'status' | 'revision' | 'title' | 'updatedAt'>,
  s: Pick<Summary, 'status' | 'revision' | 'title' | 'updatedAt'>,
): boolean {
  if (teamReportOlderThanCopy(had, s)) return true;
  return (
    had.status === s.status &&
    had.revision >= s.revision &&
    had.title === s.title &&
    had.updatedAt.getTime() === at(s.updatedAt).getTime()
  );
}

/**
 * Whether control's summary is something to tell the person: the report waits for them (a question, a fix to try) and
 * the team changed it since the box last saw it (its revision moved), or the box sees it for the first time
 * (`before` null). The revision counts the team's changes only, so a move is always the team's newest word, and the
 * person's own reply never notifies them; each revision is told once (`team-report:<id>:<revision>`).
 */
export function teamReportTellsPerson(
  before: Pick<CopyRow, 'revision'> | null,
  after: Pick<Summary, 'status' | 'revision'>,
): boolean {
  return teamReportNeedsYou(after.status) && (!before || after.revision > before.revision);
}

/** Home reads its Inbox again (an item came or went). */
async function inboxChanged(ctx: ApplyContext): Promise<void> {
  publishHomeChanged(ctx, await homeAudience(ctx, ctx.burrow.id), ['needsYou']);
}

/**
 * Whether a call that started at `generation` may still write copies: a drop of every copy since (the box left Link,
 * or moved to new hardware) makes its answer one about reports the box no longer keeps.
 */
function droppedSince(ctx: ApplyContext, generation: number | undefined): boolean {
  return generation !== undefined && generation !== teamReportsGeneration(ctx.services);
}

/** The copy of the whole report the person sees instead of an older answer, when it is at least as new. */
function keptShown(had: CopyRow, r: Pick<Summary, 'revision'>): TeamReport | null {
  const kept = TeamReport.safeParse(had.report);
  return kept.success && kept.data.revision >= r.revision ? kept.data : null;
}

/**
 * The person's report as the box keeps it now: the whole report, and whether they read it (its notifications are read
 * with it). An answer older than the copy (`older`) leaves the copy as it is, and the person reads the copy's whole
 * report when it is at least as new as the answer (`kept`), else the answer. A report the person took back a moment
 * ago (an answer that left before the withdrawal) is kept no more (`withdrawn`), and nothing is kept from a call that
 * started before every copy was dropped (`dropped`).
 */
export const keepTeamReport = defineCommand({
  name: 'team_report_keep',
  schema: z.object({
    report: TeamReport,
    read: z.boolean(),
    sent: z.boolean().default(false),
    generation: z.number().int().min(0).optional(),
  }),
  async apply(tx, ctx, input) {
    const r = input.report;
    const nothing = { reportId: r.id, older: false, kept: false, withdrawn: false, dropped: false };
    if (teamReportWithdrawnLately(ctx.services, ctx.burrow.id, r.id)) return { ...nothing, withdrawn: true };
    if (droppedSince(ctx, input.generation)) return { ...nothing, dropped: true };
    const [had] = await tx
      .select()
      .from(teamReportCopies)
      .where(and(eq(teamReportCopies.burrowId, ctx.burrow.id), eq(teamReportCopies.reportId, r.id)))
      .for('update');
    if (input.read) await settleTeamReportNotices(ctx, [r.id], 'read');
    if (had && teamReportOlderThanCopy(had, r)) {
      const shown = keptShown(had, r);
      const readRevision = input.read ? Math.max(had.readRevision, (shown ?? r).revision) : had.readRevision;
      if (readRevision !== had.readRevision)
        await tx
          .update(teamReportCopies)
          .set({ readRevision })
          .where(and(eq(teamReportCopies.burrowId, ctx.burrow.id), eq(teamReportCopies.reportId, r.id)));
      return { ...nothing, older: true, kept: shown !== null };
    }
    const readRevision = input.read ? Math.max(had?.readRevision ?? 0, r.revision) : (had?.readRevision ?? 0);
    // Control's revision only grows: an answer that crossed a newer list doesn't move it back.
    const revision = Math.max(had?.revision ?? 0, r.revision);
    const values = { ...summaryColumns(r), revision, readRevision, report: r, copiedAt: ctx.now };
    if (had)
      await tx
        .update(teamReportCopies)
        .set(values)
        .where(and(eq(teamReportCopies.burrowId, ctx.burrow.id), eq(teamReportCopies.reportId, r.id)));
    else
      await tx.insert(teamReportCopies).values({
        burrowId: ctx.burrow.id,
        reportId: r.id,
        ...values,
        createdById: ctx.actor.kind === 'person' ? ctx.actor.id : null,
      });
    // Once per report: a retry of the same send answers the same report, already logged.
    if (input.sent && !had)
      await ctx.emit({
        type: TEAM_REPORT_SENT_EVENT,
        kind: 'Messages',
        text:
          r.kind === 'idea' ? 'Sent an idea to the Whombat Team' : 'Reported a problem to the Whombat Team',
        where: 'Reports',
        // Ids only: the person's words stay out of the log.
        payload: { reportId: r.id, number: r.number, kind: r.kind },
      });
    if (teamReportNeedsYou(r.status) !== (had ? teamReportNeedsYou(had.status as TeamReportStatus) : false))
      await inboxChanged(ctx);
    return nothing;
  },
});

/**
 * The link a notification about a report opens: the report's page by its path, so it opens wherever the person uses
 * Whombat (the hosted app, the box's own address, the phone) and never names an address the phone doesn't know.
 */
export function teamReportLink(reportId: string) {
  return { type: 'external' as const, url: teamReportHref(reportId) };
}

/**
 * Control's list of the box's reports: the copies take its summaries (a report the box didn't know comes in unread
 * when the team changed it), and with the whole list (`complete`) copies of reports control no longer keeps go, with
 * their notifications; only copies the box had before the list was asked (`startedAt`, ms), never one a send made
 * while it was on its way. A report waiting for the person is told to them in fixed words: when the box first sees it
 * so, and each time the team changes it while it waits. A report the person took back a moment ago (a list that left
 * before the withdrawal) comes back neither as a copy nor as a notification, and a list that started before every
 * copy was dropped keeps nothing (`generation`).
 */
export const seeTeamReports = defineCommand({
  name: 'team_report_seen',
  schema: z.object({
    reports: z.array(TeamReportSummary).max(TEAM_REPORTS_LIST_MAX),
    complete: z.boolean(),
    startedAt: z.number().int().min(0).optional(),
    generation: z.number().int().min(0).optional(),
  }),
  async apply(tx, ctx, input) {
    const burrowId = ctx.burrow.id;
    if (droppedSince(ctx, input.generation)) return { told: 0, gone: 0, dropped: true };
    const rows = await tx
      .select()
      .from(teamReportCopies)
      .where(eq(teamReportCopies.burrowId, burrowId))
      .for('update');
    const byId = new Map(rows.map((r) => [r.reportId, r]));
    const tell: Summary[] = [];
    let changed = false;
    const listed = input.reports.filter((s) => !teamReportWithdrawnLately(ctx.services, burrowId, s.id));
    for (const s of listed) {
      const had = byId.get(s.id);
      if (!had) {
        await tx.insert(teamReportCopies).values({
          burrowId,
          reportId: s.id,
          ...summaryColumns(s),
          revision: s.revision,
          readRevision: 0,
          report: null,
          createdById: null,
          copiedAt: ctx.now,
        });
        changed ||= teamReportNeedsYou(s.status);
        if (teamReportTellsPerson(null, s)) tell.push(s);
        continue;
      }
      if (sameTeamReportSummary(had, s)) continue;
      await tx
        .update(teamReportCopies)
        .set({ ...summaryColumns(s), revision: Math.max(had.revision, s.revision), copiedAt: ctx.now })
        .where(and(eq(teamReportCopies.burrowId, burrowId), eq(teamReportCopies.reportId, s.id)));
      if (teamReportNeedsYou(s.status) !== teamReportNeedsYou(had.status as TeamReportStatus)) changed = true;
      if (teamReportTellsPerson(had, s)) tell.push(s);
    }
    let gone = 0;
    if (input.complete) {
      const kept = listed.map((s) => s.id);
      const left = await tx
        .delete(teamReportCopies)
        .where(
          and(
            eq(teamReportCopies.burrowId, burrowId),
            kept.length ? notInArray(teamReportCopies.reportId, kept) : undefined,
            // A copy made while the list was on its way (a new report) isn't in it yet.
            input.startedAt !== undefined
              ? lt(teamReportCopies.copiedAt, new Date(input.startedAt))
              : undefined,
          ),
        )
        .returning({ reportId: teamReportCopies.reportId, status: teamReportCopies.status });
      gone = left.length;
      if (left.some((l) => teamReportNeedsYou(l.status as TeamReportStatus))) changed = true;
      await settleTeamReportNotices(
        ctx,
        left.map((l) => l.reportId),
        'remove',
      );
    }
    const person = tell.length ? await thePerson(tx, burrowId) : null;
    let told = 0;
    for (const s of person ? tell : []) {
      const words = TEAM_REPORT_NOTICE_WORDS[s.status as 'needs_information' | 'available'];
      const dedupKey = `${teamReportNoticePrefix(s.id)}${s.revision}`;
      if (!person || (await notifiedAlready(tx, person.id, dedupKey))) continue;
      await notifyInCommit(ctx, {
        burrowId,
        burrowSlug: ctx.burrow.slug,
        principalId: person.id,
        kind: 'needs_you',
        actorId: ctx.actor.id,
        where: `Report #${s.number}`,
        text: words.title,
        link: teamReportLink(s.id),
        createdAt: ctx.now,
        dedupKey,
        group: teamReportPushGroup(s.id),
      });
      told += 1;
    }
    if (changed || tell.length) await inboxChanged(ctx);
    return { told, gone, dropped: false };
  },
});

/** The start of the dedup key of a report's notifications, one per revision (`team-report:<id>:<revision>`). */
const teamReportNoticePrefix = (reportId: string) => `team-report:${reportId}:`;
/** A report's notifications on the person's phones, as one group. */
const teamReportPushGroup = (reportId: string) => `team-report:${reportId}`;

/**
 * The person read a report (`read`), or it is gone (`remove`: withdrawn, no longer at control, every copy dropped): its
 * notifications are read, the person's devices told (`notification.read`) and, on a managed Whombat, its push leaves
 * their phones, as reading a message's does; gone, they are deleted too. Nothing is said.
 */
async function settleTeamReportNotices(
  ctx: ApplyContext,
  reportIds: readonly string[] | 'all',
  how: 'read' | 'remove',
): Promise<number> {
  if (reportIds !== 'all' && !reportIds.length) return 0;
  const about: SQL | undefined =
    reportIds === 'all'
      ? sql`starts_with(${notifications.dedupKey}, 'team-report:')`
      : or(
          ...reportIds.map(
            (id) => sql`starts_with(${notifications.dedupKey}, ${teamReportNoticePrefix(id)})`,
          ),
        );
  const read = await ctx.tx
    .update(notifications)
    .set({ readAt: ctx.now })
    .where(and(eq(notifications.burrowId, ctx.burrow.id), about, isNull(notifications.readAt)))
    .returning({
      id: notifications.id,
      principalId: notifications.principalId,
      dedupKey: notifications.dedupKey,
    });
  if (how === 'remove')
    await ctx.tx.delete(notifications).where(and(eq(notifications.burrowId, ctx.burrow.id), about));
  if (!read.length) return 0;
  const byPerson = new Map<string, string[]>();
  for (const r of read) byPerson.set(r.principalId, [...(byPerson.get(r.principalId) ?? []), r.id]);
  for (const [principalId, ids] of byPerson) await publishNotificationsRead(ctx, principalId, { ids });
  const control = ctx.services.push.control;
  if (control) {
    const slug = ctx.burrow.slug;
    const clears = new Set(
      read.map((r) => {
        const key = r.dedupKey ?? '';
        return `${r.principalId}|${key.slice(0, key.lastIndexOf(':'))}`;
      }),
    );
    ctx.background('team report push cleared', async () => {
      for (const clear of clears) {
        const [principalId = '', group = ''] = clear.split('|');
        await control(
          [principalId],
          {
            burrow: slug,
            notificationId: null,
            kind: 'needs_you',
            title: GENERIC_PUSH_TITLE,
            body: '',
            path: `/${slug}`,
          },
          { group, clear: true },
        );
      }
    });
  }
  return read.length;
}

async function notifiedAlready(tx: Tx, principalId: string, dedupKey: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.principalId, principalId), eq(notifications.dedupKey, dedupKey)))
    .limit(1);
  return !!row;
}

/**
 * A report that is gone: its copy and its notifications leave the box. `withdrawn`: the person took it back (the log
 * says so).
 */
export const forgetTeamReport = defineCommand({
  name: 'team_report_forget',
  schema: z.object({ reportId: z.string().min(1).max(64), withdrawn: z.boolean() }),
  async apply(tx, ctx, input) {
    const [gone] = await tx
      .delete(teamReportCopies)
      .where(and(eq(teamReportCopies.burrowId, ctx.burrow.id), eq(teamReportCopies.reportId, input.reportId)))
      .returning();
    if (input.withdrawn)
      await ctx.emit({
        type: TEAM_REPORT_WITHDRAWN_EVENT,
        kind: 'Messages',
        text: 'Took back a report to the Whombat Team',
        where: 'Reports',
        payload: { reportId: input.reportId, number: gone?.number ?? null, kind: gone?.kind ?? null },
      });
    await settleTeamReportNotices(ctx, [input.reportId], 'remove');
    if (gone && teamReportNeedsYou(gone.status as TeamReportStatus)) await inboxChanged(ctx);
    return { reportId: input.reportId, gone: !!gone };
  },
});

/**
 * Every copy of the burrow's reports goes, with their notifications, and with `drafts` the assistant's drafts not sent
 * yet: a backup restored onto new hardware starts without the earlier box's reports, and a box taken out of Link keeps
 * none. The cards still asking about those drafts are withdrawn with them, so no yes is left that would send nothing.
 */
export const dropTeamReports = defineCommand({
  name: 'team_reports_drop',
  schema: z.object({ drafts: z.boolean() }),
  async apply(tx, ctx, input) {
    const copies = await tx
      .delete(teamReportCopies)
      .where(eq(teamReportCopies.burrowId, ctx.burrow.id))
      .returning({ status: teamReportCopies.status });
    await settleTeamReportNotices(ctx, 'all', 'remove');
    const drafts = input.drafts
      ? await tx
          .delete(teamReportDrafts)
          .where(and(eq(teamReportDrafts.burrowId, ctx.burrow.id), ne(teamReportDrafts.state, 'sent')))
          .returning({ id: teamReportDrafts.id, approvalId: teamReportDrafts.approvalId })
      : [];
    let withdrawn = 0;
    for (const d of drafts)
      if (d.approvalId && (await withdrawDraftCard(ctx, d.approvalId, DRAFT_CARD_WITHDRAWN.dropped)))
        withdrawn += 1;
    if (copies.some((c) => teamReportNeedsYou(c.status as TeamReportStatus))) await inboxChanged(ctx);
    return { copies: copies.length, drafts: drafts.length, withdrawn };
  },
});

/* The assistant's drafts ------------------------------------------------------------------------------------------- */

type DraftRow = typeof teamReportDrafts.$inferSelect;

export async function loadDraft(db: Db | Tx, burrowId: string, draftId: string): Promise<DraftRow> {
  const [row] = await db.select().from(teamReportDrafts).where(eq(teamReportDrafts.id, draftId));
  if (!row || row.burrowId !== burrowId) throw notFound('Draft');
  return row;
}

/** The assistant's draft, kept for the card and the form. */
export const saveTeamReportDraft = defineCommand({
  name: 'team_report_draft_save',
  schema: z.object({
    kind: TeamReportKind,
    text: z.string().trim().min(1).max(TEAM_REPORT_TEXT_MAX),
    expected: z.string().trim().max(TEAM_REPORT_EXPECTED_MAX),
    personId: z.string().min(1).max(64),
    conversationId: z.string().min(1).max(64).nullable(),
  }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden();
    const id = `trd_${randomBytes(16).toString('base64url')}`;
    await tx.insert(teamReportDrafts).values({
      id,
      burrowId: ctx.burrow.id,
      personId: input.personId,
      agentId: ctx.actor.id,
      conversationId: input.conversationId,
      kind: input.kind,
      text: input.text,
      expected: input.expected,
      state: 'waiting',
      createdAt: ctx.now,
    });
    return { id };
  },
});

/** The card's words: exactly what would be sent, quoted. */
export function draftCardText(draft: Pick<DraftRow, 'kind' | 'text' | 'expected'>): string {
  const what = draft.kind === 'idea' ? 'this idea' : 'this problem';
  const expected = draft.expected ? `\n\nWhat you expected:\n\n${quoted(draft.expected)}` : '';
  return `I wrote down ${what} for the Whombat Team. Nothing goes until you say yes.\n\n${quoted(draft.text)}${expected}`;
}

/** What one send of a draft carries: the kind and the words, exactly. */
export const TeamReportDraftWords = z.object({
  kind: TeamReportKind,
  text: z.string().trim().min(1).max(TEAM_REPORT_TEXT_MAX),
  expected: z.string().trim().max(TEAM_REPORT_EXPECTED_MAX),
});
export type TeamReportDraftWords = z.output<typeof TeamReportDraftWords>;

/** The draft, locked for this commit. */
async function lockDraft(ctx: ApplyContext, draftId: string): Promise<DraftRow> {
  const [draft] = await ctx.tx
    .select()
    .from(teamReportDrafts)
    .where(and(eq(teamReportDrafts.id, draftId), eq(teamReportDrafts.burrowId, ctx.burrow.id)))
    .for('update');
  if (!draft) throw notFound('Draft');
  return draft;
}

/**
 * One send of the draft may go now: it becomes `sending` with the words it sends, in the same commit, and this process
 * notes it sends it. Refused while another send of it is on its way (the card's yes or the form, on any device) and once
 * it went: control would answer the same report for both, and the other's words would be lost.
 */
async function reserveDraft(ctx: ApplyContext, draft: DraftRow, words: TeamReportDraftWords): Promise<void> {
  if (draft.state === 'sent') throw conflict(TEAM_REPORT_WORDS.draftSent);
  if (draft.state === 'sending') throw conflict(TEAM_REPORT_WORDS.draftSending);
  await ctx.tx
    .update(teamReportDrafts)
    .set({ state: 'sending', kind: words.kind, text: words.text, expected: words.expected })
    .where(eq(teamReportDrafts.id, draft.id));
  noteDraftSending(ctx.services, draft.id);
}

/** The form sends the person's words for the assistant's draft: it is theirs to send, and only one send goes at once. */
export const reserveTeamReportDraft = defineCommand({
  name: 'team_report_draft_reserve',
  schema: TeamReportDraftWords.extend({ draftId: z.string().min(8).max(64) }),
  async apply(_tx, ctx, input) {
    const draft = await lockDraft(ctx, input.draftId);
    if (ctx.actor.kind !== 'person' || ctx.actor.id !== draft.personId) throw notFound('Draft');
    await reserveDraft(ctx, draft, input);
    return { draftId: draft.id };
  },
});

/** A send of the draft didn't go: it waits again, and the card's yes or the form may try once more. */
export const releaseTeamReportDraft = defineCommand({
  name: 'team_report_draft_release',
  schema: z.object({ draftId: z.string().min(8).max(64) }),
  async apply(tx, ctx, input) {
    const back = await tx
      .update(teamReportDrafts)
      .set({ state: 'waiting' })
      .where(
        and(
          eq(teamReportDrafts.id, input.draftId),
          eq(teamReportDrafts.burrowId, ctx.burrow.id),
          eq(teamReportDrafts.state, 'sending'),
        ),
      )
      .returning({ id: teamReportDrafts.id });
    return { released: back.length > 0 };
  },
});

/** The words the card quoted (its approval's data), which its yes sends; the draft's own when it carries none. */
async function cardWords(ctx: ApplyContext, draft: DraftRow): Promise<TeamReportDraftWords> {
  const own = { kind: draft.kind, text: draft.text, expected: draft.expected };
  if (!ctx.approvalId) return TeamReportDraftWords.parse(own);
  const [row] = await ctx.tx
    .select({ action: approvals.action })
    .from(approvals)
    .where(and(eq(approvals.id, ctx.approvalId), eq(approvals.burrowId, ctx.burrow.id)));
  const action = row?.action;
  const data =
    action?.type === 'custom' && action.params.name === TEAM_REPORT_ACTION
      ? ((action.params.data ?? {}) as Record<string, unknown>)
      : {};
  const quotedWords = TeamReportDraftWords.safeParse({
    kind: data.kind ?? draft.kind,
    text: data.text,
    expected: data.expected ?? '',
  });
  return quotedWords.success ? quotedWords.data : TeamReportDraftWords.parse(own);
}

/**
 * Sending the assistant's draft: always a card first, whatever its keys say. On the person's yes this runs again as the
 * assistant with the approval: it reserves the draft with the words the card quoted, and the report goes out right
 * after the commit (`sendDraftForAssistant`, a step the approval waits for). A send that didn't go, or a draft the form
 * is sending or sent already, fails the approval's execution in plain words, so the card says it didn't work; the
 * assistant is woken with how it went either way.
 */
export const sendTeamReportDraft = defineCommand({
  name: 'team_report_draft_send',
  schema: z.object({ draftId: z.string().min(8).max(64) }),
  async requiredKey(input, { db, burrow, actor }): Promise<KeyRequirement | null> {
    if (actor.kind === 'person') return null;
    const draft = await loadDraft(db, burrow.id, input.draftId);
    return {
      keyId: TEAM_REPORT_KEY_ID,
      // Always asks: only the person's press sends their words to the team.
      grants: [{ agentId: actor.id, keyId: TEAM_REPORT_KEY_ID, tier: 'ask' }],
      attempt: 'send a report to the Whombat Team',
      action: {
        type: 'custom',
        params: {
          name: TEAM_REPORT_ACTION,
          keyId: TEAM_REPORT_KEY_ID,
          // The words go with the card, so every place it can be answered shows exactly what would be sent, and its
          // yes sends exactly these.
          data: { draftId: draft.id, kind: draft.kind, text: draft.text, expected: draft.expected },
        },
      },
      where: 'Reports',
      conversationId: draft.conversationId,
      approval: {
        title:
          draft.kind === 'idea' ? 'Send an idea to the Whombat Team' : 'Report a problem to the Whombat Team',
        question: 'Send this to the Whombat Team?',
        target: 'Whombat Team',
        whatHappens: [
          'The Whombat Team and its AI assistant read it, with this Whombat’s version.',
          'You follow their answer under Reports, and can take it back there.',
        ],
        explainer: `${actor.shortName} always asks before telling the Whombat Team anything. Only your yes sends it, exactly as shown. Edit changes it first.`,
        cardText: draftCardText(draft),
      },
    };
  },
  async apply(_tx, ctx, input) {
    const draft = await lockDraft(ctx, input.draftId);
    if (ctx.actor.kind === 'agent' && !ctx.approvalId) throw forbidden();
    if (ctx.actor.kind === 'person' && ctx.actor.id !== draft.personId) throw forbidden();
    const words = await cardWords(ctx, draft);
    let refused: string | null = null;
    try {
      await reserveDraft(ctx, draft, words);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      refused = err.message;
    }
    const services = ctx.services;
    const call = {
      draftId: draft.id,
      personId: draft.personId,
      agentId: draft.agentId ?? ctx.actor.id,
      approvalId: ctx.approvalId,
      conversationId: draft.conversationId,
      words,
      refused,
    };
    // The send happens after this commit, outside any transaction, and the approval waits for it: its failure is the
    // commit's, so the card says the send didn't work. The assistant is woken with how it went.
    const burrowId = ctx.burrow.id;
    ctx.complete(async () => {
      await sendDraftForAssistant(services, burrowId, call);
      return [];
    });
    return { draftId: draft.id, reserved: refused === null };
  },
});

/** The card that asks about the draft, so a decline makes it done. */
export const askedTeamReportDraft = defineCommand({
  name: 'team_report_draft_asked',
  schema: z.object({ draftId: z.string().min(8).max(64), approvalId: z.string().min(1).max(64) }),
  async apply(tx, ctx, input) {
    await tx
      .update(teamReportDrafts)
      .set({ approvalId: input.approvalId })
      .where(and(eq(teamReportDrafts.id, input.draftId), eq(teamReportDrafts.burrowId, ctx.burrow.id)));
    return { draftId: input.draftId };
  },
});

/** Why a draft's card asks no more, in the log's words after “Withdrew request #N: ”. */
const DRAFT_CARD_WITHDRAWN = {
  sent: 'the report was sent from the form instead',
  dropped: 'the draft stayed with the earlier Whombat',
  old: 'the draft was more than 30 days old',
} as const;

/**
 * The card that still asks about a draft the person sent from the form (or that went with the earlier box's reports):
 * it waits no more. It reads as declined by them, with a signed `approval.declined` saying why, and nobody is woken:
 * the report went already, or there is nothing left to send. A card answered yes is the one sending it, and stays as it
 * is.
 */
async function withdrawDraftCard(ctx: ApplyContext, approvalId: string, why: string): Promise<boolean> {
  const [row] = await ctx.tx
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.id, approvalId),
        eq(approvals.burrowId, ctx.burrow.id),
        eq(approvals.state, 'pending'),
      ),
    )
    .for('update');
  if (!row) return false;
  const [fresh] = await ctx.tx
    .update(approvals)
    .set({ state: 'declined', decidedById: ctx.actor.id, decidedAt: ctx.now, updatedAt: ctx.now })
    .where(eq(approvals.id, row.id))
    .returning();
  const conversation = await loadConversationRow(ctx.tx, row.conversationId);
  const event = await ctx.emit({
    type: 'approval.declined',
    kind: 'Asks',
    text: `Withdrew request #${row.number}: ${why}`,
    where: conversation ? conversationLabel(conversation) : null,
    aboutId: row.requesterId,
    approvalId: row.id,
    ref: { type: 'approval', number: row.number },
    payload: { approvalId: row.id, decision: 'decline', withdrawn: true, note: null },
  });
  if (fresh) {
    const approval = toApproval(fresh);
    publishApproval(ctx, approval, event.id);
    await syncPlanSteps(ctx, approval);
  }
  return true;
}

/**
 * The draft is done: sent (as which report), or no longer wanted. Sent from the form, its card is withdrawn; sent by the
 * card's yes, the card is the one that sent it and stays as it is.
 */
export const doneTeamReportDraft = defineCommand({
  name: 'team_report_draft_done',
  schema: z.object({
    draftId: z.string().min(8).max(64),
    state: z.enum(['sent', 'declined']),
    reportId: z.string().min(1).max(64).nullable(),
  }),
  async apply(tx, ctx, input) {
    const done = await tx
      .update(teamReportDrafts)
      .set({ state: input.state, reportId: input.reportId, doneAt: ctx.now })
      .where(
        and(
          eq(teamReportDrafts.id, input.draftId),
          eq(teamReportDrafts.burrowId, ctx.burrow.id),
          inArray(teamReportDrafts.state, ['waiting', 'sending']),
        ),
      )
      .returning({ id: teamReportDrafts.id, approvalId: teamReportDrafts.approvalId });
    const approvalId = done[0]?.approvalId ?? null;
    const withdrawn =
      input.state === 'sent' && approvalId !== null
        ? await withdrawDraftCard(ctx, approvalId, DRAFT_CARD_WITHDRAWN.sent)
        : false;
    return { done: done.length > 0, withdrawn };
  },
});

/**
 * Drafts older than this go (sent, declined or left waiting), and the cards still asking about them are withdrawn, so
 * no yes is left that would send nothing; the card's Edit then says the draft is gone. One being sent now stays.
 */
export const TEAM_REPORT_DRAFT_KEEP_DAYS = 30;

export const sweepTeamReportDrafts = defineCommand({
  name: 'team_report_drafts_sweep',
  schema: z.object({ ids: z.array(z.string().min(8).max(64)).min(1).max(500) }),
  async apply(tx, ctx, input) {
    const gone = await tx
      .delete(teamReportDrafts)
      .where(
        and(
          eq(teamReportDrafts.burrowId, ctx.burrow.id),
          inArray(teamReportDrafts.id, input.ids),
          ne(teamReportDrafts.state, 'sending'),
        ),
      )
      .returning({ id: teamReportDrafts.id, approvalId: teamReportDrafts.approvalId });
    let withdrawn = 0;
    for (const d of gone)
      if (d.approvalId && (await withdrawDraftCard(ctx, d.approvalId, DRAFT_CARD_WITHDRAWN.old)))
        withdrawn += 1;
    return { gone: gone.length, withdrawn };
  },
});

export const TEAM_REPORT_COMMANDS = [
  keepTeamReport,
  seeTeamReports,
  forgetTeamReport,
  dropTeamReports,
  saveTeamReportDraft,
  sendTeamReportDraft,
  reserveTeamReportDraft,
  releaseTeamReportDraft,
  askedTeamReportDraft,
  doneTeamReportDraft,
  sweepTeamReportDrafts,
];
