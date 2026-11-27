/**
 * The claim with a console code (MA-22, CC-01…CC-08; docs/decisions/managed-runtime.md MR-49…MR-53): what the runtime
 * holds in memory for it and what it shows on the console.
 *
 * - **Letters** (CC-01): four letters from `generateClaimLetters` over a CSPRNG, drawn when the process starts and
 *   again after every wrong `code` confirmation. Memory only: never in the database, a log, a diagnostic bundle or
 *   control. They are the `code` method's PAKE password.
 * - **Lookup lease** (CC-03): the number control leased to this device, pushed by the manager (`POST /claim-lookup`).
 *   It is the box's "waiting to be claimed" presence and is never shown: the console shows only the four letters, and
 *   only while the lease is live (CC-13, MR-54).
 * - **Generation**: bumped whenever the letters change; a begin made before it can't be confirmed any more.
 * - **New letters asked for at the box** (whombat-link.md): a short window with fresh letters that stay whatever is
 *   tried, with its own small counts of wrong tries (`CLAIM_WINDOW_*`) and of the exchanges each device began. Memory
 *   only, like the letters.
 * - **Console file** (CC-08, `WHOMBAT_CONSOLE_FILE`): `ConsoleState`, replaced atomically (temp file + rename, mode
 *   0640, group `WHOMBAT_CONSOLE_GROUP` when this process may set it) on every change, and again when a backoff or the
 *   lease runs out. No file is written when the setting is unset. Once claimed it carries the burrows (the oldest
 *   one's name and the count of the others, CT-116, MR-78; `console-burrows.ts`), rewritten when they change, and the
 *   screen sign-in while one is live (`signIn`, BX-06; `screen-signin.ts`), rewritten when it starts, rotates, is used
 *   or replaced, when it runs out and when the runtime stops.
 *
 * The failure counters live in the database (`appliance_claim_failures`, MR-50); the trust service computes the
 * backoff and tells this class.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, chownSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  type ConsoleAlert,
  type ConsoleBurrows,
  type ConsoleReach,
  ConsoleSignIn,
  ConsoleState,
  consoleStateValid,
} from '@whombat/control-contracts/local';
import { ENROLL_CLAIM_BEGIN_TTL_S } from '@whombat/protocol';
import {
  CLAIM_WINDOW_S,
  CLAIM_WINDOW_WRONG,
  CLAIM_WINDOW_WRONG_PER_KEY,
  type ClaimConfirmTags,
  type ClaimMethod,
  generateClaimLetters,
} from '@whombat/protocol/claim';
import { managedAppOrigin } from '../config';
import type { Services } from '../services';
import type { BoxPasskeyBegin } from './box-passkeys';
import type { SessionTransport } from './direct/transport';
import { groupId } from './groups';
import { registeredAtControl } from './link/origin';
import type { PasskeyBegin } from './passkeys';
import type { RemoteHelpBegin } from './remote-help';
import type { ScreenBegin } from './screen-signin';

/**
 * A live `enroll.claim.begin` of one session (CC-07): what `enroll.claim` checks its confirmation against. On a community
 * box `enroll.claim.local.begin` keeps one too (`local`, method `code`; hermes-engine.md HE-59, HE-S206), which only
 * `enroll.claim.local` confirms.
 */
export interface ClaimBegin {
  claimId: string;
  method: ClaimMethod;
  /** Begun on the box's own page (`enroll.claim.local.begin`). */
  local?: true;
  tags: ClaimConfirmTags;
  expiresAt: Date;
  /** The ceremony's generation when the password was taken (a failure since then ends this begin). */
  generation: number;
  /** The MR-26 attempt row, marked `ok` when the claim succeeds. */
  attemptId: number;
}

/**
 * A live `enroll.claim.local.start` of one session: the claim id the exchange is bound to, and the claim link's secret
 * the start carried, which the begin on this session checks again (own-address.md).
 */
export interface LocalClaimStart {
  claimId: string;
  expiresAt: Date;
  link: string | undefined;
}

/**
 * A session that proved it knows the letters (`enroll.claim.local.prove`) and saw the box's own proof: the one claim
 * it may make, on this session, until it runs out. It gets no time of its own: it ends when its exchange would have
 * (and with a claim window it needed), and it is good only for the letters it proved.
 */
