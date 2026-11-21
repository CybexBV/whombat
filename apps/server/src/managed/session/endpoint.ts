/**
 * The session endpoint (MA-10): connections in, Noise responder, sessions out — through the relay, and directly on the
 * box's own listener (hermes-engine.md HE-50, direct-connection.md). Handshakes parse unauthenticated input, so each
 * path has its own budget of handshakes at once (`MAX_HANDSHAKES` for the relay, the direct listener's per address and
 * overall): with the runtime's session limit that decides whether a client is accepted or refused, and neither path can
 * starve the other.
 *
 * Admission is the box's on both paths, from the key the client proved (MA-04): an enrolled endpoint gets the `app`
 * channel, any other key the `enroll` channel. Through the relay control's ticket vouched for the client; directly
 * nobody did, so unenrolled direct sessions have a class of their own, one per address at a time, and count against
 * their address when they end without enrolling (DC-06). After that it is the same session, frames and checks.
 *
 * The box's own address (own-address.md) is a third way in: the relay's door hands `web` streams to a direct listener
 * made for it (`ownAddress`, its own limits per visitor address, no lockouts) and `acme` streams to the manager's ACME
 * socket (`OwnAddressDoor`); its sessions are direct sessions on the `door` network. Their unenrolled ones are admitted
 * apart from the local network's and Tailscale's, once their hello is read (`SessionRegistry.attach`): a visitor on
 * the internet never holds a place the person at home needs.
 */
import { OWN_ADDRESS_ACME_SOCKET } from '@whombat/control-contracts/local';
import { bytesToHex } from '@whombat/core';
import { type ApplianceMessage, encodeSessionMessage } from '@whombat/protocol/session';
import type { ByteStream } from '@whombat/secure-channel';
import { DirectGuard, DOOR_LIMITS, peerKey } from '../direct/limits';
import {
  DirectListener,
  type DirectListenerOptions,
  type DirectMeta,
  type DirectOutcome,
} from '../direct/listener';
import type { DirectWeb } from '../direct/web';
import { type DeviceTest, deviceTestRoutes } from '../own-address/device-test';
import { OwnAddressDoor } from '../own-address/door';
import { ownAddressDoor } from '../own-address/server';
import type { ManagerPort, SecureMessageChannel, SecureResponder } from '../ports';
import { protocolFrameCodec } from '../ports';
import type { ManagedRuntime } from '../runtime';
import { SessionConnection } from './connection';
import { RelayClient, type RelayStatus } from './relay-client';

export const MAX_HANDSHAKES = 8;

export interface SessionEndpointStatus {
  relay: RelayStatus;
  sessions: number;
  handshakes: number;
  stats: RelayClient['stats'];
  direct: ReturnType<DirectListener['status']> | null;
  /** The own address's door streams open now, per class, and its listener's counters. */
  ownAddress: { door: OwnAddressDoor['counts']; listener: ReturnType<DirectListener['status']> } | null;
}

/**
 * Unenrolled sessions one peer address on the local network or Tailscale may hold at once. The own address's are
 * counted per visitor address when their hello is read (`UNENROLLED_DOOR_PER_PEER`, `SessionRegistry.attach`).
 */
export const UNENROLLED_DIRECT_PER_PEER = 1;

/** The direct listener's settings the boot passes (the endpoint supplies admission and the session). */
export type DirectEndpointOptions = Omit<
  DirectListenerOptions,
  'admit' | 'onStream' | 'appliancePeerId' | 'log'
>;

/** The own address's settings the boot passes: its page and the manager's ACME socket. */
export interface OwnAddressEndpointOptions {
  web: DirectWeb | null;
  acmeSocket?: string;
  /** The DEV phone passkey device test, when switched on (`device-test.ts`). */
  deviceTest?: DeviceTest | null;
  /** Tests: shorter timers. */
  helloTimeoutMs?: number;
  heartbeatMs?: number;
}

