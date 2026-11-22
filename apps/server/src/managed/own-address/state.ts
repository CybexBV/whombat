/**
 * The box's own address as the runtime keeps it (docs/decisions/own-address.md): the manager orders and renews the
 * certificate and watches Certificate Transparency; this side
 *
 * - reads the manager's state at start and every `OWN_ADDRESS_STATE_POLL_S` (every 30 s while it waits for its first
 *   certificate, and once the served one is past two thirds of its life, when the manager renews it), treating 404
 *   (`own_address.off`, or a manager without the routes) as none;
 * - decides the A3 flag once, at the first start, from that answer (`shared_route_off`);
 * - draws the label (three words of the curated list) and has the manager register it; when control says it was used,
 *   draws again, at most 5 times, then waits an hour;
 * - records each new certificate's serial and public key before it serves it, then swaps the TLS context;
 * - reads the certificate watch every `OWN_ADDRESS_CT_POLL_S` and keeps what is foreign;
 * - keeps the owner's switch, and says which door classes the box takes: none without a label, `acme` with one, and
 *   `web` too while a certificate is served, the switch is on and browsers may open it (`webOpen`).
 *
 * Whenever what it takes changes, `onChange` tells the relay client, which declares it anew.
 */
import { createHash, randomInt, X509Certificate } from 'node:crypto';
import { createSecureContext, type SecureContext } from 'node:tls';
import {
  OWN_ADDRESS_CT_POLL_S,
  OWN_ADDRESS_STATE_POLL_S,
  type OwnAddressCtResponse,
  type OwnAddressStateResponse,
} from '@whombat/control-contracts/local';
import { drawOwnAddressLabel } from '@whombat/core/own-address';
import type { RelayDoorClass } from '@whombat/protocol/relay';
import type { OwnAddressSummary } from '@whombat/protocol/session';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { applianceState, ownAddressCerts, ownAddressForeign } from '../../db/schema/index';
import type { Services } from '../../services';
import { ManagerCallError, type ManagerPort } from '../ports';
import { ClaimLink } from './claim-link';
import { type ForeignCertificate, foreignCertificates } from './ct';

const STATE_ID = 1;

/**
 * Why the manager has no certificate yet and when it tries again, for the person's screen: only while it is failing,
 * and only with a reason the contract can carry (an odd code from a newer manager is left out, not sent broken).
 */
export function summaryFailure(
  acme: OwnAddressStateResponse['acme'],
): NonNullable<OwnAddressSummary['failure']> | undefined {
  if (acme.state !== 'failing' || !acme.error || !/^[a-z0-9_]{1,40}$/.test(acme.error)) return undefined;
  const at = acme.nextAttemptAt ? Date.parse(acme.nextAttemptAt) : Number.NaN;
  return { reason: acme.error, retryAt: Number.isFinite(at) ? new Date(at).toISOString() : null };
}
/** While the box waits for its first certificate (the manager probes and orders right after registering). */
export const OWN_ADDRESS_WAITING_POLL_MS = 30_000;
/** Draws of a label in a row that control may call used, then a pause. */
export const LABEL_DRAWS_MAX = 5;
export const LABEL_PAUSE_MS = 3_600_000;
/** A register that couldn't reach control is tried again this soon. */
const REGISTER_RETRY_MS = 60_000;

/** The certificate the box serves now. */
interface Served {
  serial: string;
  spkiSha256: string;
  notBefore: Date;
  notAfter: Date;
  context: SecureContext;
}

export interface OwnAddressOptions {
  services: Services;
  manager: ManagerPort;
  /** A uniform integer below `n` (tests pass their own). */
  randomInt?: (n: number) => number;
  /** Tests: no timers. */
  timers?: boolean;
  /**
   * Whether the runtime draws the label itself: only with a manager from before Whombat Link. With Link, control gives
   * the label and the manager registers it (whombat-link.md LNK-13); the runtime then only reads it.
   */
  drawsLabel?: () => boolean;
}

