/**
 * Where the phone's sessions come from (AP-20, AP-27): control over HTTPS (bearer token in the keystore), the box
 * itself first on the ways its last welcome named (its local network, then Tailscale; HE-50, hermes-engine-app.md
 * AP-5302), the relay after, over React Native's WebSocket — `@whombat/secure-channel` pinned to the appliance either
 * way, with native ChaCha20-Poly1305 when its self-test passes (AP-26). The same `createSecureSession` as the web sits on
 * top.
 */
import {
  type ControlApi,
  clientBuildNumber,
  controlTickets,
  createHttpControl,
  fingerprintOf,
  ownAddressRoute,
} from '@whombat/client/managed';
import { secureChannelPort } from '@whombat/client/secure-channel';
import {
  createDirectConnector,
  createManagedConnector,
  createRoutedConnector,
  type RelaySocket,
  type SessionConnector,
} from '@whombat/client/session';
import { type DirectAddresses, directRoutesFor } from '@whombat/protocol/session';
import type { Identity } from '@whombat/secure-channel';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { CONTROL_URL } from './config';
import { deleteEndpointIdentity, loadOrCreateEndpointIdentity } from './keys';
import { checkedNativeCrypto } from './nativeCrypto';
import { secureStore } from './secureStore';
import { secretTokenStore } from './stores';

/** This phone's endpoint key (MA-03): generated once, kept in the keystore. */
export interface EndpointKey {
  identity: Identity;
  peerId: string;
  /** Short fingerprint for people to compare (groups of five). */
  fingerprint: string;
}

export interface ConnectTarget {
  orgId: string;
  device: string;
  /** The appliance identity to pin (full PeerId). */
  peerId: string;
  channel: 'app' | 'enroll';
  key: EndpointKey;
  /**
   * The box's direct ways as its last welcome said (`welcome.direct`), read on every connection: an app session tries
   * them first and the relay after (HE-50, AP-5302). Enrollment, claim and recovery stay on the relay.
   */
  direct?: () => DirectAddresses | null | undefined;
  /**
   * A community box (HE-58; AP-5472): only its direct ways, on every channel — enrollment by a link included — and never
   * the relay or control's tickets (it has neither).
   */
  directOnly?: boolean;
  /** The box's own address (`https://<host>/`, own-address.md): dialed first, before the direct ways. */
  own?: () => string | null | undefined;
}

export interface ManagedEnvironment {
  control: ControlApi;
  connector(target: ConnectTarget): SessionConnector;
}

export async function loadEndpointKey(): Promise<EndpointKey> {
  const identity = await loadOrCreateEndpointIdentity(secureStore);
  return { identity, peerId: identity.peerId, fingerprint: fingerprintOf(identity.peerId) };
}

/** A new key for this phone (set up again after it was removed, AP-39): the old one is deleted first. */
export async function replaceEndpointKey(): Promise<EndpointKey> {
  await deleteEndpointIdentity(secureStore);
  return loadEndpointKey();
}

/** How this phone is named on the appliance's device list (“Pixel 7 · Android”). */
export function phoneLabel(): string {
  const name = (Device.deviceName || Device.modelName || 'Phone').trim().slice(0, 60);
  return `${name} · ${Platform.OS === 'ios' ? 'iPhone app' : 'Android app'}`;
}

export const PHONE_PLATFORM: 'android' | 'ios' = Platform.OS === 'ios' ? 'ios' : 'android';

/**
 * What this app says about itself in every session's `hello` (enrollment and app channels alike): `buildNumber` is
 * the Android `versionCode` (the iOS build number), compared with the appliance's client security floor (CT-53).
 */
export function phoneClient(build: string) {
  const native =
    PHONE_PLATFORM === 'ios'
      ? Constants.expoConfig?.ios?.buildNumber
      : Constants.expoConfig?.android?.versionCode;
  const buildNumber = clientBuildNumber(native);
  // “android 0.12.0 (12000)” for people and logs (the version and versionCode come from app.config, AP-259).
  const version = Constants.expoConfig?.version;
  const label = version
    ? `${PHONE_PLATFORM} ${version}${buildNumber !== undefined ? ` (${buildNumber})` : ''}`.slice(0, 64)
    : build;
  return { build: label, platform: PHONE_PLATFORM, ...(buildNumber !== undefined && { buildNumber }) };
}

/**
 * React Native's Android WebSocket always sends an `Origin` header (the socket URL's own origin) unless one is
 * given. A native app has no web origin, and the relay (and the box's direct listener) treat a missing Origin as a
 * native client (MA-05); an empty value is read as missing, so that is what the app sends (AP-28).
 */
function relaySocket(url: string, protocol: string): RelaySocket {
  const Ctor = WebSocket as unknown as new (
    url: string,
    protocols: string | string[],
    options: { headers: Record<string, string> },
  ) => RelaySocket;
  return new Ctor(url, protocol, { headers: { origin: '' } });
}

export function createMobileEnvironment(controlUrl: string = CONTROL_URL): ManagedEnvironment {
  const control = createHttpControl(controlUrl, { tokens: secretTokenStore(secureStore) });
  return {
    control,
    connector(t) {
      // Native AEAD when it matches the pure-JS one exactly (AP-26, checked once: AP-891); pure JS otherwise.
      const crypto = checkedNativeCrypto();
      const secure = secureChannelPort(crypto ? { crypto } : {});
      if (t.directOnly) return directConnector(t, secure);
      const relay = createManagedConnector({
        // Control's refusals by name, as on the web: signed out, or a Whombat that's retired or not this
        // organization's (AP-693).
        tickets: controlTickets(control, t),
        secure,
        identity: async () => t.key.identity,
        appliance: { peerId: t.peerId },
        channel: t.channel,
        socket: relaySocket,
      });
      const { direct } = t;
      if (t.channel !== 'app' || (!direct && !t.own)) return relay;
      return createRoutedConnector({ direct: directConnector(t, secure), relay });
    },
  };
}

/**
 * Straight to the box on the ways `t.direct` names (its last welcome's, or a link's): the phone opens both `ws://` (the
 * local network; cleartext is allowed for it, AP-5377) and `wss://`.
 */
function directConnector(t: ConnectTarget, secure: ReturnType<typeof secureChannelPort>): SessionConnector {
  return createDirectConnector({
    routes: () => {
      const own = ownAddressRoute(t.own?.());
      return [...(own ? [own] : []), ...directRoutesFor(t.direct?.(), { secureOnly: false })];
    },
    secure,
    identity: async () => t.key.identity,
    appliance: { peerId: t.peerId },
    socket: relaySocket,
  });
}