export class SessionEndpoint {
  private handshakes = 0;
  readonly relay: RelayClient;
  readonly direct: DirectListener | null;
  /** The own address's listener and door; null on a box without one (community, or no page to serve). */
  readonly ownAddress: DirectListener | null;
  readonly door: OwnAddressDoor | null;
  /** Unenrolled sessions from the local network and Tailscale, per peer address (`peerKey`). */
  private readonly unenrolledPeers = new Map<string, number>();

  constructor(
    private readonly runtime: ManagedRuntime,
    private readonly responder: SecureResponder,
    manager: ManagerPort,
    options: {
      backoff?: { baseMs: number; maxMs: number };
      random?: () => number;
      direct?: DirectEndpointOptions;
      ownAddress?: OwnAddressEndpointOptions;
    } = {},
  ) {
    const { direct, ownAddress, ...relayOptions } = options;
    const own = runtime.ownAddress;
    this.ownAddress =
      own && ownAddress
        ? new DirectListener({
            port: 0,
            hosts: [],
            interfaces: [],
            hostnames: () => [],
            development: false,
            appliancePeerId: runtime.trust.appliancePeerId,
            identity: () => ({ edition: runtime.edition, claimed: runtime.trust.ceremony.claimed }),
            log: runtime.services.log,
            admit: () => (runtime.sessions.doorFull ? 'full' : 'ok'),
            onStream: (stream, meta) => this.acceptDirect(stream, meta),
            web: ownAddress.web,
            door: ownAddressDoor(
              own,
              ownAddress.deviceTest
                ? deviceTestRoutes(ownAddress.deviceTest, () => own.host(), runtime.services.log)
                : undefined,
            ),
            guard: new DirectGuard(DOOR_LIMITS),
            ...(ownAddress.helloTimeoutMs ? { helloTimeoutMs: ownAddress.helloTimeoutMs } : {}),
            ...(ownAddress.heartbeatMs ? { heartbeatMs: ownAddress.heartbeatMs } : {}),
          })
        : null;
    this.door =
      own && this.ownAddress
        ? new OwnAddressDoor({
            accepts: () => own.accepts(),
            web: (stream, src) => this.ownAddress?.acceptDoor(stream, src),
            webOpen: () => own.webOpen(),
            acmeSocket: ownAddress?.acmeSocket ?? OWN_ADDRESS_ACME_SOCKET,
            log: runtime.services.log,
          })
        : null;
    this.relay = new RelayClient({
      manager,
      log: runtime.services.log,
      // Not refused while draining: reads still work, and the drain an update waits in is short.
      accept: () => !runtime.sessions.full && this.handshakes < MAX_HANDSHAKES,
      onStream: (stream) => this.accept(stream),
      counters: runtime.counters,
      ...(this.door ? { door: this.door } : {}),
      ...relayOptions,
    });
    // A new label, certificate or switch: the relay hears what this box takes now.
    if (own && this.door) own.onChange = (fresh) => void this.relay.refresh(fresh);
    this.direct = direct
      ? new DirectListener({
          ...direct,
          appliancePeerId: runtime.trust.appliancePeerId,
          identity: () => ({ edition: runtime.edition, claimed: runtime.trust.ceremony.claimed }),
          log: runtime.services.log,
          admit: () => (runtime.sessions.directFull ? 'full' : 'ok'),
          onStream: (stream, meta) => this.acceptDirect(stream, meta),
        })
      : null;
  }

  /** Runs the handshake and then the session over one relay byte stream. */
  accept(stream: ByteStream): void {
    this.handshakes += 1;
    this.responder(stream)
      .then((channel) => {
        this.handshakes -= 1;
        void new SessionConnection(this.runtime, channel, protocolFrameCodec).run();
      })
      .catch((err) => {
        this.handshakes -= 1;
        this.handshakeFailed(stream, err);
      });
  }

