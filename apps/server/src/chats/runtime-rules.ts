/**
 * What answers in Chat, the pure part (docs/decisions/chat-runtime.md CR-02…CR-08; chat-runtime-server.md CR-S…): how a
 * thread's choice becomes the runtime a turn runs on, which choices a provider takes, what a reply says answered it at
 * post time and at completion, and a provider's 5-hour window. No I/O: the store (`chats/runtime.ts`), the dispatch
 * queue, the claim and the completion call these.
 */
import {
  type AgentModelRuntime,
  type AgentRuntime,
  CHAT_PROVIDER_LABELS,
  CHAT_PROVIDERS,
  CHAT_RUNTIME_COPY,
  type ChatProvider,
  type ChatProviderUsage,
  type ChatRuntime,
  chatModelLabel,
  chatRuntimeEquals,
  chatRuntimeOf,
  type DispatchTrigger,
  effortLabel,
  effortsFor,
  fastNoneText,
  type ModelFallbackReport,
  modelFast,
  modelOf,
  type ProviderModel,
  type RanOn,
  type TurnRanReport,
  turnEffort,
  turnFast,
  type UsageWindow,
} from '@whombat/core';

/** The longest `RanOn.modelLabel`. */
const MODEL_LABEL_MAX = 60;

/** Whether a provider is one Chat offers (Claude Code, Codex). */
export function isChatProvider(provider: string | null | undefined): provider is ChatProvider {
  return (CHAT_PROVIDERS as readonly string[]).includes(provider ?? '');
}

/**
 * The turns a Chat thread's choice applies to (CR-02, CR-03; CR-S04): what a person does in the thread — a message, a
 * mention, More detail, Try again, a yes or no to what the turn asked, a Vault pass, a run started there, a background
 * job's word back, an Undo. Never an automation, a schedule, a Feedback assessment, a reflection, a search
 * answer or work handed over: those keep the assistant's own runtime.
 */
export const THREAD_CHOICE_TRIGGERS: readonly DispatchTrigger[] = [
  'mention',
  'dm',
  'expand',
  'retry',
  'approval_granted',
  'approval_declined',
  'run_control',
  'notify',
  'task_finished',
  // A T3 Code thread handed work in this thread moved on (docs/decisions/t3code.md).
  't3_thread',
  // A council's members answered in this thread (docs/decisions/council.md).
  'council',
  // A delegation's tasks ended in this thread (docs/decisions/delegate.md).
  'delegation',
  'undo_requested',
  // The step a person let the assistant take on a look, pressed in the look's thread (look-research.md LR-08).
  'look_fix',
];

/** Whether a turn of this trigger follows its Chat thread's choice (CR-S04). */
export function followsThreadChoice(trigger: DispatchTrigger): boolean {
  return THREAD_CHOICE_TRIGGERS.includes(trigger);
}

/**
 * What a turn woken in a Chat thread is resolved to (CR-02): the thread's choice, while the assistant itself runs on
 * Claude Code or Codex (an assistant on another model has no choice to offer, CR-01) and the choice differs from its own.
 * Null: the agent's own runtime.
 */
export function resolveThreadRuntime(
  agent: Pick<AgentModelRuntime, 'provider' | 'model' | 'effort' | 'fast'>,
  choice: ChatRuntime | null | undefined,
): ChatRuntime | null {
  const own = chatRuntimeOf(agent);
  if (!own || !choice) return null;
  return chatRuntimeEquals(choice, own) ? null : choice;
}

/**
 * The runtime a turn runs on (CR-02; CR-S03): its agent's, with provider, model, effort and fast taken from the
 * dispatch's resolved runtime (absent there: the tool's default, automatic, the model's own speed); the rest (its
 * credential source) stays the agent's.
 */
export function turnRuntimeOf<R extends AgentRuntime>(agent: R, resolved: ChatRuntime | null | undefined): R {
  if (!resolved) return agent;
  const { model: _model, effort: _effort, fast: _fast, ...host } = agent;
  return {
    ...host,
    provider: resolved.provider,
    ...(resolved.model ? { model: resolved.model } : {}),
    ...(resolved.effort ? { effort: resolved.effort } : {}),
    ...(resolved.fast !== undefined ? { fast: resolved.fast } : {}),
  } as R;
}

/** The provider a turn runs on: its resolved runtime's, else its agent's stored one, else Claude Code's. */
export function turnProviderOf(
  agentRuntime: unknown,
  resolved: Pick<ChatRuntime, 'provider'> | null | undefined,
): string {
  if (resolved?.provider) return resolved.provider;
  const stored = (agentRuntime ?? {}) as { provider?: unknown };
  return typeof stored.provider === 'string' ? stored.provider : 'claude';
}

/** What a provider offers this person now, as checked against a choice (CR-04…CR-06). */
export interface ChatProviderFacts {
  /** Can this person's turn run on it now (`chats.runtime`'s `ready`). */
  ready: boolean;
  /** Its models as the runner listed them; null while none has (any model and effort are taken then, ME-04). */
  models: readonly ProviderModel[] | null;
  /** Its turns go through the AI gateway: no fast replies there (CR-06). */
  gateway: boolean;
}

export type ChoiceCheck = { ok: true; choice: ChatRuntime } | { ok: false; problem: string };

