/**
 * Whombat Link on the runtime side (docs/decisions/whombat-link.md; contracts 4.4 `local/link.ts`). Control is the
 * authority on the state (`off · starting · on · grace · ended`); the manager learns it from every ticket answer and
 * from `link.begin`, `link.status` and `link.leave`, and keeps it for the runtime. This side
 *
 * - reads the manager's `linkState` at start, every `LINK_STATE_POLL_S` (every `LINK_UNANSWERED_POLL_MS` until the
 *   manager first answers: it may still be starting with the box; every `LINK_STARTING_POLL_MS` while it starts: the
 *   screen shows the code someone is confirming right now; every `LINK_ENDED_POLL_MS` once it ended, to come back soon
 *   after the owner subscribes again) and after the owner's own change, and tells
 *   whoever follows it (the relay endpoint, remote help, phone push tokens, the Inbox, the screen);
 * - turns Link on for the owner (the runtime signs its part of the box's registration, the content key's
 *   `contentProof`; the manager adds its own and sends `link.begin`) and off (`link.leave`), each a signed appliance
 *   event, and records a change control made as `link.state_changed`.
 *
 * A manager without the Link routes (404, or a stand-in without them) is one from before Link: a box control
 * registered before Link then runs as it did, Link `on`; any other box has none. Nothing here reads the edition.
 */
import {
  type ConsoleLink,
  type ConsoleReach,
  type ConsoleTailscale,
  LINK_STATE_POLL_S,
  LOCAL_API_VERSION,
  type LocalLinkStatus,
} from '@whombat/control-contracts/local';
import type { LinkState } from '@whombat/protocol';
import type { LinkSummary, TailscaleStatus } from '@whombat/protocol/session';
import { externalEffect } from '../../commit/scope';
import type { Services } from '../../services';
import { appendApplianceEvent } from '../audit';
import { ManagerCallError, type ManagerPort } from '../ports';

/** What the runtime knows of Link now. `assumed`: the manager has no Link routes, so it follows the box's origin. */
export interface LinkView {
  /** Whether this box can have Link at all (an environment with a control). */
  enabled: boolean;
  link: LocalLinkStatus;
  assumed: boolean;
}

/** Link features run (relay tickets, the own address, remote help, shares, push tokens): starting, on, grace. */
export function linkActive(state: LinkState): boolean {
  return state === 'starting' || state === 'on' || state === 'grace';
}

export interface LinkServiceOptions {
  services: Services;
  manager: ManagerPort;
  /**
   * Whether control registered this box before Link (its `device.json` names an appliance route other than `local`):
   * with a manager from before Link, such a box keeps today's Link features (`on`).
   */
  registeredAtControl: boolean;
  /** The content key's signature of the box's registration (`contentProof`); null where the runtime can't sign one. */
  contentProof?: (() => Promise<string | null>) | undefined;
  /** The box's name for the confirm page. */
  name?: (() => Promise<string | null>) | undefined;
  /** Tests: no timers. */
  timers?: boolean;
}

export type LinkListener = (after: LinkView, before: LinkView) => void;

/**
 * How often the manager's state is read while Link starts: the person confirms the code on the account site and then
 * watches the box's screen, so the screen (and the label's certificate after it) follows within a second or two of the
 * manager hearing it, not at the next 5-minute read. A read is a local socket and answers from the manager's memory.
 */
export const LINK_STARTING_POLL_MS = 1_000;

/**
 * How often until the manager first answers: at the box's start the runtime may be up before the manager, and the screen
 * waits for the answer (Link's code), so a failed first read isn't left until the next 5-minute one.
 */
export const LINK_UNANSWERED_POLL_MS = 3_000;

/**
 * How often while Link ended: the owner may subscribe again on the account site at any time, and the manager hears it at
 * its next look at control; the box then needs the relay back for its address.
 */
export const LINK_ENDED_POLL_MS = 60_000;

/** Why turning Link on or off didn't happen, as the session op says it (`LINK_ERROR_CODES`). */
export class LinkRefusal extends Error {
  constructor(
    readonly code:
      | 'whombat_link_unavailable'
      | 'whombat_link_busy'
      | 'whombat_link_rate_limited'
      | 'control_unreachable',
    message: string,
  ) {
    super(message);
    this.name = 'LinkRefusal';
  }
}

export const LINK_REFUSAL_WORDS = {
  unavailable: 'This Whombat can’t use Whombat Link.',
  busy: 'Whombat Link is still changing. Try again in a moment.',
  exists: 'Whombat Link already knows this Whombat under another account. Ask Whombat support for help.',
  rateLimited: 'Too many tries. Wait a few minutes and try again.',
  unreachable: 'Whombat Link didn’t answer. Try again in a moment.',
  noProof: 'This Whombat can’t sign its part of Whombat Link yet. It needs an update first.',
} as const;

