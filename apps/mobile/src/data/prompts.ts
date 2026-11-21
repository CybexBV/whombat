/**
 * The person's prompts on the phone (Whombat docs/decisions/prompts.md; app prompts-phone.md): which prompts `/` offers
 * for what is typed, what a row says in Chat and in Settings, the repository picker's state, the editor's draft (what
 * Save sends and what keeps it from being saved), the AI line, and when “Bring back Whombat’s prompts” shows. The words
 * are the shared ones (`@whombat/client`'s `PROMPT_WORDS`), so the web says the same. Pure.
 */
import {
  type DelegationAiDraft,
  delegationAiChoice,
  delegationAiLine,
  PROMPT_WORDS,
  promptPreview,
  promptProjectRows,
  promptRanWord,
  promptsFor,
} from '@whombat/client';
import {
  type CouncilProviderOption,
  type DelegationAi,
  PROMPT_TEXT_MAX,
  PROMPT_TITLE_MAX,
  type Prompt,
  type PromptAi,
  type PromptProjectsResponse,
  promptTitleFrom,
  type SavePromptBody,
  STARTER_PROMPTS,
  starterPromptId,
} from '@whombat/core';

/* `/` in the composer ------------------------------------------------------------------------------------------------ */

/**
 * What was typed after `/` while the draft is a `/` and one word (`/te`), else null: then the composer shows no prompts.
 * A space or a new line ends it, so `/skill do this` goes as typed.
 */
export function slashQuery(draft: string): string | null {
  const m = /^\/(\S*)$/.exec(draft);
  return m ? (m[1] ?? '') : null;
}

/** A prompt as a row of the `/` list and the Prompts sheet: its title, its first line, and what a screen reader says. */
export interface PromptRow {
  id: string;
  title: string;
  preview: string;
  label: string;
}

export function promptRow(p: Pick<Prompt, 'id' | 'title' | 'text'>): PromptRow {
  const preview = promptPreview(p.text);
  return { id: p.id, title: p.title, preview, label: `${p.title}. ${preview}` };
}

/** The rows `/` offers for the draft; null while the draft isn't a `/` word or nothing matches it. */
export function slashRows(prompts: readonly Prompt[] | null | undefined, draft: string): PromptRow[] | null {
  const q = slashQuery(draft);
  if (q === null || !prompts?.length) return null;
  const rows = promptsFor(prompts, q).map(promptRow);
  return rows.length ? rows : null;
}

/** What choosing a prompt does: its words into the draft, or (for a repository) the picker. */
export function promptChoice(p: Pick<Prompt, 'onRepository'>): 'draft' | 'repository' {
  return p.onRepository ? 'repository' : 'draft';
}

/* Which repository ------------------------------------------------------------------------------------------------- */

export interface PromptProjectLine {
  id: string;
  title: string;
  /** Its folder, when T3 Code says. */
  folder: string | null;
  /** “Ran 3 days ago” on the ones this prompt ran on. */
  ran: string | null;
  label: string;
}

/**
 * The picker after a repository prompt was chosen: asking T3 Code, its projects (those the prompt ran on first), none
 * yet, none by the search, or why there are none (T3 Code not connected or out of reach, with Put its words in the
 * message instead).
 */
export type PromptPickerView =
  | { kind: 'loading'; text: string }
  | { kind: 'rows'; rows: PromptProjectLine[] }
  | { kind: 'empty'; text: string }
  | { kind: 't3'; text: string };

export function promptPickerView(
  prompt: Pick<Prompt, 'runs'> | null,
  data: PromptProjectsResponse | undefined,
  failed: boolean,
  search: string,
  now: Date,
): PromptPickerView {
  if (!data) return failed ? { kind: 't3', text: PROMPT_WORDS.t3.unreachable } : loading;
  if (data.t3 !== 'ready' || !data.projects)
    return { kind: 't3', text: PROMPT_WORDS.t3[data.t3 === 'ready' ? 'unreachable' : data.t3] };
  if (!data.projects.length) return { kind: 'empty', text: PROMPT_WORDS.pickEmpty };
  const rows = promptProjectRows(prompt, data.projects, search).map((p) => {
    const ran = p.ranAt ? promptRanWord(p.ranAt, now) : null;
    return {
      id: p.id,
      title: p.title,
      folder: p.folder,
      ran,
      label: [p.title, ran].filter(Boolean).join('. '),
    };
  });
  return rows.length ? { kind: 'rows', rows } : { kind: 'empty', text: PROMPT_WORDS.pickNone };
}

const loading: PromptPickerView = { kind: 'loading', text: PROMPT_WORDS.pickLoading };

/* Settings → You → Prompts ----------------------------------------------------------------------------------------- */

