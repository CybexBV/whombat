/**
 * The route a Hermes session runs on (docs/decisions/hermes-native.md HN-07, HN-L05…HN-L08): Hermes freezes a session's
 * provider and model when it begins and keeps them across config changes (CDS-03's finding), so a resumed session runs
 * on what it began with, not on what the turn's `config.yaml` names. The turn's route is the provider and model its
 * config names (`hermesRouteOf`); the session's is what Hermes says on `session/resume` or `session/load`
 * (`models.currentModelId`, Hermes's `<provider>:<model>`, a named provider as `custom:<name>:<model>`). Pure.
 */

/** A provider and a model as Hermes's `config.yaml` names them (`model.provider`, `model.default`). */
export interface HermesRoute {
  /** `claude-subscription-directsdk-experimental`, `openai-codex`, `whombat-<kind>-<hex>`. */
  provider: string;
  /** Null: none named (the provider's own default). */
  model: string | null;
}

/** The route a turn's config names. */
export function hermesRouteOf(config: Record<string, unknown>): HermesRoute {
  const block = (config.model ?? {}) as { provider?: unknown; default?: unknown };
  const provider = typeof block.provider === 'string' ? block.provider.trim() : '';
  const model = typeof block.default === 'string' && block.default.trim() ? block.default.trim() : null;
  return { provider, model };
}

/**
 * How a resumed session fits the turn (HN-07): `same` — resume it; `model` — the same provider on another model,
 * `session/set_model` (`modelId`) before the prompt; `provider` — another provider (or a retired route such as
 * `claude-cli`): not resumed; `unknown` — Hermes didn't say, resumed as it is.
 */
export type SessionFit =
  | { fit: 'same' }
  | { fit: 'model'; from: string; modelId: string }
  | { fit: 'provider'; from: string }
  | { fit: 'unknown' };

/** The session's route in Hermes's id, split on the turn's provider (`P:` or `custom:P:`); null when it's another. */
function onProvider(currentModelId: string, provider: string): { prefix: string; model: string } | null {
  for (const prefix of [provider, `custom:${provider}`]) {
    if (currentModelId.startsWith(`${prefix}:`))
      return { prefix, model: currentModelId.slice(prefix.length + 1) };
  }
  return null;
}

/** The provider part of Hermes's id, for the log: `custom:<name>`, else what comes before the first colon. */
function providerPart(currentModelId: string): string {
  const parts = currentModelId.split(':');
  return parts[0] === 'custom' && parts.length > 2 ? `custom:${parts[1]}` : (parts[0] ?? '');
}

/** Whether a resumed session (`currentModelId`, Hermes's) runs on the turn's route (`turn`), and what to do if not. */
export function sessionFit(currentModelId: string | null | undefined, turn: HermesRoute): SessionFit {
  const id = currentModelId?.trim() ?? '';
  // Hermes says nothing (no models in its answer), or a model without its provider: nothing to compare.
  if (!id || !turn.provider || !id.includes(':')) return { fit: 'unknown' };
  const on = onProvider(id, turn.provider);
  if (!on) return { fit: 'provider', from: providerPart(id) };
  if (!turn.model || on.model === turn.model) return { fit: 'same' };
  return {
    fit: 'model',
    from: on.model,
    modelId: `${on.prefix}:${turn.model}`,
  };
}
