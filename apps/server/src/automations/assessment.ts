/**
 * Structured assessments in automation runs (docs/decisions/automation-recipes.md AR-24…AR-26, AR-37, AR-51; contracts
 * CT-323, CT-324, CT-327): the agent of a `dispatch_agent` step with `assessment: true` reports what an issue is — kind,
 * importance, confidence, size, whether it recommends a change, a plain summary, a fix plan and the technical details —
 * with its `report_assessment` tool, during that step's turn only. The report is kept on the step (the last one counts)
 * and becomes `steps.<id>.assessment` when the step finishes; a turn that reports none gives `unassessed()`, so nothing
 * follows from a missing answer. The tool's handler is in `mcp/tools.ts` (this module is loaded by the engine, which
 * must not load the MCP tools).
 */
import {
  AutomationAssessment,
  type AutomationStep,
  assessmentLine,
  assessmentMarkdown,
  assessmentOffer,
  assessmentPrTitle,
  assessmentQuestion,
  type JsonObject,
  ReportAssessmentInput,
  unassessed,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import { automationRunSteps, automationRuns, dispatches } from '../db/schema/index';
import { conflict, forbidden } from '../lib/errors';
import { type AutomationRunRow, type AutomationStepRow, publishRun } from './store';

/** What an agent hears when it calls `report_assessment` outside an assessment turn. */
export const NOT_AN_ASSESSMENT =
  'report_assessment only works in a turn where an automation asks you to assess an issue or pull request. Answer in the conversation instead.';

/**
 * An assessment as a step keeps it (`steps.<id>.assessment`): the report with the words the server adds — its `line`
 * (“Bug · high importance · sure · small fix”), a tracker fix's pull request `prTitle` (TA-51), the approval card's
 * `offer` and `question` (“Fix #12: …” and “Fix this bug?”, “Suggested change for #12: …” and “Make this change?”,
 * AR-52) and a comment's `heading` and `detailsBlock` (`assessmentMarkdown`, AR-37), so a recipe's comment reads
 * `{{steps.ask.assessment.heading}}{{steps.ask.reply}}{{…detailsBlock}}`.
 */
export function assessmentWithWords(a: AutomationAssessment): JsonObject {
  return {
    ...a,
    line: assessmentLine(a),
    offer: assessmentOffer(a),
    question: assessmentQuestion(a),
    prTitle: assessmentPrTitle(a),
    ...assessmentMarkdown(a),
  };
}

/**
 * The agent's report as a step keeps it, without the words the server added (the strict schema has none of them);
 * `unassessed()` for none, or one that doesn't parse. A report from before 0.71 has no `recommends` (= `nothing`).
 */
export function reportedAssessment(kept: unknown): AutomationAssessment {
  const {
    line: _line,
    offer: _offer,
    question: _question,
    prTitle: _prTitle,
    heading: _heading,
    detailsBlock: _detailsBlock,
    ...report
  } = kept && typeof kept === 'object' && !Array.isArray(kept) ? (kept as JsonObject) : {};
  const parsed = AutomationAssessment.safeParse(report);
  return parsed.success ? parsed.data : unassessed();
}

/** Whether a step kept an assessment its agent reported (one that parses), not `unassessed()`'s stand-in. */
export function assessmentReported(kept: unknown): boolean {
  if (!kept || typeof kept !== 'object' || Array.isArray(kept)) return false;
  const {
    line: _line,
    offer: _offer,
    question: _question,
    prTitle: _prTitle,
    heading: _heading,
    detailsBlock: _detailsBlock,
    ...report
  } = kept as JsonObject;
  const parsed = AutomationAssessment.safeParse(report);
  // `unassessed()` parses too: the stand-in is no report.
  return parsed.success && parsed.data.summary !== unassessed().summary;
}

/** `steps.<id>.assessment` of a finished assessment step: the report (else `unassessed()`) with its words. */
export function assessmentOutput(reported: unknown): JsonObject {
  return assessmentWithWords(reportedAssessment(reported));
}

/**
 * The assessment step a dispatch is the turn of (null: it isn't one): an automation's dispatch whose step has
 * `assessment: true` and still waits for this very dispatch (a retry's new turn replaces it).
 */
export async function assessmentTurn(
  db: Db,
  dispatchId: string,
): Promise<{
  dispatch: typeof dispatches.$inferSelect;
  run: AutomationRunRow;
  row: AutomationStepRow;
  step: Extract<AutomationStep, { kind: 'dispatch_agent' }>;
} | null> {
  const [found] = await db
    .select({ row: automationRunSteps, run: automationRuns, dispatch: dispatches })
    .from(automationRunSteps)
    .innerJoin(automationRuns, eq(automationRuns.id, automationRunSteps.runId))
    .innerJoin(dispatches, eq(dispatches.id, automationRunSteps.dispatchId))
    .where(eq(automationRunSteps.dispatchId, dispatchId))
    .limit(1);
  if (found?.dispatch.trigger !== 'automation') return null;
  const step = found.run.definition.steps[found.row.idx];
  if (step?.kind !== 'dispatch_agent' || !step.assessment) return null;
  return { dispatch: found.dispatch, run: found.run, row: found.row, step };
}

/** Whether `report_assessment` is this agent's in this turn (it is listed only then; AR-24). */
export async function assessesInTurn(
  db: Db,
  agentId: string,
  dispatchId: string | undefined,
): Promise<boolean> {
  if (!dispatchId) return false;
  const turn = await assessmentTurn(db, dispatchId);
  return !!turn && turn.dispatch.agentId === agentId;
}

/**
 * `automation.report_assessment` (the step's agent, `report_assessment`): keeps the assessment on the step its turn
 * belongs to, under the run's lock so the engine settling the step sees the last report. Only during that turn, while
 * the step waits for it.
 */
export const reportAssessment = defineCommand({
  name: 'automation.report_assessment',
  schema: z.object({ dispatchId: z.string(), assessment: ReportAssessmentInput }),
  async apply(tx, ctx, input): Promise<{ line: string }> {
    if (ctx.actor.kind !== 'agent') throw forbidden(NOT_AN_ASSESSMENT);
    const turn = await assessmentTurn(tx, input.dispatchId);
    if (!turn || turn.dispatch.agentId !== ctx.actor.id || turn.run.burrowId !== ctx.burrow.id)
      throw forbidden(NOT_AN_ASSESSMENT);
    if (turn.dispatch.state !== 'claimed' && turn.dispatch.state !== 'running')
      throw conflict('This turn has ended, so its assessment can’t change any more.');
    const [run] = await tx
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, turn.run.id))
      .for('update');
    const [row] = await tx
      .select()
      .from(automationRunSteps)
      .where(and(eq(automationRunSteps.runId, turn.run.id), eq(automationRunSteps.idx, turn.row.idx)));
    if (!run || row?.state !== 'waiting' || row.dispatchId !== input.dispatchId)
      throw conflict('This step is finished, so its assessment can’t change any more.');
    // Whether the reply closes the report (TA-54) is kept beside the assessment: older apps read it strictly.
    const { closes, ...reported } = input.assessment;
    const line = assessmentLine(reported);
    await tx
      .update(automationRunSteps)
      .set({
        output: {
          ...(row.output as JsonObject),
          assessment: assessmentWithWords(reported),
          closes: closes === true,
        },
        updatedAt: ctx.now,
      })
      .where(and(eq(automationRunSteps.runId, run.id), eq(automationRunSteps.idx, row.idx)));
    await ctx.emit({
      type: 'automation.assessment_reported',
      kind: 'System',
      text: `Assessed for automation run #${run.number}: ${line}`.slice(0, 500),
      where: null,
      payload: {
        runId: run.id,
        number: run.number,
        stepId: row.stepId,
        kind: input.assessment.kind,
        importance: input.assessment.importance,
        confidence: input.assessment.confidence,
        size: input.assessment.size,
        recommends: input.assessment.recommends ?? 'nothing',
      },
    });
    await publishRun(ctx, run.id);
    return { line };
  },
});
