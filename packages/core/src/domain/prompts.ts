/**
 * The person's prompts (Whombat docs/decisions/prompts.md): words they use again and again, kept under a title and
 * chosen after `/` in Chat. Most are for a repository: the person picks the prompt, then the project, and the agent
 * hands the prompt's words to a new T3 Code thread there, unchanged. Whombat ships a few to start with
 * (`STARTER_PROMPTS`), which the person changes or removes like their own.
 */
import { z } from 'zod';
import { coreTranslator, tCore } from '../i18n/catalog.js';
import { idSchema } from '../ids.js';
import { Timestamp } from './common.js';

export const PROMPT_TITLE_MAX = 60;
/** Room for a prompt with its guard rails; the agent's brief carries it whole. */
export const PROMPT_TEXT_MAX = 3000;
/** How many prompts a Whombat keeps, the shipped ones included. */
export const PROMPTS_MAX = 60;
/** The projects a prompt remembers running on, the latest first. */
export const PROMPT_RUNS_MAX = 12;

/** A shipped prompt's id: `starter-<key>`. It stays the same after the person changed the prompt. */
export const STARTER_PROMPT_ID = /^starter-[a-z][a-z0-9-]{0,39}$/;

/** A prompt of the person's own (`prm_…`) or one Whombat shipped (`starter-<key>`). */
export const PromptId = z.union([idSchema('prm'), z.string().regex(STARTER_PROMPT_ID)]);
export type PromptId = z.infer<typeof PromptId>;

/** The AI a prompt's thread runs on, as a delegation's task chooses one: a model of those T3 Code runs. */
export const PromptAi = z.strictObject({
  provider: z.string().trim().min(1).max(40),
  model: z.string().trim().min(1).max(80),
  effort: z.string().trim().min(1).max(20).nullable(),
  fast: z.boolean().nullable(),
});
export type PromptAi = z.infer<typeof PromptAi>;

/** A T3 Code project a prompt ran on, and when. */
export const PromptRun = z.object({
  projectId: z.string().min(1).max(200),
  /** The project's title when it ran. */
  title: z.string().max(200),
  at: Timestamp,
});
export type PromptRun = z.infer<typeof PromptRun>;

export const Prompt = z.object({
  id: PromptId,
  title: z.string().min(1).max(PROMPT_TITLE_MAX),
  text: z.string().min(1).max(PROMPT_TEXT_MAX),
  /**
   * For a repository: choosing it asks which project, and its words go to a new T3 Code thread there. Otherwise its
   * words go into the draft, for the person to send as they are or change first.
   */
  onRepository: z.boolean(),
  /** Adds `PROMPT_OWN_IT_LINE` to what the thread is given: the AI reshapes the code as its own. */
  ownIt: z.boolean(),
  /**
   * Whombat merges the work into the repository's default branch once it is done: the thread opens a pull request and
   * gets its checks passing, and Whombat merges it (`PROMPT_MERGE_LINES`). Absent from a Whombat from before it.
   */
  merge: z.boolean().default(false),
  /** The AI its thread runs on; null: T3 Code's default. */
  ai: PromptAi.nullable(),
  /** Whombat shipped it (`starter-…`), and whether the person changed its words since. */
  starter: z.boolean(),
  edited: z.boolean(),
  /** Where it ran, the latest first (at most `PROMPT_RUNS_MAX`). */
  runs: z.array(PromptRun).max(PROMPT_RUNS_MAX),
  updatedAt: Timestamp.nullable(),
});
export type Prompt = z.infer<typeof Prompt>;

/**
 * What the ownership switch adds, from Anthropic's guide to prompting Claude Fable 5.2: with it the AI merges duplicate
 * code and fixes what it finds nearby far more often, uses about half as many tokens again, and now and then changes
 * behaviour nobody asked about.
 */
export const PROMPT_OWN_IT_LINE =
  'This codebase is yours: what it’s for and how it’s built are your call, and you’ll keep building on it.';

/** What marks a thread's words as asking for Whombat's merge: the server looks for it in the launch and the brief. */
export const PROMPT_MERGE_MARK = 'Whombat merges this work';

/**
 * What “Merge into main when it’s done” adds: the thread ends with a pull request whose checks pass, and Whombat merges
 * it into the default branch itself once the thread is done (`t3code/merge.ts`), so a repository whose main branch takes
 * no direct pushes works the same.
 */
