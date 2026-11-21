/**
 * Choosing the AI on a delegation's checklist (docs/decisions/delegate.md), shared by web and the
 * phone: the words, how a chosen AI reads (“Claude Opus 5.5 · Extra high”), and the small menu's draft — a model of
 * those T3 Code runs (or the default), the efforts that model takes and its fast tier when it has one.
 */
import type { CouncilProviderOption, DelegationAi, DelegationAiChoice } from '@whombat/core';
import { effortWord } from './councilSetups';

export const DELEGATION_AI_WORDS = {
  /** A task's chip while it has no AI of its own. */
  chipDefault: 'Default',
  taskTitle: (n: number) => `AI for task ${n}`,
  allTitle: 'AI for every task',
  /** Under “AI for every task”: how many ticked tasks take it (the rest chose their own). */
  allCount: (n: number, of: number) => `${n} of ${of} use this`,
  /** A task's first choice: what every task gets; the card's: T3 Code's own. */
  sameAsOthers: 'Same as the others',
  t3Default: 'T3 Code’s default',
  model: 'Model',
  effort: 'Effort',
  fast: 'Fast',
  fastHint: 'Quicker, uses more of your plan',
  done: 'Done',
  cancel: 'Cancel',
  /** The line beside Hand over when some ticked tasks chose their own: “Others: GPT 6.1 Sol · High”. */
  others: (line: string) => `Others: ${line}`,
  /** For screen readers on the chip and on Hand over's arrow. */
  openTask: (title: string, line: string | null) => `AI for ${title}: ${line ?? 'default'}`,
  openAll: (line: string | null) => `AI for every task: ${line ?? 'T3 Code’s default'}`,
  loading: 'Asking T3 Code what it runs…',
  t3: {
    not_connected: 'Connect T3 Code with Manage to choose the AI.',
    unreachable: 'T3 Code can’t be reached now, so its AIs can’t be listed.',
  },
  failed: 'Couldn’t change the AI. Try again.',
} as const;

/** “Claude Opus 5.5 · Extra high · Fast”: the model, the effort chosen, and Fast when the fast tier is on. */
export function delegationAiLine(
  ai: Pick<DelegationAi, 'label' | 'effort' | 'fast'> | null | undefined,
): string | null {
  if (!ai) return null;
  return [ai.label, effortWord(ai.effort), ai.fast ? DELEGATION_AI_WORDS.fast : null]
    .filter(Boolean)
    .join(' · ');
}

/** The menu's draft: a model (null: the default), its effort and fast tier (null: the model's own). */
export interface DelegationAiDraft {
  provider: string | null;
  model: string | null;
  effort: string | null;
  fast: boolean | null;
}

export function delegationAiDraft(ai: DelegationAi | null | undefined): DelegationAiDraft {
  return ai
    ? { provider: ai.provider, model: ai.model, effort: ai.effort, fast: ai.fast }
    : { provider: null, model: null, effort: null, fast: null };
}

/** A model's key in the menu's list (“codex/gpt-6.1-sol”); '' is the default. */
export const aiModelKey = (provider: string | null, model: string | null): string =>
  provider && model ? `${provider}/${model}` : '';

export interface DelegationAiMenuView {
  /** The models to choose from, each company's together in T3 Code's order; the default comes first. */
  models: { key: string; label: string; provider: string }[];
  /** The model chosen now ('' the default). */
  selected: string;
  /** The chosen model's efforts, the one on now marked (the chosen one, else the model's own); empty: none to choose. */
  efforts: { value: string; word: string; on: boolean }[];
  /** The chosen model's fast tier, on or off now (the chosen, else the model's own); null: it has none. */
  fast: boolean | null;
}

type ModelOption = CouncilProviderOption['models'][number];

function modelOf(
  options: readonly CouncilProviderOption[],
  draft: DelegationAiDraft,
): { provider: CouncilProviderOption; model: ModelOption } | null {
  const provider = options.find((p) => p.id === draft.provider);
  const model = provider?.models.find((m) => m.id === draft.model);
  return provider && model ? { provider, model } : null;
}

/** The menu as both apps draw it. A chosen model T3 Code no longer runs still shows, by its name, so it can be changed. */
export function delegationAiMenu(
  options: readonly CouncilProviderOption[],
  draft: DelegationAiDraft,
  current: DelegationAi | null | undefined,
): DelegationAiMenuView {
  const models = options.flatMap((p) =>
    p.models.map((m) => ({ key: aiModelKey(p.id, m.id), label: m.label, provider: p.name })),
  );
  const selected = aiModelKey(draft.provider, draft.model);
  if (
    selected &&
    !models.some((m) => m.key === selected) &&
    current &&
    aiModelKey(current.provider, current.model) === selected
  )
    models.unshift({ key: selected, label: current.label, provider: current.provider });
  const found = modelOf(options, draft);
  const effortNow = draft.effort ?? found?.model.defaultEffort ?? null;
  return {
    models,
    selected,
    efforts: (found?.model.efforts ?? []).map((value) => ({
      value,
      word: effortWord(value) ?? value,
      on: value === effortNow,
    })),
    fast: found && typeof found.model.fast === 'boolean' ? (draft.fast ?? found.model.fast) : null,
  };
}

/** The draft with another model: its effort kept when the new model takes it, its fast tier back to the model's own. */
export function withAiModel(
  options: readonly CouncilProviderOption[],
  draft: DelegationAiDraft,
  key: string,
): DelegationAiDraft {
  if (!key) return { provider: null, model: null, effort: null, fast: null };
  const slash = key.indexOf('/');
  const next = { provider: key.slice(0, slash), model: key.slice(slash + 1), effort: null, fast: null };
  const found = modelOf(options, next);
  return {
    ...next,
    effort: draft.effort && found?.model.efforts.includes(draft.effort) ? draft.effort : null,
  };
}

/**
 * The draft as it is sent: a fast tier left to the model is sent as the model's own (on or off), so the card says Fast
 * when it runs fast. An effort left to the model stays its own.
 */
function settled(options: readonly CouncilProviderOption[], draft: DelegationAiDraft): DelegationAiDraft {
  const found = modelOf(options, draft);
  const fast = found && typeof found.model.fast === 'boolean' ? (draft.fast ?? found.model.fast) : null;
  return { ...draft, fast };
}

/** The draft as the card shows it once chosen (named as T3 Code names the model), or null for the default. */
export function delegationAiOf(
  options: readonly CouncilProviderOption[],
  draft: DelegationAiDraft,
): DelegationAi | null {
  const found = modelOf(options, draft);
  if (!found || !draft.provider || !draft.model) return null;
  return {
    provider: draft.provider,
    model: draft.model,
    label: found.model.label,
    effort: draft.effort,
    fast: settled(options, draft).fast,
  };
}

/** Whether two chosen AIs are the same (null and absent both the default). */
export function sameDelegationAi(
  a: DelegationAi | null | undefined,
  b: DelegationAi | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return a.provider === b.provider && a.model === b.model && a.effort === b.effort && a.fast === b.fast;
}

/** What the menu's Done sends: the chosen AI (its fast tier as it will run, `settled`), or null for the default. */
export function delegationAiChoice(
  draft: DelegationAiDraft,
  options: readonly CouncilProviderOption[] = [],
): DelegationAiChoice | null {
  if (!draft.provider || !draft.model) return null;
  const { fast } = modelOf(options, draft) ? settled(options, draft) : draft;
  return { provider: draft.provider, model: draft.model, effort: draft.effort, fast };
}