/** The SHA-256 of a certificate's DER SubjectPublicKeyInfo, lower-case hex (Cert Spotter's `pubkey_sha256`). */
export function spkiSha256(certPem: string): string {
  const der = new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

export class OwnAddressService {
  /** The manager's last answer; null before the first, or none (404). */
  private state: OwnAddressStateResponse | null = null;
  private ct: OwnAddressCtResponse | null = null;
  private served: Served | null = null;
  private reach = true;
  /** The A3 flag: null until decided. */
  private routeOff: boolean | null = null;
  private foreign: (ForeignCertificate & { firstSeenAt: string })[] = [];
  private draws = 0;
  private pausedUntil = 0;
  private registerAt = 0;
  private timers: NodeJS.Timeout[] = [];
  private polling: Promise<void> | null = null;
  private lastAccepts = '';
  private lastLabel: string | null = null;
  /** The claim link of an unclaimed box inside A3 (shown on its screen). */
  readonly claimLink: ClaimLink;
  /** What the box takes or is called changed: the relay client declares it anew (`fresh`: a new label, a new ticket). */
  onChange: ((fresh: boolean) => void) | null = null;
  /** The address became ready, changed, or was switched on or off (the console's address and claim link). */
  onReady: (() => void) | null = null;
  /** A foreign certificate was found (`notices.ts` tells the person). */
  onForeign: ((found: ForeignCertificate[]) => void) | null = null;

  constructor(private readonly options: OwnAddressOptions) {
    this.claimLink = new ClaimLink(() => options.services.clock().getTime());
  }

  private get services() {
    return this.options.services;
  }

  private now(): Date {
    return this.services.clock();
  }

  /* Start -------------------------------------------------------------------------------------------------------- */

  async start(): Promise<void> {
    await this.load();
    await this.poll();
    await this.readCt();
    if (this.options.timers === false) return;
    const every = (ms: number, run: () => Promise<void>) => {
      const timer = setInterval(() => void run().catch(() => {}), ms);
      timer.unref?.();
      this.timers.push(timer);
    };
    // The regular read, and a quicker one while the address waits for its first certificate.
    every(OWN_ADDRESS_WAITING_POLL_MS, async () => {
      if (
        this.waiting() ||
        this.renewing() ||
        Date.now() - this.lastPollAt >= OWN_ADDRESS_STATE_POLL_S * 1000
      )
        await this.poll();
    });
    every(OWN_ADDRESS_CT_POLL_S * 1000, () => this.readCt());
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private lastPollAt = 0;

  /**
   * Whether the served certificate is past two thirds of its life, when the manager renews it: read quickly until the
   * new one is served, so a short-lived certificate never ends before the runtime saw its renewal.
   */
  private renewing(): boolean {
    const s = this.served;
    if (!s) return false;
    const life = s.notAfter.getTime() - s.notBefore.getTime();
    return this.now().getTime() >= s.notBefore.getTime() + (life * 2) / 3;
  }

  /** Whether the box has a label but serves no certificate yet. */
  private waiting(): boolean {
    return Boolean(this.state?.enabled && (this.state.label === undefined || !this.served));
  }

  private async load(): Promise<void> {
    await this.services.db.insert(applianceState).values({ id: STATE_ID }).onConflictDoNothing();
    const [row] = await this.services.db
      .select({ reach: applianceState.ownAddressReach, routeOff: applianceState.sharedRouteOff })
      .from(applianceState)
      .where(eq(applianceState.id, STATE_ID));
    this.reach = row?.reach ?? true;
    this.routeOff = row?.routeOff ?? null;
    const foreign = await this.services.db.select().from(ownAddressForeign);
    this.foreign = foreign.map((f) => ({
      spkiSha256: f.spkiSha256,
      names: f.names,
      notBefore: f.notBefore.toISOString(),
      notAfter: f.notAfter.toISOString(),
      firstSeenAt: f.firstSeenAt.toISOString(),
    }));
  }

  /* The manager's state ------------------------------------------------------------------------------------------ */

  /** Reads the manager's state, registers a label when there is none, and serves a new certificate. One at a time. */
  poll(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    this.lastPollAt = Date.now();
    const read = this.options.manager.ownAddressState?.bind(this.options.manager);
    let state: OwnAddressStateResponse | null;
    try {
      state = read ? await read() : null;
    } catch (err) {
      if (!(err instanceof ManagerCallError && err.status === 404)) {
        this.services.log.debug({ err: String(err) }, 'own address: the manager’s state wasn’t read');
        return;
      }
      state = null;
    }
    await this.decideRouteOff(state?.enabled === true);
    this.state = state?.enabled ? state : null;
    // A label only on a box inside A3 or one already claimed: control refuses the claim of an unclaimed box with a label
    // (it is set up at its address), which a box outside A3 can't be.
    if (
      this.state &&
      !this.state.label &&
      this.options.drawsLabel?.() !== false &&
      (this.sharedRouteOff || (await this.claimed()))
    )
      await this.register();
    if (this.state?.cert && this.state.cert.serial !== this.served?.serial) await this.serveCertificate();
    this.changed();
  }

  /**
   * The A3 flag (own-address.md): set once, at the first start, true when the manager says the own address is on. A box
   * claimed before it was decided started on the shared route. Never changed later.
   */
  private async decideRouteOff(enabled: boolean): Promise<void> {
    if (this.routeOff !== null) return;
    const decided = await this.services.pipeline.transactAccount(async (tx) => {
      const [row] = await tx
        .select({ routeOff: applianceState.sharedRouteOff, claimed: applianceState.claimConsumedAt })
        .from(applianceState)
        .where(eq(applianceState.id, STATE_ID))
        .for('update');
      if (row?.routeOff !== null && row?.routeOff !== undefined) return row.routeOff;
      const value = enabled && !row?.claimed;
      await tx
        .update(applianceState)
        .set({ sharedRouteOff: value, updatedAt: this.now() })
        .where(and(eq(applianceState.id, STATE_ID), isNull(applianceState.sharedRouteOff)));
      return value;
    });
    this.routeOff = decided;
    if (decided) this.services.log.info({}, 'own address: this Whombat starts with its own address only');
  }

  private async claimed(): Promise<boolean> {
    const [row] = await this.services.db
      .select({ at: applianceState.claimConsumedAt })
      .from(applianceState)
      .where(eq(applianceState.id, STATE_ID));
    return Boolean(row?.at);
  }

  /** Draws a label and has the manager register it at control (D1). */
  private async register(): Promise<void> {
    const register = this.options.manager.ownAddressRegister?.bind(this.options.manager);
    const at = Date.now();
    if (!register || at < this.pausedUntil || at < this.registerAt) return;
    const random = this.options.randomInt ?? ((n: number) => randomInt(n));
    while (this.draws < LABEL_DRAWS_MAX) {
      const label = drawOwnAddressLabel(random);
      try {
        this.state = await register(label);
        this.draws = 0;
        this.services.log.info({}, 'own address: label registered');
        return;
      } catch (err) {
        const code = err instanceof ManagerCallError ? err.code : '';
        if (code === 'own_address.label_taken' || code === 'own_address.label_invalid') {
          this.draws += 1;
          continue;
        }
        if (code === 'own_address.off') {
          this.state = null;
          return;
        }
        this.registerAt = at + REGISTER_RETRY_MS;
        this.services.log.info({ err: String(err) }, 'own address: the label wasn’t registered yet');
        return;
      }
    }
    this.draws = 0;
    this.pausedUntil = at + LABEL_PAUSE_MS;
    this.services.log.warn({}, 'own address: control called every drawn label used; trying again in an hour');
  }

  /** Fetches the pair the manager hands out now, records it, and only then serves it. */
  private async serveCertificate(): Promise<void> {
    const fetch = this.options.manager.ownAddressCert?.bind(this.options.manager);
    const host = this.state?.host;
    if (!fetch || !host) return;
    try {
      const pair = await fetch();
      if (pair.host !== host) throw new Error('the certificate is for another host');
      const spki = spkiSha256(pair.certPem);
      if (spki !== pair.spkiSha256) throw new Error('the certificate’s key isn’t the one named');
      const context = createSecureContext({ cert: pair.certPem, key: pair.keyPem, minVersion: 'TLSv1.2' });
      await this.recordOwn([pair]);
      this.served = {
        serial: pair.serial,
        spkiSha256: spki,
        notBefore: new Date(pair.notBefore),
        notAfter: new Date(pair.notAfter),
        context,
      };
      this.services.log.info({ notAfter: pair.notAfter }, 'own address: serving a new certificate');
      this.onReady?.();
    } catch (err) {
      this.services.log.warn({ err: String(err) }, 'own address: the certificate wasn’t taken');
    }
  }

  /** Adds certificates to the box's own list (served or ordered): never foreign. */
  private async recordOwn(
    certs: readonly { serial: string; spkiSha256: string; notBefore: string; notAfter: string }[],
  ): Promise<void> {
    if (!certs.length) return;
    await this.services.db
      .insert(ownAddressCerts)
      .values(
        certs.map((c) => ({
          serial: c.serial,
          spkiSha256: c.spkiSha256,
          notBefore: new Date(c.notBefore),
          notAfter: new Date(c.notAfter),
        })),
      )
      .onConflictDoNothing();
  }

  /* The certificate watch ---------------------------------------------------------------------------------------- */

  /** Reads what the watch found, merges what the manager ordered into the own list, and keeps what is foreign. */
  async readCt(): Promise<void> {
    const read = this.options.manager.ownAddressCt?.bind(this.options.manager);
    const host = this.state?.host;
    if (!read || !host) return;
    let ct: OwnAddressCtResponse;
    try {
      ct = await read();
    } catch (err) {
      this.services.log.debug({ err: String(err) }, 'own address: the certificate watch wasn’t read');
      return;
    }
    this.ct = ct;
    await this.recordOwn(ct.ordered);
    const own = new Set(
      (await this.services.db.select({ spki: ownAddressCerts.spkiSha256 }).from(ownAddressCerts)).map(
        (r) => r.spki,
      ),
    );
    const found = foreignCertificates({ host, own, certs: ct.certs });
    const known = new Set(this.foreign.map((f) => f.spkiSha256));
    const fresh = found.filter((f) => !known.has(f.spkiSha256));
    if (!fresh.length) return;
    const at = this.now();
    await this.services.db
      .insert(ownAddressForeign)
      .values(
        fresh.map((f) => ({
          spkiSha256: f.spkiSha256,
          names: f.names,
          notBefore: new Date(f.notBefore),
          notAfter: new Date(f.notAfter),
          firstSeenAt: at,
        })),
      )
      .onConflictDoNothing();
    this.foreign.push(...fresh.map((f) => ({ ...f, firstSeenAt: at.toISOString() })));
    this.services.log.warn({ count: fresh.length }, 'own address: a certificate this Whombat didn’t ask for');
    this.onForeign?.(fresh);
    this.changed();
  }

  /** The foreign certificates still valid now. */
  async validForeign(): Promise<(typeof this.foreign)[number][]> {
    const now = this.now();
    const rows = await this.services.db
      .select({ spki: ownAddressForeign.spkiSha256 })
      .from(ownAddressForeign)
      .where(gt(ownAddressForeign.notAfter, now));
    const live = new Set(rows.map((r) => r.spki));
    return this.foreign.filter((f) => live.has(f.spkiSha256));
  }

  /* What the box takes ------------------------------------------------------------------------------------------- */

  /** Whether this box has an own address at all (the manager says so). */
  get enabled(): boolean {
    return this.state?.enabled === true;
  }

  /** The A3 flag (false until decided). */
  get sharedRouteOff(): boolean {
    return this.routeOff === true;
  }

  host(): string | null {
    return this.state?.host ?? null;
  }

  label(): string | null {
    return this.state?.label ?? null;
  }

  /** The certificate for the host while one is served and still valid. */
  context(): SecureContext | null {
    return this.served && this.served.notAfter > this.now() ? this.served.context : null;
  }

  /** Whether the address has what it needs to serve: its host and a valid certificate. */
  ready(): boolean {
    return Boolean(this.host() && this.context());
  }

  /**
   * Whether a browser that opens the address now gets the box's page: ready, and the box takes web traffic there (the
   * owner's switch is on, `accepts`). Only then is it an address to show or put in a link: with the switch off the
   * certificate stays valid and nothing answers.
   */
  serving(): boolean {
    return this.ready() && this.accepts().includes('web');
  }

  /**
   * A phase 2 seam: whether browsers may open the address now. Phase 2 shuts it while a foreign certificate is valid;
   * today it is always open.
   */
  webOpen(): boolean {
    return true;
  }

  /** A phase 2 seam: whether box-passkey joins are taken now (refused while a foreign certificate is valid). */
  joinsAllowed(): boolean {
    return true;
  }

  /** The door classes this box takes now (declared in the relay's control hello). */
  accepts(): RelayDoorClass[] {
    if (!this.state?.label) return [];
    return this.context() && this.reach && this.webOpen() ? ['web', 'acme'] : ['acme'];
  }

  private changed(): void {
    const accepts = this.accepts().join(',');
    const label = this.label();
    const fresh = label !== this.lastLabel;
    if (accepts === this.lastAccepts && !fresh) return;
    this.lastAccepts = accepts;
    this.lastLabel = label;
    this.onChange?.(fresh);
  }

  /** The owner's switch (`ownAddress.reach.set`): kept, declared to the relay, and the screen names another way in. */
  async setReach(on: boolean): Promise<void> {
    await this.services.db
      .update(applianceState)
      .set({ ownAddressReach: on, updatedAt: this.now() })
      .where(eq(applianceState.id, STATE_ID));
    this.reach = on;
    this.changed();
    this.onReady?.();
  }

  /* What the person sees ----------------------------------------------------------------------------------------- */

  /** `ownAddress` of `appliance.status` and `ownAddress.status`: null while the box has none. */
  summary(): OwnAddressSummary | null {
    const host = this.host();
    if (!this.state || !host) return null;
    const now = this.now();
    const served = this.context() ? this.served : null;
    const failure = served ? undefined : summaryFailure(this.state.acme);
    return {
      host,
      url: `https://${host}/`,
      state: served ? 'ready' : this.state.acme.state === 'failing' ? 'failing' : 'starting',
      reachable: this.reach,
      certificateEndsAt: served ? served.notAfter.toISOString() : null,
      ...(failure ? { failure } : {}),
      watch: {
        lastCheckAt: this.ct?.lastFreshAt ?? null,
        missed: (this.ct?.missed ?? []).slice(-64),
        foreign: this.foreign
          .filter((f) => Date.parse(f.notAfter) > now.getTime())
          .slice(-32)
          .map((f) => ({ ...f, names: f.names.slice(0, 20) })),
      },
    };
  }

  /** The certificate watch's last answer (the notices read it). */
  watch(): OwnAddressCtResponse | null {
    return this.ct;
  }

  /** The served certificate's end, for the expiring notice. */
  servedUntil(): { serial: string; notAfter: Date } | null {
    return this.served ? { serial: this.served.serial, notAfter: this.served.notAfter } : null;
  }

  /** The manager's ACME state (the failing notice). */
  acme(): OwnAddressStateResponse['acme'] | null {
    return this.state?.acme ?? null;
  }

  /** The console's alert while a certificate the box didn't ask for is still valid: since the first one was seen. */
  alert(): { kind: 'own_address_foreign'; since: string } | undefined {
    const now = this.now().getTime();
    const live = this.foreign.filter((f) => Date.parse(f.notAfter) > now);
    if (!live.length) return undefined;
    const since = live.map((f) => f.firstSeenAt).sort()[0] as string;
    return { kind: 'own_address_foreign', since };
  }

  /** The claim link for the console: only while this box is inside A3, unclaimed and its address serves its page. */
  claimUrl(): string | null {
    const host = this.host();
    if (!this.sharedRouteOff || !host || !this.serving()) return null;
    return `https://${host}/c/${this.claimLink.current}`;
  }
}
