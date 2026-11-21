/**
 * The person's prompts as the apps read them (docs/decisions/prompts.md), from the rows and the shipped prompts in code:
 * a shipped prompt follows `STARTER_PROMPTS` wherever its row leaves a part as shipped, and has no row at all until the
 * person touches it. Pure, so the list, the commands and the brief share one reading.
 */
import {
  PROMPT_RUNS_MAX,
  type Prompt,
  type PromptRun,
  STARTER_PROMPTS,
  type StarterPrompt,
  starterPromptId,
} from '@whombat/core';
import type { PromptRow } from '../db/schema/index';

type Row = Pick<
  PromptRow,
  | 'id'
  | 'starterKey'
  | 'title'
  | 'text'
  | 'onRepository'
  | 'ownIt'
  | 'merge'
  | 'ai'
  | 'hidden'
  | 'runs'
  | 'position'
  | 'createdAt'
  | 'updatedAt'
>;

/** Whether a shipped prompt's row changes anything the person sees of it. */
export function starterEdited(starter: StarterPrompt, row: Row | null): boolean {
  if (!row) return false;
  return (
    row.title !== null ||
    row.text !== null ||
    row.onRepository !== starter.onRepository ||
    row.ownIt ||
    row.merge ||
    row.ai !== null
  );
}

/** A shipped prompt with the person's changes on its row (none without one). */
export function starterView(starter: StarterPrompt, row: Row | null): Prompt {
  const edited = starterEdited(starter, row);
  return {
    id: starterPromptId(starter.key),
    title: row?.title ?? starter.title,
    text: row?.text ?? starter.text,
    onRepository: row ? row.onRepository : starter.onRepository,
    ownIt: row?.ownIt ?? false,
    merge: row?.merge ?? false,
    ai: row?.ai ?? null,
    starter: true,
    edited,
    runs: (row?.runs ?? []).slice(0, PROMPT_RUNS_MAX),
    updatedAt: edited && row ? row.updatedAt.toISOString() : null,
  };
}

/** One of the person's own prompts. */
export function ownView(row: Row): Prompt {
  return {
    id: row.id,
    title: row.title ?? '',
    text: row.text ?? '',
    onRepository: row.onRepository,
    ownIt: row.ownIt,
    merge: row.merge,
    ai: row.ai ?? null,
    starter: false,
    edited: false,
    runs: row.runs.slice(0, PROMPT_RUNS_MAX),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The list in the order Chat offers it: the shipped prompts the person kept, in `STARTER_PROMPTS` order, then their own
 * in the order they made them. A row of a shipped prompt Whombat no longer ships is left out.
 */
export function promptList(rows: readonly Row[]): Prompt[] {
  const byKey = new Map(rows.flatMap((r) => (r.starterKey ? [[r.starterKey, r] as const] : [])));
  const starters = STARTER_PROMPTS.flatMap((s) => {
    const row = byKey.get(s.key) ?? null;
    return row?.hidden ? [] : [starterView(s, row)];
  });
  const own = rows
    .filter((r) => !r.starterKey)
    .sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime())
    .map(ownView);
  return [...starters, ...own];
}

/** The prompt's runs with this one first: one entry per project, the latest first, at most `PROMPT_RUNS_MAX`. */
export function withRun(runs: readonly PromptRun[], run: PromptRun): PromptRun[] {
  return [run, ...runs.filter((r) => r.projectId !== run.projectId)].slice(0, PROMPT_RUNS_MAX);
}
