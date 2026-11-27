/**
 * An agent's model and effort in words (0.77, CT-333; Whombat model-effort.md ME-06): Configure → Model's pickers and
 * hints, the profile's line, the Keys lines of a change and the quiet note when a turn ran on the default model. Fast
 * replies since 0.96 (CT-466); Configure → Model's Fast replies uses `CHAT_RUNTIME_COPY`'s words (`text/chat-runtime.ts`).
 */

import { type AgentEffort, type ModelFallbackWhere, modelOf, type ProviderModel } from '../domain/models.js';
import { coreTranslator, coreWords } from '../i18n/catalog.js';

const EFFORTS: readonly AgentEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Effort names in a locale. */
export function effortLabels(locale?: string | null): Readonly<Record<AgentEffort, string>> {
  return coreWords(locale, 'effort', EFFORTS);
}

export const EFFORT_LABELS: Readonly<Record<AgentEffort, string>> = effortLabels('en');

const MODEL_EFFORT_KEYS = [
  'modelSection',
  'backgroundModelSection',
  'effortSection',
  'defaultModel',
  'backgroundModelSame',
  'backgroundModelHint',
  'automatic',
  'automaticHint',
  'effortHint',
  /** The toast's “Saved Banjo’s …”. */
  'saved',
  /** Shown when the box answered ok without keeping what the app asked to save (e.g. an older box stripped a field). */
  'notSaved',
] as const;

/** Configure → Model's words in a locale. */
export function modelEffortCopy(
  locale?: string | null,
): Readonly<Record<(typeof MODEL_EFFORT_KEYS)[number], string>> {
  return coreWords(locale, 'model', MODEL_EFFORT_KEYS);
}

export const MODEL_EFFORT_COPY = modelEffortCopy('en');

/** “Default (Opus)” — the tool's default model by name when the list says which — else “Default”. */
export function defaultModelLabel(
  models: readonly ProviderModel[] | null | undefined,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const model = modelOf(models, null);
  const word = tr.t('model.defaultModel');
  return model ? tr.t('model.defaultNamed', { default: word, model: model.label }) : word;
}

/** The agent's model by name: its label in the list, else its id; the default model's when it names none. */
export function modelLabel(
  models: readonly ProviderModel[] | null | undefined,
  id: string | null | undefined,
  locale?: string | null,
): string {
  if (!id) return defaultModelLabel(models, locale);
  return modelOf(models, id)?.label ?? id;
}

/** The agent's background model by name: its label in the list, else its id; “Same as the main model” when none. */
export function backgroundModelLabel(
  models: readonly ProviderModel[] | null | undefined,
  id: string | null | undefined,
  locale?: string | null,
): string {
  if (!id) return coreTranslator(locale).t('model.backgroundModelSame');
  return modelOf(models, id)?.label ?? id;
}

/** “Automatic”, “High”, “Extra high”. */
export function effortLabel(effort: AgentEffort | null | undefined, locale?: string | null): string {
  const tr = coreTranslator(locale);
  return effort ? tr.t(`effort.${effort}`) : tr.t('model.automatic');
}

/**
 * The profile's and Runs on's line: “Sonnet · High effort”, “Opus”, “Default model · Max effort”, and “· Fast” with fast
 * replies on (0.96, CT-466; Whombat chat-runtime.md CR-10): “Default model · Fast”. Null for the default model with
 * automatic effort and fast replies as the model has them (nothing to say).
 */
export function agentModelSummary(
  runtime: { model?: string | null; effort?: AgentEffort | null; fast?: boolean | null },
  models?: readonly ProviderModel[] | null,
  locale?: string | null,
): string | null {
  const tr = coreTranslator(locale);
  const fast = runtime.fast === true;
  if (!runtime.model && !runtime.effort && !fast) return null;
  const parts = [runtime.model ? modelLabel(models, runtime.model, locale) : tr.t('model.defaultModelWords')];
  if (runtime.effort) parts.push(tr.t('model.effortWords', { effort: tr.t(`effort.${runtime.effort}`) }));
  if (fast) parts.push(tr.t('model.fast'));
  return parts.join(' · ');
}

/** The Keys line of a model change: “Set Banjo’s model to Sonnet”, “… to Default (Opus)”. Signed, so English. */
export function agentModelChangeText(agentName: string, label: string): string {
  return `Set ${agentName}’s model to ${label}`;
}

/** The Keys line of a background model change: “Set Banjo’s background model to Haiku”, “… to Same as the main model”. */
export function agentBackgroundModelChangeText(agentName: string, label: string): string {
  return `Set ${agentName}’s background model to ${label}`;
}

/** The Keys line of an effort change: “Set Banjo’s effort to High”, “… to Automatic”. */
export function agentEffortChangeText(agentName: string, effort: AgentEffort | null | undefined): string {
  return `Set ${agentName}’s effort to ${effortLabel(effort)}`;
}

/** The Keys line of fast replies turned on or off (0.96, CT-466; CR-10): “Turned on fast replies for Neo”. */
export function agentFastChangeText(agentName: string, on: boolean): string {
  return `Turned ${on ? 'on' : 'off'} fast replies for ${agentName}`;
}

/**
 * Configure → Model's quiet note (ME-05): “Fable wasn’t available on Sara’s sign-in, so Banjo used the default model
 * for that turn.” — on the organization’s key, through Fusebox.
 */
export function modelFallbackText(
  agentName: string,
  modelName: string,
  where: ModelFallbackWhere,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const on =
    where.kind === 'gateway'
      ? where.name
        ? tr.t('model.fallbackGateway', { name: where.name })
        : tr.t('model.fallbackGatewayUnnamed')
      : where.kind === 'org'
        ? tr.t('model.fallbackOrg')
        : where.kind === 'local'
          ? tr.t('model.fallbackLocal')
          : where.name
            ? tr.t('model.fallbackPerson', { name: where.name })
            : tr.t('model.fallbackSomeone');
  return tr.t('model.fallback', { model: modelName, on, agent: agentName });
}
