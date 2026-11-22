/**
 * A model on your network (Whombat hermes-engine.md HE-32; contracts 0.124.0 CT-1170…CT-1175; app hermes-engine-app.md
 * AP-5003…AP-5008): what Settings → AI's section on the web and the phone share — the burrow's model where the runtime
 * has `ai.local_model`, the form as a draft (the key is never shown again: an empty field keeps the saved one while the
 * address stays on the same server), what Save and Test send, what a test found as a line with its tone, and the row's
 * lines. The sentences are the contracts' (`LOCAL_MODEL_COPY`, `localModelCheckText`, `LOCAL_MODEL_URL_PROBLEM_TEXT`);
 * `LOCAL_MODEL_TEXT` has the app's few own words. Pure.
 */
import type { SetLocalModelBody, TestLocalModelBody } from '@whombat/core/contracts';
import {
  LOCAL_MODEL_URL_PROBLEM_TEXT,
  LocalModelApiKey,
  type LocalModelCheck,
  LocalModelLabel,
  type LocalModelView,
  localModelName,
  localModelUrlProblem,
  ModelId,
} from '@whombat/core/domain';
import { LOCAL_MODEL_COPY, localModelCheckText } from '@whombat/core/text';

/** The app's own words around the contracts' (AP-5005). */
export const LOCAL_MODEL_TEXT = {
  /** Opens the form on a saved model. */
  change: 'Change',
  cancel: 'Cancel',
  /** The row before its first test. */
  notTested: 'Not tested yet.',
  testing: 'Testing…',
  /** An empty field that needs a value. */
  noAddress: 'Type the address of the AI service or model server.',
  noModel: 'Type the model’s name.',
  /** What a failed write or test says when the Whombat gave no sentence of its own. */
  failed: 'That didn’t save. Try again in a moment.',
  testFailed: 'The test didn’t run. Try again in a moment.',
  /** The agent's model and the Chat picker on Custom: a model the list doesn't name, typed. */
  another: 'Another model',
  anotherHint: 'Any model that service or server offers, by its name.',
  use: 'Use',
} as const;

/** The burrow's model on its network; null without one. */
export function localModelOf(
  burrow: { localModel?: LocalModelView | null } | null | undefined,
): LocalModelView | null {
  return burrow?.localModel ?? null;
}

/** The form while it is edited; the key field always starts empty (it is never shown again). */
export interface LocalModelDraft {
  baseUrl: string;
  model: string;
  label: string;
  apiKey: string;
}

export type LocalModelField = keyof LocalModelDraft;

/** The form for a saved model (or an empty one). */
export function localModelDraft(view: LocalModelView | null | undefined): LocalModelDraft {
  return { baseUrl: view?.baseUrl ?? '', model: view?.model ?? '', label: view?.label ?? '', apiKey: '' };
}

/** The first problem of a field's value under its schema, or null. */
function issue(
  schema: { safeParse(v: unknown): { success: boolean; error?: { issues: { message: string }[] } } },
  value: string,
) {
  const parsed = schema.safeParse(value);
  return parsed.success ? null : (parsed.error?.issues[0]?.message ?? null);
}

/**
 * What stops the form from saving or testing, by field: an empty address or model, an address Whombat can't use (the
 * contracts' sentence: “Use https:// for a model on the internet.”), a name or key that is too long. Empty when it can go.
 */
export function localModelProblems(draft: LocalModelDraft): Partial<Record<LocalModelField, string>> {
  const out: Partial<Record<LocalModelField, string>> = {};
  const baseUrl = draft.baseUrl.trim();
  if (!baseUrl) out.baseUrl = LOCAL_MODEL_TEXT.noAddress;
  else {
    const problem = localModelUrlProblem(baseUrl);
    if (problem) out.baseUrl = LOCAL_MODEL_URL_PROBLEM_TEXT[problem];
  }
  const model = draft.model.trim();
  if (!model) out.model = LOCAL_MODEL_TEXT.noModel;
  else {
    const problem = issue(ModelId, model);
    if (problem) out.model = problem;
  }
  const label = draft.label.trim();
  if (label) {
    const problem = issue(LocalModelLabel, label);
    if (problem) out.label = problem;
  }
  const key = draft.apiKey.trim();
  if (key) {
    const problem = issue(LocalModelApiKey, key);
    if (problem) out.apiKey = problem;
  }
  return out;
}

/** Scheme, host and port: a saved key belongs to that server (CT-1171's same-origin rule). */
function originOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * What the form says about the key (AP-5006): `keep` — none typed, a saved one stays (same server); `drop` — none
 * typed, but the address moved to another server, so the saved key goes (it never goes to another server); `new` — one
 * typed; `none` — no key at all.
 */
