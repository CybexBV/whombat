/**
 * Where a box's sessions come from (AP-20): the real environment (control over HTTPS, relay WebSockets,
 * `@whombat/secure-channel` pinned to the appliance — and the box itself first, on its Tailscale name, HE-50) or the fake
 * world (development, e2e). Both hand out `SessionConnector`s; everything above is the same `createSecureSession`.
 */

import {
  type ControlApi,
  clientBuildNumber,
  controlTickets,
  createHttpControl,
  storageTokenStore,
} from '@whombat/client/managed';
import { secureChannelPort } from '@whombat/client/secure-channel';
import {
  createDirectConnector,
  createManagedConnector,
  createRoutedConnector,
  type SessionConnector,
} from '@whombat/client/session';
import { type DirectAddresses, directRoutesFor } from '@whombat/protocol/session';
import type { EndpointKey } from './keys';

/**
 * What this page says about itself in every session's `hello` (enrollment and app channels alike): the appliance
 * compares `buildNumber` with its client security floor (CT-53).
 */
export const WEB_CLIENT = {
  build: import.meta.env.VITE_WHOMBAT_BUILD ?? 'dev',
  platform: 'web' as const,
  ...(clientBuildNumber(import.meta.env.VITE_WHOMBAT_BUILD_NUMBER) !== undefined && {
    buildNumber: clientBuildNumber(import.meta.env.VITE_WHOMBAT_BUILD_NUMBER) as number,
  }),
};

export interface ConnectTarget {
  orgId: string;
  device: string;
  /** The appliance identity to pin (full PeerId). */
  peerId: string;
  channel: 'app' | 'enroll';
  key: EndpointKey;
  /**
   * The box's direct ways as its last welcome said (`welcome.direct`), read on every connection: an app session tries
   * them first and the relay after (HE-50, hermes-engine-app.md AP-5302).
   */
  direct?: () => DirectAddresses | null | undefined;
}

export interface ManagedEnvironment {
  control: ControlApi;
  connector(target: ConnectTarget): SessionConnector;
  /** Development/e2e only: the fake world's controls. */
  fake?: unknown;
  /** Development/e2e only: draw the open box as its own page would (the fake world's `boxPage`, AP-5325). */
  fakePage?: () => { kind: 'box'; secure: boolean } | undefined;
  /**
   * Origins besides Stripe's that Checkout and the portal may send the browser to (AP-160): only the fake world sets
   * one (its own page, where its fake Checkout comes back); the real environment has none.
   */
  billingRedirectOrigins?: readonly string[];
}

export function realEnvironment(controlUrl: string): ManagedEnvironment {
  // Local storage is reached when a token is read or written: reaching it may throw (storage turned off, a sandboxed
  // frame), and the page must still start; the control client keeps a token it can't store for this page (AP-594).
  const control = createHttpControl(controlUrl, { tokens: storageTokenStore(() => window.localStorage) });
  const secure = secureChannelPort();
  return {
    control,
    connector: (t) => {
      const relay = createManagedConnector({
        // Control's refusals by name: signed out, or a Whombat that's retired or not this organization's (AP-693).
        tickets: controlTickets(control, t),
        secure,
        identity: async () => t.key.identity,
        appliance: { peerId: t.peerId },
        channel: t.channel,
      });
      const { direct } = t;
      if (t.channel !== 'app' || !direct) return relay;
      // An https page opens only `wss://`: the box's Tailscale name, when it has HTTPS (`directRoutesFor`, CT-1252).
      return createRoutedConnector({
        direct: createDirectConnector({
          routes: () => directRoutesFor(direct(), { secureOnly: window.isSecureContext }),
          secure,
          identity: async () => t.key.identity,
          appliance: { peerId: t.peerId },
        }),
        relay,
      });
    },
  };
}

/** The environment this build runs against: `VITE_WHOMBAT_FAKE=1` loads the fake world (never in production). */
export async function loadEnvironment(): Promise<ManagedEnvironment> {
  if (import.meta.env.VITE_WHOMBAT_FAKE === '1') {
    const { createFakeWorld } = await import('./fake/world');
    const world = await createFakeWorld();
    return {
      control: world.control,
      connector: world.connector,
      fake: world,
      fakePage: () => world.page(),
      billingRedirectOrigins: [window.location.origin],
    };
  }
  return realEnvironment(import.meta.env.VITE_WHOMBAT_CONTROL_URL ?? 'https://api.whombat.com');
}
