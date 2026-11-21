/**
 * The person's prompts (Whombat docs/decisions/prompts.md): words they use again and again, kept under a title and
 * chosen after `/` in Chat. Most are for a repository: the person picks the prompt, then the project, and the agent
 * hands the prompt's words to a new T3 Code thread there, unchanged. Whombat ships a few to start with
 * (`STARTER_PROMPTS`), which the person changes or removes like their own.
 */
import { z } from 'zod';
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
export const PROMPT_COUNCIL_LINES =
  'Don’t hand what you aren’t sure about back to me. Put those points together to a council first: three independent reviewers on different AI models (use your council skill if you have one), each given the points, the code they concern and your own view. Do what the council agrees on, with the tests still passing. Leave for me only what the council can’t settle or says is mine to choose, such as a product decision or something that can’t be undone, each with the council’s advice. Finish with what you changed, what the council decided and what is left for me.';

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
export const STARTER_PROMPTS: readonly StarterPrompt[] = [
  {
    key: 'audit',
    title: 'Find what’s broken',
    text: [
      'Read this entire project and find everything that’s broken, inconsistent, inefficient, or no longer needed. Fix what you’re sure about.',
      '',
      PROMPT_COUNCIL_LINES,
    ].join('\n'),
    onRepository: true,
  },
  {
    key: 'prune-tests',
    title: 'Prune the tests',
    text: [
      'Remove 20% of the least useful tests while maintaining code coverage within 2%.',
      '',
      'Measure coverage before you start and again at the end, with the same command. Coverage shows that a line ran, not that anything checked it, so keep every test that guards security, permissions, a contract between parts, a migration, stored data or a named regression, however slow it is. Delete tests; don’t skip or weaken them, and don’t change production code.',
      '',
      'Finish with the number of tests and the coverage before and after, and the list of what you removed.',
    ].join('\n'),
    onRepository: true,
  },
  {
    key: 'simplify',
    title: 'Remove needless complexity',
    text: [
      'Find and remove unnecessary complexity in this repository: wrappers that do nothing, the same logic written twice, abstractions with a single use, dead code and unused dependencies. Behaviour stays the same and the tests still pass. Leave alone what is fine as it is: fewer lines is not the goal.',
      '',
      PROMPT_COUNCIL_LINES,
    ].join('\n'),
    onRepository: true,
  },
  {
    key: 'refactor',
    title: 'Refactor until you’re happy',
    text: [
      'Refactor until you are happy with the architecture. Test live after each significant step, review your own change and commit it. Track progress in /tmp/refactor-<project name>.md.',
      '',
      'What the software does for the people who use it stays the same. Finish with what you changed and why, and what you would still change.',
    ].join('\n'),
    onRepository: true,
  },
  {
    key: 'bugs',
    title: 'Hunt for bugs',
    text: [
      'Find and fix correctness bugs in this repository, starting with what people use most. Fix the cause, not the symptom, and add a test that fails without the fix.',
      '',
      `What you suspect but couldn’t confirm counts as something you aren’t sure about. ${PROMPT_COUNCIL_LINES}`,
    ].join('\n'),
    onRepository: true,
  },
  {
    key: 'security',
    title: 'Review the security',
    text: [
      'Review the security of this repository: keys and passwords in the code or its history, missing sign-in and permission checks, input that is trusted without checking, data of one person that another can reach, and packages with known vulnerabilities. Confirm each finding in the code before you report it.',
      '',
      'Rank what you find by how bad it is, explain each in plain English, and fix the top three, each with a test that fails without the fix. Work only in this repository and a local environment: don’t rotate keys, don’t touch production and don’t write exploit code. List the rest for me to review.',
    ].join('\n'),
    onRepository: true,
  },
  {
    key: 'dependencies',
    title: 'Check the dependencies',
    text: [
      'Check this repository’s dependencies against known vulnerabilities. For each advisory, check whether the installed version is affected and whether the code can reach the vulnerable part, and quote the line that decides it. Rank by the real risk here, not by the advisory’s score.',
      '',
      'Upgrade what matters on a branch, one dependency per commit, with the tests passing. Leave an upgrade that needs code changes as an entry in a list, with what it would take. Don’t write exploit code.',
    ].join('\n'),
    onRepository: true,
  },
  {
    key: 'faster',
    title: 'Make it faster',
    text: [
      'Find and implement performance improvements in this repository. Measure first: find the slow parts with a profile, a trace, a query plan or a benchmark instead of guessing, and write down the baseline.',
      '',
      'Keep a change only when the same measurement shows it is faster and the tests still pass; behaviour stays the same. Finish with the numbers before and after each change, and what you tried that didn’t help.',
    ].join('\n'),
    onRepository: true,
  },
  {
    key: 'faster-build',
    title: 'Speed up the build and tests',
    text: [
      'Reduce the time this repository’s build and tests take by 30%.',
      '',
      'Time them three times before you start and take the average. You are done when three runs in the same environment average 30% less, with every test still passing. Don’t remove, skip or weaken tests, and don’t drop a step that checks something. If 30% is out of reach, stop and say what is in the way.',
      '',
      'Finish with the times before and after, and what you changed.',
    ].join('\n'),
    onRepository: true,
  },
  {
    key: 'docs',
    title: 'Make the docs match the code',
    text: [
      'Read the documentation in this repository (the README, the docs folder, comments that explain how something works) and compare it with what the code does today. Fix what is out of date and remove what describes things that are gone.',
      '',
      `What you couldn’t settle from the code counts as something you aren’t sure about. ${PROMPT_COUNCIL_LINES}`,
    ].join('\n'),
    onRepository: true,
  },
  {
    key: 'agent-instructions',
    title: 'Check the agent instructions',
    text: 'Read the instructions this repository gives coding agents (AGENTS.md, CLAUDE.md, skills and rules files). Find the ones that contradict each other, name files or commands that no longer exist, repeat what the code makes obvious, or work around problems older models had. Give me the changes as a list and change nothing until I say so.',
    onRepository: true,
  },
];

export function starterPromptId(key: string): string {
  return `starter-${key}`;
}

/** The shipped prompt behind a `starter-<key>` id, or null. */
export function starterPromptOf(id: string): StarterPrompt | null {
  if (!id.startsWith('starter-')) return null;
  const key = id.slice('starter-'.length);
  return STARTER_PROMPTS.find((s) => s.key === key) ?? null;
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
