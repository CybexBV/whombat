/**
 * The appliance's relay connections (MA-05; `@whombat/protocol/relay`; docs/decisions/managed-runtime.md MR-17):
 *
 * - one **control connection** (outbound WebSocket, subprotocol `whombat-relay.v1`): `hello` with an appliance
 *   admission ticket from the manager, then `welcome`; the relay announces each client with `incoming{session}`;
 *   `drain` (worker shutdown) or a close makes it reconnect — exponential backoff with full jitter, a fresh ticket
 *   after 4401;
 * - its **lease** (docs/decisions/whombat-link.md): a relay that names one in `welcome` closes the control
 *   connection with 4401 `lease` unless the box renews within `renewWithinS`. The box renews in band, ahead of that, with
 *   a fresh ticket from the manager (`renew`, answered by `renewed` or `renew_refused`); a relay without a lease never
 *   gets a `renew` (it would close the connection with 4400);
 * - one **data connection** per session: `hello{session}`, then `ready`, after which only binary messages flow;
 *   the bytes go to the Noise responder and the session. At capacity (or too many handshakes at once, which
 *   parse unauthenticated input) the appliance answers `refuse{session}` instead.
 *
 * The relay only ever sees tickets and opaque bytes: nothing here decides who a client is.
 *
 * **Door streams** (docs/decisions/own-address.md): a box with its own address declares the door classes it takes in its
 * control hello (`accepts`: `acme` once it has a label, `web` too once it serves a certificate and the owner's switch is
 * on). The relay announces each with `incoming{session, class, src}`; the data connection says the same class, and after
 * `ready` its bytes are a browser's or a certificate authority's TLS connection, handed to the own address as a
 * `Duplex` (`RelayDuplex`). They have budgets of their own (`door.admit`), apart from `accept()` for app sessions. An
 * incoming of a class this box didn't declare, or one this version doesn't know, is refused: it ends that session only,
 * never the control connection. The control connection is opened again, once each time, when what it declares changes,
 * or when a fresh ticket carries another label than the one it was opened with and the relay takes no renewal (an older
 * relay reads the label from the ticket at `hello` only; one with a lease takes the new label from a `renew`).
 */
import { isIP } from 'node:net';
import {
  parseRelayDownstream,
  RELAY_CLOSE,
  RELAY_PATH,
  RELAY_PROTOCOL_VERSION,
  RELAY_SUBPROTOCOL,
  type RelayDoorClass,
  RelayHello,
  RelayId,
  RelayRefuse,
  RelayRenew,
  type RelayRenewRefusal,
} from '@whombat/protocol/relay';
import type { ByteStream } from '@whombat/secure-channel';
import { nodeWebSocketByteStream } from '@whombat/secure-channel/node';
import WebSocket from 'ws';
import { Outage } from '../../lib/outage';
import type { Logger } from '../../services';
import type { RuntimeCounters } from '../counters';
import { type AdmissionTicket, type ManagerPort, managerUnreachable } from '../ports';
import { RelayDuplex } from './relay-stream';

export type RelayStatus = 'stopped' | 'connecting' | 'connected' | 'backoff';

/** What the box's own address takes from the relay's door (own-address.md). */
export interface RelayDoorPort {
  /** The door classes this box takes now: declared in each control hello. */
  accepts(): readonly RelayDoorClass[];
  /** A slot for one door stream of `cls` from `src`, or null over its budget (then refused). Returns its release. */
  admit(cls: RelayDoorClass, src: string): (() => void) | null;
  /** A joined door stream: raw TLS bytes from `src`. */
  onStream(stream: RelayDuplex, cls: RelayDoorClass, src: string): void;
}

/**
 * The label a ticket carries (`lbl`, the box's registered own-address label), read from the compact JWS's payload. Never
 * verified here: it only decides whether to open the control connection again; the relay verifies the ticket.
 */
export function ticketLabel(jws: string): string | null {
  const payload = jws.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { lbl?: unknown };
    return typeof claims.lbl === 'string' ? claims.lbl : null;
  } catch {
    return null;
  }
}

