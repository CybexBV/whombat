/**
 * Reports to the Whombat Team through the commit pipeline (docs/decisions/team-reports.md). Control keeps the reports;
 * the calls to it happen outside any transaction (`service.ts`), and these commands keep what it answered:
 *
 * - `team_report_keep`: a whole report as control answered it, and whether the person has read it now;
 * - `team_report_seen`: control's list. A team change shows as unread; a status entering a question or a fix to try is
 *   an Inbox item and a notification in fixed words, never the team's;
 * - `team_report_forget`: a report that is gone (withdrawn, or no longer at control) leaves the box at once;
 * - `team_reports_drop`: every copy goes (a backup restored onto new hardware, a box taken out of Link).
 *
 * The assistant drafts: `team_report_draft_save` keeps its draft and `team_report_draft_send` always asks the
 * person on a card that quotes exactly what goes, whatever the assistant's keys say; their yes sends it as them
 * (`sendDraftForAssistant`), and the card's Edit opens the form with the draft. Sent from the form, the card that
 * still asks about it is withdrawn (`team_report_draft_done`).
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
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { publishApproval, syncPlanSteps } from '../approvals/engine';
import { type ApplyContext, defineCommand, type KeyRequirement } from '../commit/types';
import { managedAppOrigin } from '../config';
import type { Db, Tx } from '../db/client';
import { approvals, notifications, teamReportCopies, teamReportDrafts } from '../db/schema/index';
import { notifyInCommit } from '../domain/notify';
import { thePerson } from '../domain/the-person';
import { homeAudience, publishHomeChanged } from '../home/notify';
import { conflict, forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { toApproval } from '../read/work';
import { quoted } from '../trackers/reply';
import { sendDraftForAssistant } from './service';

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
 * Whether control's newer summary entered a status that waits for the person by a change of the team's (its revision
 * moved): the person's own reply moves no revision, so it never notifies them.
 */
export function teamReportEnteredNeedsYou(
  before: Pick<CopyRow, 'status' | 'revision'>,
  after: Pick<Summary, 'status' | 'revision'>,
): boolean {
  return (
    teamReportNeedsYou(after.status) && after.status !== before.status && after.revision > before.revision
  );
}

/** Home reads its Inbox again (an item came or went). */
async function inboxChanged(ctx: ApplyContext): Promise<void> {
  publishHomeChanged(ctx, await homeAudience(ctx, ctx.burrow.id), ['needsYou']);
}

/**
 * The person's report as the box keeps it now: the whole report, and whether they read it. An answer older than the
 * copy (`older`) leaves the copy as it is; the person has still read what it shows.
 */
export const keepTeamReport = defineCommand({
  name: 'team_report_keep',
  schema: z.object({ report: TeamReport, read: z.boolean(), sent: z.boolean().default(false) }),
  async apply(tx, ctx, input) {
    const r = input.report;
    const [had] = await tx
      .select()
      .from(teamReportCopies)
      .where(and(eq(teamReportCopies.burrowId, ctx.burrow.id), eq(teamReportCopies.reportId, r.id)))
      .for('update');
    const readRevision = input.read ? Math.max(had?.readRevision ?? 0, r.revision) : (had?.readRevision ?? 0);
    if (had && teamReportOlderThanCopy(had, r)) {
      if (readRevision !== had.readRevision)
        await tx
          .update(teamReportCopies)
          .set({ readRevision })
          .where(and(eq(teamReportCopies.burrowId, ctx.burrow.id), eq(teamReportCopies.reportId, r.id)));
      return { reportId: r.id, older: true };
    }
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
    return { reportId: r.id, older: false };
  },
});

/** The link a notification about a report opens: the report's page in the app. */
function reportLink(ctx: ApplyContext, reportId: string) {
  try {
    return {
      type: 'external' as const,
      url: `${managedAppOrigin(ctx.services.config)}${teamReportHref(reportId)}`,
    };
  } catch {
    // No app address configured (a development box): the person's Chat.
    return { type: 'dm' as const };
  }
}