export interface ClaimProof {
  claimId: string;
  expiresAt: Date;
  /** The ceremony's generation of the letters that were proved: other letters since then end this proof. */
  generation: number;
  /** The begin's attempt row, marked `ok` when the claim succeeds. */
  attemptId: number;
}

/**
 * New letters asked for at the box's own screen: since when and until when they stay, the wrong tries on them and the
 * exchanges each device began with them.
 */
export interface ClaimWindow {
  since: Date;
  until: Date;
  wrong: number;
  wrongBy: Map<string, number>;
  begunBy: Map<string, number>;
}

/** Per-session state the dispatcher hands to session ops (the connection owns it; it goes when the session closes). */
export interface SessionScope {
  claimBegin: ClaimBegin | null;
  /** The live `enroll.claim.local.start`: only this session begins its exchange. */
  localStart?: LocalClaimStart | null;
  /** The live `enroll.claim.local.prove`: only this session claims with it, once. */
  claimProof?: ClaimProof | null;
  /** The live `passkey.register.begin` (docs/decisions/passkeys.md PK-06): its nonce, used once. */
  passkeyBegin?: PasskeyBegin | null;
  backupVerify?: {
    accountId: string;
    endpointId: string;
    credentialId: string;
    keySealed: string;
    envelope: string;
    proof: string;
    expiresAt: Date;
  } | null;
  /** The live `enroll.screen.begin` (signin-at-box BX-03): what `enroll.screen` checks its tag against. */
  screenBegin?: ScreenBegin | null;
  /** The live `remoteHelp.confirmBegin` (remote-help-server.md RH-S04): its nonce and choice, used once. */
  remoteHelpBegin?: RemoteHelpBegin | null;
  /**
   * The session's key prefix in the presence tracker (docs/decisions/essentials-conversations.md EC-27): one entry
   * per burrow the session follows, gone when it closes.
   */
  presenceKey?: string;
  /** Set when the session closed: nothing more is tracked for it. */
  closed?: boolean;
  /** How the session reached the box and from which page (direct-connection.md DC-10); unset: the relay. */
  transport?: SessionTransport;
  /**
   * Through the box's own address: the visitor's address as the door saw it. Its tries at the claim link are counted
   * under it.
   */
  doorPeer?: string;
  /** The live box-passkey begins (own-address.md): each nonce used once. */
  boxPasskeyRegister?: BoxPasskeyBegin | null;
  boxPasskeyEnroll?: BoxPasskeyBegin | null;
}

export const CLAIM_BEGIN_TTL_MS = ENROLL_CLAIM_BEGIN_TTL_S * 1000;

/** What the trust service knows from the database. */
export interface ClaimStatus {
  claimed: boolean;
  /** Provisioning named the device (`claim.json` loaded): a claim can be bound to its id. */
  deviceReady: boolean;
  /** The backoff's end, when `enroll.claim.begin` is refused now. */
  retryAt: Date | null;
}

const newLetters = () => generateClaimLetters((n) => new Uint8Array(randomBytes(n)));

/**
 * The console file's `url` while a box claimed on its own pages has no address (no network yet): plain HTTP on the
 * unspecified address. A console shows an address only when it is `https://` (or loopback in development), and tells
 * the app an IPv4 address only when it is a real one, so this one is never shown.
 */
export const NO_ADDRESS_URL = 'http://0.0.0.0/';

export class ClaimCeremony {
  private letters: string | null = newLetters();
  private lease: { lookup: string; expiresAt: Date } | null = null;
  private status: ClaimStatus | null = null;
  private burrows: ConsoleBurrows | undefined;
  private signIn: ConsoleSignIn | undefined;
  private locale: string | undefined;
  private timer: NodeJS.Timeout | null = null;
  private lastWritten: string | null = null;
  private closed = false;
  private window: ClaimWindow | null = null;
  /** Bumped whenever the letters change: a begin from before can't be confirmed any more. */
  generation = 0;

  private readonly community: boolean;

