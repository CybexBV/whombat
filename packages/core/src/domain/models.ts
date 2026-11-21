/**
 * An agent's model and effort (0.77, CT-333; Whombat model-effort.md): which of its tool's models runs the agent's
 * turns and how hard it thinks. The tools list their own models (`ProviderModel`, read by the runner from Claude Code's
 * `initialize` and Codex's `model/list`, without a sign-in); an agent names one (`AgentModelRuntime.model`, absent: the
 * tool's default) and an effort (`AgentModelRuntime.effort`, absent: automatic). Since 0.96 (CT-456; Whombat
 * chat-runtime.md CR-06) also fast replies, where the model offers them (`ProviderModel.fast`, `AgentModelRuntime.fast`).
 */
import { z } from 'zod';
import { Timestamp } from './common.js';

/**
 * How hard the model thinks in a turn, least first: Claude Code's `--effort`, Codex's `turn/start` `effort`. A model
 * supports some of them (`ProviderModel.efforts`): Claude Code's `low`…`max`, Codex's `low`…`ultra` on some models.
 */
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export const AgentEffort = z.enum(AGENT_EFFORTS);
export type AgentEffort = z.infer<typeof AgentEffort>;

/** A model's id as the tool takes it: `opus`, `claude-fable-5-1[1m]`, `gpt-6.1-sol`. */
export const MODEL_ID_MAX = 120;
export const ModelId = z.string().trim().min(1).max(MODEL_ID_MAX);

/** At most this many models in a tool's list. */
export const PROVIDER_MODELS_MAX = 40;

/**
 * Fast replies on a model (0.96, CT-456; Whombat chat-runtime.md CR-06): `off` — offered, off unless asked; `on` —
 * offered and on by default. Claude Code's `supportsFastMode` (`off`), Codex's `priority` service tier (`on` where it is
 * the model's `defaultServiceTier`, else `off`).
 */
export const MODEL_FAST = ['off', 'on'] as const;
export const ModelFast = z.enum(MODEL_FAST);
export type ModelFast = z.infer<typeof ModelFast>;

/** One model a tool offers, as the tool itself lists it. */
export const ProviderModel = z.object({
  /** What the tool takes (`--model`, Codex's `model`); an agent stores it as `runtime.model`. */
  id: ModelId,
  /** “Opus”, “GPT-6.1-Sol”. */
  label: z.string().min(1).max(60),
  /** The tool's own line about it, without prices (“Opus 5.5 · Best for everyday, complex tasks”). */
  description: z.string().max(200).nullable(),
  /** The efforts it takes, least first. Empty: it takes none, and no effort is sent with it. */
  efforts: z.array(AgentEffort).max(AGENT_EFFORTS.length),
  /** The model the tool runs when the agent names none. At most one in a list. */
  isDefault: z.boolean(),
  /**
   * Its fast replies (0.96, CT-456): `off` or `on` by default. Absent or null: it has none, and
   * nothing about speed is sent with it.
   */
  fast: ModelFast.nullable().optional(),
});
export type ProviderModel = z.infer<typeof ProviderModel>;

export const ProviderModels = z.array(ProviderModel).max(PROVIDER_MODELS_MAX);

/** The kind of turn automatic effort tells apart (Whombat RA-DS57): code work, or everything conversational. */
export type TurnEffortKind = 'work' | 'chat';

/**
 * Automatic effort (Whombat RA-DS57, ME-02): code work — a run, work handed over, an automation's step with a writable
 * checkout — thinks hard; conversation stays quick. The same for Claude Code and Codex.
 */
export const AUTOMATIC_EFFORT: Readonly<Record<TurnEffortKind, AgentEffort>> = {
  work: 'high',
  chat: 'medium',
};

/** The model of `models` the agent runs: the one named `id`, else the tool's default; null when the list doesn't have it. */
export function modelOf(
  models: readonly ProviderModel[] | null | undefined,
  id: string | null | undefined,
): ProviderModel | null {
  if (!models) return null;
  return id ? (models.find((m) => m.id === id) ?? null) : (models.find((m) => m.isDefault) ?? null);
}

/**
 * The efforts an agent may pick with `id` (absent: the default model): that model's, or every effort while the list
 * isn't known or doesn't have the model (the runner keeps a turn's effort within what the model takes, `turnEffort`).
 */
export function effortsFor(
  models: readonly ProviderModel[] | null | undefined,
  id: string | null | undefined,
): readonly AgentEffort[] {
  return modelOf(models, id)?.efforts ?? AGENT_EFFORTS;
}