/** The same door classes, in any order. */
function sameClasses(a: readonly RelayDoorClass[], b: readonly RelayDoorClass[]): boolean {
  return a.length === b.length && a.every((c) => b.includes(c));
}

export interface RelayClientOptions {
  manager: ManagerPort;
  /** A spliced data connection is ready: run the handshake and the session over it. */
  onStream(stream: ByteStream): void;
  /** Whether another session may start (session capacity and handshakes in flight). */
  accept(): boolean;
  log: Logger;
  backoff?: { baseMs: number; maxMs: number };
  /** For tests: 0..1. */
  random?: () => number;
  /** A connection that stayed up this long resets the backoff. */
  stableMs?: number;
  /**
   * The control connection is pinged this often, and one that leaves a ping unanswered for `pongWaitMs` is replaced
   * (open-speed.md OS-01). Defaults 5 s and 3 s.
   */
  livenessMs?: number;
  pongWaitMs?: number;
  /** A data connection not `ready` after this long gets a second one beside it (OS-02). Default 2.5 s; 0 turns it off. */
  dataRaceAfterMs?: number;
  /** A relay WebSocket's opening handshake must finish within this (OS-03). Default 10 s. */
  dialTimeoutMs?: number;
  /** Diagnostics counters (MR-42): connects, disconnects and the last close code. */
  counters?: RuntimeCounters;
  /** The own address's door streams; none: nothing declared, every door stream refused. */
  door?: RelayDoorPort;
  /**
   * How long before the relay would end the lease the box renews it. Default 90 s: by then the manager's cached ticket
   * is inside its own 60 s margin, so it hands a fresh one with a later expiry.
   */
  renewAheadMs?: number;
  /** A renewal that couldn't be sent, or was refused for now (`stale`, `replayed`, `rate`), is tried again this much later. Default 10 s. */
  renewRetryMs?: number;
}

/** The lease of one control connection: the ticket the relay holds it under, when it would end, the renewal on its way. */
interface Lease {
  ws: WebSocket;
  ticket: AdmissionTicket;
  /** When the relay closes the connection unless a renewal is taken (from the last `renewWithinS`). */
  endsAt: number;
  timer: NodeJS.Timeout | null;
  /** The renewal sent and not answered yet, and whether it was sent for a new label. */
  sent: { ticket: AdmissionTicket; forLabel: boolean } | null;
  /** Tickets the relay refused to renew with: never sent again. */
  refused: Set<string>;
  /** After a refusal for any other reason the box fetches a ticket and tries once more; this says it did. */
  triedAgain: boolean;
}

/** When a ticket expires, in ms (the manager's `expiresAt`); 0 when unreadable. */
function expiryOf(ticket: AdmissionTicket): number {
  const at = Date.parse(ticket.expiresAt);
  return Number.isFinite(at) ? at : 0;
}

/** How long an outage of the control plane is expected before it is a warning (BH-09): a restart of it. */
export const RELAY_OUTAGE_GRACE_MS = 5 * 60_000;
const NETWORK_DOWN = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

/**
 * Whether a relay connection failed only because the relay, or the edge in front of it, can't be reached now (BH-09): a
 * 5xx answer to the upgrade (`Unexpected server response: 502` while the control plane restarts) or no connection at
 * all. Anything else is a real error.
 */
export function relayUnreachable(err: unknown): boolean {
  const e = err as { message?: unknown; code?: unknown } | null;
  return (
    /Unexpected server response: 5\d\d\b/.test(String(e?.message ?? '')) ||
    (typeof e?.code === 'string' && NETWORK_DOWN.has(e.code))
  );
}

/** Full-jitter exponential backoff (AWS style): uniform in [0, min(max, base·2^attempt)]. Pure. */
export function backoffDelay(attempt: number, base: number, max: number, random: () => number): number {
  const ceiling = Math.min(max, base * 2 ** Math.min(attempt, 30));
  return Math.floor(random() * ceiling);
}

