/**
 * The assistant's two tools for reports to the Whombat Team (docs/decisions/team-reports.md):
 * `report_to_whombat_team` keeps its draft and always becomes a card that quotes exactly what goes; only the person's
 * yes sends it (`sendDraftForAssistant`). `whombat_team_reports` reads the person's reports as numbers, the start of
 * the person's own words, statuses in words and dates: never the team's words, and the team may rename a report, so
 * never its title either.
 */
import {
  type ReportToWhombatTeamInput,
  type ReportToWhombatTeamOutput,
  TEAM_REPORT_STATUS_WORDS,
  TeamReport,
  teamReportExcerptTitle,
  type WhombatTeamReportsOutput,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { teamReportCopies } from '../db/schema/index';
import { iso } from '../lib/time';
import type { ToolContext } from '../mcp/tools';
import type { Services } from '../services';
import { ownTurn } from '../vault/self-serve';
import { askedTeamReportDraft, saveTeamReportDraft, sendTeamReportDraft } from './commands';
import { TEAM_REPORT_WORDS, teamPortOf } from './control';
import { lastAvailability, listTeamReports, teamReportCopiesOf } from './service';

/**
 * Whether the assistant is offered the tools in this burrow: the box reaches the team, and the person could send a
 * report when control was last asked, or has reports.
 */
export async function teamReportsOffered(services: Services, burrowId: string): Promise<boolean> {
  if (!teamPortOf(services, 'read')) return false;
  if (lastAvailability(services)?.available) return true;
  const [copy] = await services.db
    .select({ id: teamReportCopies.reportId })
    .from(teamReportCopies)
    .where(eq(teamReportCopies.burrowId, burrowId))
    .limit(1);
  return !!copy;
}

const fail = (reason: 'not_here' | 'unavailable', message: string): ReportToWhombatTeamOutput => ({
  status: 'failed',
  reason,
  message,
});

export async function reportToWhombatTeamTool(
  ctx: ToolContext,
  input: ReportToWhombatTeamInput,
): Promise<ReportToWhombatTeamOutput> {
  const { services } = ctx;
  const turn = await ownTurn(services.db, ctx);
  if (!turn || turn.conversation.dmPersonId !== turn.person.id)
    return fail('not_here', 'Only in a turn for the person, in their own Chat.');
  if (!teamPortOf(services, 'send'))
    return fail(
      'unavailable',
      teamPortOf(services, 'read') ? TEAM_REPORT_WORDS.sendNeedsLink : TEAM_REPORT_WORDS.linkOff,
    );
  if (lastAvailability(services)?.available === false)
    return fail('unavailable', 'The person can’t send reports to the Whombat Team now.');
  const commit = { burrowId: ctx.burrowId, actorId: ctx.agentId, onBehalfOf: ctx.onBehalfOf };
  const saved = await services.pipeline.commit(
    saveTeamReportDraft,
    {
      kind: input.kind,
      text: input.text,
      expected: input.expected ?? '',
      personId: turn.person.id,
      conversationId: turn.conversation.id,
    },
    commit,
  );
  if (saved.status !== 'ok') return fail('unavailable', 'The draft wasn’t kept.');
  const draftId = saved.result.id;
  const res = await services.pipeline.commit(sendTeamReportDraft, { draftId }, commit);
  if (res.status !== 'pending_approval')
    return fail('unavailable', res.status === 'blocked' ? res.message : 'The report wasn’t sent.');
  await services.pipeline.commit(askedTeamReportDraft, { draftId, approvalId: res.approvalId }, commit);
  return { status: 'pending_approval', approvalId: res.approvalId, message: res.message };
}

export async function whombatTeamReportsTool(ctx: ToolContext): Promise<WhombatTeamReportsOutput> {
  const { services } = ctx;
  const turn = await ownTurn(services.db, ctx);
  if (!turn) return { available: false, reports: [], note: 'Only in a turn for the person.' };
  const list = await listTeamReports(services, ctx.burrowId, turn.person.id);
  const own = await ownWords(services, ctx.burrowId);
  const note = list.stale
    ? 'This is what Whombat kept: its servers can’t be reached just now.'
    : !list.available
      ? 'The person can’t send a new report now.'
      : undefined;
  return {
    available: list.available,
    reports: list.reports.map((r) => ({
      number: r.number,
      kind: r.kind,
      title: own.get(r.id) ?? `Report #${r.number}`,
      status: TEAM_REPORT_STATUS_WORDS[r.status],
      unread: r.unread,
      createdAt: iso(new Date(r.createdAt * 1000)),
      updatedAt: iso(new Date(r.updatedAt * 1000)),
    })),
    ...(note ? { note } : {}),
  };
}

/**
 * The start of what the person wrote in each report the box has whole, by report id: the assistant's titles. A title
 * control sends may be the team's name for the report, so it never reaches the assistant.
 */
async function ownWords(services: Services, burrowId: string): Promise<Map<string, string>> {
  const words = new Map<string, string>();
  for (const copy of await teamReportCopiesOf(services, burrowId)) {
    const whole = TeamReport.safeParse(copy.report);
    if (whole.success) words.set(copy.reportId, teamReportExcerptTitle(whole.data.text));
  }
  return words;
}