/**
 * Control's list of the box's reports: the copies take its summaries (a report the box didn't know comes in unread
 * when the team changed it), and with the whole list (`complete`) copies of reports control no longer keeps go. A
 * report that now waits for the person is told to them once, in fixed words.
 */
export const seeTeamReports = defineCommand({
  name: 'team_report_seen',
  schema: z.object({
    reports: z.array(TeamReportSummary).max(TEAM_REPORTS_LIST_MAX),
    complete: z.boolean(),
  }),
  async apply(tx, ctx, input) {
    const burrowId = ctx.burrow.id;
    const rows = await tx
      .select()
      .from(teamReportCopies)
      .where(eq(teamReportCopies.burrowId, burrowId))
      .for('update');
    const byId = new Map(rows.map((r) => [r.reportId, r]));
    const tell: Summary[] = [];
    let changed = false;
    for (const s of input.reports) {
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
        continue;
      }
      if (sameTeamReportSummary(had, s)) continue;
      await tx
        .update(teamReportCopies)
        .set({ ...summaryColumns(s), revision: Math.max(had.revision, s.revision), copiedAt: ctx.now })
        .where(and(eq(teamReportCopies.burrowId, burrowId), eq(teamReportCopies.reportId, s.id)));
      if (teamReportNeedsYou(s.status) !== teamReportNeedsYou(had.status as TeamReportStatus)) changed = true;
      if (teamReportEnteredNeedsYou(had, s)) tell.push(s);
    }
    let gone = 0;
    if (input.complete) {
      const kept = input.reports.map((s) => s.id);
      const left = await tx
        .delete(teamReportCopies)
        .where(
          and(
            eq(teamReportCopies.burrowId, burrowId),
            kept.length ? notInArray(teamReportCopies.reportId, kept) : undefined,
          ),
        )
        .returning({ status: teamReportCopies.status });
      gone = left.length;
      if (left.some((l) => teamReportNeedsYou(l.status as TeamReportStatus))) changed = true;
    }
    const person = tell.length ? await thePerson(tx, burrowId) : null;
    for (const s of person ? tell : []) {
      const words = TEAM_REPORT_NOTICE_WORDS[s.status as 'needs_information' | 'available'];
      const dedupKey = `team-report:${s.id}:${s.revision}`;
      if (!person || (await notifiedAlready(tx, person.id, dedupKey))) continue;
      await notifyInCommit(ctx, {
        burrowId,
        burrowSlug: ctx.burrow.slug,
        principalId: person.id,
        kind: 'needs_you',
        actorId: ctx.actor.id,
        where: `Report #${s.number}`,
        text: words.title,
        link: reportLink(ctx, s.id),
        createdAt: ctx.now,
        dedupKey,
        group: `team-report:${s.id}`,
      });
    }
    if (changed || tell.length) await inboxChanged(ctx);
    return { told: person ? tell.length : 0, gone };
  },
});

async function notifiedAlready(tx: Tx, principalId: string, dedupKey: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.principalId, principalId), eq(notifications.dedupKey, dedupKey)))
    .limit(1);
  return !!row;
}

/** A report that is gone: its copy leaves the box. `withdrawn`: the person took it back (the log says so). */
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
    if (gone && teamReportNeedsYou(gone.status as TeamReportStatus)) await inboxChanged(ctx);
    return { reportId: input.reportId, gone: !!gone };
  },
});

/**
 * Every copy of the burrow's reports goes, and with `drafts` the assistant's drafts not sent yet: a backup restored onto
 * new hardware starts without the earlier box's reports, and a box taken out of Link keeps none.
 */
