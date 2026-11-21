/**
 * What the agent is told, out of the chat's sight, when the person uses a prompt on a T3 Code project
 * (docs/decisions/prompts.md): start a new T3 Code thread there whose task is the prompt's words exactly as they are,
 * between two marker lines, then say in one line that it started. Chat shows only the person's short line.
 */
import { PROMPT_MERGE_MARK, type PromptAi } from '@whombat/core';

export const PROMPT_WORDS_BEGIN = '----- the prompt’s words begin -----';
export const PROMPT_WORDS_END = '----- the prompt’s words end -----';

/** The AI the thread runs on: as `t3_thread_launch` takes it, or the person's choice T3 Code can't run now. */
export type PromptLaunchAi =
  | { kind: 'default' }
  | { kind: 'chosen'; modelSelection: { instanceId: string; model: string; options: unknown[] } }
  | { kind: 'unavailable'; ai: PromptAi };

export interface PromptBriefParts {
  person: string;
  title: string;
  project: { id: string; title: string };
  /** The T3 Code connection's handle, for `connection_call`. */
  handle: string;
  /** `promptTask(…)`: the words the thread is given. */
  task: string;
  ai: PromptLaunchAi;
  /** “Merge into main when it’s done”: Whombat merges the thread's pull request itself. */
  merge?: boolean;
}

export function promptBrief(p: PromptBriefParts): string {
  const project = JSON.stringify(p.project.id);
  const model = p.ai.kind === 'chosen' ? `, modelSelection ${JSON.stringify(p.ai.modelSelection)}` : '';
  const aiLine =
    p.ai.kind === 'chosen'
      ? 'That modelSelection is the AI the prompt names.'
      : p.ai.kind === 'unavailable'
        ? `The prompt names ${p.ai.ai.model} (${p.ai.ai.provider}), which T3 Code can’t run now: leave out modelSelection so T3 Code uses its default, and say so in your line.`
        : 'Leave out modelSelection: T3 Code uses its default.';
  return [
    `${p.person} chose their saved prompt “${p.title}” for the T3 Code project “${p.project.title}” (projectId ${project}).`,
    `Start a new T3 Code thread in that project: t3_thread_launch through connection_call on ${p.handle}, with projectId ${project}, a short title, a worktree of its own from the project’s default branch, runtimeMode "full-access"${model}, and as its message exactly the words between the two marker lines below: nothing added, removed or reworded, and not the marker lines themselves. ${aiLine}`,
    `Then tell ${p.person} in one short line only that T3 Code is on it (the thread by its title) and that its report appears in this thread when it is done, with no updates in between; and wait for it as for any T3 Code thread: Whombat wakes you here when it finishes or asks something.`,
    ...(p.merge
      ? [
          `${PROMPT_MERGE_MARK} itself: once the thread is done, Whombat merges its pull request into the default branch when its checks pass, and says so here. Don’t merge it yourself or ask the thread to.`,
        ]
      : []),
    '',
    PROMPT_WORDS_BEGIN,
    p.task,
    PROMPT_WORDS_END,
  ].join('\n');
}