  /**
   * A box inside A3 (own-address.md): claimed on pages it served, like a community box, so its letters are on the
   * console whenever it isn't claimed. Its console points at the claim link once its own address serves its page, its
   * local network's page before that; and it shows an alert while a certificate it didn't ask for is valid (any box
   * with an own address). The boot sets it.
   */
  ownAddress: {
    local(): boolean;
    url(): string | null;
    alert(): ConsoleAlert | undefined;
    /**
     * Another way to the claim while `url` is the claim link at the box's own address: its Tailscale page, else its
     * address on the local network. Null without one, and whenever `url` isn't that link. The own address is on the
     * internet, where strangers can keep it busy; the screen then still names a way they can't reach.
     */
    fallback(): string | null;
    /** New letters were asked for at the box: the claim link changes with them, before the screen is drawn. */
    newLink(): void;
  } | null = null;

  /** How the box is reached, shown in any state (Whombat Link's code and state, Tailscale's sign-in; 4.4). */
  reach: (() => ConsoleReach | undefined) | null = null;

  /**
   * True until the manager first says how the box is reached (its Link state). The boot sets it. Meanwhile an unclaimed
   * box's screen says it is starting: the claim screen without a secure address would send the person nowhere, and
   * Link's code (or Tailscale's sign-in) follows within seconds.
   */
  reachPending: (() => boolean) | null = null;

  /**
   * Whether a box claimed on its own pages has an address anyone can reach it at (its network, Tailscale, its own
   * address). The boot sets it. Without one an unclaimed box's screen says to check the network, and a claimed one's
   * names no address: never the hosted app's, never the box's own loopback.
   */
  hasWay: (() => boolean) | null = null;

  /**
   * Whether the box's network gave it an IPv6 address and no IPv4 one. The boot sets it. The phone app takes an IPv4
   * address only, so the screen of an unclaimed box then says that an IPv4 address is another way, whichever IPv6
   * addresses it has (one nobody can be told, a link-local or a public one, leaves the box without any way to name).
   */
  ipv6Only: (() => boolean) | null = null;

  /**
   * Whether a browser has the claim link open (the runtime sets it from its sessions). The screen then says to type the
   * letters on that page, without the link, its QR code or another way in.
   */
  pageOpen: (() => boolean) | null = null;

  constructor(
    private readonly services: Services,
    private readonly file: string | undefined = services.config.WHOMBAT_CONSOLE_FILE,
  ) {
    // Claimed on a page it served unless control registered the box (whombat-link.md LNK-01).
    this.community = !registeredAtControl(services.config);
  }

  /**
   * A community box (hermes-engine.md HE-59, HE-S211) or one inside A3: the letters are on the console whenever it isn't
   * claimed — no control leases a lookup and no provisioning names a device — and its URL is the box's own page.
   */
  get local(): boolean {
    return this.community || (this.ownAddress?.local() ?? false);
  }

  /**
   * `WHOMBAT_APP_URL` + `/claim` (CC-08); on a community box its own page, where the claim runs (HE-S211); on a box inside
   * A3 its claim link or its local page. Null when none is known (then nothing is written). A box control didn't
   * register (every Whombat Link box) counts as community here and is inside A3 once Link gave it its address: its
   * door takes a claim only with the link (requireClaimLink), so the screen must show the link, not the bare address.
   */
  get url(): string | null {
    if (this.ownAddress?.local()) {
      const own = this.ownAddress.url();
      if (own) return own;
    }
    try {
      const origin = managedAppOrigin(this.services.config);
      return this.local ? `${origin}/` : `${origin}/claim`;
    } catch {
      return null;
    }
  }

  /** Writes the console again when what it shows may have changed by itself (the box's page moved, HE-S211). */
  refresh(): void {
    this.write();
  }

  /** Whether the claim state is known and says claimed (the box's page answers it before a session, CT-1301). */
  get claimed(): boolean | undefined {
    return this.status ? this.status.claimed : undefined;
  }

  /** The runtime is starting: the console says so until the trust service reports the claim state. */
  announceStarting(): void {
    this.status = null;
    this.write();
  }

  /** The claim state from the database (at start, after the claim record loaded, after a failure or a claim). */
  setStatus(status: ClaimStatus): void {
    this.status = status;
    if (status.claimed) {
      this.letters = null;
      this.lease = null;
      this.window = null;
    }
    this.write();
  }

  /**
   * The burrows the claimed console shows (the oldest one's name and the count of the others; CT-116); undefined
   * when there is none. Shown only once claimed.
   */
  setBurrows(burrows: ConsoleBurrows | undefined): void {
    this.burrows = burrows;
    this.write();
  }

