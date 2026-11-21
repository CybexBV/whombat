/**
 * A server task's row in the conversation (Whombat task-feedback.md TF-17; contracts 0.116 `DeskSessionTask`; appliance
 * CG-284): what it says now. The page can't import the contracts, so core's task card helpers it needs are copied here
 * (`@whombat/core` domain/task-card.ts `formatTaskDuration`, `taskResultLine`, `taskCardElapsedMs`), as `deskCopy`
 * copies the words; `taskCard.test.ts` runs core's own cases on them and finds them in the vendored source. Pure.
 */
import type { DeskSessionTask } from './desk';
import { DESK_WORDS } from './deskCopy';

/** How long the task ran, or has run so far (`now`, ms), in ms; never negative (core's `taskCardElapsedMs`). */
export function taskElapsedMs(task: Pick<DeskSessionTask, 'startedAt' | 'endedAt'>, now: number): number {
  const d = (task.endedAt ? Date.parse(task.endedAt) : now) - Date.parse(task.startedAt);
  return Number.isFinite(d) ? Math.max(0, d) : 0;
}

/**
 * A task's time in words (core's `formatTaskDuration`): “0 s”, “12 s”, “4 min”, “1 h”, “1 h 5 min”, “1 d 3 h” — whole
 * units, rounded down, plain spaces.
 */
export function formatTaskDuration(milliseconds: number): string {
  const s = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0;
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d} d` : `${d} d ${h % 24} h`;
}

/**
 * The first sentence of the outcome words for a line (core's `taskResultLine`): the first line with text, up to its
 * first `.`, `!`, `?` or `…` followed by a space or the end (“v2.1.3” stays whole), without a closing full stop.
 */
export function taskResultLine(result: string): string {
  const line = (result.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
  const sentence = /^(.+?[.!?…])(?=\s|$)/.exec(line)?.[1] ?? line;
  return sentence.endsWith('.') && !sentence.endsWith('..') ? sentence.slice(0, -1) : sentence;
}

/** What a task's row says (CG-284). */
export interface TaskRowView {
  title: string;
  /** The state's label: “Running”, “Done”, “Didn’t work”… */
  label: string;
  /** How long it has run, ticking while it runs, then how long it took; null when Whombat lost track of it. */
  time: string | null;
  /** Once it ended: the outcome's first sentence (a lost task's words in full: they say where it is); else null. */
  result: string | null;
}

export function taskRow(task: DeskSessionTask, now: number): TaskRowView {
  const lost = task.state === 'lost';
  return {
    title: task.title,
    label: DESK_WORDS.tasks[task.state],
    time: lost ? null : formatTaskDuration(taskElapsedMs(task, now)),
    result: task.result ? (lost ? task.result : taskResultLine(task.result) || null) : null,
  };
}
