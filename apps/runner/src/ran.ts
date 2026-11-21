/**
 * What a Claude Code or Codex turn ran on, for its completion (`CompleteBody.ran`, Whombat chat-runtime.md CR-07, CR-08;
 * chat-runtime-runner.md CR-R01, CR-R05…CR-R08): the model sent (null: the tool's default, also after the ME-05
 * fallback), the effort sent (null: none), whether its model calls ran fast, and why not when fast replies were asked
 * for. ACP runtimes and the scripted demo report none.
 */
import {
  type AgentEffort,
  type FastSkippedReason,
  type ModelFast,
  modelFast,
  type ProviderModel,
  TurnRanReport,
  turnFast,
} from '@whombat/core';

/** The provider's `speed` event: how fast it ran, and why not when the turn asked (claude/fast.ts). */
export interface TurnSpeed {
  fast: boolean;
  skipped?: FastSkippedReason;
}

/**
 * The fast replies a turn asks for (CR-06, CR-R01): the runtime's `fast` (the agent's, or the Chat thread's the server
 * put in its place), only where the turn's model offers them by this runner's list (`turnFast`: an unknown list or model
 * sends nothing); nothing through the AI gateway, where Whombat doesn't offer them (CR-R08).
 */
export function fastFor(
  setting: boolean | null | undefined,
  models: readonly ProviderModel[] | null,
  model: string | undefined,
  gateway: boolean,
): boolean | null {
  return gateway ? null : turnFast(setting, modelFast(models, model));
}

export interface TurnRanFacts {
  /** What the attempt that counts was started with (`TurnInput`). */
  sent: {
    model?: string | undefined;
    effort?: AgentEffort | null | undefined;
    fast?: boolean | null | undefined;
  };
  /**
   * The fast replies the turn wanted before the AI gateway or a fallback to the default model had their say:
   * `fastFor` on the agent's own model, the gateway left out.
   */
  wanted: boolean | null;
  /** The sent model's fast replies by this runner's list (`modelFast`): the model's own default when nothing was sent. */
  offered: ModelFast | null;
  /** The turn went through the burrow's AI gateway: its speed isn't known, and never fast by Whombat's asking. */
  gateway: boolean;
  /** The provider's last `speed` event of that attempt; null when it said nothing (Codex, an older Claude Code). */
  speed: TurnSpeed | null;
}

/**
 * The completion's `ran` (CR-R05…CR-R08). Fast: what the provider said, else what was sent, else the model's own default
 * (`on`) — never through the gateway. `fastSkipped` only when fast was wanted or sent and it didn't run fast: the
 * provider's reason, else `unavailable` (the gateway, a default model without fast replies). Null when it wouldn't pass
 * the contract (a model id over 120 characters): the completion goes without it.
 */
export function turnRan(facts: TurnRanFacts): TurnRanReport | null {
  const { sent, speed } = facts;
  const fast = speed ? speed.fast : (sent.fast ?? (!facts.gateway && facts.offered === 'on'));
  const asked = facts.wanted === true || sent.fast === true;
  const report: TurnRanReport = {
    model: sent.model ?? null,
    effort: sent.effort ?? null,
    fast,
    ...(asked && !fast ? { fastSkipped: speed?.skipped ?? 'unavailable' } : {}),
  };
  const parsed = TurnRanReport.safeParse(report);
  return parsed.success ? parsed.data : null;
}
