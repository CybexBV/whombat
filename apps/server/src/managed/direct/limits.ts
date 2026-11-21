/**
 * The direct listener's limits (direct-connection.md DC-05): nobody needs a ticket to reach it, so what the relay and
 * control bound per subject is bounded here per address. Per peer (an IPv4 address, a Tailscale address, a local IPv6
 * /64 — a device can take any address of its own prefix): open sockets, new WebSockets (a token bucket), handshakes at
 * once, and failures (a handshake that didn't finish, a key this box doesn't know) — too many in a window and the
 * address is turned away for a while. Overall: sockets and handshakes at once, kept apart from the relay's own
 * handshake budget so neither path can starve the other. Memory is bounded: idle peers are forgotten, and past
 * `maxPeers` a new address is refused until some are.
 */
import { isIP } from 'node:net';
import { isTailscaleAddress, plainAddress } from './network';

export interface DirectLimits {
  /** Sockets open at once, per peer and overall. */
  socketsPerPeer: number;
  sockets: number;
  /** New WebSockets per peer: a burst, then this many a second. */
  upgradeBurst: number;
  upgradesPerSecond: number;
  /** Noise handshakes in flight, per peer and overall (they parse unauthenticated input). */
  handshakesPerPeer: number;
  handshakes: number;
  /** Failures (`failed`) within `failureWindowMs` that turn a peer away for `lockoutMs`. */
  failures: number;
  failureWindowMs: number;
  lockoutMs: number;
  /** Peers remembered at once. */
  maxPeers: number;
  /**
   * Whether failures turn a peer away. Off for the own address's door streams: their address is what the relay says,
   * and the relay is inside the threat model (own-address.md), so it is used for fair sharing only.
   */
  lockouts: boolean;
}

export const DIRECT_LIMITS: DirectLimits = {
  socketsPerPeer: 64,
  sockets: 512,
  upgradeBurst: 30,
  upgradesPerSecond: 1,
  handshakesPerPeer: 4,
  handshakes: 16,
  failures: 20,
  failureWindowMs: 10 * 60_000,
  lockoutMs: 10 * 60_000,
  maxPeers: 4_096,
  lockouts: true,
};

/**
 * The own address's limits (own-address.md): per visitor address (IPv4, or IPv6 /64) as the door saw it, and overall,
 * the TLS connections at once (a browser holds one on HTTP/2 plus one per tab's socket), new sockets and handshakes; no
 * lockouts. The door's own budgets (64 `web` streams) stand in front of these.
 */
export const DOOR_LIMITS: DirectLimits = {
  ...DIRECT_LIMITS,
  socketsPerPeer: 32,
  sockets: 64,
  lockouts: false,
};

interface Peer {
  sockets: number;
  handshakes: number;
  tokens: number;
  refilledAt: number;
  failures: number[];
  lockedUntil: number;
  seenAt: number;
}

/** The key a peer is counted under: the address, or its /64 for a local IPv6 address. */
export function peerKey(address: string): string {
  const plain = plainAddress(address);
  if (isIP(plain) !== 6 || isTailscaleAddress(plain)) return plain;
  const groups = expandIpv6(plain);
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : plain;
}

function expandIpv6(address: string): string[] | null {
  const [head = '', tail] = address.toLowerCase().split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  if (tail === undefined && a.length !== 8) return null;
  const fill = 8 - a.length - b.length;
  if (fill < 0) return null;
  return [...a, ...Array<string>(fill).fill('0'), ...b].map((g) => g.replace(/^0+(?=.)/, ''));
}

export type UpgradeVerdict = 'ok' | 'rate_limited' | 'locked';

export class DirectGuard {
  readonly limits: DirectLimits;
  private readonly peers = new Map<string, Peer>();
  private sockets = 0;
  private handshakes = 0;
  /** Counters for the health view (no addresses). */
  readonly stats = {
    socketsRefused: 0,
    upgradesRefused: 0,
    handshakesRefused: 0,
    failures: 0,
    lockouts: 0,
  };

  constructor(
    limits: Partial<DirectLimits> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.limits = { ...DIRECT_LIMITS, ...limits };
  }

