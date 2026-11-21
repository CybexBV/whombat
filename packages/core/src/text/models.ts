/**
 * An agent's model and effort in words (0.77, CT-333; Whombat model-effort.md ME-06): Configure → Model's pickers and
 * hints, the profile's line, the Keys lines of a change and the quiet note when a turn ran on the default model. Fast
 * replies since 0.96 (CT-466); Configure → Model's Fast replies uses `CHAT_RUNTIME_COPY`'s words (`text/chat-runtime.ts`).
 */
import { type AgentEffort, type ModelFallbackWhere, modelOf, type ProviderModel } from '../domain/models.js';

export const EFFORT_LABELS: Readonly<Record<AgentEffort, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

export const MODEL_EFFORT_COPY = {
  modelSection: 'MODEL',
  effortSection: 'EFFORT',
  defaultModel: 'Default',
  automatic: 'Automatic',
  automaticHint: 'Medium for conversations, high for code work.',
  effortHint: 'Every reply and task uses this. Higher thinks longer: slower replies and more usage.',
  /** The toast's “Saved Banjo’s …”. */
  saved: 'model and effort',
} as const;

/** “Default (Opus)” — the tool's default model by name when the list says which — else “Default”. */
export function defaultModelLabel(models: readonly ProviderModel[] | null | undefined): string {
  const model = modelOf(models, null);
  return model ? `${MODEL_EFFORT_COPY.defaultModel} (${model.label})` : MODEL_EFFORT_COPY.defaultModel;
}

/** The agent's model by name: its label in the list, else its id; the default model's when it names none. */
export function modelLabel(
  models: readonly ProviderModel[] | null | undefined,
  id: string | null | undefined,
): string {
  if (!id) return defaultModelLabel(models);
  return modelOf(models, id)?.label ?? id;
}

/** “Automatic”, “High”, “Extra high”. */
export function effortLabel(effort: AgentEffort | null | undefined): string {
  return effort ? EFFORT_LABELS[effort] : MODEL_EFFORT_COPY.automatic;
}

/**
 * The profile's and Runs on's line: “Sonnet · High effort”, “Opus”, “Default model · Max effort”, and “· Fast” with fast
 * replies on (0.96, CT-466; Whombat chat-runtime.md CR-10): “Default model · Fast”. Null for the default model with
 * automatic effort and fast replies as the model has them (nothing to say).
 */
export function agentModelSummary(
  runtime: { model?: string | null; effort?: AgentEffort | null; fast?: boolean | null },
  models?: readonly ProviderModel[] | null,
): string | null {
  const fast = runtime.fast === true;
  if (!runtime.model && !runtime.effort && !fast) return null;
  const parts = [runtime.model ? modelLabel(models, runtime.model) : 'Default model'];
  if (runtime.effort) parts.push(`${EFFORT_LABELS[runtime.effort]} effort`);
  if (fast) parts.push('Fast');
  return parts.join(' · ');
}

/** The Keys line of a model change: “Set Banjo’s model to Sonnet”, “… to Default (Opus)”. */
export function agentModelChangeText(agentName: string, label: string): string {
  return `Set ${agentName}’s model to ${label}`;
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
export function modelFallbackText(agentName: string, modelName: string, where: ModelFallbackWhere): string {
  const on =
    where.kind === 'gateway'
      ? `through ${where.name ?? 'the AI gateway'}`
      : where.kind === 'org'
        ? 'on the organization’s key'
        : where.kind === 'local'
          ? 'on the model server on your network'
          : `on ${where.name ? `${where.name}’s` : 'that person’s'} sign-in`;
  return `${modelName} wasn’t available ${on}, so ${agentName} used the default model for that reply.`;
}
