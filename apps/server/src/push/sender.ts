/**
 * Dispatches a `PushPayload` to a device's transport (web push / FCM / APNs), retries a transient
 * `'failed'` outcome a couple of times with backoff, and prunes the device row when the transport reports
 * the token is gone. This is the one thing `notify()` and `LiveActivityBroadcaster` call — they don't know
 * which transport a device uses.
 */

import type { PushPreview } from '@whombat/control-contracts/device';
import type { PushPayload, PushProvider } from '@whombat/core';
import type { Config } from '../config';
import type { Db } from '../db/client';
import type { Logger } from '../services';
import { sendApns } from './apns';
import { prunePushTarget } from './devices';
import { sendFcm } from './fcm';
import type { PushDevice, PushOutcome, PushTransport } from './types';
import { sendWebPush } from './webpush';

const TRANSPORTS: Record<PushProvider, PushTransport> = {
  webpush: sendWebPush,
  fcm: sendFcm,
  apns: sendApns,
};

/** What a managed push carries besides its payload (docs/decisions/notifications.md NT-14…NT-16). */
export interface ControlPushOptions {
  /**
   * The phone keeps one notification per group (a conversation thread, an approval): the collapse key is derived
   * from it. Absent = the notification itself (NT-15).
   */
  group?: string;
  /** The title and start of the text the phone shows; absent = its generic text for the kind (NT-14). */
  preview?: PushPreview;
  /** Remove the group's notification from the phone instead of showing one (NT-16). */
  clear?: boolean;
}

/** A VAPID key pair (base64url, as `web-push` makes them). */
export interface VapidPair {
  publicKey: string;
  privateKey: string;
}

const RETRY_DELAYS_MS = [250, 1000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PushSender {
  /**
   * Managed mode (MR-13): no transport sends content; notifications go to control as content-free requests
   * (`managed/push.ts`) through this hook instead.
   */
  control:
    | ((principalIds: readonly string[], payload: PushPayload, options?: ControlPushOptions) => Promise<void>)
    | null = null;

  /** What the transports get: the configuration, with the box's own VAPID pair when it has one (HE-S220). */
  private transportConfig: Config;
  private own: VapidPair | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly log: Logger,
    /** Overridable for tests: skip the real backoff delays. */
    private readonly delay: (ms: number) => Promise<void> = sleep,
  ) {
    this.transportConfig = config;
  }

  /** The VAPID pair web push signs with: the configuration's, else the box's own; null for none. */
  vapid(): VapidPair | null {
    if (this.config.VAPID_PUBLIC_KEY && this.config.VAPID_PRIVATE_KEY)
      return { publicKey: this.config.VAPID_PUBLIC_KEY, privateKey: this.config.VAPID_PRIVATE_KEY };
    return this.own;
  }

  /**
   * The community box's own pair (hermes-engine.md HE-61, HE-S220; `managed/vapid.ts`), made at its first start: web push
   * signs with it unless the configuration sets one.
   */
  useOwnVapid(pair: VapidPair | null): void {
    this.own = pair;
    const vapid = this.vapid();
    this.transportConfig = vapid
      ? { ...this.config, VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey }
      : this.config;
  }

  /** Sends to one device, retrying `'failed'` outcomes, and prunes on `'prune'`. Never throws. */
  async send(device: PushDevice, payload: PushPayload): Promise<PushOutcome> {
    // Content goes to Apple, Google or a browser push service only where this box was given their keys (VAPID, FCM,
    // APNs: the community edition, hermes-engine.md HE-56); without them each transport skips. The commercial box has
    // none: its phones are told through Whombat's cloud without content (`managed/push.ts`).
    const transport = TRANSPORTS[device.provider];
    let outcome: PushOutcome = 'failed';
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        outcome = await transport(this.transportConfig, this.log, device, payload);
      } catch (err) {
        this.log.warn({ deviceId: device.id, err: String(err) }, 'push transport threw');
        outcome = 'failed';
      }
      if (outcome !== 'failed') break;
      const wait = RETRY_DELAYS_MS[attempt];
      if (wait !== undefined) await this.delay(wait);
    }
    if (outcome === 'prune') {
      await prunePushTarget(this.db, device);
    }
    return outcome;
  }

  /** Sends to every device in parallel; one device's failure doesn't affect the others. */
  async sendAll(devices: readonly PushDevice[], payload: PushPayload): Promise<PushOutcome[]> {
    return Promise.all(devices.map((device) => this.send(device, payload)));
  }
}
