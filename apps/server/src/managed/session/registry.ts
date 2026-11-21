/**
 * The live sessions of this runtime (MA-04 §6, MA-05): revocation closes an endpoint's sessions at once (with a
 * clear-cache notice), an authorization change closes the account's sessions, shutdown and drain say goodbye.
 *
 * Capacity is per class (review M-4, MA-19e, MR-28): enrolled endpoints have their own `MAX_SESSIONS`; unenrolled
 * keys (anyone with a ticket, keys are free) share a small `MAX_UNENROLLED_SESSIONS`, and each such session closes
 * after `UNENROLLED_IDLE_MS` without an enrollment request (and after `UNENROLLED_MAX_MS` in any case), so they can
 * never crowd out the person who uses the appliance. A session that enrolls moves to the enrolled class.
 *
 * Unenrolled sessions that came directly (direct-connection.md DC-06) have a class of their own, so nobody on the local
 * network can take the places of the devices enrolling through the relay, or the reverse.
 *
 * Unenrolled sessions through the box's own address (own-address.md) have theirs too, apart from the local network's
 * and Tailscale's: whoever finds the address on the internet can hold only those places, never the ones the person at
 * home sets the box up with. One visitor address holds at most half of them. A visitor who shows the claim link from
 * the box's screen in its hello gets a place kept for such visitors alone, so a stranger can't keep the public setup
 * out either.
 *
 * A screen elsewhere's key (desk-display.md DK-146) holds at most `MAX_SESSIONS_PER_SCREEN` sessions: a newer one closes
 * its oldest, so a page that reconnects isn't locked out by its dead sessions, and a tablet in someone's kitchen can't
 * take the places of the person's devices.
 */
import type { Services } from '../../services';
import type { CloseReason, SessionConnection } from './connection';

export const MAX_SESSIONS = 64;
/** Sessions one screen's key holds at once. */
export const MAX_SESSIONS_PER_SCREEN = 2;
export const MAX_UNENROLLED_SESSIONS = 4;
/** Unenrolled sessions from the local network and Tailscale at once (their own class). */
export const MAX_UNENROLLED_DIRECT_SESSIONS = 4;
/** Unenrolled sessions through the box's own address at once (their own class). */
export const MAX_UNENROLLED_DOOR_SESSIONS = 8;
/**
 * …and of one visitor address, as the door saw it: a household or a carrier's NAT shares one, so a few browsers setting
 * up at once each get theirs (own-address.md), and one address never holds the whole class.
 */
export const UNENROLLED_DOOR_PER_PEER = 4;
/** Places kept for visitors at the own address who showed the claim link from the box's screen. */
export const MAX_UNENROLLED_CLAIM_LINK_SESSIONS = 4;
/** An unenrolled session closes after this long without an `enroll`-channel request. */
export const UNENROLLED_IDLE_MS = 60_000;
/** …and after this long in any case (a pairing code lives 10 minutes). */
export const UNENROLLED_MAX_MS = 11 * 60_000;

export interface SessionLimits {
  maxSessions: number;
  maxUnenrolled: number;
  maxUnenrolledDirect: number;
  maxUnenrolledDoor: number;
  unenrolledDoorPerPeer: number;
  maxUnenrolledClaimLink: number;
  unenrolledIdleMs: number;
  unenrolledMaxMs: number;
}

/**
 * How a session came in, which decides the class an unenrolled one counts in: through the relay, from the local
 * network or Tailscale (`local`), or through the box's own address (`door`), there with the visitor's address and
 * whether its hello showed the claim link.
 */
export type SessionWay =
  | { via: 'relay' }
  | { via: 'local' }
  | { via: 'door'; peer: string; claimLink: boolean };

export class SessionRegistry {
  private readonly enrolled = new Set<SessionConnection>();
  private readonly unenrolled = new Set<SessionConnection>();
  private readonly unenrolledDirect = new Set<SessionConnection>();
  /** Through the own address, by the visitor's address. */
  private readonly unenrolledDoor = new Map<SessionConnection, string>();
  private readonly unenrolledClaimLink = new Set<SessionConnection>();
  private readonly off: () => void;
  readonly limits: SessionLimits;

  constructor(services: Services, limits: Partial<SessionLimits> = {}) {
    this.limits = {
      maxSessions: MAX_SESSIONS,
      maxUnenrolled: MAX_UNENROLLED_SESSIONS,
      maxUnenrolledDirect: MAX_UNENROLLED_DIRECT_SESSIONS,
      maxUnenrolledDoor: MAX_UNENROLLED_DOOR_SESSIONS,
      unenrolledDoorPerPeer: UNENROLLED_DOOR_PER_PEER,
      maxUnenrolledClaimLink: MAX_UNENROLLED_CLAIM_LINK_SESSIONS,
      unenrolledIdleMs: UNENROLLED_IDLE_MS,
      unenrolledMaxMs: UNENROLLED_MAX_MS,
      ...limits,
    };
    this.off = services.bus.onControl((c) => {
      if (c.type === 'endpoint.revoked') {
        for (const s of this.enrolled)
          if (s.principal?.endpoint?.id === c.endpointId)
            void s.close('endpoint_revoked', c.generation ?? s.principal.authzGeneration);
      } else if (c.type === 'authz.changed') {
        for (const s of this.enrolled)
          if (s.principal?.account?.id === c.accountId && s.principal.authzGeneration !== c.generation)
            void s.close('authz_changed', c.generation);
      }
    });
  }