  /** The owner's language tag for the console UI, or undefined for the default. */
  setLocale(locale: string | null | undefined): void {
    const next = locale && ConsoleState.shape.locale.safeParse(locale).success ? locale : undefined;
    if (next === this.locale) return;
    this.locale = next;
    this.write();
  }

  /**
   * Whether this box has a screen to show a sign-in code on (BX-06): the console file is written (`WHOMBAT_CONSOLE_FILE`
   * and the hosted UI's origin are set). Without it `enroll.screen.request` is `screen_unavailable`.
   */
  get showsScreen(): boolean {
    return Boolean(this.file) && this.url !== null && !this.closed;
  }

  /**
   * The screen sign-in the claimed console shows (BX-06), or undefined for none; shown only once claimed and until its
   * `expiresAt` (the file is rewritten then by itself). The letters are in it: never log it.
   */
  setSignIn(signIn: ConsoleSignIn | undefined): void {
    // One the file can't carry is left out rather than keeping the whole file from being written.
    this.signIn = signIn && ConsoleSignIn.safeParse(signIn).success ? signIn : undefined;
    this.write();
  }

  /** The manager's lookup lease (`POST /claim-lookup`); null clears it. Ignored once claimed. */
  setLease(lease: { lookup: string; expiresAt: Date } | null): void {
    if (this.status?.claimed) return;
    this.lease = lease;
    this.write();
  }

  /** The live lease, if any. */
  liveLease(now: Date): { lookup: string; expiresAt: Date } | null {
    return this.lease && this.lease.expiresAt > now ? this.lease : null;
  }

  /**
   * The `code` method's password and the generation it belongs to, while a code is on the console (a device id and a
   * live lookup lease; not claimed); null otherwise (`claim_not_ready`). Never logged.
   */
  codePassword(now: Date): { password: string; generation: number } | null {
    if (!this.letters || !this.status || this.status.claimed) return null;
    // A community box shows its letters without a device id or a lease (HE-S211).
    if (!this.local && (!this.status.deviceReady || !this.liveLease(now))) return null;
    return { password: this.letters, generation: this.generation };
  }

  /**
   * A failed confirmation: every live begin ends; under `code` the letters rotate at once (CC-07). The wait that
   * follows is set when the counters were read (`setRetryAt`); `retryAt` sets it here.
   */
  failed(method: ClaimMethod, retryAt?: Date | null): void {
    this.generation++;
    if (method === 'code' && this.letters) this.letters = newLetters();
    if (this.status && retryAt !== undefined) this.status = { ...this.status, retryAt };
    this.write();
  }

  /**
   * The claim was written: the letters, the lease and any window go at once, before the database is read again, so
   * nothing asked for at the box meanwhile brings letters back.
   */
  markClaimed(): void {
    if (!this.status) return;
    this.setStatus({ ...this.status, claimed: true, retryAt: null });
  }

  /**
   * The person at the box asked for new letters: fresh ones at once, kept for `CLAIM_WINDOW_S` whatever is tried, with
   * the wait after wrong tries set aside meanwhile. Null when the box shows no letters of its own (claimed, or claimed
   * through control). Asking again while a window runs starts a new one.
   */
  openWindow(now: Date = this.services.clock()): Date | null {
    if (!this.letters || !this.status || this.status.claimed || !this.local) return null;
    this.generation++;
    this.letters = newLetters();
    // A new claim link with them, drawn on the same screen: this is the only time the link changes before a claim,
    // so the one the person reads here always works.
    this.ownAddress?.newLink();
    const until = new Date(now.getTime() + CLAIM_WINDOW_S * 1000);
    this.window = { since: now, until, wrong: 0, wrongBy: new Map(), begunBy: new Map() };
    this.write();
    return until;
  }

  /** The window that runs now, if any. One that ran out ends here: its letters go, as after a wrong try. */
  liveWindow(now: Date = this.services.clock()): ClaimWindow | null {
    if (!this.window) return null;
    if (this.window.until > now) return this.window;
    this.window = null;
    this.generation++;
    if (this.letters) this.letters = newLetters();
    return null;
  }

