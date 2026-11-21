/**
 * Pure sync logic for the phone's home-screen status widget: builds the native payload from the box's name and
 * Home overview (via `@whombat/client`'s `homeWidgetStatus`), deduplicates unchanged writes, and clears the widget
 * when the person signs out or removes the box.
 */
import { homeWidgetStatus } from '@whombat/client';
import type { HomeOverview } from '@whombat/core';
import type { StatusWidgetPayload } from '../../modules/whombat-live';

export interface StatusWidgetInput {
  overview: Pick<HomeOverview, 'summary' | 'needsYou' | 'things' | 'generatedAt'>;
  applianceId: string;
  applianceName: string | null | undefined;
  burrowName: string | null | undefined;
  timeZone: string;
  now?: Date | number;
}

/** Builds the widget payload for a box; prefers the directory/registry name, else the burrow's name. */
export function statusWidgetPayload(input: StatusWidgetInput): StatusWidgetPayload {
  const boxName = input.applianceName?.trim() || input.burrowName?.trim() || null;
  const widget = homeWidgetStatus(input.overview, {
    boxName,
    timeZone: input.timeZone,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return { ...widget, applianceId: input.applianceId };
}

export interface StatusWidgetTarget {
  setStatusWidget(payload: StatusWidgetPayload): Promise<void>;
  clearStatusWidget(applianceId?: string): Promise<void>;
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
    async clear(applianceId?: string): Promise<void> {
      lastKey = null;
      await target.clearStatusWidget(applianceId).catch(() => {});
    },
    reset(): void {
      lastKey = null;
    },
  };
}
