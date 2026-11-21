/**
 * How hard a turn thinks (Whombat model-effort.md ME-02, ME-03; resourceful-agents.md RA-DS57): the agent's own effort,
 * else automatic — `high` for code work, `medium` for everything conversational — the same for Claude Code and Codex.
 * The runner keeps it within what the turn's model takes (its model list, `TurnInput.effort`); a provider called
 * without one works it out from the context alone.
 */
import { type AgentEffort, type TurnEffortKind, turnEffort } from '@whombat/core';
import type { TurnInput } from '../contract';

/**
 * The kind of turn automatic effort tells apart (RA-DS57): code work — a run turn, an automation's step with a writable
 * checkout — or everything conversational (a DM, a mention, “More detail”, a search answer, a Feedback assessment, a
 * job's wake-up, a scheduled turn, a yes or no to an ask, a reflection…).
 */
export function turnEffortKind(ctx: TurnInput['context'] | undefined): TurnEffortKind {
  const dispatch = ctx?.dispatch;
  if (dispatch?.mode === 'run' || ctx?.run) return 'work';
  if (dispatch?.trigger === 'automation' && ctx?.workspace?.access === 'write') return 'work';
  return 'chat';
}

/**
 * The effort a provider sends with a turn: the runner's (`TurnInput.effort`, already kept within the model's efforts;
 * null: none), else the agent's own or automatic for the kind of turn, as it is (no model list to keep it within).
 */
export function turnEffortOf(input: Pick<TurnInput, 'context' | 'effort'>): AgentEffort | null {
  if (input.effort !== undefined) return input.effort;
  return turnEffort(input.context?.agent?.runtime?.effort, turnEffortKind(input.context), null);
}
