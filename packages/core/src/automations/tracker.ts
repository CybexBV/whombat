/**
 * Tracker runs (Whombat report-trackers.md). Since 0.71 (CT-327, TA-23) looking inside the reporting organization
 * follows the tracker's token, not a switch: every agent step of a run that started from a tracker report asks for the
 * grant unless it writes code or gives a verdict, and the tracker refuses it when the token may not grant it.
 */
import type { AutomationStep } from '../domain/automation.js';

/**
 * Whether a step of a run that started from a tracker report asks its tracker for read access to the reporting
 * organization (TA-23): an agent step that neither writes code (a `write` checkout) nor gives a verdict — the assessing
 * step, an answer, a person's own instructions. `DispatchAgentStep.trackerAccess` is ignored.
 */
export function trackerAccessAsked(step: AutomationStep): boolean {
  return step.kind === 'dispatch_agent' && step.workspace?.access !== 'write' && !step.verdict;
}