export const dropTeamReports = defineCommand({
  name: 'team_reports_drop',
  schema: z.object({ drafts: z.boolean() }),
  async apply(tx, ctx, input) {
    const copies = await tx
      .delete(teamReportCopies)
      .where(eq(teamReportCopies.burrowId, ctx.burrow.id))
      .returning({ status: teamReportCopies.status });
    const drafts = input.drafts
      ? await tx
          .delete(teamReportDrafts)
          .where(and(eq(teamReportDrafts.burrowId, ctx.burrow.id), eq(teamReportDrafts.state, 'waiting')))
          .returning({ id: teamReportDrafts.id })
      : [];
    if (copies.some((c) => teamReportNeedsYou(c.status as TeamReportStatus))) await inboxChanged(ctx);
    return { copies: copies.length, drafts: drafts.length };
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

/**
 * Sending the assistant's draft: always a card first, whatever its keys say. On the person's yes this runs again as the
 * assistant with the approval, and the report goes out after the commit (`sendDraftForAssistant`).
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
          // The words go with the card, so every place it can be answered shows exactly what would be sent.
          data: { draftId: draft.id, text: draft.text, expected: draft.expected },
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
  async apply(tx, ctx, input) {
    const [draft] = await tx
      .select()
      .from(teamReportDrafts)
      .where(and(eq(teamReportDrafts.id, input.draftId), eq(teamReportDrafts.burrowId, ctx.burrow.id)))
      .for('update');
    if (!draft) throw notFound('Draft');
    if (ctx.actor.kind === 'agent' && !ctx.approvalId) throw forbidden();
    if (ctx.actor.kind === 'person' && ctx.actor.id !== draft.personId) throw forbidden();
    if (draft.state !== 'waiting') throw conflict('This report was sent already.');
    const services = ctx.services;
    const call = {
      draftId: draft.id,
      agentId: draft.agentId ?? ctx.actor.id,
      approvalId: ctx.approvalId,
      conversationId: draft.conversationId,
    };
    // The send happens after this commit, outside any transaction; the assistant is woken with how it went.
    ctx.after(() => sendDraftForAssistant(services, ctx.burrow.id, call));
    return { draftId: draft.id };
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

/**
 * The card that still asks about a draft the person sent from the form: it waits no more. It reads as declined by
 * them, with a signed `approval.declined` saying why, and nobody is woken: the report went already. A card answered
 * yes is the one sending it, and stays as it is.
 */
async function withdrawDraftCard(ctx: ApplyContext, approvalId: string): Promise<boolean> {
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
    text: `Withdrew request #${row.number}: the report was sent from the form instead`,
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

/** The draft is done: sent (as which report), or no longer wanted. Sent from the form, its card is withdrawn. */
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
          eq(teamReportDrafts.state, 'waiting'),
        ),
      )
      .returning({ id: teamReportDrafts.id, approvalId: teamReportDrafts.approvalId });
    const approvalId = done[0]?.approvalId ?? null;
    const withdrawn =
      input.state === 'sent' && approvalId !== null ? await withdrawDraftCard(ctx, approvalId) : false;
    return { done: done.length > 0, withdrawn };
  },
});

/** Drafts older than this go (sent, declined or left waiting): the card's Edit then says the draft is gone. */
export const TEAM_REPORT_DRAFT_KEEP_DAYS = 30;

export const sweepTeamReportDrafts = defineCommand({
  name: 'team_report_drafts_sweep',
  schema: z.object({ ids: z.array(z.string().min(8).max(64)).min(1).max(500) }),
  async apply(tx, ctx, input) {
    const gone = await tx
      .delete(teamReportDrafts)
      .where(and(eq(teamReportDrafts.burrowId, ctx.burrow.id), inArray(teamReportDrafts.id, input.ids)))
      .returning({ id: teamReportDrafts.id });
    return { gone: gone.length };
  },
});

export const TEAM_REPORT_COMMANDS = [
  keepTeamReport,
  seeTeamReports,
  forgetTeamReport,
  dropTeamReports,
  saveTeamReportDraft,
  sendTeamReportDraft,
  askedTeamReportDraft,
  doneTeamReportDraft,
  sweepTeamReportDrafts,
];
