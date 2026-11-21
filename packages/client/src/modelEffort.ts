/**
 * An agent's model and effort (Whombat model-effort.md ME-01…ME-07; contracts 0.77.0, CT-333; app
 * docs/decisions/model-effort.md AP-1128…): what the web's Configure → Model & provider and Android's agent screen share
 * — the model runtime as a draft (a new provider clears model and effort, a new model keeps the effort within what it
 * takes), the whole model runtime `agents.update` gets every time, the pickers' choices and hints, the quiet note when a
 * turn ran on the default model and the profile's line. Every word is the contracts' (`text/models.ts`). A model on the
 * person's network (`local`, contracts 0.124 CT-1173; hermes-engine-app.md AP-5000) has a model too — the burrow's own
 * first, the others its server listed, any other typed — and no effort or fast replies. Pure.
 */
import {
  AGENT_EFFORTS,
  type AgentEffort,
  type AgentModelFallback,
  type AgentModelRuntime,
  type AgentModelRuntimeUpdate,
  type AgentProvider,
  effortsFor,
  type LocalModelView,
  localProviderModels,
  modelFast,
  modelOf,
  type ProviderModel,
  turnEffort,
} from '@whombat/core/domain';
import {
  agentModelSummary,
  backgroundModelLabel,
  CHAT_RUNTIME_COPY,
  defaultModelLabel,
  EFFORT_LABELS,
  effortLabel,
  MODEL_EFFORT_COPY,
  modelFallbackText,
  modelLabel,
} from '@whombat/core/text';

/** The model part of an agent's runtime while someone edits it: null is the default model, automatic effort. */
export interface ModelRuntimeDraft {
  provider: AgentProvider;
  /** One of the tool's models (`ProviderModel.id`); null: the tool's default. */
  model: string | null;
  /** Optional model of the same provider for background work; absent/null: same as the main model. */
  backgroundModel?: string | null;
  /** null: automatic (high for code work, medium for conversation); always null on `local`. */
  effort: AgentEffort | null;
  /**
   * Fast replies: on or off; absent: the model's own default.
   * Carried through every change, so saving a model or an effort never drops it.
   */
  fast?: boolean;
}

/** The tools whose effort and fast replies an agent picks: Claude Code and ChatGPT (custom AI models have neither). */
export function hasModelEffort(provider: AgentProvider): provider is 'claude' | 'codex' {
  return provider === 'claude' || provider === 'codex';
}

/** An agent's stored model runtime as a draft. */
export function modelRuntimeDraft(
  runtime: Pick<AgentModelRuntimeUpdate, 'provider' | 'model' | 'backgroundModel' | 'effort' | 'fast'>,
): ModelRuntimeDraft {
  const own = hasModelEffort(runtime.provider);
  return {
    provider: runtime.provider,
    model: runtime.model ?? null,
    ...(runtime.backgroundModel ? { backgroundModel: runtime.backgroundModel } : {}),
    effort: own ? (runtime.effort ?? null) : null,
    ...(own && runtime.fast !== undefined ? { fast: runtime.fast } : {}),
  };
}

/**
 * Another provider picked: main model, background model, effort and fast replies go back to their defaults
 * (a model id belongs to its provider). Picking the one it is on changes nothing.
 */
export function draftWithProvider(draft: ModelRuntimeDraft, provider: AgentProvider): ModelRuntimeDraft {
  if (provider === draft.provider) return draft;
  return { provider, model: null, effort: null };
}

/**
 * Another model picked (null: the default): a chosen effort stays when the model takes it, else becomes the nearest
 * level it does take (`turnEffort`), and automatic when it takes none; fast replies are dropped when it
 * has none. While the list doesn't know the model, the effort and fast replies stay as they are.
 */
export function draftWithModel(
  draft: ModelRuntimeDraft,
  model: string | null,
  models: readonly ProviderModel[] | null | undefined,
): ModelRuntimeDraft {
  const known = modelOf(models, model);
  const supported = known?.efforts ?? null;
  const effort = draft.effort ? turnEffort(draft.effort, 'chat', supported) : null;
  const { fast, ...rest } = draft;
  return { ...rest, model, effort, ...(fast !== undefined && (!known || known.fast) ? { fast } : {}) };
}

