/**
 * A step whose turn handed its T3 Code wait to Whombat (docs/decisions/outsiders-turns.md, `turn-waits.ts`): the
 * engine waits for the thread in the turn's place, and once it finished or asks something the step gets a new turn
 * with the same instructions (the step op `turn_resume`). The step's time still counts from its first turn's claim.
 */
import type { AutomationStep } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { catalogConnections } from '../../db/schema/index';
import type { DispatchRow } from '../../runtime/context';
import type { Services } from '../../services';
import { callT3 } from '../../things/kinds/business/t3code';
import { type StepOp, stepTimeoutMs } from '../steps';
import type { AutomationStepRow } from '../store';
import { handedWaitOf, waitTimedOut } from '../turn-waits';
import { failure } from './step-ops';

/** How often the engine asks T3 Code whether a handed-over thread is done. */
export const HANDED_WAIT_CHECK_MS = 20_000;
/** How many times one attempt of a step may hand its wait over before it counts as stuck. */
export const HANDED_WAITS_MAX = 20;
const PROBE_MS = 1000;

/** When a step's time began: its first turn's claim (a turn after a handed wait keeps it). */
export function stepClockStart(row: AutomationStepRow, d: Pick<DispatchRow, 'claimedAt'>): Date | null {
  const since = handedWaitOf(row.output)?.since;
  const at = since ? new Date(since) : null;
  return at && !Number.isNaN(at.getTime()) ? at : d.claimedAt;
}

/** When the engine last asked T3 Code about a handed-over thread, by the turn that handed it (in this process). */
const lastChecked = new Map<string, number>();

/**
 * A step whose finished turn handed its wait over: null while the thread is at work (or T3 Code doesn't answer, until
 * the step's time is up), `turn_resume` once it finished or asks, a failure when the step's time is up or it handed
 * over too often.
 */
export async function observeHandedWait(
  services: Services,
  row: AutomationStepRow,
  step: Extract<AutomationStep, { kind: 'dispatch_agent' }>,
  d: DispatchRow,
  now: Date,
): Promise<StepOp | null> {
  const waitsOn = d.waitsOn;
  if (!waitsOn) return null;
  const start = stepClockStart(row, d);
  if (start && now.getTime() > start.getTime() + stepTimeoutMs(step)) {
    lastChecked.delete(d.id);
    return failure(row, step, 'The agent didn’t finish in time.');
  }
  if ((handedWaitOf(row.output)?.count ?? 0) >= HANDED_WAITS_MAX) {
    lastChecked.delete(d.id);
    return failure(row, step, 'The agent kept handing its wait for T3 Code over without finishing.');
  }
  const last = lastChecked.get(d.id);
  if (last !== undefined && now.getTime() - last < HANDED_WAIT_CHECK_MS) return null;
  // A run stopped while its step waited leaves its entry behind: old ones go once there are many.
  if (lastChecked.size > 500)
    for (const [id, at] of lastChecked) if (now.getTime() - at > 60 * 60_000) lastChecked.delete(id);
  lastChecked.set(d.id, now.getTime());
  const [connection] = await services.db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.id, waitsOn.connectionId));
  if (!connection) {
    lastChecked.delete(d.id);
    return failure(row, step, 'The T3 Code connection its turn waited for is gone.');
  }
  let probe: unknown;
  try {
    probe = await callT3(services, connection, 't3_thread_wait', {
      threadId: waitsOn.threadId,
      ...(waitsOn.settled ? { untilDelegatedWorkSettled: true } : {}),
      timeoutMs: PROBE_MS,
    });
  } catch (err) {
    services.log.warn(
      { dispatchId: d.id, threadId: waitsOn.threadId, err: String(err).slice(0, 200) },
      'automations: a handed-over T3 Code thread couldn’t be read; asked again soon',
    );
    return null;
  }
  if (waitTimedOut(probe)) return null;
  lastChecked.delete(d.id);
  return { op: 'turn_resume', idx: row.idx, dispatchId: d.id };
}