export function localModelKeyChoice(
  draft: Pick<LocalModelDraft, 'baseUrl' | 'apiKey'>,
  view: Pick<LocalModelView, 'baseUrl' | 'hasApiKey'> | null | undefined,
): 'keep' | 'drop' | 'new' | 'none' {
  if (draft.apiKey.trim()) return 'new';
  if (!view?.hasApiKey) return 'none';
  const before = originOf(view.baseUrl);
  return before !== null && before === originOf(draft.baseUrl) ? 'keep' : 'drop';
}

/** The key part of a body: a typed key, null to drop the saved one, absent to keep it (or have none). */
function keyPart(
  draft: LocalModelDraft,
  view: LocalModelView | null | undefined,
): { apiKey?: string | null } {
  const choice = localModelKeyChoice(draft, view);
  if (choice === 'new') return { apiKey: draft.apiKey.trim() };
  if (choice === 'drop') return { apiKey: null };
  return {};
}

/** `burrows.setLocalModel`'s body. */
export function localModelSetBody(
  draft: LocalModelDraft,
  view: LocalModelView | null | undefined,
): SetLocalModelBody {
  const label = draft.label.trim();
  return {
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
    label: label || null,
    ...keyPart(draft, view),
  };
}

/** Whether the box's returned `localModel` matches what `burrows.setLocalModel` asked to save. */
export function localModelSaved(
  requested: SetLocalModelBody,
  returned: Pick<LocalModelView, 'baseUrl' | 'model' | 'label' | 'hasApiKey'> | null | undefined,
): boolean {
  if (!returned) return false;
  if (returned.baseUrl !== requested.baseUrl) return false;
  if (returned.model !== requested.model) return false;
  if ((returned.label ?? null) !== (requested.label ?? null)) return false;
  if (typeof requested.apiKey === 'string' && !returned.hasApiKey) return false;
  if (requested.apiKey === null && returned.hasApiKey) return false;
  return true;
}

/** Whether the form holds the saved model as it is (address, model and key); its name may differ. */
export function localModelUnchanged(
  draft: LocalModelDraft,
  view: LocalModelView | null | undefined,
): boolean {
  return (
    !!view &&
    draft.baseUrl.trim() === view.baseUrl &&
    draft.model.trim() === view.model &&
    localModelKeyChoice(draft, view) !== 'new'
  );
}

/**
 * `burrows.testLocalModel`'s body: the saved model checked again (its result kept, the burrow published) while the form
 * holds it as it is, else the draft tried without saving it.
 */
export function localModelTestBody(
  draft: LocalModelDraft,
  view: LocalModelView | null | undefined,
): TestLocalModelBody {
  if (localModelUnchanged(draft, view)) return {};
  return { draft: { baseUrl: draft.baseUrl.trim(), model: draft.model.trim(), ...keyPart(draft, view) } };
}

export type LocalModelTone = 'ok' | 'warn' | 'bad' | 'mut';

/**
 * What the last test found, as a line with its dot's tone (AP-5007): “It answers.” (ok), “Whombat can’t reach it. …”
 * (warn: it may be off for now), the rest (bad: something to fix); “Not tested yet.” before a test.
 */
export function localModelCheckLine(
  check: Pick<LocalModelCheck, 'state'> | null | undefined,
  model: string,
): { text: string; tone: LocalModelTone } {
  if (!check) return { text: LOCAL_MODEL_TEXT.notTested, tone: 'mut' };
  const tone: LocalModelTone = check.state === 'ok' ? 'ok' : check.state === 'unreachable' ? 'warn' : 'bad';
  return { text: localModelCheckText(check.state, model), tone };
}

/**
 * The saved model's row (AP-5005): its name (the label, else the model) and what it is — “llama3.3:70b ·
 * http://192.168.1.20:11434/v1” (the model only when a name hides it).
 */
export function localModelRow(view: LocalModelView): { name: string; meta: string } {
  const name = localModelName(view);
  return { name, meta: [view.label ? view.model : null, view.baseUrl].filter(Boolean).join(' · ') };
}

/** The field hints and labels in the form's order (the contracts' words). */
export const LOCAL_MODEL_FIELDS: readonly { field: LocalModelField; label: string; hint: string | null }[] = [
  { field: 'baseUrl', label: LOCAL_MODEL_COPY.address, hint: LOCAL_MODEL_COPY.addressHint },
  { field: 'model', label: LOCAL_MODEL_COPY.model, hint: LOCAL_MODEL_COPY.modelHint },
  { field: 'label', label: LOCAL_MODEL_COPY.label, hint: LOCAL_MODEL_COPY.labelHint },
  { field: 'apiKey', label: LOCAL_MODEL_COPY.apiKey, hint: null },
];
