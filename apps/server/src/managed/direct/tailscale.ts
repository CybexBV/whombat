/**
 * Tailscale for This Whombat (hermes-engine.md HE-51; direct-connection.md DC-13…DC-16): the image's tailscaled, off
 * until the person signs it in from Settings → This Whombat with Tailscale's own login link. The manager drives it and is
 * the only caller of tailscaled's local API (contracts 1.0.0 CT-1255, `MANAGER_PATHS.tailscale*`); the runtime asks the
 * manager for the state, the person's on, off and sign in, and the certificate for the box's Tailscale name that the
 * direct listener serves HTTPS with. Whombat holds no Tailscale secret and never an auth key.
 *
 * Shapes: `TailscaleStatus` (`@whombat/protocol/session`), the manager's `TailscaleStateResponse` and
 * `TailscaleCertResponse` (`@whombat/control-contracts/local`).
 */
import { X509Certificate } from 'node:crypto';
import { createSecureContext, type SecureContext } from 'node:tls';
import type { TailscaleCertResponse, TailscalePeer } from '@whombat/control-contracts/local';
import { TAILSCALE_OFF, type TailscaleStatus, tailscaleLoginUrlTrusted } from '@whombat/protocol/session';
import type { Logger } from '../../services';

export type TailscaleCert = TailscaleCertResponse;

/** The manager's Tailscale calls (`ManagerPort`, CT-1255). */
export interface TailscalePort {
  tailscaleState(): Promise<TailscaleStatus>;
  /** `loginServer`: the coordination server wanted, absent for Tailscale's own (contracts 1.1 `TailscaleOnRequest`). */
  tailscaleOn(input: { loginServer?: string }): Promise<TailscaleStatus>;
  tailscaleOff(input: { signOut?: boolean }): Promise<TailscaleStatus>;
  tailscaleSignIn(): Promise<TailscaleStatus>;
  tailscaleCert(): Promise<TailscaleCert>;
  /** The tailnet's other devices (3.11 `TailscalePeersResponse`, tailnet-reach.md TN-06); none unless it is on. */
  tailscalePeers(): Promise<TailscalePeer[]>;
}

/**
 * Only a login page the person may open is shown (whatever the manager passes on): on the box's own login server's origin,
 * or Tailscale's (`https://*.tailscale.com`) without one (contracts 1.1 `tailscaleLoginUrlTrusted`, CT-1306).
 */
export function tailscaleLoginUrl(value: string | null, loginServer?: string | null): string | null {
  if (!value) return null;
  return tailscaleLoginUrlTrusted(value, loginServer) ? value : null;
}

/** How often the runtime reads the state itself (the names the listener answers to and the routes follow it). */
export const TAILSCALE_REFRESH_MS = 30_000;

/**
 * What the person hears when Tailscale signed the box out by itself: its key ran out, or someone removed it from the
 * tailnet (docs/decisions/tailnet-reach.md TN-05).
 */
export const TAILSCALE_SIGNED_OUT_TEXT =
  'Tailscale signed this Whombat out, so your agents can’t reach the devices on your tailnet right now. Sign in again under Settings → This Whombat → Tailscale.';
/** A certificate is asked for again this long before it runs out, and at least daily (CT-1255). */
const CERT_RENEW_BEFORE_MS = 14 * 24 * 3600_000;
const CERT_RECHECK_MS = 24 * 3600_000;
const CERT_RETRY_MS = 60_000;

/** Tailscale for This Whombat on the runtime's side: the last state, the person's changes, the certificate. */
export class TailscaleService {
  private current: TailscaleStatus = TAILSCALE_OFF;
  /** The manager answered the last time it was asked. */
  private reachable = false;
  private timer: NodeJS.Timeout | null = null;
  private cert: { name: string; context: SecureContext; renewAt: number } | null = null;
  private certFetch: Promise<SecureContext | null> | null = null;
  private certFailedAt = Number.NEGATIVE_INFINITY;
  /** Called after a state that differs from the last (a community box reads its own page again, HE-S202). */
  onChange: (() => void) | null = null;
  /**
   * Called when a read finds the box signed out of its tailnet (on before, now asking for a sign-in or an approval,
   * perhaps after a moment of starting) without the person having changed anything: once per time it was on (TN-05).
   */
  onSignedOut: (() => void) | null = null;
  /** On at the runtime's own last reads, since the person last changed anything (TN-05). */
  private wasOn = false;

  constructor(
    private readonly manager: TailscalePort | null,
    private readonly log: Logger,
    private readonly options: { refreshMs?: number; now?: () => number } = {},
  ) {}