export class RelayClient {
  status: RelayStatus = 'stopped';
  private control: WebSocket | null = null;
  private ticket: AdmissionTicket | null = null;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private connectedAt = 0;
  /** What the open control connection declared, and the label its ticket carried (the relay routes by both). */
  private declared: readonly RelayDoorClass[] = [];
  private declaredLabel: string | null = null;
  /** The control connection closed on purpose to declare anew: open the next one at once. */
  private reopenNow = false;
  /** The open control connection's lease; null for a relay that names none (it takes no renewal). */
  private lease: Lease | null = null;
  private readonly data = new Set<WebSocket>();
  /** Counters for the manager's health view (no content, no ids). */
  readonly stats = {
    controlConnects: 0,
    incoming: 0,
    refused: 0,
    dataFailures: 0,
    /** Control connections replaced because a ping went unanswered (OS-01). */
    controlStalls: 0,
    /** Data connections that got a second dial beside them (OS-02). */
    dataRaces: 0,
    /** Door streams joined, and refused (undeclared or unknown class, a bad `src`, over budget). */
    doorStreams: 0,
    doorRefused: 0,
    /** Control connections opened again to declare a change (classes, label, another worker). */
    redeclares: 0,
    /** Renewals of the control connection's lease sent, taken and refused. */
    renewsSent: 0,
    renewed: 0,
    renewRefused: 0,
  };
  /** The control plane out of reach (a ticket the manager can't get, the relay answering 5xx): BH-09. */
  private readonly reach: Outage;

  constructor(private readonly options: RelayClientOptions) {
    this.reach = new Outage({
      what: 'relay: the control plane',
      log: () => this.options.log,
      graceMs: RELAY_OUTAGE_GRACE_MS,
    });
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.status = 'stopped';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.endLease();
    this.control?.close(1000, 'stopping');
    this.control = null;
    for (const ws of this.data) ws.close(1001, 'stopping');
    this.data.clear();
  }

  private async freshTicket(): Promise<AdmissionTicket> {
    if (this.ticket && Date.parse(this.ticket.expiresAt) - Date.now() > 30_000) return this.ticket;
    this.ticket = await this.options.manager.ticket('interactive');
    // A fresh ticket with another label (control started signing it, the box just registered one, or Link ended and it
    // carries none): a relay with a lease takes it in a renewal; an older one knows the label only from the hello.
    if (this.status === 'connected' && ticketLabel(this.ticket.ticket) !== this.declaredLabel) {
      if (this.lease && this.lease.ws === this.control) this.renewForLabel(this.lease, this.ticket);
      else this.redeclare('label');
    }
    return this.ticket;
  }

  /** Stops the lease's timer: its connection closed, or the client stopped. */
  private endLease(): void {
    if (this.lease?.timer) clearTimeout(this.lease.timer);
    this.lease = null;
  }

  /** The relay named `withinS` seconds for the lease: plan the renewal ahead of it. */
  private planRenewal(lease: Lease, withinS: number): void {
    lease.endsAt = Date.now() + withinS * 1000;
    const ahead = this.options.renewAheadMs ?? 90_000;
    this.renewAt(lease, Math.max(0, withinS * 1000 - ahead));
  }

  private renewAt(lease: Lease, delayMs: number): void {
    if (lease.timer) clearTimeout(lease.timer);
    lease.timer = setTimeout(() => {
      lease.timer = null;
      void this.renew(lease);
    }, delayMs);
    lease.timer.unref?.();
  }

  /** Tries again later while the lease still runs; past it the relay closes the connection and the box reconnects. */
  private renewLater(lease: Lease): void {
    const retryMs = this.options.renewRetryMs ?? 10_000;
    if (this.lease === lease && Date.now() + retryMs < lease.endsAt) this.renewAt(lease, retryMs);
  }

