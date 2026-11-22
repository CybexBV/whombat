/**
 * What an older app can't read of automations (docs/decisions/automation-recipes.md): an app below session protocol
 * minor 3 parses automations with contracts that have no `mail` trigger or source, no `connection_actions` step and
 * no `proposeActions`. It drops a run whose trigger it doesn't know from the run history and refuses the live update
 * of one, and refuses a whole automation whose definition has any of them (the definition's members are strict). So
 * such an app gets a form it reads — the run's trigger as a message, such a step as an earlier step, the automation
 * without that definition (its summary and glance still say what it does) — and a newer app gets everything.
 */
import type {
  Automation,
  AutomationDefinition,
  AutomationExport,
  AutomationRun,
  RealtimeEvent,
} from '@whombat/core';
import { ApiError } from '../lib/errors';

/** The protocol minor that reads automations started by mail and their `connection_actions` steps. */
export const MAIL_AUTOMATIONS_MINOR = 3;

/** Whether a session at `minor` reads them; outside a session (`undefined`), it does. */
export const readsMailAutomations = (minor: number | undefined) =>
  minor === undefined || minor >= MAIL_AUTOMATIONS_MINOR;

/** Whether a definition has anything an app below `MAIL_AUTOMATIONS_MINOR` refuses. */
function newerDefinition(definition: AutomationDefinition | null | undefined): boolean {
  if (!definition) return false;
  return (
    definition.triggers.some((t) => t.kind === 'mail') ||
    definition.recipe?.when.kind === 'mail' ||
    definition.steps.some(
      (s) =>
        s.kind === 'connection_actions' || (s.kind === 'dispatch_agent' && s.proposeActions !== undefined),
    )
  );
}

/** An automation as an app at `minor` reads it. */
export function automationFor(automation: Automation, minor: number | undefined): Automation {
  if (readsMailAutomations(minor)) return automation;
  return {
    ...automation,
    ...(newerDefinition(automation.definition) ? { definition: null } : {}),
    ...(newerDefinition(automation.draft) ? { draft: null } : {}),
    ...(automation.glance?.source === 'mail' ? { glance: { ...automation.glance, source: 'message' } } : {}),
  };
}

/** A run as an app at `minor` reads it. */
export function runFor(run: AutomationRun, minor: number | undefined): AutomationRun {
  if (readsMailAutomations(minor)) return run;
  return {
    ...run,
    trigger: run.trigger.kind === 'mail' ? { ...run.trigger, kind: 'message_posted' } : run.trigger,
    steps: run.steps.map((s) => (s.kind === 'connection_actions' ? { ...s, kind: 'unknown' } : s)),
  };
}

type Answer = Record<string, unknown>;
const withAutomation = (body: Answer, minor: number | undefined) =>
  body.automation ? { ...body, automation: automationFor(body.automation as Automation, minor) } : body;
const withRun = (body: Answer, minor: number | undefined) =>
  body.run ? { ...body, run: runFor(body.run as AutomationRun, minor) } : body;

/** Each automation op's answer, as an app at `minor` reads it. */
const ANSWERS: Record<string, (body: Answer, minor: number | undefined) => Answer> = {
  'automations.list': (body, minor) => ({
    ...body,
    automations: (body.automations as Automation[]).map((a) => automationFor(a, minor)),
  }),
  'automations.runs': (body, minor) => ({
    ...body,
    runs: (body.runs as AutomationRun[]).map((r) => runFor(r, minor)),
  }),
  'automations.export': (body) => {
    if (newerDefinition((body as unknown as AutomationExport).definition))
      throw new ApiError('conflict', 'Update the app to export this automation.');
    return body;
  },
};
for (const op of [
  'automations.create',
  'automations.get',
  'automations.saveDraft',
  'automations.discardDraft',
  'automations.publish',
  'automations.setEnabled',
  'automations.setKeys',
  'automations.webhook',
  'automations.acceptPlan',
])
  ANSWERS[op] = withAutomation;
for (const op of [
  'automations.runNow',
  'automations.run',
  'automations.pauseRun',
  'automations.resumeRun',
  'automations.cancelRun',
  'automations.reviewStep',
])
  ANSWERS[op] = (body, minor) => withRun(withAutomation(body, minor), minor);

/** An op's answer as an app at `minor` reads it (every other op's as it is). */
export function answerFor(op: string, body: unknown, minor: number | undefined): unknown {
  const to = ANSWERS[op];
  if (!to || readsMailAutomations(minor) || !body || typeof body !== 'object') return body;
  return to(body as Answer, minor);
}

/** A live update as an app at `minor` reads it. */
export function eventFor(event: RealtimeEvent, minor: number | undefined): RealtimeEvent {
  if (readsMailAutomations(minor)) return event;
  if (event.type === 'automation.updated')
    return { ...event, automation: automationFor(event.automation, minor) };
  if (event.type === 'automation.run.updated') return { ...event, run: runFor(event.run, minor) };
  return event;
}
