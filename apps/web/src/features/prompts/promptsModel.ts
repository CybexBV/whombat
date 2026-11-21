/**
 * The person's prompts on web (docs/app/decisions/prompts-web.md): which prompts and skills `/` lists for what was
 * typed, the line a prompt's latest run makes in Settings, whether “Bring back Whombat’s prompts” is offered, the
 * editor's draft and what it sends, and whether a box knows prompts at all. Pure, so it is unit-tested.
 */
import { delegationAiLine, promptRanWord, promptsFor } from '@whombat/client';
import {
  type CouncilProviderOption,
  PROMPT_TEXT_MAX,
  PROMPT_TITLE_MAX,
  type Prompt,
  type PromptAi,
  promptTitleFrom,
  STARTER_PROMPTS,
} from '@whombat/core';
import type { SavePromptBody } from '@whombat/core/contracts';
import { type SkillCommand, skillCommandsFor } from '../messaging/model';

/** Words the shared `PROMPT_WORDS` doesn't have, for the web app only (named in prompts-web.md). */
export const PROMPT_WEB_WORDS = {
  /** `/` matched neither a prompt nor a skill. */
  nothing: 'Nothing by that name.',
  /** The `/` list's name for screen readers when it holds both groups. */
  menuLabel: 'Prompts and skills',
  /** The editor's line under its title when it keeps a message's words. */
  newTitle: 'New prompt',
  /** The editor refuses an empty title or prompt. */
  titleNeeded: 'Give the prompt a title.',
  textNeeded: 'Write the prompt’s words.',
  /** The picker's way back to the list (also Escape). */
  back: 'Back',
} as const;

/** A box that doesn't have prompts (`unknown_op`, or the route isn't there): no prompts anywhere, and no error. */
export function promptsMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; status?: unknown };
  if (e.code === 'unknown_op') return true;
  return e.status === 404 || e.status === 501;
}

/** One row of the `/` menu: a prompt or a skill. */
export type SlashOption = { kind: 'prompt'; prompt: Prompt } | { kind: 'skill'; skill: SkillCommand };

/** The `/` menu for what was typed after `/`: the matching prompts first, then the matching skills. */
export function slashOptions(
  prompts: readonly Prompt[],
  skills: readonly SkillCommand[],
  query: string,
): SlashOption[] {
  return [
    ...promptsFor(prompts, query).map((prompt) => ({ kind: 'prompt' as const, prompt })),
    ...skillCommandsFor(skills, query).map((skill) => ({ kind: 'skill' as const, skill })),
  ];
}

/** “Ran 3 days ago · Fusebox”: the latest run, or null when it never ran. */
export function promptRunLine(prompt: Pick<Prompt, 'runs'>, now: Date = new Date()): string | null {
  const last = prompt.runs[0];
  if (!last) return null;
  return [promptRanWord(last.at, now), last.title.trim()].filter(Boolean).join(' · ');
}

/** Bringing back Whombat's prompts does something: one of them is missing, or its words were changed. */
export function restoreOffered(prompts: readonly Pick<Prompt, 'starter' | 'edited'>[]): boolean {
  const starters = prompts.filter((p) => p.starter);
  return starters.length < STARTER_PROMPTS.length || starters.some((p) => p.edited);
}

/** The editor's draft. */
export interface PromptDraft {
  title: string;
  text: string;
  onRepository: boolean;
  ownIt: boolean;
  merge: boolean;
  ai: PromptAi | null;
}

/** A prompt's draft, or a new one (from a message's words: its title from their first line). */
export function promptDraftOf(prompt: Prompt | null, text = ''): PromptDraft {
  if (prompt)
    return {
      title: prompt.title,
      text: prompt.text,
      onRepository: prompt.onRepository,
      ownIt: prompt.ownIt,
      merge: prompt.merge,
      ai: prompt.ai,
    };
  const words = text.trim().slice(0, PROMPT_TEXT_MAX);
  return {
    title: words ? promptTitleFrom(words) : '',
    text: words,
    // A new prompt is for a repository, as most are; a message's words are most often something to send again.
    onRepository: !words,
    ownIt: false,
    merge: false,
    ai: null,
  };
}

/** What Save sends, or which field is missing. `ownIt`, the merge and the AI count only for a repository. */
export function promptSaveBody(draft: PromptDraft): { body: SavePromptBody } | { problem: 'title' | 'text' } {
  const title = draft.title.trim().slice(0, PROMPT_TITLE_MAX);
  const text = draft.text.trim().slice(0, PROMPT_TEXT_MAX);
  if (!title) return { problem: 'title' };
  if (!text) return { problem: 'text' };
  return {
    body: {
      title,
      text,
      onRepository: draft.onRepository,
      ownIt: draft.onRepository && draft.ownIt,
      merge: draft.onRepository && draft.merge,
      ai: draft.onRepository ? draft.ai : null,
    },
  };
}

/**
 * “Claude Opus 5.5 · High”: the chosen AI named as T3 Code names its model (its id while T3 Code's list isn't there),
 * or null for T3 Code's default.
 */
export function promptAiLine(
  ai: PromptAi | null,
  options: readonly CouncilProviderOption[] | null | undefined,
): string | null {
  if (!ai) return null;
  const label =
    options?.find((p) => p.id === ai.provider)?.models.find((m) => m.id === ai.model)?.label ?? ai.model;
  return delegationAiLine({ label, effort: ai.effort, fast: ai.fast });
}