  /**
   * The planned renewal: a ticket from the manager (asked directly, past this client's own cache), sent only when it
   * expires later than the one the lease runs on; the relay would refuse an older one as `stale`.
   */
  private async renew(lease: Lease): Promise<void> {
    if (this.lease !== lease || lease.sent) return;
    let fresh: AdmissionTicket;
    try {
      fresh = await this.options.manager.ticket('interactive');
    } catch (err) {
      if (managerUnreachable(err)) this.reach.failed(err, { step: 'ticket' });
      else this.options.log.warn({ err: String(err) }, 'relay: no ticket to renew the lease with');
      this.renewLater(lease);
      return;
    }
    if (this.lease !== lease || lease.sent) return;
    if (expiryOf(fresh) <= expiryOf(lease.ticket) || lease.refused.has(fresh.ticket)) {
      this.renewLater(lease);
      return;
    }
    this.sendRenew(lease, fresh, ticketLabel(fresh.ticket) !== this.declaredLabel);
  }

  /** A fresh ticket names another label: renew with it now rather than opening the connection again. */
  private renewForLabel(lease: Lease, fresh: AdmissionTicket): void {
    if (lease.sent || lease.refused.has(fresh.ticket)) return;
    this.sendRenew(lease, fresh, true);
  }

  private sendRenew(lease: Lease, fresh: AdmissionTicket, forLabel: boolean): void {
    if (lease.ws.readyState !== WebSocket.OPEN) return;
    if (lease.timer) clearTimeout(lease.timer);
    lease.timer = null;
    lease.sent = { ticket: fresh, forLabel };
    this.stats.renewsSent += 1;
    lease.ws.send(JSON.stringify(RelayRenew.parse({ t: 'renew', ticket: fresh.ticket })));
  }

  /** `renewed`: the lease runs on the new ticket, which the next data connections use too. */
  private onRenewed(lease: Lease, withinS: number): void {
    const sent = lease.sent;
    lease.sent = null;
    lease.triedAgain = false;
    this.stats.renewed += 1;
    if (sent) {
      lease.ticket = sent.ticket;
      this.declaredLabel = ticketLabel(sent.ticket.ticket);
      if (!this.ticket || expiryOf(sent.ticket) >= expiryOf(this.ticket)) this.ticket = sent.ticket;
    }
    this.planRenewal(lease, withinS);
    // A newer ticket with yet another label arrived while this renewal was on its way.
    if (this.ticket && ticketLabel(this.ticket.ticket) !== this.declaredLabel)
      this.renewForLabel(lease, this.ticket);
  }

  /**
   * `renew_refused`: the lease is unchanged. A ticket for another worker means connecting there; `stale`, `replayed`
   * and `rate` are tried again shortly; anything else gets one more try with a newly fetched ticket. A renewal for a new
   * label that is refused opens the connection again instead, so the relay learns the label from the hello.
   */
  private onRenewRefused(lease: Lease, reason: RelayRenewRefusal, withinS: number): void {
    const sent = lease.sent;
    lease.sent = null;
    lease.endsAt = Date.now() + withinS * 1000;
    this.stats.renewRefused += 1;
    this.options.log.info({ reason }, 'relay: lease renewal refused');
    if (sent && reason !== 'rate') lease.refused.add(sent.ticket.ticket);
    if (reason === 'wrong_worker') {
      this.ticket = null;
      this.redeclare('worker');
      return;
    }
    if (sent?.forLabel) {
      this.redeclare('label');
      return;
    }
    if (reason === 'stale' || reason === 'replayed' || reason === 'rate') {
      this.renewLater(lease);
      return;
    }
    if (lease.triedAgain) return;
    lease.triedAgain = true;
    this.ticket = null;
    void this.renew(lease);
  }

  /**
   * Whether the control connection still declares what this box takes: called when the own address's label, classes
   * or switch changed, and on its regular read. `fresh` drops the cached ticket first (the manager hands a new one after
   * a label was registered). Opens the control connection again, once, when anything differs.
   */
  async refresh(fresh = false): Promise<void> {
    if (this.stopped) return;
    if (fresh) this.ticket = null;
    if (this.status !== 'connected') return;
    if (!sameClasses(this.options.door?.accepts() ?? [], this.declared)) {
      this.redeclare('accepts');
      return;
    }
    try {
      await this.freshTicket();
    } catch {
      /* the next connection asks again */
    }
  }

