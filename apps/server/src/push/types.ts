/**
 * Push transports (web push, FCM, APNs) share this device/result shape. `PushSender` (sender.ts) dispatches
 * by `device.provider`, retries transient failures, and prunes devices the push service reports as gone.
 */
import type { PushPayload, PushProvider } from '@whombat/core';
import type { Config } from '../config';
import type { Logger } from '../services';

/** Enough of a `devices` row (or a synthetic per-activity target, see live-activity.ts) to send one push. */
export interface PushDevice {
  /** Real `devices.id` for pruning; a synthetic id (never matching a row) is fine when pruning must no-op. */
  id: string;
  provider: PushProvider;
  /** FCM / APNs token, the web push subscription endpoint, or (APNs live activities) an activity token. */
  token: string;
  webPush: { p256dh: string; auth: string } | null;
  /** APNs live activities only: this token is a push-to-start token (`.push-to-start-token` topic suffix). */
  apnsPushToStart?: boolean;
  /**
   * APNs live activities only: the activity the token is for. A token Apple turns down is then removed alone (the
   * activity's update token, or the push-to-start token), never the device with its alert token.
   */
  liveActivity?: { kind: 'run' | 'approval'; refId: string };
}

/** `sent` / `skipped` stop retrying; `prune` deletes the device row; `failed` retries, then gives up. */
export type PushOutcome = 'sent' | 'skipped' | 'failed' | 'prune';

/** One provider's send function: config + logger in, an outcome out. No two calls share transport state
 *  beyond in-module caches (OAuth2 / APNs provider tokens), so this is safe to call concurrently. */
export type PushTransport = (
  config: Config,
  log: Logger,
  device: PushDevice,
  payload: PushPayload,
) => Promise<PushOutcome>;
