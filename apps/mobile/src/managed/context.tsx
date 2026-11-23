/**
 * What the burrow app's screens need from a managed Whombat beyond the typed client (AP-27): the raw session for
 * session-native operations (status, devices, sign-ins, backups), who and what is connected, the journeys back out
 * (recovery kit, switch, sign out), push state, notification taps and where decrypted files are cached. Null in
 * the legacy app, so shared screens ask `useManaged()` and fall back.
 */
import type { ControlApi, ManagedWhombats, PushState } from '@whombat/client/managed';
import type { ApplianceSession, ConnectionState } from '@whombat/client/session';
import { createContext, useContext } from 'react';
import type { PushTap } from '../navigation/routes';
import type { AppUpdateSource } from './appUpdate';

export interface ManagedPush {
  state: PushState;
  /** Epoch ms of the last push this install received (null: none yet). Separate from the session. */
  lastReceivedAt: number | null;
  /** Asks for permission (only from a tap) and registers. */
  enable(): void;
  /** Opens the system settings for this app (after a denial). */
  openSettings(): void;
}

export interface PushTaps {
  /** The tap waiting since before the burrow app was up (once). */
  take(): PushTap | null;
  subscribe(listener: (tap: PushTap) => void): () => void;
}

/** Taps arrive before or after the app is ready for them: held until someone listens, then handed over. */
export function createPushTaps(): PushTaps & { push(tap: PushTap): void } {
  let pending: PushTap | null = null;
  const listeners = new Set<(tap: PushTap) => void>();
  return {
    push(tap) {
      if (listeners.size) for (const l of [...listeners]) l(tap);
      else pending = tap;
    },
    take() {
      const t = pending;
      pending = null;
      return t;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** App paths from links that named this appliance (MR-45), held until the navigator takes them. */
export interface LinkBus {
  take(): string | null;
  subscribe(listener: (path: string) => void): () => void;
  /** Keep a path for the next navigator (one that mounts after a burrow switch, AP-366), listeners or not. */
  hold(path: string): void;
}

export function createLinkBus(): LinkBus & { push(path: string): void } {
  let pending: string | null = null;
  const listeners = new Set<(path: string) => void>();
  return {
    push(path) {
      if (listeners.size) for (const l of [...listeners]) l(path);
      else pending = path;
    },
    hold(path) {
      pending = path;
    },
    take() {
      const p = pending;
      pending = null;
      return p;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * A link for the Whombat `to`: to the navigator showing it now when that is `to`, else held for `to`'s navigator, which
 * mounts with the switch. The one still showing until then must not take a path meant for another Whombat.
 */
export function sendLink(
  bus: Pick<ReturnType<typeof createLinkBus>, 'push' | 'hold'>,
  path: string,
  showing: string | null,
  to: string,
): void {
  if (showing === to) bus.push(path);
  else bus.hold(path);
}

export interface ManagedContextValue {
  session: ApplianceSession;
  connection: ConnectionState;
  applianceId: string;
  applianceName: string | null;
  applianceFingerprint: string;
  /** The identity this phone pinned for the Whombat (AP-63): what its add-a-device links name. */
  appliancePeerId: string;
  /** This phone's key fingerprint. */
  deviceFingerprint: string;
  /** This phone's key (its session PeerId), which a Whombat's own passkey challenges name (remote help, AP-4470). */
  devicePeerId: string;
  email: string;
  /** Scope of everything cached from this appliance (org/appliance/account/generation, AP-17). */
  cacheScope: string;
  push: ManagedPush;
  /** “Make a kit” (a Whombat from before the passkey); absent where there is none (a community box): hidden. */
  onKit?(): void;
  /**
   * Bringing a Whombat back (Whombat backup-options.md BKO-28, BKO-29, BKO-34): where a restore stands (finish it, try
   * again), or `later` on a Whombat that started fresh. Absent where the phone can't (a community box).
   */
  onBringBack?(later: boolean): void;
  switchAppliance(): void;
  /** Switch Whombat's sheet (whombat-switcher.md AP-3084): the organization's Whombats, and opening another one. */
  whombats: ManagedWhombats;
  signOut(): void;
  /** Notification taps to resolve through the session (the one that opened the app, then each new one). */
  taps: PushTaps;
  /** A quiet one-line note in the strip under the status bar (e.g. a tapped notification's item is gone). */
  showNote(text: string): void;
  /** App paths from links that named this appliance (MR-45). */
  links: LinkBus;
  /**
   * Control and this appliance's organization. A community box has no control (AP-5470): absent there.
   */
  control?: ControlApi;
  /**
   * Where this app looks for a newer build of itself: control's public download list, asked with no sign-in. Present on
   * a community box too, which otherwise makes no control calls: without it the phone never hears of an update.
   */
  updates?: AppUpdateSource;
  orgId: string;
  /**
   * The box is the community edition (HE-58; AP-5470): no relay, control, remote help, licence or phone push — the
   * screens leave those out and offer what the box does itself (links and QR codes, its mail server, Tailscale's own
   * login server). From the box's record on this phone, and `welcome.edition` once the session says it.
   */
  community: boolean;
  /**
   * The box's own address as a screen read it (`appliance.status`, a rename's answer): the phone keeps it when it
   * changed, so the next connection dials the current one.
   */
  ownAddressSeen?(own: { host: string; url: string } | null): void;
}

export const ManagedContext = createContext<ManagedContextValue | null>(null);

/**
 * Opens another of this person's burrows on the Whombat (a link in the old form, or with `?burrow=`, AP-366): false
 * when they don't belong to it. Null outside a managed Whombat.
 */
export const BurrowSwitchContext = createContext<((slug: string) => boolean) | null>(null);

export function useBurrowSwitch(): ((slug: string) => boolean) | null {
  return useContext(BurrowSwitchContext);
}

export function useManaged(): ManagedContextValue | null {
  return useContext(ManagedContext);
}

export function useManagedOrThrow(): ManagedContextValue {
  const v = useContext(ManagedContext);
  if (!v) throw new Error('useManagedOrThrow() outside a managed Whombat');
  return v;
}