  /** Whether this runtime has a manager to ask (a development runtime may not). */
  get managed(): boolean {
    return this.manager !== null;
  }

  /** The last state read (the listener's names, the routes). */
  get last(): TailscaleStatus {
    return this.current;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  start(): void {
    if (!this.manager || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.options.refreshMs ?? TAILSCALE_REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** `read`: the runtime's own read, not the answer to the person's change. */
  private keep(status: TailscaleStatus, read = false): TailscaleStatus {
    const clean = { ...status, loginUrl: tailscaleLoginUrl(status.loginUrl, status.loginServer) };
    const changed = JSON.stringify(clean) !== JSON.stringify(this.current);
    const asking = clean.state === 'needs_sign_in' || clean.state === 'needs_approval';
    const signedOut = read && this.wasOn && asking;
    // The person's change starts again from what it answered; a read keeps “was on” through starting and errors.
    if (!read || asking || clean.state === 'off') this.wasOn = clean.state === 'on';
    else if (clean.state === 'on') this.wasOn = true;
    this.current = clean;
    this.reachable = true;
    if (clean.state !== 'on' || clean.name !== this.cert?.name) this.cert = null;
    if (changed) this.onChange?.();
    if (signedOut) this.onSignedOut?.();
    return clean;
  }

  /** Reads the state now; null when there is no manager or it didn't answer (`host.tailscale`'s `reason`). */
  async refresh(): Promise<TailscaleStatus | null> {
    if (!this.manager) return null;
    try {
      return this.keep(await this.manager.tailscaleState(), true);
    } catch (err) {
      if (this.reachable) this.log.warn({ err: String(err) }, 'tailscale: the manager did not answer');
      this.reachable = false;
      return null;
    }
  }

  private requireManager(): TailscalePort {
    if (!this.manager) throw new Error('no manager');
    return this.manager;
  }

  /**
   * Turns it on (HE-S217): `loginServer` absent keeps the box's (as last read: read now if it wasn't), `null` is Tailscale's
   * own, a server is that one (normalized by the caller). The manager always gets the one wanted and signs the box out of
   * a tailnet on another server first. Answers the status, the server and whether it changed.
   */
  async turnOn(
    loginServer?: string | null,
  ): Promise<{ status: TailscaleStatus; loginServer: string | null; changed: boolean }> {
    const manager = this.requireManager();
    if (loginServer === undefined && !this.reachable && !(await this.refresh()))
      throw new Error('the manager did not answer');
    const before = this.current.loginServer ?? null;
    const wanted = loginServer === undefined ? before : loginServer;
    const status = this.keep(await manager.tailscaleOn(wanted ? { loginServer: wanted } : {}));
    return { status, loginServer: wanted, changed: wanted !== before };
  }

  async turnOff(signOut: boolean): Promise<TailscaleStatus> {
    return this.keep(await this.requireManager().tailscaleOff(signOut ? { signOut: true } : {}));
  }

  async signIn(): Promise<TailscaleStatus> {
    return this.keep(await this.requireManager().tailscaleSignIn());
  }

  /** The tailnet's other devices, for the agent (TN-06): read now with the state; null without a manager that answers. */
  async peers(): Promise<{ status: TailscaleStatus; peers: TailscalePeer[] } | null> {
    if (!this.manager) return null;
    const status = await this.refresh();
    if (!status) return null;
    if (status.state !== 'on') return { status, peers: [] };
    return { status, peers: await this.manager.tailscalePeers() };
  }

  /** The names the box answers to on the tailnet while Tailscale is on: its MagicDNS name and short name. */
  hostnames(): string[] {
    const name = this.current.state === 'on' ? this.current.name : null;
    if (!name) return [];
    const short = name.split('.')[0];
    return short && short !== name ? [name, short] : [name];
  }

  /**
   * The certificate for `servername` when it is the box's Tailscale name and the tailnet has HTTPS: asked of the
   * manager on first use, again daily and before it runs out, kept in memory only.
   */
  async certificate(servername: string): Promise<SecureContext | null> {
    const { state, name, https } = this.current;
    if (!this.manager || state !== 'on' || !name || servername !== name || !https) return null;
    const held = this.cert?.name === name ? this.cert : null;
    if (held && held.renewAt > this.now()) return held.context;
    // A failed fetch isn't retried for a minute (a handshake each time would hammer the manager).
    if (this.now() - this.certFailedAt < CERT_RETRY_MS) return held?.context ?? null;
    this.certFetch ??= this.fetchCertificate(name).finally(() => {
      this.certFetch = null;
    });
    return this.certFetch;
  }

  private async fetchCertificate(name: string): Promise<SecureContext | null> {
    try {
      const pair = await this.requireManager().tailscaleCert();
      if (pair.name !== name) throw new Error('the certificate is for another name');
      const context = createSecureContext({ key: pair.keyPem, cert: pair.certPem });
      const validTo = Date.parse(new X509Certificate(pair.certPem).validTo);
      const renewAt = Number.isFinite(validTo)
        ? Math.max(
            this.now() + 3600_000,
            Math.min(validTo - CERT_RENEW_BEFORE_MS, this.now() + CERT_RECHECK_MS),
          )
        : this.now() + CERT_RECHECK_MS;
      this.cert = { name, context, renewAt };
      return context;
    } catch (err) {
      this.certFailedAt = this.now();
      this.log.warn({ err: String(err) }, 'tailscale: no certificate for the box’s name; its page stays off');
      return this.cert?.name === name ? this.cert.context : null;
    }
  }
}

/**
 * A stand-in for the manager's Tailscale (tests and `FakeManager`; DC-16): needs a sign-in, Tailscale's login link after
 * sign-in, on once someone signed in there (`completeSignIn`), off and signed out, and a certificate pair for its name
 * while the tailnet has HTTPS. Never this machine's own tailscaled.
 */
export class FakeTailscale implements TailscalePort {
  signedIn = false;
  running = false;
  linkMade = false;
  https = true;
  name = 'box.tail0000.ts.net';
  /** A test-only certificate pair for `name` (`__fixtures__/tailscale-cert-pair.pem` split). */
  pair: { certPem: string; keyPem: string } | null = null;
  /** The coordination server it signs in to (a Headscale), absent for Tailscale's own; kept across turns. */
  loginServer: string | undefined;
  readonly calls: string[] = [];

  completeSignIn(): void {
    this.signedIn = true;
    this.running = true;
    this.linkMade = false;
  }

  private status(): TailscaleStatus {
    const server = this.loginServer ? { loginServer: this.loginServer } : {};
    if (!this.running) return { ...TAILSCALE_OFF, ...server };
    if (!this.signedIn)
      return {
        ...TAILSCALE_OFF,
        state: 'needs_sign_in',
        loginUrl: this.linkMade
          ? this.loginServer
            ? `${this.loginServer}/register/nodekey:1a2b3c4d5e`
            : 'https://login.tailscale.com/a/1a2b3c4d5e'
          : null,
        ...server,
      };
    return {
      state: 'on',
      loginUrl: null,
      name: this.name,
      addresses: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
      tailnet: 'mara@example.com',
      https: this.https,
      problem: null,
      ...server,
    };
  }

  async tailscaleState() {
    this.calls.push('state');
    return this.status();
  }

  async tailscaleOn(input: { loginServer?: string } = {}) {
    this.calls.push(input.loginServer ? `on@${input.loginServer}` : 'on');
    // Another server: out of the tailnet on the old one first (CT-1306).
    if (input.loginServer !== this.loginServer) this.signedIn = false;
    this.loginServer = input.loginServer;
    this.running = true;
    if (!this.signedIn) this.linkMade = true;
    return this.status();
  }

  async tailscaleOff(input: { signOut?: boolean }) {
    this.calls.push(input.signOut ? 'off+signOut' : 'off');
    this.running = false;
    if (input.signOut) this.signedIn = false;
    return this.status();
  }

  async tailscaleSignIn() {
    this.calls.push('signIn');
    this.running = true;
    this.signedIn = false;
    this.linkMade = true;
    return this.status();
  }

  /** The tailnet's other devices while it is on (tests set them). */
  peers: TailscalePeer[] = [];

  async tailscalePeers() {
    this.calls.push('peers');
    return this.running && this.signedIn ? this.peers : [];
  }

  async tailscaleCert() {
    this.calls.push('cert');
    if (!this.running || !this.signedIn || !this.https || !this.pair)
      throw new Error('409 tailscale.no_https');
    return { v: 1 as const, name: this.name, ...this.pair, notAfter: '2126-09-29T22:39:27Z' };
  }
}

const services = new WeakMap<object, TailscaleService>();

/** The box's Tailscale for the agent's tools (`tailnet_devices`), set at boot; null on a development box without one. */
export function tailscaleOf(owner: object): TailscaleService | null {
  return services.get(owner) ?? null;
}

export function setTailscaleFor(owner: object, tailscale: TailscaleService): void {
  services.set(owner, tailscale);
}
