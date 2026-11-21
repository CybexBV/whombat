/**
 * The model a turn runs on: how hard it thinks and whether it replies fast (model-effort.md ME-02, ME-03; chat-runtime.md
 * CR-06), the default the turn falls back to when the tool refuses the agent's model (ME-05), and what the completion
 * says it ran on (CR-07; chat-runtime-runner.md CR-R05).
 */

import { type TurnInput, turnEffortKind } from '@whombat/agent-runtime';
import {
  type DispatchContext,
  type ModelFallbackReport,
  modelFast,
  modelOf,
  type ProviderModel,
  type TurnRanReport,
  turnEffort,
} from '@whombat/core';
import { fastFor, type TurnRanFacts, turnRan } from '../ran';
import type { TurnDeps } from './deps';

/**
 * The efforts the turn's model takes, from this runner's list of the tool's models (ME-03): the named model's, else the
 * default's; null when the list isn't known or doesn't have the model (the effort goes as it is).
 */
export function effortsOf(
  models: readonly ProviderModel[] | null,
  model: string | undefined,
): ProviderModel['efforts'] | null {
  return modelOf(models, model)?.efforts ?? null;
}

/**
 * How hard the model thinks (ME-02, ME-03): the agent's effort, else automatic for the kind of turn, kept within what
 * the turn's model takes by this runner's list of the tool's models (unknown: as it is). Fast replies (CR-06; CR-R01):
 * the runtime's `fast` where the turn's model offers them by the same list (unknown: nothing sent), never through the AI
 * gateway (CR-R08).
 */
export class TurnModel {
  /** This runner's list of the tool's models; null when it doesn't know them, or for another provider. */
  readonly models: readonly ProviderModel[] | null;
  /**
   * The person's ask on their own model, before the gateway or a fallback had their say: a reply that came at the
   * normal speed for it says so (CR-08).
   */
  readonly wantedFast: boolean | null;
  readonly #ctx: DispatchContext;
  readonly #gateway: boolean;

  constructor(
    turn: { ctx: DispatchContext; deps: Pick<TurnDeps, 'registry'> },
    live: 'claude' | 'codex' | null,
    gateway: boolean,
    model: string | undefined,
  ) {
    this.#ctx = turn.ctx;
    this.#gateway = gateway;
    this.models = live ? (turn.deps.registry.models?.(live) ?? null) : null;
    this.wantedFast = live ? fastFor(turn.ctx.agent.runtime.fast, this.models, model, false) : null;
  }

  /** The input's effort and fast replies for the model it names (none: the tool's default). */
  apply(input: TurnInput): void {
    input.effort = turnEffort(
      this.#ctx.agent.runtime.effort,
      turnEffortKind(this.#ctx),
      effortsOf(this.models, input.model),
    );
    input.fast = fastFor(this.#ctx.agent.runtime.fast, this.models, input.model, this.#gateway);
  }

  /** What an attempt runs on (CR-R05): what it was started with; its speed as the provider says (CR-R04). */
  ran(input: TurnInput): TurnRanFacts {
    return {
      sent: { model: input.model, effort: input.effort, fast: input.fast },
      wanted: this.wantedFast,
      offered: modelFast(this.models, input.model),
      gateway: this.#gateway,
      speed: null,
    };
  }
}

/** What the completion says the provider ran: the model fallback (ME-05) and what the turn ran on (CR-R05). */
export class TurnRan {
  /** The agent's model was refused and the turn ran again on the tool's default (model-effort.md ME-05). */
  modelFallback: ModelFallbackReport | null = null;
  /**
   * What the turn ran on (chat-runtime.md CR-07; chat-runtime-runner.md CR-R05): set when a Claude Code or Codex attempt
   * starts, from what it was started with and what the provider said of its speed. Absent before the provider ran.
   */
  facts: TurnRanFacts | null = null;

  /** The completion's `modelFallback`, and its `ran` once an attempt started (a report the contract refuses, none). */
  report(): { modelFallback?: ModelFallbackReport; ran?: TurnRanReport } {
    const ran = this.facts ? turnRan(this.facts) : null;
    return { ...(this.modelFallback ? { modelFallback: this.modelFallback } : {}), ...(ran ? { ran } : {}) };
  }
}