export interface PromptListLine {
  id: string;
  title: string;
  /** Its first line. */
  preview: string;
  /** “Ran 3 days ago · Fusebox”, when it ran. */
  ran: string | null;
  label: string;
}

export function promptListLine(p: Prompt, now: Date): PromptListLine {
  const latest = p.runs[0];
  const ran = latest
    ? [promptRanWord(latest.at, now), latest.title.trim()].filter(Boolean).join(' · ')
    : null;
  const preview = promptPreview(p.text);
  return {
    id: p.id,
    title: p.title,
    preview,
    ran,
    label: [p.title, preview, ran].filter(Boolean).join('. '),
  };
}

/** “Bring back Whombat’s prompts” shows while one Whombat shipped is gone or has other words. */
export function canRestorePrompts(prompts: readonly Pick<Prompt, 'id' | 'starter' | 'edited'>[]): boolean {
  const ids = new Set(prompts.map((p) => p.id));
  return (
    STARTER_PROMPTS.some((s) => !ids.has(starterPromptId(s.key))) ||
    prompts.some((p) => p.starter && p.edited)
  );
}

/* The editor ------------------------------------------------------------------------------------------------------ */

export interface PromptDraft {
  title: string;
  text: string;
  onRepository: boolean;
  ownIt: boolean;
  merge: boolean;
  ai: PromptAi | null;
}

/** The draft the editor opens on: the prompt, words from a message (titled by their first line), or nothing yet. */
export function promptDraftFor(prompt: Prompt | null, fromText?: string | null): PromptDraft {
  if (prompt)
    return {
      title: prompt.title,
      text: prompt.text,
      onRepository: prompt.onRepository,
      ownIt: prompt.ownIt,
      merge: prompt.merge,
      ai: prompt.ai,
    };
  const text = (fromText ?? '').trim().slice(0, PROMPT_TEXT_MAX);
  // A new prompt is for a repository unless it holds words from a message, which are most often a reply to send again.
  return {
    title: text ? promptTitleFrom(text) : '',
    text,
    onRepository: !text,
    ownIt: false,
    merge: false,
    ai: null,
  };
}

export function samePromptDraft(a: PromptDraft, b: PromptDraft): boolean {
  return (
    a.title === b.title &&
    a.text === b.text &&
    a.onRepository === b.onRepository &&
    a.ownIt === b.ownIt &&
    a.merge === b.merge &&
    samePromptAi(a.ai, b.ai)
  );
}

export function samePromptAi(a: PromptAi | null, b: PromptAi | null): boolean {
  if (!a || !b) return !a && !b;
  return a.provider === b.provider && a.model === b.model && a.effort === b.effort && a.fast === b.fast;
}

/** What Save sends: trimmed, and “Let it reshape the code”, the merge and the AI only on a prompt for a repository. */
export function promptDraftBody(d: PromptDraft): SavePromptBody {
  return {
    title: d.title.trim(),
    text: d.text.trim(),
    onRepository: d.onRepository,
    ownIt: d.onRepository && d.ownIt,
    merge: d.onRepository && d.merge,
    ai: d.onRepository ? d.ai : null,
  };
}

/** Save is there to press: a title and words that fit, and something changed (a new one: always). */
export function promptCanSave(draft: PromptDraft, original: PromptDraft | null): boolean {
  const title = draft.title.trim();
  const text = draft.text.trim();
  if (!title || !text || title.length > PROMPT_TITLE_MAX || text.length > PROMPT_TEXT_MAX) return false;
  return !original || !samePromptDraft(draft, original);
}

/* The AI ---------------------------------------------------------------------------------------------------------- */

/** The prompt's AI as the delegation menu takes it, named as T3 Code names its model (else by its id). */
export function promptAiShown(
  ai: PromptAi | null,
  options: readonly CouncilProviderOption[] | null | undefined,
): DelegationAi | null {
  if (!ai) return null;
  const label =
    options?.find((p) => p.id === ai.provider)?.models.find((m) => m.id === ai.model)?.label ?? ai.model;
  return { provider: ai.provider, model: ai.model, label, effort: ai.effort, fast: ai.fast };
}

/** The AI row's value: “Claude Opus 5.5 · Extra high”, or “T3 Code’s default”. */
export function promptAiLine(
  ai: PromptAi | null,
  options: readonly CouncilProviderOption[] | null | undefined,
): string {
  return delegationAiLine(promptAiShown(ai, options)) ?? PROMPT_WORDS.aiDefault;
}

/** The delegation menu's Done as the prompt keeps it (null: T3 Code's default). */
export function promptAiFromMenu(
  draft: DelegationAiDraft,
  options: readonly CouncilProviderOption[],
): PromptAi | null {
  return delegationAiChoice(draft, options);
}
