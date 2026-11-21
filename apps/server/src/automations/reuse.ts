/**
 * A “Try it” run reuses a fresh, identical assessment (run9 review RN-S2). John tried an automation on a report its real
 * trigger had assessed 90 minutes before, and Dusty assessed it all over again. Now an assessment step (`assessment:
 * true`) of a TEST run about a tracker report or a GitHub issue — never a pull request, never a real run — first looks
 * for the latest earlier run of the same automation (test or real, created in the last 24 hours) about the same item
 * whose step of the same id succeeded with an assessment its agent reported, for the same agent, the same checkout and
 * exactly the instructions this step renders now (which covers both edited instructions and a changed report). Found:
 * nobody is asked, the step succeeds at once with that assessment and its answer, and the run's thread says so.
 */
import type { AutomationStep, JsonObject } from '@whombat/core';
import { and, desc, eq, gt, lte, ne, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { automationRunSteps, automationRuns } from '../db/schema/index';
import { scopeReport } from '../trackers/items';
import { reportedAssessment } from './assessment';
import type { AutomationRunRow } from './store';
import type { RunWorkspace } from './workspace';

/** How old an assessment may be to be used again. */
export const REUSE_WINDOW_MS = 24 * 3_600_000;

type AgentStep = Extract<AutomationStep, { kind: 'dispatch_agent' }>;

/** The item a run is about, as an assessment may be reused for it: a tracker report or a GitHub issue. */
function reusableItem(scope: unknown): { where: SQL; noun: 'report' | 'issue' } | null {
  const report = scopeReport(scope);
  if (report)
    return {
      where: sql`${automationRuns.scope} ->> 'kind' = 'tracker' and ${automationRuns.scope} ->> 'connectionId' = ${report.connectionId} and ${automationRuns.scope} ->> 'reportId' = ${report.reportId}`,
      noun: 'report',
    };
  const s = scope as { kind?: unknown; item?: unknown; repo?: unknown; number?: unknown } | null;
  if (
    s?.kind !== 'github' ||
    s.item !== 'issue' ||
    typeof s.repo !== 'string' ||
    typeof s.number !== 'number'
  )
    return null;
  return {
    where: sql`${automationRuns.scope} ->> 'kind' = 'github' and ${automationRuns.scope} ->> 'item' = 'issue' and lower(${automationRuns.scope} ->> 'repo') = ${s.repo.toLowerCase()} and ${automationRuns.scope} ->> 'number' = ${String(s.number)}`,
    noun: 'issue',
  };
}

/** The same checkout: repository (any case), access and branch — or none on both sides. */
function sameWorkspace(kept: unknown, now: RunWorkspace | null): boolean {
  const ws = (kept as { workspace?: Partial<RunWorkspace> } | null)?.workspace ?? null;
  if (!ws || !now) return !ws && !now;
  return (
    typeof ws.repo === 'string' &&
    ws.repo.toLowerCase() === now.repo.toLowerCase() &&
    ws.access === now.access &&
    ws.branch === now.branch
  );
}

export interface ReusableAssessment {
  noun: 'report' | 'issue';
  runId: string;
  runNumber: number;
  finishedAt: Date;
  output: JsonObject;
}

/**
 * The earlier assessment this test run's step may use instead of asking its agent (RN-S2), or null. `instructions` is
 * what the step renders now, `workspace` its rendered checkout.
 */
export async function reusableAssessment(
  db: Db,
  run: AutomationRunRow,
  step: AgentStep,
  agentId: string,
  workspace: RunWorkspace | null,
  instructions: string,
  now: Date,
): Promise<ReusableAssessment | null> {
  if (!run.test || !step.assessment) return null;
  const item = reusableItem(run.scope);
  if (!item) return null;
  const rows = await db
    .select({
      runId: automationRuns.id,
      runNumber: automationRuns.number,
      finishedAt: automationRunSteps.finishedAt,
      output: automationRunSteps.output,
    })
    .from(automationRunSteps)
    .innerJoin(automationRuns, eq(automationRuns.id, automationRunSteps.runId))
    .where(
      and(
        eq(automationRuns.automationId, run.automationId),
        ne(automationRuns.id, run.id),
        gt(automationRuns.createdAt, new Date(now.getTime() - REUSE_WINDOW_MS)),
        lte(automationRuns.createdAt, run.createdAt),
        item.where,
        eq(automationRunSteps.stepId, step.id),
        eq(automationRunSteps.state, 'succeeded'),
        sql`${automationRunSteps.output} -> 'assessment' is not null`,
        // Only what an agent really assessed: a step that reused one points at the run it came from instead.
        sql`${automationRunSteps.output} -> 'reusedFrom' is null`,
        sql`${automationRunSteps.output} ->> 'agentId' = ${agentId}`,
        sql`${automationRunSteps.output} ->> 'instructions' = ${instructions}`,
      ),
    )
    .orderBy(desc(automationRuns.createdAt), desc(automationRuns.number))
    .limit(10);
  for (const row of rows) {
    const output = row.output as JsonObject;
    if (!sameWorkspace(output, workspace) || !row.finishedAt) continue;
    // A turn that reported nothing (“Not assessed”) is no assessment to go on.
    const a = reportedAssessment(output.assessment);
    if (a.kind === 'unclear' && a.confidence === 'low') continue;
    return {
      noun: item.noun,
      runId: row.runId,
      runNumber: row.runNumber,
      finishedAt: row.finishedAt,
      output,
    };
  }
  return null;
}

/** How long ago, in plain words (within a day). */
export function agoWords(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'a moment ago';
  if (minutes === 1) return 'a minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
}

/** What the reused step keeps (RN-S2): the earlier assessment and answer, and where they came from. */
export function reusedOutput(found: ReusableAssessment, instructions: string): JsonObject {
  const o = found.output;
  return {
    ...(o.agentId !== undefined ? { agentId: o.agentId } : {}),
    instructions,
    ...(o.workspace !== undefined ? { workspace: o.workspace } : {}),
    assessment: o.assessment ?? null,
    text: typeof o.text === 'string' ? o.text : '',
    reply: typeof o.reply === 'string' ? o.reply : '',
    reusedFrom: {
      runId: found.runId,
      runNumber: found.runNumber,
      finishedAt: found.finishedAt.toISOString(),
    },
  };
}

/** The quote of the earlier answer: its last message, else everything it said, else the assessment's summary. */
function quoted(found: ReusableAssessment): string {
  const o = found.output;
  const said =
    (typeof o.reply === 'string' && o.reply.trim()) ||
    (typeof o.text === 'string' && o.text.trim()) ||
    reportedAssessment(o.assessment).summary.trim();
  const clipped = said.length > 3000 ? `${said.slice(0, 2999).trimEnd()}…` : said;
  return clipped
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
}

/** The one message in the run's thread (RN-S2): whose assessment, from when, the answer quoted, and how to ask again. */
export function reusedMessage(found: ReusableAssessment, agentName: string, now: Date): string {
  const ago = agoWords(now.getTime() - found.finishedAt.getTime());
  return [
    `${agentName} assessed this ${found.noun} in run #${found.runNumber} ${ago} and nothing has changed since, so I’m using that assessment:`,
    quoted(found),
    `Ask ${agentName} here if you want a fresh look.`,
  ].join('\n\n');
}

/** The step's input summary on the run page. */
export function reusedSummary(found: ReusableAssessment, agentName: string): string {
  return `Used ${agentName}’s assessment from run #${found.runNumber}: the ${found.noun} and the instructions haven’t changed`;
}
