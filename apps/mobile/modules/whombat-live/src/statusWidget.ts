/**
 * Pure home-screen status widget queue and conditional clear matching, shared by the native bridge wrapper
 * (`WhombatLive`) and the app's `StatusWidgetBridge`.
 *
 * Clearing a box or source invalidates every matching write still waiting in this queue AND synchronously notifies
 * upstream bridge queues (`onClearStatusWidget`) so a queued write can never land after a clear and restore a
 * removed, revoked or departed box's status.
 */
import type { HomeWidgetStatus } from '@whombat/client';

/** Whether a widget snapshot belongs to a cloud-signed-in box or a direct community box. */
export type StatusWidgetSource = 'cloud' | 'community';

/** Optional scope for `clearStatusWidget`: clear only if the saved snapshot matches the given box and/or source. */
export interface ClearStatusWidgetFilter {
  applianceId?: string;
  source?: StatusWidgetSource;
}

/** Saved calm status pushed to the Android and iOS home-screen widgets. */
export interface StatusWidgetPayload extends HomeWidgetStatus {
  /** Appliance id on this phone, so forgetting one box only clears its own widget status. */
  applianceId: string;
  /** Account/connection kind, so cloud sign-out or expiry clears cloud snapshots without wiping community boxes. */
  source?: StatusWidgetSource;
}

/** Minimal native store surface needed by `createStatusWidgetQueue`. */
export interface NativeStatusWidgetStore {
  setStatusWidget?(snapshotJson: string): Promise<void>;
  clearStatusWidget?(applianceId: string | null, source?: StatusWidgetSource | null): Promise<void>;
}

export type StatusWidgetClearListener = (filter?: string | ClearStatusWidgetFilter) => void;

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

interface PendingWrite {
  payload: StatusWidgetPayload;
  cancelled: boolean;
}

/**
 * Serializes status-widget writes and clears against the native module so an earlier write can never overtake a
 * later clear on a native concurrent pool (e.g., Swift's AsyncFunction executor), drops any matching queued write
 * invalidated by a later clear before it reaches native storage, and notifies registered upstream queues on clear.
 */
export function createStatusWidgetQueue(getNative: () => NativeStatusWidgetStore | null | undefined) {
  let queue: Promise<void> = Promise.resolve();
  const pendingWrites = new Set<PendingWrite>();
  const clearListeners = new Set<StatusWidgetClearListener>();

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };

  return {
    setStatusWidget(payload: StatusWidgetPayload): Promise<void> {
      const entry: PendingWrite = { payload, cancelled: false };
      pendingWrites.add(entry);
      return enqueue(async () => {
        pendingWrites.delete(entry);
        if (entry.cancelled) return;
        await getNative()?.setStatusWidget?.(JSON.stringify(payload));
      });
    },

    clearStatusWidget(filter?: string | ClearStatusWidgetFilter): Promise<void> {
      for (const entry of pendingWrites) {
        if (shouldClearStatusWidget(entry.payload, filter)) entry.cancelled = true;
      }
      for (const listener of [...clearListeners]) {
        try {
          listener(filter);
        } catch {
          // One listener failing must never block clearing native storage.
        }
      }
      return enqueue(async () => {
        const native = getNative();
        if (typeof filter === 'string') {
          await native?.clearStatusWidget?.(filter, null);
          return;
        }
        await native?.clearStatusWidget?.(filter?.applianceId ?? null, filter?.source ?? null);
      });
    },

    onClearStatusWidget(listener: StatusWidgetClearListener): () => void {
      clearListeners.add(listener);
      return () => {
        clearListeners.delete(listener);
      };
    },
  };
}
