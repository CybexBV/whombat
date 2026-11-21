/**
 * Every plan change the web makes (plan pane, the Inbox's NEEDS YOU, create flow), as small async functions that resolve to
 * whether it went through. Refusals become one toast (a started step that can't be removed, a missing key, a plan
 * that's gone); `pending` names the change in flight so its button can say so.
 */
import type { CommitResult } from '@whombat/client';
import { licenceRefusalText } from '@whombat/client/managed';
import { usePlanWrite, useTheAgent } from '@whombat/client/react';
import { type Plan, type PlanStep, stepGoesAhead } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { useState } from 'react';
import { useToast } from '../../components/Toast';
import { planErrorText } from './planModel';

export type PlanChange =
  | 'start'
  | 'mark_done'
  | 'retry'
  | 'cancel'
  | 'remove'
  | 'edit'
  | 'move'
  | 'add'
  | 'rename'
  | 'due'
  | 'canvas';

/** Where a refusal goes instead of a toast: shown next to the form that caused it (the server's words). */
export type RefusalHandler = (text: string) => void;

export interface PlanActions {
  /** `<change>:<stepId | planId>` while a change is in flight. */
  pending: string | null;
  start(plan: Plan, step: PlanStep, change?: 'start' | 'retry'): Promise<boolean>;
  markDone(plan: Plan, step: PlanStep): Promise<boolean>;
  cancel(plan: Plan, step: PlanStep): Promise<boolean>;
  remove(plan: Plan, step: PlanStep): Promise<boolean>;
  editStep(plan: Plan, step: PlanStep, title: string): Promise<boolean>;
  move(plan: Plan, step: PlanStep, by: -1 | 1): Promise<boolean>;
  addStep(plan: Plan, title: string): Promise<boolean>;
  rename(plan: Plan, title: string): Promise<boolean>;
  setDue(plan: Plan, due: string | null): Promise<boolean>;
  createCanvas(plan: Plan): Promise<Plan | null>;
}

export function usePlanActions(burrow: string): PlanActions {
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);
  const update = usePlanWrite(api.plans.update);
  const addStep = usePlanWrite(api.plans.addStep);
  const updateStep = usePlanWrite(api.plans.updateStep);
  const removeStep = usePlanWrite(api.plans.removeStep);
  const startStep = usePlanWrite(api.plans.startStep);
  const createCanvas = usePlanWrite(api.plans.createCanvas);

  const agentName = useTheAgent(burrow).words.name;

  async function run<T>(
    key: string,
    call: () => Promise<CommitResult<T>>,
    done?: string | ((data: T) => string | null),
    onRefusal?: RefusalHandler,
  ): Promise<T | null> {
    setPending(key);
    try {
      const result = await call();
      if (result.status === 'ok') {
        const text = typeof done === 'function' ? done(result.data) : done;
        if (text) toast.show(text);
        return result.data;
      }
      const text = result.status === 'blocked' ? result.message : 'That needs a person to approve first.';
      if (onRefusal) onRefusal(text);
      else toast.show(text);
      return null;
    } catch (error) {
      const text = licenceRefusalText(error) ?? planErrorText(error);
      if (onRefusal) onRefusal(text);
      else toast.show(text);
      return null;
    } finally {
      setPending((p) => (p === key ? null : p));
    }
  }

  const stepParams = (plan: Plan, step: PlanStep) => ({ burrow, planId: plan.id, stepId: step.id });

  return {
    pending,
    start: async (plan, step, change = 'start') =>
      (await run(
        `${change}:${step.id}`,
        () => startStep.mutateAsync({ params: stepParams(plan, step), body: {} }),
        // The agent does every step (OA-14).
        () =>
          stepGoesAhead(step)
            ? `Asked ${agentName} to go ahead with “${step.title}”.`
            : change === 'retry'
              ? `Asked ${agentName} to try “${step.title}” again.`
              : `Asked ${agentName} to take “${step.title}”.`,
      )) !== null,
    markDone: async (plan, step) =>
      (await run(
        `mark_done:${step.id}`,
        () => updateStep.mutateAsync({ params: stepParams(plan, step), body: { state: 'done' } }),
        `Marked “${step.title}” done.`,
      )) !== null,
    cancel: async (plan, step) =>
      (await run(
        `cancel:${step.id}`,
        () => updateStep.mutateAsync({ params: stepParams(plan, step), body: { state: 'cancelled' } }),
        `Cancelled “${step.title}”. It stays on the plan, crossed out.`,
      )) !== null,
    remove: async (plan, step) =>
      (await run(
        `remove:${step.id}`,
        () => removeStep.mutateAsync({ params: stepParams(plan, step) }),
        `Removed “${step.title}”.`,
      )) !== null,
    editStep: async (plan, step, title) =>
      (await run(`edit:${step.id}`, () =>
        updateStep.mutateAsync({ params: stepParams(plan, step), body: { title } }),
      )) !== null,
    move: async (plan, step, by) => {
      const ids = plan.steps.map((s) => s.id);
      const i = ids.indexOf(step.id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= ids.length) return false;
      [ids[i], ids[j]] = [ids[j] as string, ids[i] as string];
      return (
        (await run(`move:${step.id}`, () =>
          update.mutateAsync({ params: { burrow, planId: plan.id }, body: { order: ids } }),
        )) !== null
      );
    },
    addStep: async (plan, title) =>
      (await run(`add:${plan.id}`, () =>
        addStep.mutateAsync({ params: { burrow, planId: plan.id }, body: { title } }),
      )) !== null,
    rename: async (plan, title) =>
      (await run(`rename:${plan.id}`, () =>
        update.mutateAsync({ params: { burrow, planId: plan.id }, body: { title } }),
      )) !== null,
    setDue: async (plan, due) =>
      (await run(`due:${plan.id}`, () =>
        update.mutateAsync({ params: { burrow, planId: plan.id }, body: { due } }),
      )) !== null,
    createCanvas: async (plan) =>
      (
        await run(
          `canvas:${plan.id}`,
          () => createCanvas.mutateAsync({ params: { burrow, planId: plan.id } }),
          'Plan canvas created.',
        )
      )?.plan ?? null,
  };
}
