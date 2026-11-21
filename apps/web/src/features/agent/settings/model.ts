/**
 * Settings → Agent's parts (one-agent.md AP-4923; was the agent settings page, ui-improvements U5, AP-380…): what a
 * draft changed and the save toasts. The parts themselves are `../parts.ts`.
 */

import type { ModelRuntimeDraft } from '@whombat/client';
import { MODEL_EFFORT_COPY } from '@whombat/core/text';

/** JSON with sorted object keys, so two drafts compare by value whatever order their keys were set in. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}

/** Whether two drafts hold the same values (key order and `undefined` fields don't count). */
export function sameDraft(a: unknown, b: unknown): boolean {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

/** “Updated Banjo’s access.” — a tab's save toast (AP-385). */
export function savedText(name: string, what: string): string {
  return `Updated ${name}’s ${what}.`;
}

/**
 * Model & provider's save toast (model-effort.md AP-1129): “Updated Banjo’s AI provider.”, “Updated Banjo’s model and
 * effort.”, and “Updated Banjo’s AI provider, model and effort.” when a model or an effort was picked on the new one;
 * on Local “model” and “AI provider and model”.
 */
export function modelSavedText(
  name: string,
  before: Pick<ModelRuntimeDraft, 'provider'>,
  after: Pick<ModelRuntimeDraft, 'provider' | 'model' | 'effort'>,
): string {
  const moved = before.provider !== after.provider;
  // A model on the network has no effort (hermes-engine-app.md AP-5042): “model” alone.
  const local = after.provider === 'local';
  if (!moved) return savedText(name, local ? 'model' : MODEL_EFFORT_COPY.saved);
  if (!after.model && !after.effort) return savedText(name, 'AI provider');
  return savedText(name, local ? 'AI provider and model' : `AI provider, ${MODEL_EFFORT_COPY.saved}`);
}

/** A save step's answer when it didn't happen: the notice to show, or null when it went through. */
export function outcomeNotice(
  result:
    | { status: 'ok' }
    | { status: 'blocked'; message: string }
    | { status: 'pending_approval'; approvalNumber: number },
): string | null {
  if (result.status === 'blocked') return result.message;
  if (result.status === 'pending_approval')
    return `Waiting for a person to approve (approval #${result.approvalNumber}).`;
  return null;
}