/**
 * The effort a turn runs with (ME-02, ME-03): the agent's own, else automatic for the kind of turn, kept within what the
 * model takes — the nearest lower one it has, else the nearest higher. Null when the model takes none (`supported` is
 * empty): no effort is sent. `supported` absent or null: not known, the effort as it is.
 */
export function turnEffort(
  setting: AgentEffort | null | undefined,
  kind: TurnEffortKind,
  supported?: readonly AgentEffort[] | null,
): AgentEffort | null {
  const wanted = setting ?? AUTOMATIC_EFFORT[kind];
  if (!supported) return wanted;
  if (supported.length === 0) return null;
  if (supported.includes(wanted)) return wanted;
  const at = AGENT_EFFORTS.indexOf(wanted);
  const lower = AGENT_EFFORTS.slice(0, at)
    .reverse()
    .find((e) => supported.includes(e));
  return lower ?? AGENT_EFFORTS.slice(at + 1).find((e) => supported.includes(e)) ?? null;
}

/** Whether the model of `models` named `id` (absent: the default) has fast replies, and their default; null when not. */
export function modelFast(
  models: readonly ProviderModel[] | null | undefined,
  id: string | null | undefined,
): ModelFast | null {
  return modelOf(models, id)?.fast ?? null;
}

/**
 * Whether a turn asks for fast replies (0.96, CT-457; CR-06): the runtime's `fast`, when the model offers them. Null —
 * nothing is sent, so the model's own default applies — when the runtime doesn't say (`setting` absent) or the model has
 * none (`offered` null or absent). `false` is sent too: it turns a model's default `on` off.
 */
export function turnFast(
  setting: boolean | null | undefined,
  offered: ModelFast | null | undefined,
): boolean | null {
  if (setting === undefined || setting === null || !offered) return null;
  return setting;
}

/**
 * Why a turn asked for fast replies but ran at the normal speed (0.96, CT-458; CR-08): `busy` — the fast tier's own
 * limit or cooldown; `credits` — no usage credits on the Claude account (Codex: the plan's usage); `org` — the Claude
 * organization (Codex: the ChatGPT workspace) has them turned off; `unavailable` — anything else.
 */
export const FAST_SKIPPED_REASONS = ['busy', 'credits', 'org', 'unavailable'] as const;
export const FastSkippedReason = z.enum(FAST_SKIPPED_REASONS);
export type FastSkippedReason = z.infer<typeof FastSkippedReason>;

/**
 * What a turn actually ran on, as the runner reports it (0.96, CT-458; `CompleteBody.ran`): the model (null: the tool's
 * default, no `--model` sent), the effort sent (null: none), whether it ran fast, and why not when fast was asked for.
 */
export const TurnRanReport = z.object({
  model: ModelId.nullable(),
  effort: AgentEffort.nullable(),
  fast: z.boolean(),
  fastSkipped: FastSkippedReason.nullable().optional(),
});
export type TurnRanReport = z.infer<typeof TurnRanReport>;

/**
 * The agent's model refused a turn — not available on the sign-in or gateway the turn ran on — so the runner ran the
 * turn again on the tool's default (ME-05). `detail` is what the tool said, for owners and admins only.
 */
export const ModelFallbackReport = z.object({
  model: ModelId,
  detail: z.string().max(500),
});
export type ModelFallbackReport = z.infer<typeof ModelFallbackReport>;

/**
 * Where a turn's model wasn't available: a person's sign-in (`name` is theirs), the organization's key, the burrow's
 * AI gateway (`name` is the gateway's, “Fusebox”), or the model server on the owner's network (`local`, 0.124 CT-1173;
 * `name` is `localModelName`'s, and the turn ran on the burrow's own model).
 */
export const ModelFallbackWhere = z.object({
  kind: z.enum(['account', 'org', 'gateway', 'local']),
  name: z.string().max(80).nullable(),
});
export type ModelFallbackWhere = z.infer<typeof ModelFallbackWhere>;

/**
 * The agent's last turn ran on the tool's default because its model wasn't available there (ME-05): shown quietly on
 * Configure → Model (`modelFallbackText`), never in a conversation. Cleared by a later turn on the agent's model and
 * by a change of model.
 */
export const AgentModelFallback = z.object({
  model: ModelId,
  where: ModelFallbackWhere,
  at: Timestamp,
});
export type AgentModelFallback = z.infer<typeof AgentModelFallback>;
