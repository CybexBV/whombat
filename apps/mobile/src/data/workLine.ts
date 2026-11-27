/**
 * The work at a glance on a Chat row and a live card: the work line's bar (who answered, which tasks are done, who is
 * at work) and a live council's or checklist's ⋯, which stops it quietly. The words are the shared `@whombat/client`
 * `workLine.ts` and its council words. Pure.
 */
import { councilWords, type WorkProgress } from '@whombat/client';
import { type NativeMenuSpec, plainMenu } from './nativeMenu';

/* The work line's bar ----------------------------------------------------------------------------------------------- */

export type WorkSegment = 'done' | 'working' | 'todo';

/** At most this many segments: a longer list of tasks reads as a share of them. */
const MAX_SEGMENTS = 12;

/** The bar's segments for a count (members answered, tasks done; those at work breathe); none for a sweep or nothing. */
export function workSegments(progress: WorkProgress): WorkSegment[] {
  if (progress?.kind !== 'steps' || progress.total <= 0) return [];
  const total = Math.min(progress.total, MAX_SEGMENTS);
  const scale = total / progress.total;
  const done = Math.min(total, Math.round(progress.done * scale));
  const working = Math.min(
    total - done,
    Math.max(progress.working > 0 ? 1 : 0, Math.round(progress.working * scale)),
  );
  return Array.from({ length: total }, (_, i) =>
    i < done ? 'done' : i < done + working ? 'working' : 'todo',
  );
}

/* A live card's menu ------------------------------------------------------------------------------------------------ */

/** A live card's ⋯ (a council's, a checklist's): Council settings where it has one, then Stop… (it asks first). */
export function liveCardMenu({
  change,
  stop,
  locale,
}: {
  change: boolean;
  stop: boolean;
  locale?: string;
}): NativeMenuSpec {
  const w = councilWords(locale);
  return plainMenu([
    change ? [{ id: 'change', title: w.changeCouncil, icon: 'person.2' }] : [],
    stop ? [{ id: 'stop', title: `${w.stop}…`, icon: 'stop', destructive: true }] : [],
  ]);
}

export function parseLiveCardPick(id: string): 'change' | 'stop' | null {
  return id === 'change' || id === 'stop' ? id : null;
}
