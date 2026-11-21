/**
 * Pure sync logic for the phone's home-screen status widget: builds the native payload from the box's name and
 * Home overview (via `@whombat/client`'s `homeWidgetStatus`), deduplicates unchanged writes, and clears the widget
 * when the person signs out or removes the box.
 */
import { homeWidgetStatus } from '@whombat/client';
import type { HomeOverview } from '@whombat/core';
import type {
  ClearStatusWidgetFilter,
  StatusWidgetPayload,
  StatusWidgetSource,
} from '../../modules/whombat-live';
import { COMMUNITY_ORG } from '../managed/community';

export interface StatusWidgetInput {
  overview: Pick<HomeOverview, 'summary' | 'needsYou' | 'things' | 'generatedAt'>;
  applianceId: string;
  applianceName: string | null | undefined;
  burrowName: string | null | undefined;
  /** Whether the open box is a cloud-managed or direct community box; defaults to `'cloud'`. */
  source?: StatusWidgetSource;
  timeZone: string;
  now?: Date | number;
}

/** Whether an open box's org id belongs to a direct community box or a cloud-signed-in box. */
export function statusWidgetSourceFor(orgId: string | null | undefined): StatusWidgetSource {
  return orgId === COMMUNITY_ORG ? 'community' : 'cloud';
}

/** Builds the widget payload for a box; prefers the directory/registry name, else the burrow's name. */
export function statusWidgetPayload(input: StatusWidgetInput): StatusWidgetPayload {
  const boxName = input.applianceName?.trim() || input.burrowName?.trim() || null;
  const widget = homeWidgetStatus(input.overview, {
    boxName,
    timeZone: input.timeZone,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return { ...widget, applianceId: input.applianceId, source: input.source ?? 'cloud' };
}

/**
 * Mirrors the native widget store's conditional clear rule: clears unconditionally when no filter is given,
 * matches `applianceId` when specified, and matches `source` when specified (treating pre-upgrade snapshots
 * with no `source` as `'cloud'` so cloud sign-out/expiry never leaves them behind).
 */
export function shouldClearStatusWidget(
  saved: Pick<StatusWidgetPayload, 'applianceId' | 'source'> | null,
  filter?: string | ClearStatusWidgetFilter,
): boolean {
  if (!saved) return false;
  const applianceId = (typeof filter === 'string' ? filter : filter?.applianceId)?.trim() ?? '';
  const source = (typeof filter === 'string' ? undefined : filter?.source)?.trim() ?? '';
  if (applianceId && saved.applianceId && saved.applianceId !== applianceId) return false;
  if (source) {
    const savedSource = saved.source?.trim() ?? '';
    if (savedSource !== source && !(savedSource === '' && source === 'cloud')) return false;
  }
  return true;
}

export interface StatusWidgetTarget {
  setStatusWidget(payload: StatusWidgetPayload): Promise<void>;
  clearStatusWidget(filter?: string | ClearStatusWidgetFilter): Promise<void>;
}

/**
 * Clears the home-screen widget on cloud sign-out or session expiry when it is showing a cloud box,
 * even if community boxes are known on this phone (a widget showing a community box stays untouched).
 */
export async function clearCloudStatusWidget(
  target: Pick<StatusWidgetTarget, 'clearStatusWidget'>,
): Promise<void> {
  await target.clearStatusWidget({ source: 'cloud' }).catch(() => {});
}

/**
 * Deduplicates writes to the native widget store so identical overviews don't re-broadcast updates, and forgets
 * its last key whenever `clear` runs so signing back in always writes fresh state.
 */
export function createStatusWidgetSync(target: StatusWidgetTarget) {
  let lastKey: string | null = null;
  return {
    async push(payload: StatusWidgetPayload): Promise<boolean> {
      const key = JSON.stringify(payload);
      if (key === lastKey) return false;
      lastKey = key;
      try {
        await target.setStatusWidget(payload);
        return true;
      } catch {
        // Retry on the next change if the native write failed.
        if (lastKey === key) lastKey = null;
        return false;
      }
    },
    async clear(filter?: string | ClearStatusWidgetFilter): Promise<void> {
      lastKey = null;
      await target.clearStatusWidget(filter).catch(() => {});
    },
    reset(): void {
      lastKey = null;
    },
  };
}
