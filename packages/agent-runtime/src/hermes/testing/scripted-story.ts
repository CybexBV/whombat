/**
 * The demo storyline the scripted Hermes plays (docs/decisions/hermes-engine.md HE-33): Dusty's run #1907 on PR #482
 * reaches 41 of 41 and asks Joris to re-review, from `@whombat/fixtures` (the words of `Whombat Desktop.dc.html`).
 * Loaded only by turns that need it (a run, a search answer, a review): the fixtures take a while to import, and most
 * turns are a quick reply. Pure.
 */
import {
  cnv_pr482,
  LIVE_LOG_LINES,
  LIVE_STEP_INTERVAL_MS,
  pr,
  RUN_STEPS_TIMELINE,
  searchAnswer,
  run as storylineRun,
} from '@whombat/fixtures';
import type { ResultFacts } from './scripted-turn.ts';

export const STORYLINE = {
  runNumber: storylineRun.number,
  branch: storylineRun.branch,
  prNumber: pr.number,
  branchRoomId: cnv_pr482.id,
  /** One LIVE line every 2.6 s. */
  tickMs: LIVE_STEP_INTERVAL_MS,
  lines: LIVE_LOG_LINES.map((l) => l.text),
  steps: RUN_STEPS_TIMELINE,
  /** After the "✓ 41 of 41 tests passed" line (the mock's `tick >= 7`). */
  testsAtTick: 7,
  tests: { before: { passed: 38, total: 41 }, after: { passed: 41, total: 41 } },
  /** The run card once done. */
  summary: 'Pushed 7be20f and asked Joris to re-review.',
  /** The agent in the branch room at 11:36. */
  pushedMessage: 'Pushed 7be20f. Rounding happens before formatting now, and there’s a test for €0,005.',
  pushedDoing: 'Pushed 7be20f and asked Joris to re-review.',
  /** An approval of a pushed fix in the branch room, with its pill. */
  approvedMessage: 'Approved. Rounding order is right.',
  approvedDoing: `Approved PR #${pr.number}. Rounding order is right.`,
  answerText: searchAnswer.text,
  answerActions: searchAnswer.actions,
} as const;

/** Is this the demo run (#1907 on feat/invoice-pdf)? */
export function isStorylineRun(run: { number: number; branch: string }): boolean {
  return run.number === STORYLINE.runNumber && run.branch === STORYLINE.branch;
}

/** How many LIVE lines the run already played: the position after its latest log line. */
export function storylineTick(run: { activity: string }): number {
  const i = STORYLINE.lines.lastIndexOf(run.activity);
  return i < 0 ? 0 : i + 1;
}

/**
 * Index of the active step after `tick` LIVE lines (the mock's `activeIdx`); equals the step count when every step is
 * done.
 */
export function activeStepAt(tick: number): number {
  if (tick < 1) return 0;
  if (tick < 3) return 1;
  if (tick < 4) return 2;
  if (tick < 7) return 3;
  if (tick < 8) return 4;
  return STORYLINE.steps.length;
}

/**
 * Files touched after `tick` LIVE lines. The diff grows like the mock's run card (`+214 −12` at tick 0 → `+250 −20`
 * at the end) over the six files of the run page.
 */
export function filesAt(tick: number): { path: string; add: number; del: number }[] {
  const grow = Math.min(tick, 6);
  const shrink = Math.min(tick, 4);
  return [
    { path: 'billing/pdf/render.ts', add: 128, del: 0 },
    { path: 'billing/pdf/format.ts', add: 34 + 3 * grow, del: 9 + 2 * shrink },
    { path: 'billing/api/invoices.ts', add: 22, del: 1 },
    { path: 'billing/pdf/cache.ts', add: 18, del: 0 },
    { path: 'billing/pdf/format.test.ts', add: 9 + 3 * grow, del: 2 },
    { path: 'billing/flags.ts', add: 3, del: 0 },
  ];
}

/**
 * Citations for an answer: the storyline's three receipts (a thread, a patch and a run about rounding) when the results
 * carry them, else the top results.
 */
export function pickCitations(
  query: string,
  results: readonly ResultFacts[],
): { storyline: boolean; cited: ResultFacts[] } {
  // Prefer hits about rounding for each receipt type (the mock's #incidents thread, PR #311, Run #1882).
  const about = (type: string) =>
    results.find((r) => r.type === type && /round/i.test(r.text)) ?? results.find((r) => r.type === type);
  const thread = about('THREAD');
  const patch = about('PATCH');
  const runHit = about('RUN');
  if (/round/i.test(query) && thread && patch && runHit)
    return { storyline: true, cited: [thread, patch, runHit] };
  return { storyline: false, cited: results.slice(0, 3) };
}

/** "[1][2][3]" */
export function citationMarkers(n: number): string {
  return Array.from({ length: n }, (_, i) => `[${i + 1}]`).join('');
}