  /** Closes the control connection to open a new one at once; app sessions run on (their data connections stay). */
  private redeclare(why: 'accepts' | 'label' | 'worker'): void {
    const ws = this.control;
    if (!ws || this.reopenNow) return;
    this.reopenNow = true;
    this.stats.redeclares += 1;
    this.options.log.info({ why }, 'relay: declaring the own address anew');
    ws.close(1000, 'redeclare');
  }

  private refuse(ws: WebSocket, session: string): void {
    this.stats.refused += 1;
    ws.send(JSON.stringify(RelayRefuse.parse({ t: 'refuse', session })));
  }

  /**
   * An `incoming` this version can't read (a class it doesn't know): that session is refused, the control connection
   * stays. Null when the message isn't such an `incoming`.
   */
  private unknownIncoming(text: string): string | null {
    try {
      const msg = JSON.parse(text) as { t?: unknown; session?: unknown };
      if (msg.t !== 'incoming') return null;
      const session = RelayId.safeParse(msg.session);
      return session.success ? session.data : null;
    } catch {
      return null;
    }
  }

  private schedule(delayMs?: number): void {
    if (this.stopped) return;
    const { baseMs, maxMs } = this.options.backoff ?? { baseMs: 500, maxMs: 30_000 };
    const delay = delayMs ?? backoffDelay(this.attempt, baseMs, maxMs, this.options.random ?? Math.random);
    this.attempt += 1;
    this.status = 'backoff';
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
    this.timer.unref?.();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.status = 'connecting';
    let ticket: AdmissionTicket;
    try {
      ticket = await this.freshTicket();
    } catch (err) {
      if (managerUnreachable(err)) this.reach.failed(err, { step: 'ticket' });
      else this.options.log.warn({ err: String(err) }, 'relay: no admission ticket from the manager');
      this.schedule();
      return;
    }
    const ws = new WebSocket(relayUrl(ticket.relayUrl), RELAY_SUBPROTOCOL, {
      maxPayload: 8_192,
      handshakeTimeout: this.options.dialTimeoutMs ?? 10_000,
    });
    this.control = ws;
    this.stats.controlConnects += 1;
    this.reopenNow = false;
    let liveness: NodeJS.Timeout | null = null;
    ws.on('open', () => {
      // What this connection declares, read as it says hello: a change after this opens a new one (`refresh`).
      const accepts = [...(this.options.door?.accepts() ?? [])];
      this.declared = accepts;
      this.declaredLabel = ticketLabel(ticket.ticket);
      ws.send(
        JSON.stringify(
          RelayHello.parse({
            t: 'hello',
            v: RELAY_PROTOCOL_VERSION,
            ticket: ticket.ticket,
            class: 'interactive',
            ...(accepts.length ? { accepts } : {}),
          }),
        ),
      );
    });
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        ws.close(RELAY_CLOSE.badHello, 'binary on control');
        return;
      }
      const text = raw.toString();
      const parsed = parseRelayDownstream(text);
      if (!parsed.ok) {
        const session = this.unknownIncoming(text);
        if (session) {
          this.stats.incoming += 1;
          this.stats.doorRefused += 1;
          this.refuse(ws, session);
          return;
        }
        ws.close(parsed.close, parsed.error.slice(0, 100));
        return;
      }
      const msg = parsed.value;
      if (msg.t === 'welcome') {
        this.reach.ok();
        this.status = 'connected';
        this.connectedAt = Date.now();
        this.options.counters?.bump('relayConnects');
        if (this.options.counters) this.options.counters.lastRelayConnectedAt = new Date();
        liveness ??= this.watchControl(ws);
        // Only a relay that names a lease takes a renewal; an older one would close the connection for it.
        this.endLease();
        if (msg.lease) {
          const lease: Lease = {
            ws,
            ticket,
            endsAt: 0,
            timer: null,
            sent: null,
            refused: new Set(),
            triedAgain: false,
          };
          this.lease = lease;
          this.planRenewal(lease, msg.lease.renewWithinS);
        }
      } else if (msg.t === 'renewed' || msg.t === 'renew_refused') {
        const lease = this.lease;
        if (!lease || lease.ws !== ws) return;
        if (msg.t === 'renewed') this.onRenewed(lease, msg.lease.renewWithinS);
        else this.onRenewRefused(lease, msg.reason, msg.lease.renewWithinS);
      } else if (msg.t === 'incoming') {
        this.stats.incoming += 1;
        if (msg.class === 'web' || msg.class === 'acme') {
          // Only what this connection declared, from a visitor address that is one, within the door's own budgets.
          const door = this.options.door;
          const src = msg.src;
          const release =
            door && this.declared.includes(msg.class) && src && isIP(src) ? door.admit(msg.class, src) : null;
          if (!door || !src || !release) {
            this.stats.doorRefused += 1;
            this.refuse(ws, msg.session);
            return;
          }
          void this.openData(msg.session, msg.class, { src, release, door });
          return;
        }
        if (!this.options.accept()) {
          this.refuse(ws, msg.session);
          return;
        }
        void this.openData(msg.session, msg.class);
      } else if (msg.t === 'drain') {
        ws.close(1000, 'relay draining');
        this.control = null;
        this.schedule(msg.retryAfterMs + Math.floor((this.options.random ?? Math.random)() * 1000));
      }
    });
    ws.on('close', (code, reason) => {
      if (liveness) clearInterval(liveness);
      liveness = null;
      if (this.lease?.ws === ws) this.endLease();
      if (this.control !== ws) return;
      this.control = null;
      this.options.counters?.bump('relayDisconnects');
      if (this.options.counters) this.options.counters.lastRelayErrorCode = String(code);
      if (this.connectedAt && Date.now() - this.connectedAt > (this.options.stableMs ?? 30_000))
        this.attempt = 0;
      this.connectedAt = 0;
      if (code === RELAY_CLOSE.badTicket) this.ticket = null;
      let delay: number | undefined = this.reopenNow ? 0 : undefined;
      this.reopenNow = false;
      if (code === RELAY_CLOSE.draining) {
        try {
          delay = (JSON.parse(reason.toString()) as { retryAfterMs?: number }).retryAfterMs;
        } catch {
          delay = undefined;
        }
      }
      // Each retry of an outage closes too: one line for the outage is enough (BH-09).
      if (this.reach.down) this.options.log.debug({ code }, 'relay control connection closed');
      else this.options.log.info({ code }, 'relay control connection closed');
      this.schedule(delay);
    });
    ws.on('error', (err) => {
      if (relayUnreachable(err)) this.reach.failed(err, { step: 'connect' });
      else this.options.log.warn({ err: String(err) }, 'relay control connection error');
    });
  }

  /**
   * Pings the control connection every `livenessMs`; one that leaves a ping unanswered for `pongWaitMs` is on a bad
   * network path (it delays every `incoming`, so every session's start), so it is dropped and the close reconnects it on
   * a fresh one, from another port (OS-01). A check that runs late (the event loop was busy) judges nothing: the pong
   * may be waiting behind it.
   */
  private watchControl(ws: WebSocket): NodeJS.Timeout {
    const livenessMs = this.options.livenessMs ?? 5000;
    const pongWaitMs = this.options.pongWaitMs ?? 3000;
    const tickMs = Math.min(1000, livenessMs, pongWaitMs);
    let pingAt = 0;
    let lastPing = 0;
    let lastTick = Date.now();
    ws.on('pong', () => {
      pingAt = 0;
    });
    const timer = setInterval(() => {
      const at = Date.now();
      const late = at - lastTick > tickMs * 2;
      lastTick = at;
      if (this.control !== ws || ws.readyState !== WebSocket.OPEN) {
        clearInterval(timer);
        return;
      }
      if (pingAt) {
        if (!late && at - pingAt >= pongWaitMs) {
          clearInterval(timer);
          this.stats.controlStalls += 1;
          this.options.log.info(
            { waitedMs: at - pingAt },
            'relay control connection stopped answering; opening a fresh one',
          );
          ws.terminate();
        }
        return;
      }
      if (at - lastPing >= livenessMs) {
        pingAt = lastPing = at;
        ws.ping();
      }
    }, tickMs);
    timer.unref?.();
    return timer;
  }

  /**
   * A data connection for one incoming session; its bytes go to the responder once the relay says `ready`. One not
   * `ready` after `dataRaceAfterMs`, or one that fails before, gets a second dial beside it (OS-02): the relay pairs the
   * session with whichever says `hello` first and turns the other away, and the one left over is closed.
   */
  private async openData(
    session: string,
    cls: 'interactive' | 'bulk' | RelayDoorClass,
    door?: { src: string; release: () => void; door: RelayDoorPort },
  ): Promise<void> {
    let ticket: AdmissionTicket;
    try {
      ticket = await this.freshTicket();
    } catch {
      this.stats.dataFailures += 1;
      door?.release();
      return;
    }
    const dials = new Set<WebSocket>();
    /** Dials closed because the other one won: their errors aren't failures. */
    const lostRace = new WeakSet<WebSocket>();
    let started = 0;
    let joined = false;
    const raceAfterMs = this.options.dataRaceAfterMs ?? 2500;
    let race: NodeJS.Timeout | null = null;
    const dial = () => {
      started += 1;
      const ws = new WebSocket(relayUrl(ticket.relayUrl), RELAY_SUBPROTOCOL, {
        maxPayload: 262_144,
        handshakeTimeout: this.options.dialTimeoutMs ?? 10_000,
      });
      dials.add(ws);
      this.data.add(ws);
      const onMessage = (raw: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) {
          ws.close(RELAY_CLOSE.badHello, 'binary before ready');
          return;
        }
        const parsed = parseRelayDownstream(raw.toString());
        if (!parsed.ok) {
          ws.close(parsed.close, parsed.error.slice(0, 100));
          return;
        }
        if (parsed.value.t === 'ready') {
          // Synchronously, so no binary message is missed: from here the socket is a byte stream.
          ws.off('message', onMessage);
          joined = true;
          if (race) clearTimeout(race);
          for (const other of dials)
            if (other !== ws) {
              lostRace.add(other);
              other.terminate();
            }
          try {
            if (door && (cls === 'web' || cls === 'acme')) {
              this.stats.doorStreams += 1;
              const stream = new RelayDuplex(ws, { remote: door.src, local: 'door' });
              stream.once('close', door.release);
              door.door.onStream(stream, cls, door.src);
            } else this.options.onStream(nodeWebSocketByteStream(ws as never));
          } catch (err) {
            this.stats.dataFailures += 1;
            this.options.log.warn({ err: String(err) }, 'relay data connection failed');
            ws.close(1011, 'failed');
          }
        }
      };
      ws.on('open', () => {
        ws.send(
          JSON.stringify(
            RelayHello.parse({
              t: 'hello',
              v: RELAY_PROTOCOL_VERSION,
              ticket: ticket.ticket,
              class: cls,
              session,
            }),
          ),
        );
      });
      ws.on('message', onMessage);
      ws.on('close', () => {
        this.data.delete(ws);
        dials.delete(ws);
        // Failed before the session joined, with nothing else dialing: once more right away (the relay waits for it).
        if (!joined && dials.size === 0 && started < 2 && !this.stopped) {
          if (race) clearTimeout(race);
          dial();
        } else if (!joined && dials.size === 0) door?.release();
      });
      ws.on('error', () => {
        if (!lostRace.has(ws)) this.stats.dataFailures += 1;
      });
    };
    dial();
    if (raceAfterMs > 0) {
      race = setTimeout(() => {
        race = null;
        if (joined || started >= 2 || this.stopped) return;
        this.stats.dataRaces += 1;
        dial();
      }, raceAfterMs);
      race.unref?.();
    }
  }
}

/** The relay endpoint: the ticket's URL, with `/v1/connect` when it names only the host. */
export function relayUrl(url: string): string {
  const u = new URL(url);
  if (u.pathname === '/' || u.pathname === '') u.pathname = RELAY_PATH;
  return u.toString();
}