/** Another background model picked (null: explicit “Same as the main model”). */
export function draftWithBackgroundModel(
  draft: ModelRuntimeDraft,
  backgroundModel: string | null,
): ModelRuntimeDraft {
  const { backgroundModel: _bg, ...rest } = draft;
  const trimmed = backgroundModel?.trim();
  return { ...rest, backgroundModel: trimmed || null };
}

/** Another effort picked (null: automatic). */
export function draftWithEffort(draft: ModelRuntimeDraft, effort: AgentEffort | null): ModelRuntimeDraft {
  return { ...draft, effort };
}

/**
 * Fast replies turned on or off (CR-10); left out when that is the model's own default, so the agent follows the model.
 */
export function draftWithFast(
  draft: ModelRuntimeDraft,
  on: boolean,
  models: readonly ProviderModel[] | null | undefined,
): ModelRuntimeDraft {
  const { fast: _, ...rest } = draft;
  const offered = modelFast(models, draft.model);
  return offered && on === (offered === 'on') ? rest : { ...rest, fast: on };
}

/**
 * Configure → Model's Fast replies (CR-10): shown only when the picked model offers them, with the provider's hint
 * (`CHAT_RUNTIME_COPY.fastHint`); `on` as the draft has it, else the model's default. Null: hidden.
 */
export function fastChoice(
  draft: Pick<ModelRuntimeDraft, 'provider' | 'model' | 'fast'>,
  models: readonly ProviderModel[] | null | undefined,
): { on: boolean; label: string; hint: string } | null {
  if (!hasModelEffort(draft.provider)) return null;
  const offered = modelFast(models, draft.model);
  if (!offered) return null;
  return {
    on: draft.fast ?? offered === 'on',
    label: CHAT_RUNTIME_COPY.fast,
    hint: CHAT_RUNTIME_COPY.fastHint[draft.provider],
  };
}

/**
 * `agents.update`'s `runtime`: the whole model runtime, every time, so saving one field never drops another:
 * `{provider, model?, backgroundModel?, effort?, fast?}` (explicit `null` clears `backgroundModel`; omitted keeps it
 * on the same provider).
 */
export function modelRuntimeBody(draft: ModelRuntimeDraft): AgentModelRuntimeUpdate {
  const own = hasModelEffort(draft.provider);
  const model = draft.model?.trim();
  const backgroundModel = draft.backgroundModel?.trim();
  return {
    provider: draft.provider,
    ...(model ? { model } : {}),
    ...(backgroundModel
      ? { backgroundModel }
      : draft.backgroundModel === null
        ? { backgroundModel: null }
        : {}),
    ...(own && draft.effort ? { effort: draft.effort } : {}),
    ...(own && draft.fast !== undefined ? { fast: draft.fast } : {}),
  };
}

/**
 * The models a provider offers on this Whombat: a tool's as the runner lists them (`ProviderSetup.models`; undefined
 * while they aren't known), the model on the network's from the burrow (`localProviderModels`: its own first, then the
 * others its last test listed; empty without one).
 */
export function providerModels(
  status:
    | { providers: readonly { provider: string; models?: readonly ProviderModel[] | undefined }[] }
    | null
    | undefined,
  provider: AgentProvider,
  localModel?: Pick<LocalModelView, 'model' | 'label' | 'check'> | null,
): readonly ProviderModel[] | undefined {
  if (provider === 'local') return localProviderModels(localModel);
  return status?.providers.find((p) => p.provider === provider)?.models;
}

/** One of MODEL's choices: `id` null is the tool's default. */
export interface ModelChoice {
  id: string | null;
  /** “Default (Opus)”, “Sonnet”, an id the list doesn't have. */
  label: string;
  /** The tool's own line about it (“Sonnet 5 · Best for everyday tasks”); none for the default and unknown ids. */
  description: string | null;
}

/**
 * MODEL's choices: “Default (Opus)” first (no model), then the tool's list in its order; the agent's own model last when
 * the list doesn't have it or isn't known, by its id, so what it is on always shows.
 */