  /** Whether this device used its wrong tries on the letters of the window that runs now. */
  windowSpent(peerId: string, now: Date): boolean {
    return (this.liveWindow(now)?.wrongBy.get(peerId) ?? 0) >= CLAIM_WINDOW_WRONG_PER_KEY;
  }

  /**
   * A wrong try on the letters: `none` when no window runs (the caller rotates as usual, `failed`); `open` while the
   * window goes on, its letters and other devices' exchanges untouched; `ended` on the window's last wrong try (the
   * caller rotates, `failed`).
   */
  windowFailed(peerId: string, now: Date): 'none' | 'open' | 'ended' {
    const window = this.liveWindow(now);
    if (!window) return 'none';
    window.wrong++;
    window.wrongBy.set(peerId, (window.wrongBy.get(peerId) ?? 0) + 1);
    if (window.wrong < CLAIM_WINDOW_WRONG) return 'open';
    this.window = null;
    return 'ended';
  }

  /**
   * A device begins an exchange with the letters of `window`: counted on the window itself, up to `limit` each; false
   * when it used them. Whatever it began before these letters doesn't count, and nothing begun with them is missed.
   */
  windowBegin(window: ClaimWindow, peerId: string, limit: number): boolean {
    const begun = window.begunBy.get(peerId) ?? 0;
    if (begun >= limit) return false;
    window.begunBy.set(peerId, begun + 1);
    return true;
  }

  /** That exchange wasn't begun after all (it couldn't be recorded): the device keeps the try. */
  windowUnbegin(window: ClaimWindow, peerId: string): void {
    const begun = window.begunBy.get(peerId) ?? 0;
    if (begun > 1) window.begunBy.set(peerId, begun - 1);
    else window.begunBy.delete(peerId);
  }

  /** The window ends now, whatever is left of it: the caller changes the letters (`failed`). */
  endWindow(): void {
    this.window = null;
  }

  /** The wait the counters give now, for when the window is over (it isn't shown while one runs). */
  setRetryAt(retryAt: Date | null): void {
    if (this.status) this.status = { ...this.status, retryAt };
    this.write();
  }

  /** What the console shows now (CC-08). */
  consoleState(now: Date = this.services.clock()): ConsoleState | null {
    const state = this.claimConsoleState(now);
    if (!state) return state;
    const alert = this.ownAddress?.alert();
    const reach = this.reach?.();
    // Said on its own, not read from the address: a box whose only addresses can't be told to anyone names none.
    const ipv6Only = this.local && state.state !== 'claimed' && this.ipv6Only?.() === true;
    const fallbackUrl = state.state === 'claimable' ? this.fallbackUrl(state.url) : null;
    // Only the claim link at the box's own address opens a page that can be open: the screen beside it.
    const pageOpen =
      state.state === 'claimable' && state.url.startsWith('https://') && this.pageOpen?.() === true;
    return {
      ...state,
      ...(ipv6Only ? { ipv6Only: true as const } : {}),
      ...(fallbackUrl ? { fallbackUrl } : {}),
      ...(pageOpen ? { pageOpen: true as const } : {}),
      ...(alert ? { alert } : {}),
      ...(reach ? { reach } : {}),
      ...(this.locale ? { locale: this.locale } : {}),
    };
  }

  /**
   * The other way in that the claim screen names under the claim link at the box's own address, or null: only one the
   * console file can carry, and never the address already shown.
   */
  private fallbackUrl(url: string): string | null {
    if (!this.ownAddress?.local()) return null;
    const other = this.ownAddress.fallback();
    if (!other || other === url) return null;
    return ConsoleState.shape.fallbackUrl.safeParse(other).success ? other : null;
  }