/**
 * Whether a provider takes a choice (CR-04…CR-06, ME-04's rules; CR-S05), and the choice as it is stored: the provider
 * must be ready for this person (“ChatGPT isn’t set up on this Whombat.”), the model in its list when there is one
 * (“ChatGPT has no model called “x” on this Whombat.”), the effort one the model takes (“Sonnet doesn’t take Max
 * effort.”), fast replies only where the model offers them (`fastNoneText`) and never through the AI gateway
 * (“Fast replies don’t go through the AI gateway.”). Fast off where there is none to turn off is dropped, not refused.
 */
export function checkChoice(choice: ChatRuntime, facts: ChatProviderFacts): ChoiceCheck {
  const label = CHAT_PROVIDER_LABELS[choice.provider];
  if (!facts.ready) return { ok: false, problem: CHAT_RUNTIME_COPY.notSetUp(label) };
  const models = facts.models;
  // The model on the person's network (CT-1173): any model it serves may be typed, and none takes an effort.
  const local = choice.provider === 'local';
  if (models && choice.model && !local && !models.some((m) => m.id === choice.model))
    return { ok: false, problem: `${label} has no model called “${choice.model}” on this Whombat.` };
  const efforts = local ? (modelOf(models, choice.model)?.efforts ?? []) : effortsFor(models, choice.model);
  if (choice.effort && !efforts.includes(choice.effort))
    return {
      ok: false,
      problem: `${chatModelLabel(models, choice.model)} doesn’t take ${effortLabel(choice.effort)} effort.`,
    };
  const stored: ChatRuntime = { provider: choice.provider };
  if (choice.model) stored.model = choice.model;
  if (choice.effort) stored.effort = choice.effort;
  if (choice.fast !== undefined) {
    const offered = models ? modelFast(models, choice.model) !== null : true;
    if (choice.fast && facts.gateway) return { ok: false, problem: CHAT_RUNTIME_COPY.fastGateway };
    if (choice.fast && !offered) return { ok: false, problem: fastNoneText(models, choice.model) };
    if (offered && !facts.gateway) stored.fast = choice.fast;
  }
  return { ok: true, choice: stored };
}

/** A model's label for a reply (“Opus”), or null when not known: no model named and no list saying the default. */
function labelOf(models: readonly ProviderModel[] | null, id: string | null | undefined): string | null {
  if (!id && !modelOf(models, null)) return null;
  return chatModelLabel(models, id).slice(0, MODEL_LABEL_MAX);
}

/**
 * What answered a reply, as it is posted (CR-07; CR-S08): the provider and model the turn was resolved to, the effort a
 * conversation turn sends (`turnEffort` with kind `chat`, within what the model takes) and whether it asked for fast
 * replies (`turnFast`; the model's own default when it doesn't say; never through the AI gateway, CR-R08). Null when the
 * turn isn't on Claude Code or Codex.
 */
export function ranOnAtPost(
  runtime: Pick<AgentModelRuntime, 'provider' | 'model' | 'effort' | 'fast'>,
  models: readonly ProviderModel[] | null,
  options: { gateway?: boolean } = {},
): RanOn | null {
  if (!isChatProvider(runtime.provider)) return null;
  const model = modelOf(models, runtime.model);
  return {
    provider: runtime.provider,
    model: runtime.model ?? null,
    modelLabel: labelOf(models, runtime.model),
    effort: turnEffort(runtime.effort, 'chat', model?.efforts ?? null),
    fast: !options.gateway && (turnFast(runtime.fast, model?.fast) ?? model?.fast === 'on'),
  };
}

/**
 * What answered a reply, once its turn completed (CR-07, CR-08; CR-S09): what the runner says the turn ran
 * (`CompleteBody.ran`: model, effort, fast and why not), and the model it asked for when that wasn't available and the
 * turn ran on the default (`modelFallback` → `modelSkipped`). An older runner sends no `ran`: the post-time values stay,
 * but a fallback it reports still says the turn came from the default model.
 */
export function ranOnAtCompletion(
  posted: RanOn,
  ran: TurnRanReport | undefined,
  fallback: Pick<ModelFallbackReport, 'model'> | undefined,
  models: readonly ProviderModel[] | null,
): RanOn {
  if (!ran && !fallback) return posted;
  const model = ran ? ran.model : fallback ? null : posted.model;
  return {
    provider: posted.provider,
    model,
    modelLabel: ran || fallback ? labelOf(models, model) : posted.modelLabel,
    effort: ran ? ran.effort : posted.effort,
    fast: ran ? ran.fast : posted.fast,
    fastSkipped: ran ? (ran.fastSkipped ?? null) : (posted.fastSkipped ?? null),
    modelSkipped: fallback?.model ?? null,
  };
}

/**
 * The 5-hour window of a sign-in (CR-09): how much is used and when it resets, from its snapshot's `five_hour` window
 * with a known share. Null for an API key, an unknown window or none.
 */
export function fiveHourUsage(
  snapshot: { kind: string; windows: readonly UsageWindow[] } | null | undefined,
): ChatProviderUsage | null {
  if (!snapshot || snapshot.kind === 'api_key') return null;
  const window = snapshot.windows.find((w) => w.kind === 'five_hour' && w.usedPct !== null);
  if (!window || window.usedPct === null) return null;
  return { usedPct: window.usedPct, resetsAt: window.resetsAt };
}
