/**
 * The agent's AI provider in Settings → Agent → Model and AI (docs/decisions/agent-setup.md; one-agent.md AP-4968;
 * hermes-engine-app.md AP-5120…AP-5122): what it runs on now and what it could move to, as the web's picker allows —
 * Claude Code or ChatGPT when ready (named and stated as the web does, chatgpt-no-client.md AP-5611, AP-5613), and
 * Local (the burrow's model on its network, contracts 0.124 CT-1170) once you set one up. Then its model and effort (Whombat model-effort.md; AP-1133): MODEL and EFFORT as the web's Configure has them,
 * each choice with the whole model runtime it saves; since contracts 0.96 Fast replies where the model has them and the
 * summary line (Whombat chat-runtime.md CR-10; chat-runtime-android.md AP-2730, AP-2731). On Local MODEL lists its
 * models and takes any other by name (“Another model”, AP-5001); it has no effort and no fast replies.
 */
import {
  agentModelLine,
  backgroundModelChoices,
  draftWithBackgroundModel,
  draftWithEffort,
  draftWithFast,
  draftWithModel,
  effortChoices,
  effortHint,
  fastChoice,
  LOCAL_MODEL_TEXT,
  modelChoices,
  modelEffortLabels,
  modelFallbackNote,
  modelRuntimeBody,
  modelRuntimeDraft,
  providerModels,
} from '@whombat/client';
import { SOURCE_TEXT } from '@whombat/client/signins';
import {
  type AgentModelFallback,
  type AgentModelRuntime,
  type AgentProvider,
  type AgentRuntime,
  type AgentSetupStatus,
  agentsBlockedNotice,
  CHAT_PROVIDER_LABELS,
  engineReady,
  LIVE_PROVIDERS,
  type LocalModelView,
  localModelName,
  MODEL_EFFORT_COPY,
  PROVIDER_LABELS,
  providerStateLabel,
} from '@whombat/core';

export interface RunsOnOption {
  key: AgentProvider;
  label: string;
  /** “Ready · 2.1.278 (Claude Code)”, ChatGPT's “Ready”, “Not installed”, Local's name (“Llama on the NAS”)… */
  state: string;
  runtime: { provider: AgentProvider };
  selected: boolean;
  /** Can be picked now. */
  selectable: boolean;
}

export interface RunsOnModel {
  options: RunsOnOption[];
  /**
   * A line under the options: why the agent can't reply on this Whombat right now (its runner, or a part of the Whombat
   * that isn't ready, in the contracts' words), or that the model on the network it is on isn't set up.
   */
  note: string | null;
}

/** Local's line when the agent is on it and the burrow has none (the agent's own reply says the same, CT-1170). */
export const LOCAL_NOT_SET_UP = 'The custom AI model isn’t set up yet. Set it up in Settings → AI.';

export function runsOnModel(
  runtime: AgentRuntime,
  status: AgentSetupStatus,
  who: { agentName: string; localModel: LocalModelView | null },
): RunsOnModel {
  const options: RunsOnOption[] = LIVE_PROVIDERS.map((provider) => {
    const setup = status.providers.find((p) => p.provider === provider);
    const selected = runtime.provider === provider;
    return {
      key: provider,
      label: PROVIDER_LABELS[provider],
      state: setup ? providerStateLabel(setup) : 'Not checked yet',
      runtime: { provider },
      selected,
      selectable: !selected && setup?.state === 'ready',
    };
  });
  const local = who.localModel;
  const onLocal = runtime.provider === 'local';
  if (local || onLocal)
    options.push({
      key: 'local',
      label: CHAT_PROVIDER_LABELS.local,
      state: local ? localModelName(local) : PROVIDER_LABELS.local,
      runtime: { provider: 'local' },
      selected: onLocal,
      selectable: !onLocal && !!local,
    });
  const note = !engineReady(status)
    ? agentsBlockedNotice(status, who.agentName)
    : onLocal && !local
      ? LOCAL_NOT_SET_UP
      : null;
  return { options, note };
}

/** One choice in MODEL's or EFFORT's sheet: what it says and the whole model runtime picking it saves. */
export interface ModelEffortChoice {
  key: string;
  label: string;
  /** The model's own line, or what Automatic does. */
  detail: string | null;
  checked: boolean;
  runtime: AgentModelRuntime;
}