export class LinkService {
  #view: LinkView;
  #listeners = new Set<LinkListener>();
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #reading: Promise<LinkView> | null = null;
  /** The owner's own change in flight: its event says who, so the poll doesn't record it as control's. */
  #ownChange = false;
  /** The manager has answered once (or has no Link routes): until then the view is a guess and reads come fast. */
  #answered = false;
  /** The box's name as last given to the manager while Link ran (`tellName`); null before. */
  #nameTold: string | null = null;
  /** The name being given now: one at a time, in order. */
  #telling: Promise<void> = Promise.resolve();

  constructor(private readonly options: LinkServiceOptions) {
    this.#view = this.assumedView();
  }

  private get services() {
    return this.options.services;
  }

  /** What a box without the manager's Link routes has: today's features if control registered it, else none. */
  private assumedView(): LinkView {
    const on = this.options.registeredAtControl;
    return {
      enabled: on,
      link: { state: on ? 'on' : 'off', since: this.services.clock().toISOString() },
      assumed: true,
    };
  }

  async start(): Promise<void> {
    await this.refresh();
    if (this.options.timers === false) return;
    this.#stopped = false;
    this.schedule();
  }

  /**
   * The next read: every few seconds until the manager first answers, soon while Link starts, every minute once it
   * ended, else every `LINK_STATE_POLL_S`.
   */
  private schedule(): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    const ms = !this.#answered
      ? LINK_UNANSWERED_POLL_MS
      : this.state === 'starting'
        ? LINK_STARTING_POLL_MS
        : this.state === 'ended'
          ? LINK_ENDED_POLL_MS
          : LINK_STATE_POLL_S * 1000;
    this.#timer = setTimeout(() => {
      void this.refresh()
        .catch(() => {})
        .finally(() => this.schedule());
    }, ms);
    this.#timer.unref?.();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  view(): LinkView {
    return this.#view;
  }

  /**
   * Whether the manager has said what Link is on this box (or that it has no Link routes). Before, the view is only
   * what the box's origin suggests: the screen says Whombat is starting rather than “no secure address”.
   */
  get answered(): boolean {
    return this.#answered;
  }

  get state(): LinkState {
    return this.#view.enabled ? this.#view.link.state : 'off';
  }

  /** Link features may run: starting, on or grace. */
  active(): boolean {
    return this.#view.enabled && linkActive(this.#view.link.state);
  }

  /** Control knows the box (any state but off): claim and revocation reports, push.send, forgetting a token. */
  known(): boolean {
    return this.#view.enabled && this.#view.link.state !== 'off';
  }

  onChange(listener: LinkListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Reads the manager's state now (one read at a time); keeps the last one when the manager doesn't answer. */
  refresh(): Promise<LinkView> {
    this.#reading ??= this.read().finally(() => {
      this.#reading = null;
    });
    return this.#reading;
  }

  private async read(): Promise<LinkView> {
    const read = this.options.manager.linkState?.bind(this.options.manager);
    if (!read) return this.answer(this.assumedView());
    try {
      const answer = await read();
      return this.answer({ enabled: answer.enabled, link: answer.link, assumed: false });
    } catch (err) {
      if (err instanceof ManagerCallError && err.status === 404) return this.answer(this.assumedView());
      this.services.log.debug({ err: String(err) }, 'link: the manager’s state wasn’t read');
      return this.#view;
    }
  }

  /** The manager's answer: the first one also tells the listeners when nothing changed, so the screen moves on. */
  private async answer(next: LinkView): Promise<LinkView> {
    const first = !this.#answered;
    this.#answered = true;
    const view = await this.adopt(next, false, first);
    // Link runs and control may not have the box's name yet (it linked before it had one): give it now.
    if (this.runs()) void this.tellName();
    return view;
  }

  /** Link is on or in grace, as the manager said it (not assumed). */
  private runs(): boolean {
    const v = this.#view;
    return v.enabled && !v.assumed && (v.link.state === 'on' || v.link.state === 'grace');
  }

  /**
   * Gives control the box's name while Link runs, so the account site shows it rather than “Your Whombat”: an Easy box
   * links at its first start, before its setup asks for a name. Through the manager's `link.on`, which sends a name
   * control wasn't given yet only after control says Link still runs (the manager's `Keeper.On`). Called when the box
   * is named or renamed and after each read of the manager's state; a name already given here costs nothing, and no
   * owner's change is recorded.
   */
  tellName(): Promise<void> {
    const run = async () => {
      const on = this.options.manager.linkOn?.bind(this.options.manager);
      if (!on || !this.runs()) return;
      const name = (await this.options.name?.().catch(() => null))?.slice(0, 64) ?? null;
      if (!name || name === this.#nameTold) return;
      const contentProof = await this.options.contentProof?.().catch(() => null);
      if (!contentProof) return;
      try {
        const answer = await on({ v: LOCAL_API_VERSION, contentProof, name });
        this.#nameTold = name;
        // Control's state as the manager read it: a Link that ended meanwhile is control's change.
        await this.adopt({ enabled: answer.enabled, link: answer.link, assumed: false }, false);
      } catch (err) {
        this.services.log.info({ err: String(err).slice(0, 200) }, 'link: the box’s name wasn’t given yet');
      }
    };
    this.#telling = this.#telling.then(run, run);
    return this.#telling;
  }

  /**
   * Takes a new view; tells the listeners when the state or what they show changed (or `announce`: the first answer).
   */
  private async adopt(next: LinkView, own: boolean, announce = false): Promise<LinkView> {
    const before = this.#view;
    // The assumed view of a box without Link routes keeps its first `since`.
    const kept = next.assumed && before.assumed && next.link.state === before.link.state ? before : next;
    this.#view = kept;
    if (!sameView(before, kept) || announce) {
      const stateMoved = (before.enabled ? before.link.state : 'off') !== this.state;
      if (stateMoved && !own && !next.assumed && !before.assumed && !this.#ownChange)
        await this.record('link.state_changed', null, null).catch((err) =>
          this.services.log.warn({ err: String(err) }, 'link: the change wasn’t recorded'),
        );
      if (stateMoved) this.services.log.info({ state: this.state }, 'link: state');
      for (const listener of this.#listeners) {
        try {
          listener(kept, before);
        } catch (err) {
          this.services.log.warn({ err: String(err) }, 'link: a listener failed');
        }
      }
      // The next read follows the state the box is in now. The wait planned for the state before (five minutes while
      // Link was off or on) would leave a box whose owner just turned Link on showing its code long after the code
      // was confirmed.
      if (stateMoved && this.#timer) this.schedule();
    }
    return kept;
  }

  /** The owner turns Link on: the manager asks control for a code (`starting`) or answers the state control has. */
  async turnOn(by: { accountId: string; endpointId: string | null }): Promise<LinkView> {
    const on = this.options.manager.linkOn?.bind(this.options.manager);
    if (!on || !this.#view.enabled)
      throw new LinkRefusal('whombat_link_unavailable', LINK_REFUSAL_WORDS.unavailable);
    const contentProof = await this.options.contentProof?.().catch(() => null);
    if (!contentProof) throw new LinkRefusal('whombat_link_unavailable', LINK_REFUSAL_WORDS.noProof);
    const name = (await this.options.name?.().catch(() => null)) ?? null;
    return this.change(by, 'link.on', () =>
      on({ v: LOCAL_API_VERSION, contentProof, ...(name ? { name: name.slice(0, 64) } : {}) }),
    );
  }

  /** The owner turns Link off: the box stops using it at once, the manager tells control (`link.leave`). */
  async turnOff(by: { accountId: string; endpointId: string | null }): Promise<LinkView> {
    const off = this.options.manager.linkOff?.bind(this.options.manager);
    if (!off || !this.#view.enabled)
      throw new LinkRefusal('whombat_link_unavailable', LINK_REFUSAL_WORDS.unavailable);
    return this.change(by, 'link.off', () => off({ v: LOCAL_API_VERSION }));
  }

  private async change(
    by: { accountId: string; endpointId: string | null },
    type: 'link.on' | 'link.off',
    run: () => Promise<{ enabled: boolean; link: LocalLinkStatus }>,
  ): Promise<LinkView> {
    this.#ownChange = true;
    try {
      let answer: { enabled: boolean; link: LocalLinkStatus };
      try {
        // The manager acts outside the database: once it was asked, the owner's change is recorded even when the
        // request is cancelled meanwhile. Turning Link off closes the relay, and with it the session of a device that
        // came in through it, before the record is written.
        // A manager that answered with a refusal didn't change it; the next read of its state shows if it did.
        answer = await externalEffect(`manager.${type}`, run, {
          refused: (err) => err instanceof ManagerCallError && err.status > 0,
        });
      } catch (err) {
        throw refusalOf(err);
      }
      const view = await this.adopt({ enabled: answer.enabled, link: answer.link, assumed: false }, true);
      await this.record(type, by.accountId, by.endpointId).catch((err) =>
        this.services.log.error(
          { err: String(err).slice(0, 200), type },
          'link: the owner’s change wasn’t recorded in the audit log',
        ),
      );
      return view;
    } finally {
      this.#ownChange = false;
    }
  }

  private async record(
    type: 'link.on' | 'link.off' | 'link.state_changed',
    accountId: string | null,
    endpointId: string | null,
  ): Promise<void> {
    const state = this.state;
    await this.services.pipeline.transactAccount(async (tx) => {
      await appendApplianceEvent(tx, this.services.custody, {
        type,
        actorAccountId: accountId,
        endpointId,
        payload: accountId ? { byAccountId: accountId, state } : { state },
        at: this.services.clock(),
      });
    });
  }

  /** Link as the person's devices see it (`reach.get`); null on a box that can't have Link. */
  summary(): LinkSummary | null {
    if (!this.#view.enabled) return null;
    return linkSummary(this.#view.link);
  }
}

const links = new WeakMap<object, LinkService>();

/** The runtime's Link for these services (policies and notices read it); none outside a managed runtime. */
export function setLinkFor(services: object, link: LinkService): void {
  links.set(services, link);
}

export function linkOf(services: object): LinkService | null {
  return links.get(services) ?? null;
}

/** The manager's status as the session says it (the label stays the own address's). */
export function linkSummary(link: LocalLinkStatus): LinkSummary {
  return {
    state: link.state,
    since: link.since,
    ...(link.pending ? { pending: link.pending } : {}),
    ...(link.waitingForAddress ? { waitingForAddress: true } : {}),
    ...(link.graceEndsAt && link.state === 'grace' ? { graceEndsAt: link.graceEndsAt } : {}),
    ...(link.trialEndsAt ? { trialEndsAt: link.trialEndsAt } : {}),
    ...(link.email ? { email: link.email } : {}),
  };
}

function sameView(a: LinkView, b: LinkView): boolean {
  if (a.enabled !== b.enabled || a.assumed !== b.assumed) return false;
  const x = a.link;
  const y = b.link;
  return (
    x.state === y.state &&
    x.pending?.code === y.pending?.code &&
    x.pending?.expiresAt === y.pending?.expiresAt &&
    Boolean(x.waitingForAddress) === Boolean(y.waitingForAddress) &&
    x.graceEndsAt === y.graceEndsAt &&
    x.trialEndsAt === y.trialEndsAt &&
    x.label === y.label &&
    x.email === y.email
  );
}

/** The manager's refusal of an owner's change as the session's. */
export function refusalOf(err: unknown): LinkRefusal {
  if (err instanceof LinkRefusal) return err;
  if (err instanceof ManagerCallError) {
    if (err.status === 404 || err.code === 'link.unavailable')
      return new LinkRefusal('whombat_link_unavailable', LINK_REFUSAL_WORDS.unavailable);
    if (err.code === 'link.busy') return new LinkRefusal('whombat_link_busy', LINK_REFUSAL_WORDS.busy);
    if (err.code === 'link.device_exists')
      return new LinkRefusal('whombat_link_unavailable', LINK_REFUSAL_WORDS.exists);
    if (err.code === 'link.rate_limited' || err.status === 429)
      return new LinkRefusal('whombat_link_rate_limited', LINK_REFUSAL_WORDS.rateLimited);
  }
  return new LinkRefusal('control_unreachable', LINK_REFUSAL_WORDS.unreachable);
}

/**
 * How the box is reached, for its screen (`ConsoleState.reach`, 4.4; whombat-link.md LNK-13, LNK-14, LNK-06a): Link's
 * state and, while it starts, the code and page to type it at; Tailscale's sign-in link, whether its tailnet has HTTPS
 * certificates off, and the box's name. Undefined when there's nothing to show.
 */
export function consoleReach(view: LinkView, tailscale: TailscaleStatus | null): ConsoleReach | undefined {
  const l = view.link;
  const link: ConsoleLink | undefined =
    view.enabled && !view.assumed
      ? {
          state: l.state,
          ...(l.state === 'starting' && l.pending
            ? { code: l.pending.code, url: l.pending.url, expiresAt: l.pending.expiresAt }
            : {}),
          ...(l.waitingForAddress ? { waitingForAddress: true } : {}),
          ...(l.state === 'grace' && l.graceEndsAt ? { graceEndsAt: l.graceEndsAt } : {}),
        }
      : undefined;
  const ts: ConsoleTailscale | undefined =
    tailscale && tailscale.state !== 'off'
      ? {
          ...(tailscale.state === 'needs_sign_in' && tailscale.loginUrl
            ? { loginUrl: tailscale.loginUrl }
            : {}),
          ...(tailscale.state === 'on' && !tailscale.https ? { needsHttps: true } : {}),
          ...(tailscale.state === 'on' && tailscale.name ? { name: tailscale.name } : {}),
        }
      : undefined;
  const tsShown = ts && Object.keys(ts).length > 0 ? ts : undefined;
  if (!link && !tsShown) return undefined;
  return { ...(link ? { link } : {}), ...(tsShown ? { tailscale: tsShown } : {}) };
}
