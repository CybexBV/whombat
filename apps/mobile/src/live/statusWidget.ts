/**
 * Pure sync logic for the phone's home-screen status widget: builds the native payload from the box's name and
 * Home overview (via `@whombat/client`'s `homeWidgetStatus`), deduplicates unchanged writes, and clears the widget
 * when the person signs out or removes the box.
 */
import { homeWidgetStatus } from '@whombat/client';
import type { HomeOverview } from '@whombat/core';
import {
  type ClearStatusWidgetFilter,
  type StatusWidgetClearListener,
  type StatusWidgetPayload,
  type StatusWidgetSource,
  shouldClearStatusWidget,
  statusWidgetLabels,
} from '../../modules/whombat-live/src/statusWidget';
import { COMMUNITY_ORG } from '../managed/community';

export { shouldClearStatusWidget };

export interface StatusWidgetInput {
  overview: Pick<HomeOverview, 'summary' | 'needsYou' | 'things' | 'generatedAt'>;
  applianceId: string;
  applianceName: string | null | undefined;
  burrowName: string | null | undefined;
  /** Whether the open box is a cloud-managed or direct community box; defaults to `'cloud'`. */
  source?: StatusWidgetSource;
  timeZone: string;
  locale?: string;
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
    ...(input.locale !== undefined ? { locale: input.locale } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return {
    ...widget,
    applianceId: input.applianceId,
    source: input.source ?? 'cloud',
    ...(input.locale && { labels: statusWidgetLabels(input.locale) }),
  };
}

export interface StatusWidgetTarget {
  setStatusWidget(payload: StatusWidgetPayload): Promise<void>;
  clearStatusWidget(filter?: string | ClearStatusWidgetFilter): Promise<void>;
  /** Optional hook notified synchronously when any caller clears the underlying native queue. */
  onClearStatusWidget?(listener: StatusWidgetClearListener): () => void;
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
 * Clears `departingDevice`'s widget snapshot when the person leaves it (explicit switch, revocation,
 * or selecting another box). When `nextDevice` matches `departingDevice`, keeps the snapshot intact
 * so reopening the same box does not blank its status while reconnecting.
 */
export async function clearDepartingStatusWidget(
  target: Pick<StatusWidgetTarget, 'clearStatusWidget'>,
  departingDevice: string | null | undefined,
  nextDevice?: string | null,
): Promise<void> {
  const leaving = departingDevice?.trim() ?? '';
  if (!leaving) return;
  const entering = nextDevice?.trim() ?? '';
  if (entering && leaving === entering) return;
  await target.clearStatusWidget(leaving).catch(() => {});
}

/**
 * Switches the registry's active appliance to `nextDevice` and clears the departing box's widget
 * snapshot whenever the active box actually changes, so an offline next box never keeps showing the
 * previous box's status.
 */
export function switchActiveAppliance(
  registry: { lastUsed(): string | null; setLastUsed(device: string | null): void },
  target: Pick<StatusWidgetTarget, 'clearStatusWidget'>,
  nextDevice: string | null,
): void {
  const previous = registry.lastUsed();
  registry.setLastUsed(nextDevice);
  if (previous && previous !== nextDevice) {
    void target.clearStatusWidget(previous).catch(() => {});
  }
}

/**
 * Deduplicates and serializes writes to the native widget store so identical overviews don't re-broadcast
 * updates, stale queued writes are dropped after `clear`/`reset` or an external clear on `target`, and clearing
 * always lets the next push write.
 */
export function createStatusWidgetSync(target: StatusWidgetTarget) {
  let lastKey: string | null = null;
  let lastPayload: StatusWidgetPayload | null = null;
  let queue: Promise<void> = Promise.resolve();
  let suppressSelfClear = 0;
  const pendingWrites = new Set<{ payload: StatusWidgetPayload; cancelled: boolean }>();

  const invalidate = (filter?: string | ClearStatusWidgetFilter): void => {
    for (const entry of pendingWrites) {
      if (shouldClearStatusWidget(entry.payload, filter)) entry.cancelled = true;
    }
    if (lastPayload && shouldClearStatusWidget(lastPayload, filter)) {
      lastKey = null;
      lastPayload = null;
    }
  };

  const unsubscribe = target.onClearStatusWidget?.((filter) => {
    if (suppressSelfClear > 0) return;
    invalidate(filter);
  });

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    push(payload: StatusWidgetPayload): Promise<boolean> {
      const key = JSON.stringify(payload);
      if (key === lastKey) return Promise.resolve(false);
      lastKey = key;
      lastPayload = payload;
      const entry = { payload, cancelled: false };
      pendingWrites.add(entry);
      return enqueue(async () => {
        pendingWrites.delete(entry);
        // A clear, external clear, or reset ran while this write waited in the queue: drop the stale push.
        if (entry.cancelled) return false;
        try {
          await target.setStatusWidget(payload);
          return true;
        } catch {
          // Retry on the next change if the native write failed.
          if (lastKey === key && !entry.cancelled) {
            lastKey = null;
            lastPayload = null;
          }
          return false;
        }
      });
    },
    clear(filter?: string | ClearStatusWidgetFilter): Promise<void> {
      invalidate(filter);
      return enqueue(async () => {
        suppressSelfClear++;
        let clearing: Promise<void>;
        try {
          clearing = target.clearStatusWidget(filter);
        } finally {
          suppressSelfClear--;
        }
        await clearing.catch(() => {});
      });
    },
    reset(): void {
      invalidate();
    },
    dispose(): void {
      invalidate();
      unsubscribe?.();
    },
  };
}