  get size(): number {
    return (
      this.enrolled.size +
      this.unenrolled.size +
      this.unenrolledDirect.size +
      this.unenrolledDoor.size +
      this.unenrolledClaimLink.size
    );
  }

  /** Unenrolled sessions through the relay. */
  get unenrolledSize(): number {
    return this.unenrolled.size;
  }

  /** Unenrolled sessions from the local network and Tailscale. */
  get unenrolledDirectSize(): number {
    return this.unenrolledDirect.size;
  }

  /** Unenrolled sessions through the own address that showed no claim link. */
  get unenrolledDoorSize(): number {
    return this.unenrolledDoor.size;
  }

  /** Unenrolled sessions through the own address in the places kept for the claim link. */
  get unenrolledClaimLinkSize(): number {
    return this.unenrolledClaimLink.size;
  }

  /** Both classes are full: an `incoming` client is refused before its handshake. */
  get full(): boolean {
    return this.enrolled.size >= this.limits.maxSessions && this.unenrolled.size >= this.limits.maxUnenrolled;
  }

  /** Both classes a client from the local network or Tailscale may land in are full: refused before its handshake. */
  get directFull(): boolean {
    return (
      this.enrolled.size >= this.limits.maxSessions &&
      this.unenrolledDirect.size >= this.limits.maxUnenrolledDirect
    );
  }

  /**
   * Every class a visitor at the own address may land in is full: refused before its handshake. The places kept for
   * the claim link count: only the hello says whether a visitor has it.
   */
  get doorFull(): boolean {
    return (
      this.enrolled.size >= this.limits.maxSessions &&
      this.unenrolledDoor.size >= this.limits.maxUnenrolledDoor &&
      this.unenrolledClaimLink.size >= this.limits.maxUnenrolledClaimLink
    );
  }

  /**
   * Attaches a session in its class; false when that class is full (the caller refuses it). `screen`: the endpoint id
   * of a screen's key, whose oldest sessions beyond `MAX_SESSIONS_PER_SCREEN` close.
   */
  attach(
    s: SessionConnection,
    enrolled: boolean,
    way: SessionWay = { via: 'relay' },
    screen: string | null = null,
  ): boolean {
    if (screen) {
      const same = [...this.enrolled].filter((o) => o.principal?.endpoint?.id === screen);
      for (const old of same.slice(0, Math.max(0, same.length - MAX_SESSIONS_PER_SCREEN + 1))) {
        this.enrolled.delete(old);
        void old.close('overload');
      }
    }
    if (!enrolled && way.via === 'door') {
      // The claim link's places first; when those are taken, a visitor with the link waits among the others.
      if (way.claimLink && this.unenrolledClaimLink.size < this.limits.maxUnenrolledClaimLink) {
        this.unenrolledClaimLink.add(s);
        return true;
      }
      let ofPeer = 0;
      for (const peer of this.unenrolledDoor.values()) if (peer === way.peer) ofPeer += 1;
      if (
        this.unenrolledDoor.size >= this.limits.maxUnenrolledDoor ||
        ofPeer >= this.limits.unenrolledDoorPerPeer
      )
        return false;
      this.unenrolledDoor.set(s, way.peer);
      return true;
    }
    const [set, max] = enrolled
      ? [this.enrolled, this.limits.maxSessions]
      : way.via === 'local'
        ? [this.unenrolledDirect, this.limits.maxUnenrolledDirect]
        : [this.unenrolled, this.limits.maxUnenrolled];
    if (set.size >= max) return false;
    set.add(s);
    return true;
  }

  /** An unenrolled session enrolled (claim, invite, recovery, pairing): it now counts as enrolled. */
  promote(s: SessionConnection): void {
    // Each is asked, so a session leaves whichever class held it.
    const held = [
      this.unenrolled.delete(s),
      this.unenrolledDirect.delete(s),
      this.unenrolledDoor.delete(s),
      this.unenrolledClaimLink.delete(s),
    ];
    if (held.some(Boolean)) this.enrolled.add(s);
  }

  detach(s: SessionConnection): void {
    this.enrolled.delete(s);
    this.unenrolled.delete(s);
    this.unenrolledDirect.delete(s);
    this.unenrolledDoor.delete(s);
    this.unenrolledClaimLink.delete(s);
  }

  /**
   * New letters were asked for at the box: every session of a device nobody let in that came from the local network,
   * Tailscale or the own address closes, those that showed the claim link too (the link changed with the letters).
   * Whatever held those places before the person came holds none now; their own device connects again by itself.
   * Before the claim such a session can do nothing but claim, and its exchange ended with the old letters anyway.
   * They close as `new_letters`: the box ended them, so none counts against its address as a failed try.
   */
  async closeUnclaimedSetups(): Promise<number> {
    const held = [...this.unenrolledDirect, ...this.unenrolledDoor.keys(), ...this.unenrolledClaimLink];
    await Promise.all(held.map((s) => s.close('new_letters')));
    return held.length;
  }

  private all(): SessionConnection[] {
    return [
      ...this.enrolled,
      ...this.unenrolled,
      ...this.unenrolledDirect,
      ...this.unenrolledDoor.keys(),
      ...this.unenrolledClaimLink,
    ];
  }

  async closeAll(reason: CloseReason): Promise<void> {
    await Promise.all(this.all().map((s) => s.close(reason)));
  }

  close(): void {
    this.off();
  }
}
