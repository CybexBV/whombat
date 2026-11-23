/**
 * Where the box's own page gets the box from (hermes-engine-app.md AP-5322, AP-5420): the box that served it — its
 * identity at `GET /v1/direct` (`DirectIdentity`: the PeerId, and since 1.1 its edition and whether it is claimed,
 * CT-1300) and this origin's direct socket — or, in development and the e2e suite (`VITE_WHOMBAT_FAKE=1`), the fake
 * world's community box behind the same interface.
 */
import { ownAddressOfPage } from '@whombat/client/managed';
import { secureChannelPort } from '@whombat/client/secure-channel';
import { createDirectConnector, type SessionConnector } from '@whombat/client/session';
import { DIRECT_PATH, DirectIdentity } from '@whombat/protocol/direct';
import type { DirectRoute } from '@whombat/protocol/session';
import type { EndpointKey } from './keys';

export interface BoxEnvironment {
  /** What the box says about itself, or null when it couldn't be asked. */
  identity(): Promise<DirectIdentity | null>;
  /** A connection to the box, pinned to `peerId`, with this browser's key. */
  connector(target: { peerId: string; key: EndpointKey }): SessionConnector;
  /** Whether this page is a secure context (the box's Tailscale page, `localhost`): Web Push and passkeys need one. */
  secure(): boolean;
  /**
   * The box's own address when this page is it (`<name>.whombat.app`, own-address.md): the claim link and the box's
   * own passkeys work here. Null on the local network, Tailscale and `localhost`.
   */
  ownAddress?(): string | null;
  /** Development/e2e only: the fake world's controls. */
  fake?: unknown;
}

/** This page's way to its box: its own origin's direct socket. */
export function ownRoute(location: Pick<Location, 'protocol' | 'host'> = window.location): DirectRoute {
  const tls = location.protocol === 'https:';
  return {
    way: /\.ts\.net(:\d+)?$/i.test(location.host) ? 'tailscale' : 'lan',
    socket: `${tls ? 'wss' : 'ws'}://${location.host}${DIRECT_PATH}`,
    web: `${location.protocol}//${location.host}/`,
  };
}

/** What the box says about itself at `GET /v1/direct` (`DirectIdentity`), or null. */
export async function boxIdentity(fetchFn: typeof fetch = fetch): Promise<DirectIdentity | null> {
  try {
    const res = await fetchFn(DIRECT_PATH, { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok) return null;
    const parsed = DirectIdentity.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function realBoxEnvironment(): BoxEnvironment {
  const secure = secureChannelPort();
  return {
    identity: () => boxIdentity(),
    connector: (t) =>
      createDirectConnector({
        routes: () => [ownRoute()],
        secure,
        identity: async () => t.key.identity,
        appliance: { peerId: t.peerId },
      }),
    secure: () => window.isSecureContext,
    ownAddress: () => ownAddressOfPage(window.location.hostname),
  };
}

/** The environment this build runs against: `VITE_WHOMBAT_FAKE=1` loads the fake world (never in production). */
export async function loadBoxEnvironment(): Promise<BoxEnvironment> {
  if (import.meta.env.VITE_WHOMBAT_FAKE === '1') {
    const { createFakeWorld } = await import('./fake/world');
    const world = await createFakeWorld();
    return { ...world.box(), fake: world };
  }
  return realBoxEnvironment();
}
