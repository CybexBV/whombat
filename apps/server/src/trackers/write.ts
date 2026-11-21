/**
 * Writing an agent's assessment back to a tracker report (docs/decisions/report-trackers.md TA-11…TA-13): what a
 * `tracker_update` step would write for this run (`trackerWritePlan`, also the approval guard's re-render), and the write
 * itself in the engine's external pass (`sendWrite`): only the values the tracker doesn't have yet, with a request id
 * kept on the step attempt, so a step sent again after a crash or a lost answer writes nothing twice (the driver's
 * part). Never `reproduced`, a status or a message.
 */
import {
  type AutomationStep,
  renderTemplate,
  TrackerItemId,
  type TrackerWords,
  type TrackerWrite,
  trackerNothingToWriteText,
  trackerWriteLine,
  trackerWriteOf,
  UNKNOWN_TRACKER_WORDS,
} from '@whombat/core';
import { reportedAssessment } from '../automations/assessment';
import type { CatalogConnectionRow } from '../connections/types';
import type { Db } from '../db/client';
import { loadAgentRow } from '../read/principals';
import { trackerConnectionRow } from './connection';
import type { BoundDriver } from './drivers';
import { mirroredNumber } from './store';

type Step = Extract<AutomationStep, { kind: 'tracker_update' }>;

/** Why a `tracker_update` step has no report to write to. */
export const NO_REPORT = 'Nothing to write: this run didn’t start from a tracker’s report.';

/** What a step would write, or why it writes nothing (`fatal`: the step can't run at all). */
export type TrackerWritePlan =
  | {
      ok: true;
      connectionId: string;
      /** The connection's label (“Acme Desk dev”). */
      connection: string;
      reportId: string;
      number: number;
      write: TrackerWrite;
      /** The agent whose assessment it is. */
      agent: string;
      /** What a person says yes to when the key asks (TA-12). */
      proposal: { title: string; details: string };
    }
  | { ok: false; reason: string; fatal?: boolean };

/**
 * What a `tracker_update` step would write for this run (TA-11): the report its template names, the assessment of step
 * `from` mapped to the tracker's (`trackerWriteOf`), and the line a person approves (“Acme Desk dev #15: Likely bug ·
 * high priority”). `wordsOf`: the connection's tracker words (its driver's). Nothing to write — not a bug, not assessed, no report — is a reason the step is skipped with.
 */
export async function trackerWritePlan(
  db: Db,
  run: { burrowId: string; definition: { steps: readonly AutomationStep[] }; scope: unknown },
  steps: readonly { stepId: string; output: unknown }[],
  step: Step,
  scope: Record<string, unknown>,
  wordsOf: (row: CatalogConnectionRow) => TrackerWords = () => UNKNOWN_TRACKER_WORDS,
): Promise<TrackerWritePlan> {
  const reportId = renderTemplate(step.report, scope, 100).trim();
  if (!reportId) return { ok: false, reason: NO_REPORT };
  if (!TrackerItemId.safeParse(reportId).success)
    return { ok: false, reason: `Nothing to write: “${reportId.slice(0, 60)}” isn’t a report id.` };
  const row = await trackerConnectionRow(db, run.burrowId, step.connectionId);
  if (!row) return { ok: false, reason: 'Its tracker connection is gone.', fatal: true };
  const from = run.definition.steps.find((s) => s.id === step.from);
  const agentRow = from?.kind === 'dispatch_agent' ? await loadAgentRow(db, run.burrowId) : undefined;
  const agent = agentRow?.name ?? 'The agent';
  const kept = steps.find((s) => s.stepId === step.from)?.output as { assessment?: unknown } | undefined;
  const mapped = trackerWriteOf(reportedAssessment(kept?.assessment));
  const words = wordsOf(row);
  if ('skip' in mapped)
    return { ok: false, reason: trackerNothingToWriteText(mapped.skip, agent, words.product) };
  const trigger = scope.trigger as {
    kind?: unknown;
    reportId?: unknown;
    connectionId?: unknown;
    number?: unknown;
  };
  const number =
    trigger?.kind === 'tracker' &&
    trigger.reportId === reportId &&
    trigger.connectionId === step.connectionId &&
    typeof trigger.number === 'number'
      ? trigger.number
      : ((await mirroredNumber(db, step.connectionId, reportId)) ?? 0);
  const title = trackerWriteLine(row.label, number, mapped.write);
  return {
    ok: true,
    connectionId: row.id,
    connection: row.label,
    reportId,
    number,
    write: mapped.write,
    agent,
    proposal: {
      title: title.slice(0, 160),
      details: `${agent}’s assessment goes to ${row.label} as the report’s assessment and priority, for ${/^the /i.test(words.team) ? words.team : `the ${words.team}`}. The reporter doesn’t see them and gets no email.`,
    },
  };
}

/** What a write sent: each value, or null when it wasn't sent (the tracker had it, or the assessment gives none). */
export interface WriteSent {
  assessment: TrackerWrite['assessment'];
  priority: TrackerWrite['priority'];
}

/**
 * The write (TA-13), by the connection's driver: only what differs, with the step's request id. `resend`: the step may
 * have sent it before (after a crash or a lost answer): values the tracker already has count as written then, else as
 * nothing to write. Throws the driver's failures (`SourceProblem`, `TrackerRefusal`, `TrackerNotFound`, a second
 * `TrackerConflict`).
 */
export async function sendWrite(
  driver: BoundDriver,
  reportId: string,
  write: TrackerWrite,
  requestId: string,
  resend: boolean,
): Promise<{ sent: WriteSent } | { unchanged: true }> {
  const res = await driver.write(reportId, {
    assessment: write.assessment,
    priority: write.priority,
    requestId,
    resend,
  });
  if ('unchanged' in res) return { unchanged: true };
  return {
    sent: {
      assessment: (res.sent.assessment as TrackerWrite['assessment']) ?? null,
      priority: (res.sent.priority as TrackerWrite['priority']) ?? null,
    },
  };
}
