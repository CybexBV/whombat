/**
 * How an observed activity row reads (work-supervision WS-13…WS-17): its status mark and tone, the words a screen
 * reader gets, and the feed's entries (core `collapseActivity`: routine reads fold into one group per turn). Pure.
 */
import { type Activity, type ActivityEntry, type ActivityStatus, collapseActivity } from '@whombat/core';

export type ActivityTone = 'ok' | 'warn' | 'bad' | 'mut' | 'live';

export const STATUS_TONE: Record<ActivityStatus, ActivityTone> = {
  running: 'live',
  waiting: 'warn',
  done: 'ok',
  failed: 'bad',
  interrupted: 'mut',
};

export const STATUS_LABEL: Record<ActivityStatus, string> = {
  running: 'Running',
  waiting: 'Waiting',
  done: 'Done',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

/** What the feed shows: its entries, or the one line that stands in for none. */
export function activityFeed(activities: readonly Activity[]): {
  entries: ActivityEntry[];
  empty: string | null;
} {
  if (activities.length > 0) return { entries: collapseActivity(activities), empty: null };
  // Every turn reports its steps now (hermes-engine-app.md AP-5009): none is simply none yet.
  return { entries: [], empty: 'No steps reported yet.' };
}

/** “billing/pdf/format.ts” stays whole; a long command line is cut for the row (the evidence has it all). */
export function objectText(object: string | null): string | null {
  if (!object) return null;
  const line = object.split('\n')[0] ?? '';
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

/** Entries a feed shows before “Show n earlier”. */
export const ACTIVITY_VISIBLE = 10;

/** How many of the oldest entries stay folded: none until the feed is a third longer than what shows. */
export function hiddenEntries(count: number): number {
  return count > Math.round(ACTIVITY_VISIBLE * 1.3) ? count - ACTIVITY_VISIBLE : 0;
}