  private claimConsoleState(now: Date): ConsoleState | null {
    const noWay = this.local && this.hasWay?.() === false;
    // No address to name: plain HTTP on no address at all, which every console reads as “nothing to open”.
    const url = noWay ? NO_ADDRESS_URL : this.url;
    if (!url) return null;
    const s = this.status;
    if (!s) return { v: 1, state: 'starting', url };
    if (s.claimed) {
      const signIn = this.signIn && new Date(this.signIn.expiresAt) > now ? this.signIn : undefined;
      return {
        v: 1,
        state: 'claimed',
        url,
        ...(this.burrows ? { burrows: this.burrows } : {}),
        ...(signIn ? { signIn } : {}),
      };
    }
    if (this.reachPending?.()) return { v: 1, state: 'starting', url };
    // Nobody can reach it: the letters would have nowhere to go.
    if (noWay) return { v: 1, state: 'waiting', url };
    const window = this.liveWindow(now);
    // The person at the box can ask for new letters wherever the box shows letters of its own.
    const ask = this.local && this.letters ? { newLetters: true as const } : {};
    if (window && this.letters)
      return {
        v: 1,
        state: 'claimable',
        url,
        code: this.letters,
        lettersUntil: window.until.toISOString(),
        ...ask,
      };
    if (s.retryAt && s.retryAt > now)
      return { v: 1, state: 'backoff', url, retryAt: s.retryAt.toISOString(), ...ask };
    const lease = this.liveLease(now);
    if (this.local && this.letters) return { v: 1, state: 'claimable', url, code: this.letters, ...ask };
    if (!s.deviceReady || !lease || !this.letters) return { v: 1, state: 'waiting', url };
    // Only the letters: the lookup number never reaches the console (CC-13).
    return { v: 1, state: 'claimable', url, code: this.letters };
  }

  /** Writes the console file when its content changed, and schedules the next change (backoff end, lease end). */
  private write(): void {
    if (this.closed) return;
    this.schedule();
    if (!this.file && (!this.local || this.services.config.NODE_ENV !== 'development')) return;
    const state = this.consoleState();
    if (!state || !consoleStateValid(state)) return;
    this.showInDevelopment(state);
    if (!this.file) return;
    const text = `${JSON.stringify(state)}\n`;
    if (text === this.lastWritten) return;
    try {
      writeConsoleFile(this.file, text, this.services.config.WHOMBAT_CONSOLE_GROUP);
      this.lastWritten = text;
    } catch (err) {
      // Only the error code: the message could name the temp file, never the code, but stay terse.
      this.services.log.warn(
        { code: (err as NodeJS.ErrnoException)?.code ?? 'unknown' },
        'console: the claim console file could not be written',
      );
    }
  }

  private shownCode: string | undefined;

  /**
   * `pnpm dev` as a community box (HE-S236): no screen, so the letters go to the log when they change — development
   * only; a box never logs them (CC-01).
   */
  private showInDevelopment(state: ConsoleState): void {
    if (!this.local || this.services.config.NODE_ENV !== 'development' || state.code === this.shownCode)
      return;
    this.shownCode = state.code;
    if (state.code)
      this.services.log.info({}, `Claim code (development only): ${state.code}, on ${state.url}`);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const now = this.services.clock().getTime();
    const s = this.status;
    if (!s) return;
    // Claimed: only a sign-in on the screen runs out; before, a backoff or the lease.
    const ends = s.claimed
      ? [this.signIn ? new Date(this.signIn.expiresAt).getTime() : undefined]
      : [s.retryAt?.getTime(), this.lease?.expiresAt.getTime(), this.window?.until.getTime()];
    const next = ends.filter((t): t is number => t !== undefined && t > now).sort((a, b) => a - b)[0];
    if (next === undefined) return;
    // Past the moment by a little, so the state has changed when it is computed; at most a day ahead.
    this.timer = setTimeout(() => this.write(), Math.min(next - now + 50, 86_400_000));
    this.timer.unref?.();
  }

  /**
   * The runtime stops: its letters die with it, so an unclaimed console goes back to `starting` (the next process
   * draws new letters) and a claimed one loses the sign-in it showed (BX-06).
   */
  close(): void {
    this.signIn = undefined;
    if (!this.status?.claimed) this.announceStarting();
    else this.write();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.closed = true;
    this.letters = null;
    this.window = null;
  }
}

/**
 * Replaces `file` atomically: a temp file in the same directory (mode 0640, the console group when this process may
 * set it), then `rename` over the old one, so `whombat-console` never reads half a file.
 */
export function writeConsoleFile(file: string, text: string, group: string): void {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, text, { mode: 0o640 });
    chmodSync(tmp, 0o640);
    const gid = groupId(group);
    const mine = [process.getgid?.(), ...(process.getgroups?.() ?? [])];
    if (gid !== null && mine.includes(gid)) chownSync(tmp, -1, gid);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