export function modelChoices(
  models: readonly ProviderModel[] | null | undefined,
  current: string | null,
): ModelChoice[] {
  const choices: ModelChoice[] = [
    { id: null, label: defaultModelLabel(models), description: null },
    ...(models ?? []).map((m) => ({ id: m.id, label: m.label, description: m.description })),
  ];
  if (current && !choices.some((c) => c.id === current))
    choices.push({ id: current, label: modelLabel(models, current), description: null });
  return choices;
}

/**
 * BACKGROUND MODEL's choices: “Same as the main model” first (no override), then only the models the chosen provider
 * actually lists; a previously stored id that left the list stays visible so the person can see and change it.
 */
export function backgroundModelChoices(
  models: readonly ProviderModel[] | null | undefined,
  current: string | null | undefined,
): ModelChoice[] {
  const choices: ModelChoice[] = [
    { id: null, label: MODEL_EFFORT_COPY.backgroundModelSame, description: null },
    ...(models ?? []).map((m) => ({ id: m.id, label: m.label, description: m.description })),
  ];
  if (current && !choices.some((c) => c.id === current))
    choices.push({ id: current, label: backgroundModelLabel(models, current), description: null });
  return choices;
}

/** One of EFFORT's choices: `value` null is Automatic. */
export interface EffortChoice {
  value: AgentEffort | null;
  /** “Automatic”, “Extra high”. */
  label: string;
}

/**
 * EFFORT's choices: Automatic, then the levels the picked model takes, least first (every level while the list doesn't
 * know the model); the agent's own level in its place when the model doesn't take it. None at all for a model that takes
 * no effort: then the section isn't shown.
 */
export function effortChoices(
  models: readonly ProviderModel[] | null | undefined,
  model: string | null,
  current: AgentEffort | null,
): EffortChoice[] {
  const efforts = effortsFor(models, model);
  if (efforts.length === 0 && !current) return [];
  return [
    { value: null, label: MODEL_EFFORT_COPY.automatic },
    ...AGENT_EFFORTS.filter((e) => efforts.includes(e) || e === current).map((e) => ({
      value: e,
      label: EFFORT_LABELS[e],
    })),
  ];
}

/** The line under EFFORT: what Automatic does, or that a chosen level applies to every turn. */
export function effortHint(effort: AgentEffort | null): string {
  return effort ? MODEL_EFFORT_COPY.effortHint : MODEL_EFFORT_COPY.automaticHint;
}

/** The picked model, background model and effort in words (Android's rows): “Default (Opus)”, “Same as the main model”, “Automatic”. */
export function modelEffortLabels(
  draft: Pick<ModelRuntimeDraft, 'model' | 'backgroundModel' | 'effort'>,
  models: readonly ProviderModel[] | null | undefined,
): { model: string; description: string | null; backgroundModel: string; effort: string } {
  return {
    model: modelLabel(models, draft.model),
    description: draft.model ? (modelOf(models, draft.model)?.description ?? null) : null,
    backgroundModel: backgroundModelLabel(models, draft.backgroundModel),
    effort: effortLabel(draft.effort),
  };
}

/**
 * The quiet note when the agent's last turn ran on the default model (ME-05): “Fable wasn’t available on Sara’s sign-in,
 * so Banjo used the default model for that turn.”; null when it didn't.
 */
export function modelFallbackNote(
  agentName: string,
  fallback: AgentModelFallback | null | undefined,
  models: readonly ProviderModel[] | null | undefined,
): string | null {
  return fallback ? modelFallbackText(agentName, modelLabel(models, fallback.model), fallback.where) : null;
}

/**
 * The profile's line (ME-06): “Sonnet · High effort”, “Opus”, “Default model · Max effort”, “· Fast” with fast replies
 * on (CR-10), a model on the network's by its name; null for the default model with automatic effort and on a runtime
 * without `agents.model_effort`.
 */
export function agentModelLine(
  runtime: Pick<AgentModelRuntime, 'provider' | 'model' | 'effort' | 'fast'> | null | undefined,
  models: readonly ProviderModel[] | null | undefined,
  feature: boolean,
): string | null {
  if (!feature || !runtime) return null;
  return agentModelSummary(runtime, models);
}