  /**
   * A direct connection (DC-06): the handshake, then admission by the box from the key the client proved, as through
   * the relay — an enrolled endpoint gets the `app` channel, a revoked one the session's own `revoked`, any other key the
   * `enroll` channel in the direct listener's own unenrolled class. A peer address on the local network or Tailscale
   * holds one unenrolled session at a time (another gets `too_many`), and one that ends without enrolling counts as a
   * failure for its address, unless the box itself ended it for new letters asked for at its screen: that is the
   * person's own doing and must never lock their device out. A visitor at the own address is counted when its hello
   * is read, which may show the claim link. Resolves once admission is decided (the listener counts refusals and
   * failures per address).
   */
  async acceptDirect(stream: ByteStream, meta: DirectMeta): Promise<DirectOutcome> {
    let channel: SecureMessageChannel;
    try {
      channel = await this.responder(stream);
    } catch (err) {
      this.handshakeFailed(stream, err);
      return 'failed';
    }
    const identity = await this.runtime.trust.identify(
      channel.remotePeerId,
      bytesToHex(channel.remotePublicKey),
    );
    const unenrolled = !identity.endpoint && !identity.revoked;
    const door = meta.network === 'door';
    const peer = peerKey(meta.remote);
    if (unenrolled && !door && (this.unenrolledPeers.get(peer) ?? 0) >= UNENROLLED_DIRECT_PER_PEER) {
      await this.refuse(channel, {
        t: 'error',
        code: 'too_many',
        message: 'This device is already setting up another connection here. Try again in a minute.',
        retryable: true,
      });
      return 'refused';
    }
    const session = new SessionConnection(this.runtime, channel, protocolFrameCodec, {
      transport: {
        via: 'direct',
        network: meta.network,
        tls: meta.tls,
        page:
          meta.origin === null ? null : { origin: meta.origin, secureContext: meta.secureContext === true },
      },
      ...(door ? { doorPeer: peer } : {}),
    });
    if (unenrolled) {
      if (!door) this.unenrolledPeers.set(peer, (this.unenrolledPeers.get(peer) ?? 0) + 1);
      void session.done.then((reason) => {
        if (!door) {
          const left = (this.unenrolledPeers.get(peer) ?? 1) - 1;
          if (left > 0) this.unenrolledPeers.set(peer, left);
          else this.unenrolledPeers.delete(peer);
        }
        if (!session.principal?.endpoint && reason !== 'new_letters')
          (door ? this.ownAddress : this.direct)?.guard.failed(meta.remote);
      });
    }
    void session.run();
    return identity.revoked ? 'refused' : 'session';
  }

  /** A refusal as the answer to the client's hello, then the end. */
  private async refuse(channel: SecureMessageChannel, message: ApplianceMessage): Promise<void> {
    try {
      await channel.send(
        protocolFrameCodec.encode({ type: 'control', streamId: 0, payload: encodeSessionMessage(message) }),
      );
      await channel.close();
    } catch {
      channel.abort();
    }
  }

  private handshakeFailed(stream: ByteStream, err: unknown): void {
    this.runtime.counters.bump('handshakeFailures');
    this.runtime.services.log.info({ err: String(err) }, 'session handshake failed');
    stream.abort(err instanceof Error ? err : new Error(String(err)));
  }

  start(): void {
    this.relay.start();
    this.runtime.relayStatus = () => this.relay.status;
  }

  /** Closes the relay connection (Whombat Link stopped running, whombat-link.md LNK-05); `start` opens it again. */
  stopRelay(): void {
    this.relay.stop();
  }

  /** Opens the direct listener (DC-02). A port that can't be had leaves the box on the relay only (logged). */
  async startDirect(): Promise<boolean> {
    if (!this.direct) return false;
    try {
      await this.direct.listen();
      return true;
    } catch (err) {
      this.runtime.services.log.warn(
        { err: String(err), port: this.direct.port },
        'direct listener: not started; clients reach this Whombat through the relay only',
      );
      return false;
    }
  }

  async stop(): Promise<void> {
    this.relay.stop();
    await this.direct?.close();
    await this.ownAddress?.close();
  }

  status(): SessionEndpointStatus {
    return {
      relay: this.relay.status,
      sessions: this.runtime.sessions.size,
      handshakes: this.handshakes,
      stats: this.relay.stats,
      direct: this.direct?.status() ?? null,
      ownAddress:
        this.door && this.ownAddress ? { door: this.door.counts, listener: this.ownAddress.status() } : null,
    };
  }
}