  get openSockets(): number {
    return this.sockets;
  }

  get inFlightHandshakes(): number {
    return this.handshakes;
  }

  private peer(address: string, create: boolean): Peer | null {
    const key = peerKey(address);
    let peer = this.peers.get(key);
    const now = this.now();
    if (!peer && create) {
      if (this.peers.size >= this.limits.maxPeers) this.forgetIdle(now);
      if (this.peers.size >= this.limits.maxPeers) return null;
      peer = {
        sockets: 0,
        handshakes: 0,
        tokens: this.limits.upgradeBurst,
        refilledAt: now,
        failures: [],
        lockedUntil: 0,
        seenAt: now,
      };
      this.peers.set(key, peer);
    }
    if (peer) peer.seenAt = now;
    return peer ?? null;
  }

  /** Peers with nothing open, no lockout and no failure in the window go. */
  private forgetIdle(now: number): void {
    for (const [key, p] of this.peers)
      if (
        p.sockets === 0 &&
        p.handshakes === 0 &&
        p.lockedUntil <= now &&
        p.failures.every((at) => now - at > this.limits.failureWindowMs) &&
        now - p.seenAt > 60_000
      )
        this.peers.delete(key);
  }

  /** A socket opened: false when it must be closed at once (too many, or a locked-out peer). */
  openSocket(address: string): boolean {
    const peer = this.peer(address, true);
    if (
      !peer ||
      this.sockets >= this.limits.sockets ||
      peer.sockets >= this.limits.socketsPerPeer ||
      peer.lockedUntil > this.now()
    ) {
      this.stats.socketsRefused += 1;
      return false;
    }
    peer.sockets += 1;
    this.sockets += 1;
    return true;
  }

  closeSocket(address: string): void {
    const peer = this.peer(address, false);
    if (peer && peer.sockets > 0) peer.sockets -= 1;
    if (this.sockets > 0) this.sockets -= 1;
  }

  /** A new WebSocket from the peer: one token of its bucket. */
  upgrade(address: string): UpgradeVerdict {
    const peer = this.peer(address, true);
    const now = this.now();
    if (!peer) {
      this.stats.upgradesRefused += 1;
      return 'rate_limited';
    }
    if (peer.lockedUntil > now) {
      this.stats.upgradesRefused += 1;
      return 'locked';
    }
    const refill = ((now - peer.refilledAt) / 1000) * this.limits.upgradesPerSecond;
    peer.tokens = Math.min(this.limits.upgradeBurst, peer.tokens + refill);
    peer.refilledAt = now;
    if (peer.tokens < 1) {
      this.stats.upgradesRefused += 1;
      return 'rate_limited';
    }
    peer.tokens -= 1;
    return 'ok';
  }

  /** A Noise handshake may start: false at the peer's or the listener's limit. */
  beginHandshake(address: string): boolean {
    const peer = this.peer(address, true);
    if (
      !peer ||
      this.handshakes >= this.limits.handshakes ||
      peer.handshakes >= this.limits.handshakesPerPeer
    ) {
      this.stats.handshakesRefused += 1;
      return false;
    }
    peer.handshakes += 1;
    this.handshakes += 1;
    return true;
  }

  endHandshake(address: string): void {
    const peer = this.peer(address, false);
    if (peer && peer.handshakes > 0) peer.handshakes -= 1;
    if (this.handshakes > 0) this.handshakes -= 1;
  }

  /** A failure from the peer (a handshake that didn't finish, a key that isn't enrolled, a bad hello). */
  failed(address: string): void {
    this.stats.failures += 1;
    const peer = this.peer(address, true);
    if (!peer) return;
    const now = this.now();
    if (!this.limits.lockouts) return;
    peer.failures = peer.failures.filter((at) => now - at <= this.limits.failureWindowMs);
    peer.failures.push(now);
    if (peer.failures.length >= this.limits.failures && peer.lockedUntil <= now) {
      peer.lockedUntil = now + this.limits.lockoutMs;
      peer.failures = [];
      this.stats.lockouts += 1;
    }
  }

  locked(address: string): boolean {
    return (this.peer(address, false)?.lockedUntil ?? 0) > this.now();
  }
}