export const PROMPT_MERGE_LINES = `${PROMPT_MERGE_MARK} into the default branch once you are done. So when you have finished: commit your changes, push your branch and open a pull request into the default branch (when nothing needed changing, open none). Get its checks passing: watch it, fix what fails and push, at most three rounds, never weakening a check, then stop watching it. Don’t merge it yourself, whatever the repository’s own instructions say: Whombat merges it once its checks pass.`;

/**
 * How a shipped prompt ends when the AI has open points: a council decides them instead of the person, who is left
 * only what is theirs to choose. A thread whose T3 Code has a council skill uses it; any other asks three reviewers
 * itself.
 */
export function promptCouncilLines(locale?: string | null): string {
  return tCore(locale, 'starter.council');
}

export const PROMPT_COUNCIL_LINES = promptCouncilLines('en');

export interface StarterPrompt {
  key: string;
  title: string;
  text: string;
  onRepository: boolean;
}

/**
 * The prompts a Whombat starts with, in the order the list shows them. The first one's opening is as its author wrote
 * it (Alex Albert), the second is as its author wrote it (Peter Steinberger, with the guard rails of his test audit),
 * and so is the first line of the refactor one (Steinberger); a starter the person never changed follows these words,
 * so improving one here improves it everywhere. The ones that used to end with a list for the person to review end
 * with `PROMPT_COUNCIL_LINES` instead.
 */
const STARTER_PROMPT_KEYS = [
  'audit',
  'prune-tests',
  'simplify',
  'refactor',
  'bugs',
  'security',
  'dependencies',
  'faster',
  'faster-build',
  'docs',
  'agent-instructions',
] as const;

/** The shipped prompts in a locale: their titles and the words a thread is given. */
export function starterPrompts(locale?: string | null): readonly StarterPrompt[] {
  const tr = coreTranslator(locale);
  const council = tr.t('starter.council');
  return STARTER_PROMPT_KEYS.map((key) => ({
    key,
    title: tr.t(`starter.${key}.title`),
    text: tr.t(`starter.${key}.text`, { council }),
    onRepository: true,
  }));
}

export const STARTER_PROMPTS: readonly StarterPrompt[] = starterPrompts('en');

export function starterPromptId(key: string): string {
  return `starter-${key}`;
}

/** The shipped prompt behind a `starter-<key>` id, or null; in a locale (English by default). */
export function starterPromptOf(id: string, locale?: string | null): StarterPrompt | null {
  if (!id.startsWith('starter-')) return null;
  const key = id.slice('starter-'.length);
  return (locale ? starterPrompts(locale) : STARTER_PROMPTS).find((s) => s.key === key) ?? null;
}

const day = (iso: string) => iso.slice(0, 10);

/**
 * What the T3 Code thread is given: the prompt's words as they are, then the ownership line and the merge lines when
 * they are on, then when it last ran on this project, so a thread can start from what changed since.
 */
export function promptTask(
  prompt: Pick<Prompt, 'text' | 'ownIt'> & { merge?: boolean },
  lastRunAt: string | null | undefined = null,
): string {
  const parts = [prompt.text.trim()];
  if (prompt.ownIt) parts.push(PROMPT_OWN_IT_LINE);
  if (prompt.merge) parts.push(PROMPT_MERGE_LINES);
  if (lastRunAt) parts.push(`(This prompt last ran on this repository on ${day(lastRunAt)}.)`);
  return parts.join('\n\n');
}

/** The line Chat shows for a prompt sent to a project: “Find what’s broken · Fusebox”. */
export function promptLine(title: string, projectTitle: string | null | undefined): string {
  const project = projectTitle?.trim();
  return project ? `${title.trim()} · ${project}` : title.trim();
}

/** When a prompt last ran on a project; null when it never did. */
export function promptLastRun(prompt: Pick<Prompt, 'runs'>, projectId: string): string | null {
  return prompt.runs.find((r) => r.projectId === projectId)?.at ?? null;
}

/** A title for words being kept as a prompt: their first line, cut at a word. */
export function promptTitleFrom(text: string): string {
  const first =
    text
      .trim()
      .split('\n')[0]
      ?.replace(/[.:;,!?]+$/, '')
      .trim() ?? '';
  if (first.length <= PROMPT_TITLE_MAX) return first;
  const cut = first.slice(0, PROMPT_TITLE_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