export interface ModelEffortView {
  model: { label: string; description: string | null; choices: ModelEffortChoice[] };
  /** Optional model for background work; null when the provider lists no models and none is set. */
  backgroundModel: { label: string; hint: string; choices: ModelEffortChoice[] } | null;
  /** Null when the model takes no effort. */
  effort: { label: string; hint: string; choices: ModelEffortChoice[] } | null;
  /**
   * Fast replies (CR-10, AP-2730): on or off as the agent has them, else the model's default, the provider's words, and
   * the whole model runtime each way saves; null where the model has none or the runtime lacks `chat.runtime`.
   */
  fast: {
    on: boolean;
    label: string;
    hint: string;
    runtime: (on: boolean) => AgentModelRuntime;
  } | null;
  /** RUNS ON's line under the provider it is on (AP-2731): “Opus · High effort · Fast”; null for the defaults. */
  summary: string | null;
  /** “Fable wasn’t available on Sara’s sign-in, so Banjo used the default model for that turn.” */
  fallback: string | null;
  /** Under the effort sheet's levels: a chosen level applies to every turn. */
  fixedHint: string;
  /**
   * Local only (AP-5001): the model sheet's “Another model” field — its words and the whole model runtime a typed name
   * saves; null for Claude Code and ChatGPT.
   */
  another: { label: string; hint: string; use: string; runtime: (name: string) => AgentModelRuntime } | null;
}

/**
 * MODEL and EFFORT on an agent's screen (AP-1133), as the web's Configure → Model & provider: only where the runtime has
 * `agents.model_effort`. The models are the tool's own list (“Default (Opus)” first), Local's the burrow's own and the
 * others its server listed (AP-5121); the levels the picked model takes after Automatic (none on Local). Each choice
 * carries the whole model runtime (`agents.update`), its effort kept within what a new model takes and its fast replies
 * kept (`fastFeature`: the runtime has `chat.runtime`, so Fast replies shows where the model has them, CR-10, CR-11).
 */
export function modelEffortView(
  agent: { name: string; runtime: AgentRuntime },
  status: AgentSetupStatus,
  feature: boolean,
  fallback: AgentModelFallback | null | undefined,
  fastFeature = false,
  localModel: LocalModelView | null = null,
): ModelEffortView | null {
  if (!feature) return null;
  const models = providerModels(status, agent.runtime.provider, localModel);
  const draft = modelRuntimeDraft(agent.runtime);
  const labels = modelEffortLabels(draft, models);
  const bgChoices = backgroundModelChoices(models, draft.backgroundModel).map((c) => ({
    key: c.id ?? 'same',
    label: c.label,
    detail: c.description,
    checked: c.id === (draft.backgroundModel ?? null),
    runtime: modelRuntimeBody(draftWithBackgroundModel(draft, c.id)),
  }));
  const efforts = effortChoices(models, draft.model, draft.effort).map((c) => ({
    key: c.value ?? 'automatic',
    label: c.label,
    detail: c.value ? null : MODEL_EFFORT_COPY.automaticHint,
    checked: c.value === draft.effort,
    runtime: modelRuntimeBody(draftWithEffort(draft, c.value)),
  }));
  return {
    model: {
      label: labels.model,
      description: labels.description,
      choices: modelChoices(models, draft.model).map((c) => ({
        key: c.id ?? 'default',
        label: c.label,
        detail: c.description,
        checked: c.id === draft.model,
        runtime: modelRuntimeBody(draftWithModel(draft, c.id, models)),
      })),
    },
    backgroundModel:
      bgChoices.length > 1
        ? { label: labels.backgroundModel, hint: MODEL_EFFORT_COPY.backgroundModelHint, choices: bgChoices }
        : null,
    effort: efforts.length
      ? { label: labels.effort, hint: effortHint(draft.effort), choices: efforts }
      : null,
    fast: fastOf(),
    summary: agentModelLine(agent.runtime, models, feature),
    fallback: modelFallbackNote(agent.name, fallback, models),
    fixedHint: MODEL_EFFORT_COPY.effortHint,
    another:
      agent.runtime.provider === 'local'
        ? {
            label: LOCAL_MODEL_TEXT.another,
            hint: LOCAL_MODEL_TEXT.anotherHint,
            use: LOCAL_MODEL_TEXT.use,
            runtime: (name) => modelRuntimeBody(draftWithModel(draft, name.trim() || null, models)),
          }
        : null,
  };

  function fastOf(): ModelEffortView['fast'] {
    const fast = fastFeature ? fastChoice(draft, models) : null;
    if (!fast) return null;
    return { ...fast, runtime: (on) => modelRuntimeBody(draftWithFast(draft, on, models)) };
  }
}

/* Whose sign-in its turns run on (OA-11; AP-4968; Whombat one-person.md OP-09) ------------------------------------ */

/** The provider's name in a sign-in line (the web's `PROVIDERS`): “Claude”, “ChatGPT”; Local has no sign-ins. */
const SIGN_IN_PROVIDERS: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'ChatGPT' };

export interface SignInLine {
  title: string;
  note: string;
}

/**
 * SIGN-IN under Model and AI (one-person-android.md AP-5763): your own sign-in, or your own API key, in the web's words
 * (`SOURCE_TEXT`). Null for a provider without sign-ins (the model on the network).
 */
export function signInLine(runtime: Pick<AgentRuntime, 'provider'>): SignInLine | null {
  const provider = SIGN_IN_PROVIDERS[runtime.provider];
  if (!provider) return null;
  return { title: SOURCE_TEXT.title(provider), note: SOURCE_TEXT.note };
}
