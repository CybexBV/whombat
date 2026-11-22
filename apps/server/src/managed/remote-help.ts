/**
 * Remote help in the runtime (docs/decisions/remote-help.md RH-01…RH-13; remote-help-server.md RH-S01…): the person
 * lets Whombat support into this Whombat for a while. The support service (`remote-help-client.ts`) is the authority —
 * it keeps the grant, judges Forever and the help code, lets support in and records what they do; the runtime is how
 * the person reaches it and hears about it:
 *
 * - **Ops** (`remoteHelp.*`, the person's devices only): the state; a passkey step-up bound to the exact choice
 *   (`confirmBegin` keeps a nonce with the level and duration in the session, single use, 300 s; `start` verifies the
 *   assertion against `passkeyRemoteHelpChallenge({nonce, endpoint: the session's PeerId, level, duration})` with a
 *   live passkey of the caller's own, RH-S04); without a passkey the person starts without one; Stop never asks; the
 *   visits; a visit's command line, cleaned (`remote-help-transcript.ts`).
 * - **The follower** long-polls the service's events (`GET /v1/events`) and keeps the state it shows the person and the
 *   desk fresh. Each event is recorded once: its signed appliance event (`remote_help.on`, `.off`, `.visit`) and the
 *   cursor move in one transaction (`appliance_state.remote_help_seq`, migration 0134, RH-S05). Then, at most once and
 *   only for recent events, the person hears (one-person.md OP-S78): of a grant they didn't make themselves, of a
 *   visit's start (a message from the agent; a `security` push without a Chat) and of five wrong help codes (RH-08).
 * - **The desk** (`deskView`, `stopAtDesk`): the line and its Stop, without unlocking (RH-04).
 */
import { randomBytes } from 'node:crypto';
import {
  type DeskRemoteHelp,
  type SupportEvent,
  type SupportState,
  supportEventValid,
} from '@whombat/control-contracts/local';
import {
  REMOTE_HELP_LIMITS,
  REMOTE_HELP_WORDS,
  type RemoteHelpDuration,
  type RemoteHelpLevel,
  remoteHelpTurnedOnText,
  remoteHelpVisitText,
  remoteHelpWho,
} from '@whombat/core';
import {
  type APP_ERROR_CODES,
  hostText,
  passkeyRemoteHelpChallengeBase64url,
  REMOTE_HELP_CONFIRM_TTL_S,
  REMOTE_HELP_STEPS_SHOWN,
  REMOTE_HELP_VISITS_MAX,
  type RemoteHelpConfirmBeginInput,
  type RemoteHelpConfirmBeginOutput,
  RemoteHelpOffAuditPayload,
  RemoteHelpOnAuditPayload,
  type RemoteHelpStartInput,
  type RemoteHelpState,
  type RemoteHelpTranscriptInput,
  type RemoteHelpVisit,
  RemoteHelpVisitAuditPayload,
  type RemoteHelpVisitsInput,
  remoteHelpTranscriptName,
  type WebAuthnAuthenticationResponse,
} from '@whombat/protocol/session';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { externalEffect } from '../commit/scope';
import type { Config } from '../config';
import { accounts, applianceState, burrows } from '../db/schema/index';
import { type TellOptions, tellPerson } from '../desk/tell';
import { thePersonAccountId } from '../domain/the-person';
import { recentPlaces } from '../guides/place';
import { ApiError, notFound } from '../lib/errors';
import type { Services } from '../services';
import { appendApplianceEvent } from './audit';
import type { SessionScope } from './claim';
import { passkeysWorkHere } from './direct/transport';
import { FakeSupport } from './fake-support';
import type { PasskeyService } from './passkeys';
import { COMMUNITY_TEXT, passkeysUnavailableHere } from './policy';
import type { ControlPush } from './push';
import {
  SupportCallError,
  type SupportPort,
  SupportSocketClient,
  type SupportVisit,
  supportRefused,
} from './remote-help-client';
import { cleanTranscriptStream } from './remote-help-transcript';
import { remoteHelpVisitNotice, SECURITY_NOTICES, type SecurityNotice } from './security-push';
import { SessionOpError } from './session-error';
import { requireEnrolled, type SessionPrincipal, type TrustService } from './trust';

type ConfirmBeginInput = z.infer<typeof RemoteHelpConfirmBeginInput>;
type StartInput = z.infer<typeof RemoteHelpStartInput>;
type VisitsInput = z.infer<typeof RemoteHelpVisitsInput>;
type TranscriptInput = z.infer<typeof RemoteHelpTranscriptInput>;

/** A live `remoteHelp.confirmBegin` of one session: what `remoteHelp.start` binds the passkey's challenge to. */
export interface RemoteHelpBegin {
  nonce: string;
  accountId: string;
  endpointId: string;
  level: RemoteHelpLevel;
  duration: RemoteHelpDuration;
  expiresAt: Date;
}

/** A begin lives this long in the session (`REMOTE_HELP_CONFIRM_TTL_S`, as a passkey registration's, PK-06). */
export const REMOTE_HELP_BEGIN_TTL_MS = REMOTE_HELP_CONFIRM_TTL_S * 1000;
/** The long poll's wait (the contract's most). */
export const REMOTE_HELP_WAIT_S = 25;
/** Events older than this when they are read are recorded but nobody is told any more (RH-S06). */
export const REMOTE_HELP_STALE_MS = 3600_000;
/**
 * A visit by the one who visited a while ago isn't announced in the Chat again for this long: support works in
 * many short visits, and a line for each buried the person's Chat.
 */
export const REMOTE_HELP_VISIT_QUIET_MS = 12 * 3600_000;

/* Words and refusals --------------------------------------------------------------------------------------------- */

/** The refusals (`details.code`, `APP_ERROR_CODES`). */
export type RemoteHelpErrorCode = Extract<
  keyof typeof APP_ERROR_CODES,
  | 'remote_help_unavailable'
  | 'forever_not_allowed'
  | 'passkey_required'
  | 'passkey_failed'
  | 'remote_help_busy'
>;

const REFUSALS: Readonly<
  Record<RemoteHelpErrorCode, { code: 'not_allowed' | 'forbidden' | 'unavailable'; message: string }>
> = {
  remote_help_unavailable: {
    code: 'not_allowed',
    message: REMOTE_HELP_WORDS.refusals.remote_help_unavailable,
  },
  forever_not_allowed: { code: 'not_allowed', message: REMOTE_HELP_WORDS.refusals.forever_not_allowed },
  // The client goes on to the passkey (its words are the card's hint); these are a fallback.
  passkey_required: { code: 'forbidden', message: REMOTE_HELP_WORDS.passkeyHint },
  passkey_failed: { code: 'forbidden', message: REMOTE_HELP_WORDS.refusals.passkey_failed },
  remote_help_busy: { code: 'unavailable', message: REMOTE_HELP_WORDS.refusals.remote_help_busy },
};

/** A refusal as the session answers it: the generic code, remote help's own in `details.code`. */
export function remoteHelpRefusal(code: RemoteHelpErrorCode): SessionOpError {
  const r = REFUSALS[code];
  return new SessionOpError(r.code, r.message, { code });
}

/** The service's refusal as the session sees it: Forever and availability are its to judge; anything else is busy. */
function refusalOf(err: unknown): SessionOpError {
  if (err instanceof SessionOpError) return err;
  if (err instanceof SupportCallError) {
    if (err.code === 'forever_not_allowed') return remoteHelpRefusal('forever_not_allowed');
    if (err.code === 'unavailable' && err.status !== 0) return remoteHelpRefusal('remote_help_unavailable');
  }
  return remoteHelpRefusal('remote_help_busy');
}

/** A person's name as the grant carries it (RH-S03): their name, else their email's local part, as display text. */
export function grantorName(account: { name: string | null; email: string }): string {
  return (
    hostText(account.name ?? '', 120) ||
    hostText(account.email.split('@')[0] ?? '', 120) ||
    REMOTE_HELP_WORDS.someone
  );
}

/** The service's state as the person sees it (RH-S02): no wrong-code count, the help code only when it is needed. */
export function remoteHelpStateOf(state: SupportState): RemoteHelpState {
  const grant = state.grant;
  return {
    available: state.available,
    foreverAllowed: state.foreverAllowed,
    helpCodeRequired: state.helpCodeRequired,
    grant: grant
      ? {
          level: grant.level,
          since: grant.since,
          until: grant.until,
          grantedBy: { accountId: grant.grantedBy.accountId, name: grant.grantedBy.name },
          helpCode: state.helpCodeRequired ? grant.helpCode : null,
        }
      : null,
    connected: state.connected
      .slice(0, REMOTE_HELP_LIMITS.connectedMax)
      .map((c) => ({ visitId: c.visitId, who: remoteHelpWho(c.who), since: c.since })),
  };
}

/** A runtime without a support service: nothing to turn on. */
export const REMOTE_HELP_UNAVAILABLE: RemoteHelpState = {
  available: false,
  foreverAllowed: false,
  helpCodeRequired: false,
  grant: null,
  connected: [],
};

export function remoteHelpVisitOf(visit: SupportVisit): RemoteHelpVisit {
  return { ...visit, who: remoteHelpWho(visit.who), steps: visit.steps.slice(-REMOTE_HELP_STEPS_SHOWN) };
}

/** The desk's line (`DeskState.remoteHelp`): absent while off; the newest person connected. */
export function deskRemoteHelpOf(state: SupportState | null, now: number): DeskRemoteHelp | undefined {
  const grant = state?.grant;
  if (!state || !grant) return undefined;
  if (grant.until && Date.parse(grant.until) <= now) return undefined;
  const newest = [...state.connected].sort((a, b) => Date.parse(b.since) - Date.parse(a.since))[0];
  return { level: grant.level, until: grant.until, connected: newest ? remoteHelpWho(newest.who) : null };
}

/* What each event leaves behind ------------------------------------------------------------------------------------- */

/** One signed appliance event (RH-08). */
export type RemoteHelpRecord = {
  /** The person's account, when they did it (checked against the accounts before it is written). */
  accountId: string | null;
  at: Date;
} & (
  | { type: 'remote_help.on'; payload: z.infer<typeof RemoteHelpOnAuditPayload> }
  | { type: 'remote_help.off'; payload: z.infer<typeof RemoteHelpOffAuditPayload> }
  | { type: 'remote_help.visit'; payload: z.infer<typeof RemoteHelpVisitAuditPayload> }
);

/**
 * The appliance event an event is recorded as (RH-08), or null (a visit's start is recorded with its end; an event
 * without what its record needs). A visit's end without its start or level takes them from `visit` (the service's
 * list), else its own time.
 */
export function recordOf(
  event: SupportEvent,
  visit?: Pick<SupportVisit, 'startedAt' | 'level'>,
): RemoteHelpRecord | null {
  const at = new Date(event.at);
  switch (event.kind) {
    case 'grant':
      if (!event.level || !event.duration) return null;
      return {
        type: 'remote_help.on',
        accountId: event.by?.accountId ?? null,
        payload: { level: event.level, duration: event.duration },
        at,
      };
    case 'stop': {
      const reason = event.reason === 'desk' ? 'desk' : 'owner';
      return {
        type: 'remote_help.off',
        accountId: reason === 'owner' ? (event.by?.accountId ?? null) : null,
        payload: { reason },
        at,
      };
    }
    case 'expired':
      return { type: 'remote_help.off', accountId: null, payload: { reason: 'expired' }, at };
    case 'locked_out':
      return { type: 'remote_help.off', accountId: null, payload: { reason: 'wrong_codes' }, at };
    case 'visit_end': {
      const level = event.level ?? visit?.level;
      if (!level) return null;
      return {
        type: 'remote_help.visit',
        accountId: null,
        payload: {
          ...(event.visitId ? { visitId: event.visitId } : {}),
          who: remoteHelpWho(event.who ?? ''),
          level,
          startedAt: event.startedAt ?? visit?.startedAt ?? event.at,
          endedAt: event.at,
          steps: event.steps ?? 0,
        },
        at,
      };
    }
    case 'visit_start':
      return null;
  }
}

/** A record whose payload is the contract's (`RemoteHelp*AuditPayload`). */
function recordValid(record: RemoteHelpRecord): boolean {
  const schema =
    record.type === 'remote_help.on'
      ? RemoteHelpOnAuditPayload
      : record.type === 'remote_help.off'
        ? RemoteHelpOffAuditPayload
        : RemoteHelpVisitAuditPayload;
  return schema.safeParse(record.payload).success;
}

/** Who hears of an event (RH-08): the person unless they are `except`, a `security` push when `push` names one, and the words. */
export interface RemoteHelpNotice {
  except: string | null;
  /**
   * The `security` push for someone without a Chat to say it in (`what` names the event); the Chat line is the notice
   * otherwise, and it buzzes the phone as any message from the assistant does (push-words.md PW-01).
   */
  push: { what: string; notice: SecurityNotice } | null;
  text: string;
  /** The words aren't said in their Chat again within this long. */
  unlessSaidWithinMs: number | null;
}

export function noticeOf(event: SupportEvent): RemoteHelpNotice | null {
  switch (event.kind) {
    case 'grant':
      if (!event.level || !event.duration) return null;
      return {
        except: event.by?.accountId ?? null,
        push: null,
        text: remoteHelpTurnedOnText(event.level, event.duration),
        unlessSaidWithinMs: null,
      };
    case 'visit_start': {
      const text = remoteHelpVisitText(remoteHelpWho(event.who ?? ''));
      return {
        except: null,
        push: {
          what: `remote-help-visit:${event.visitId ?? event.seq}`,
          notice: remoteHelpVisitNotice(text),
        },
        text,
        unlessSaidWithinMs: REMOTE_HELP_VISIT_QUIET_MS,
      };
    }
    case 'locked_out':
      return {
        except: null,
        push: { what: `remote-help-locked-out:${event.seq}`, notice: SECURITY_NOTICES.remoteHelpLockedOut },
        text: REMOTE_HELP_WORDS.messages.lockedOut,
        unlessSaidWithinMs: null,
      };
    default:
      return null;
  }
}

/** The person's account, unless they are `except` (they did it themselves; one-person.md OP-S78). */
async function personAccounts(services: Services, except: string | null): Promise<string[]> {
  const out = new Set<string>();
  for (const b of await services.db.select({ id: burrows.id }).from(burrows)) {
    const account = await thePersonAccountId(services.db, b.id);
    if (account && account !== except) out.add(account);
  }
  return [...out];
}

/* The follower's cursor --------------------------------------------------------------------------------------------- */

/** The last event recorded, and the service's host key then (a new key means its events started again). */
export interface RemoteHelpCursor {
  seq: number;
  hostKey: string | null;
}

export interface RemoteHelpCursorStore {
  load(): Promise<RemoteHelpCursor>;
  /** Starts again from the beginning of a new event log. */
  reset(hostKey: string | null): Promise<void>;
  /** Records the event (when it has a record) and moves past `seq`, together; false when it was past already. */
  advance(seq: number, hostKey: string | null, record: RemoteHelpRecord | null): Promise<boolean>;
}

const STATE_ID = 1;

/** The cursor in `appliance_state` (migration 0134), moved in the transaction that signs the event (RH-S05). */
export class DbRemoteHelpCursorStore implements RemoteHelpCursorStore {
  constructor(private readonly services: Services) {}

  async load(): Promise<RemoteHelpCursor> {
    const [row] = await this.services.db
      .select({ seq: applianceState.remoteHelpSeq, hostKey: applianceState.remoteHelpHostKey })
      .from(applianceState)
      .where(eq(applianceState.id, STATE_ID));
    return { seq: row?.seq ?? 0, hostKey: row?.hostKey ?? null };
  }

  async reset(hostKey: string | null): Promise<void> {
    await this.services.pipeline.transactAccount(async (tx) => {
      await tx.insert(applianceState).values({ id: STATE_ID }).onConflictDoNothing();
      await tx
        .update(applianceState)
        .set({ remoteHelpSeq: 0, remoteHelpHostKey: hostKey })
        .where(eq(applianceState.id, STATE_ID));
    });
  }

  advance(seq: number, hostKey: string | null, record: RemoteHelpRecord | null): Promise<boolean> {
    return this.services.pipeline.transactAccount(async (tx) => {
      await tx.insert(applianceState).values({ id: STATE_ID }).onConflictDoNothing();
      const [row] = await tx
        .select({ seq: applianceState.remoteHelpSeq })
        .from(applianceState)
        .where(eq(applianceState.id, STATE_ID))
        .for('update');
      if ((row?.seq ?? 0) >= seq) return false;
      if (record) {
        const actor = record.accountId
          ? (await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, record.accountId)))[0]
          : undefined;
        await appendApplianceEvent(tx, this.services.custody, {
          type: record.type,
          actorAccountId: actor?.id ?? null,
          endpointId: null,
          payload: record.payload,
          at: record.at,
        });
      }
      await tx
        .update(applianceState)
        .set({ remoteHelpSeq: seq, remoteHelpHostKey: hostKey })
        .where(eq(applianceState.id, STATE_ID));
      return true;
    });
  }
}

/* The service ------------------------------------------------------------------------------------------------------ */

type Tell = (
  services: Services,
  burrowId: string,
  personId: string,
  text: string,
  options?: TellOptions,
) => Promise<boolean>;

export interface RemoteHelpOptions {
  /** Where the follower keeps its place (tests: in memory). */
  store?: RemoteHelpCursorStore;
  /** The step-up (the trust service's passkeys); none: nobody can confirm with a passkey. */
  passkeys?: Pick<PasskeyService, 'hasPasskey' | 'stepUpOptions' | 'confirm'> | null;
  /** Security pushes to the person's devices. */
  push?: Pick<ControlPush, 'security'> | null;
  /** How the agent tells the person (`desk/tell.ts`). */
  tell?: Tell;
  /** The person's account unless `except` (tests: theirs). */
  personAccounts?: (except: string | null) => Promise<string[]>;
  /** Where an account's assistant speaks up for it (`recentPlaces`: the burrow it was last active in). */
  placeOf?: (accountId: string) => Promise<{ burrowId: string; personId: string } | null>;
  /** Runs `fn` in `ms`; returns what cancels it (the follower's pauses; tests: theirs). */
  after?: (ms: number, fn: () => void) => () => void;
  /** The long poll's wait (tests: 0). */
  waitS?: number;
}

const timer = (ms: number, fn: () => void): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

export class RemoteHelpService {
  readonly #store: RemoteHelpCursorStore;
  readonly #tell: Tell;
  readonly #after: (ms: number, fn: () => void) => () => void;
  readonly #waitS: number;
  readonly #listeners = new Set<() => void>();
  readonly #abort = new AbortController();
  readonly #sleepers = new Set<() => void>();
  #state: SupportState | null = null;
  #answering = false;
  #cursor: RemoteHelpCursor | null = null;
  #loop: Promise<void> | null = null;
  #closed = false;
  #warnedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly services: Services,
    readonly port: SupportPort,
    private readonly options: RemoteHelpOptions = {},
  ) {
    this.#store = options.store ?? new DbRemoteHelpCursorStore(services);
    this.#tell = options.tell ?? tellPerson;
    this.#after = options.after ?? timer;
    this.#waitS = options.waitS ?? REMOTE_HELP_WAIT_S;
  }

  /** The service answered the last time it was asked (the `remote_help` feature is advertised only then, RH-S09). */
  get answering(): boolean {
    return this.#answering;
  }

  /** The state as last read. */
  peek(): SupportState | null {
    return this.#state;
  }

  /** Called when the state read changed (the desk's line). */
  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #accept(state: SupportState): SupportState {
    this.#answering = true;
    const before = this.#state;
    this.#state = state;
    if (JSON.stringify(before) !== JSON.stringify(state))
      for (const fn of [...this.#listeners])
        try {
          fn();
        } catch (err) {
          this.services.log.warn({ err: String(err) }, 'remote help: a listener failed');
        }
    return state;
  }

  #warn(err: unknown, what: string): void {
    const now = Date.now();
    if (now - this.#warnedAt < 60_000) return;
    this.#warnedAt = now;
    const call = err instanceof SupportCallError ? err : null;
    this.services.log.warn(
      { status: call?.status ?? null, code: call?.code ?? (err instanceof Error ? err.name : 'error') },
      `remote help: ${what}`,
    );
  }

  /** Reads the state now; null (and logged at most once a minute) when the service doesn't answer. */
  async refresh(): Promise<SupportState | null> {
    try {
      return this.#accept(await this.port.state());
    } catch (err) {
      this.#answering = false;
      this.#warn(err, 'the support service didn’t answer');
      return null;
    }
  }

  /* The follower (RH-S05, RH-S06) ------------------------------------------------------------------ */

  /** Follows the service's events until `close`. */
  follow(): void {
    if (this.#loop || this.#closed) return;
    this.#loop = this.#run();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#abort.abort();
    for (const wake of [...this.#sleepers]) wake();
    await this.#loop?.catch(() => {});
    this.#loop = null;
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        cancel();
        this.#sleepers.delete(wake);
        resolve();
      };
      const cancel = this.#after(ms, wake);
      this.#sleepers.add(wake);
      if (this.#closed) wake();
    });
  }

  async #run(): Promise<void> {
    let backoff = 1_000;
    while (!this.#closed) {
      const began = Date.now();
      try {
        const handled = await this.followOnce();
        backoff = 1_000;
        // A service that answers at once with nothing (no long poll): not more than once a second.
        if (!handled && Date.now() - began < 1_000 && !this.#closed) await this.#sleep(1_000);
      } catch (err) {
        if (this.#closed) break;
        this.#answering = false;
        this.#warn(err, 'following the support service failed; trying again');
        await this.#sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  /**
   * One long poll: the state, then the events after the cursor, each recorded once and told when recent. A new host key
   * or a log that went back (`next` below the cursor) starts from its beginning. Returns how many were handled; throws
   * when the service or the database didn't answer (the cursor stays, the event comes again).
   */
  async followOnce(waitS = this.#waitS): Promise<number> {
    const state = this.#accept(await this.port.state());
    let cursor = this.#cursor ?? (await this.#store.load());
    const hostKey = state.hostKey ?? cursor.hostKey;
    if (state.hostKey && cursor.hostKey && state.hostKey !== cursor.hostKey) {
      this.services.log.info('remote help: the support service is new; following its events from the start');
      await this.#store.reset(state.hostKey);
      cursor = { seq: 0, hostKey: state.hostKey };
    }
    this.#cursor = cursor;
    const answer = await this.port.events(cursor.seq, waitS, this.#abort.signal);
    if (answer.next < cursor.seq) {
      this.services.log.info(
        'remote help: the support service’s events started again; following from the start',
      );
      await this.#store.reset(hostKey);
      this.#cursor = { seq: 0, hostKey };
      return 0;
    }
    let handled = 0;
    for (const event of [...answer.events].sort((a, b) => a.seq - b.seq)) {
      if (this.#closed) break;
      if (event.seq <= (this.#cursor?.seq ?? 0)) continue;
      await this.#handle(event, hostKey);
      handled++;
    }
    if (handled) await this.refresh();
    return handled;
  }

  async #handle(event: SupportEvent, hostKey: string | null): Promise<void> {
    // An event outside the contract is passed over (logged): it can't stop the ones after it.
    const valid = supportEventValid(event);
    if (!valid)
      this.services.log.warn({ kind: event.kind, seq: event.seq }, 'remote help: an event isn’t valid');
    const visit =
      valid && event.kind === 'visit_end' && (!event.startedAt || !event.level)
        ? await this.#visit(event.visitId)
        : undefined;
    const candidate = valid ? recordOf(event, visit) : null;
    const record = candidate && recordValid(candidate) ? candidate : null;
    if (candidate && !record)
      this.services.log.warn({ kind: event.kind, seq: event.seq }, 'remote help: an event can’t be recorded');
    const advanced = await this.#store.advance(event.seq, hostKey, record);
    this.#cursor = { seq: event.seq, hostKey };
    if (!advanced || !valid) return;
    this.services.log.info({ kind: event.kind, seq: event.seq }, 'remote help: event recorded');
    const age = this.services.clock().getTime() - Date.parse(event.at);
    if (age > REMOTE_HELP_STALE_MS || this.services.maintenance.quarantined) return;
    await this.#notify(event).catch((err) =>
      this.services.log.warn(
        { err: String(err).slice(0, 200), kind: event.kind },
        'remote help: the person not told',
      ),
    );
  }

  /** A visit from the service's list (a visit's end without its start, RH-S05); undefined when it isn't there. */
  async #visit(visitId: string | undefined): Promise<SupportVisit | undefined> {
    if (!visitId) return undefined;
    try {
      return (await this.port.visits({ limit: 20 })).find((v) => v.id === visitId);
    } catch {
      return undefined;
    }
  }

  /**
   * The person hears of it (RH-08): the agent's message in their Chat, which buzzes their phone like any message; a
   * `security` push only for someone without a Chat to say it in. Support works in many short visits, and a push for
   * each said “Whombat needs you” all day (push-words.md PW-01).
   */
  async #notify(event: SupportEvent): Promise<void> {
    const notice = noticeOf(event);
    if (!notice) return;
    const ids = await (this.options.personAccounts ?? ((except) => personAccounts(this.services, except)))(
      notice.except,
    );
    if (!ids.length) return;
    const untold: string[] = [];
    for (const accountId of ids) {
      try {
        const place = this.options.placeOf
          ? await this.options.placeOf(accountId)
          : ((await recentPlaces(this.services, accountId))[0] ?? null);
        const options = { unlessSaidWithinMs: notice.unlessSaidWithinMs };
        if (
          !place ||
          !(await this.#tell(this.services, place.burrowId, place.personId, notice.text, options))
        ) {
          this.services.log.info({ kind: event.kind }, 'remote help: the person has no Chat to tell them');
          untold.push(accountId);
        }
      } catch (err) {
        this.services.log.warn({ err: String(err).slice(0, 200) }, 'remote help: the person wasn’t told');
        untold.push(accountId);
      }
    }
    if (notice.push && untold.length)
      await this.options.push
        ?.security(untold, notice.push.what, notice.push.notice)
        .catch((err) => this.services.log.warn({ err: String(err) }, 'remote help: the push failed'));
  }

  /* The ops (the person's devices only) ----------------------------------------------------------- */

  /** `remoteHelp.get`: the state now; `remote_help_busy` when the service doesn't answer. */
  async get(principal: SessionPrincipal): Promise<RemoteHelpState> {
    requireEnrolled(principal);
    try {
      return remoteHelpStateOf(this.#accept(await this.port.state()));
    } catch (err) {
      this.#warn(err, 'the support service didn’t answer');
      throw refusalOf(err);
    }
  }

  /**
   * `remoteHelp.confirmBegin {level, duration}`: a caller with a passkey gets a fresh nonce, kept in this session with
   * the choice it was begun for (a new begin replaces it), and the options that confirm exactly that choice from this
   * device; one without gets nulls (they confirm in a dialog).
   */
  async confirmBegin(
    principal: SessionPrincipal,
    session: SessionScope | null,
    input: ConfirmBeginInput,
    /** The refusal when this session can't run a passkey ceremony (a page of the box's own name); null when it can. */
    noPasskeysHere: ApiError | null = null,
  ): Promise<RemoteHelpConfirmBeginOutput> {
    const { account, endpoint } = requireEnrolled(principal);
    if (!session) throw new ApiError('bad_request', 'Turn on remote help over a session.');
    session.remoteHelpBegin = null;
    const passkeys = this.options.passkeys;
    if (!passkeys || !(await passkeys.hasPasskey(account.id))) return { nonce: null, options: null };
    // Someone with a passkey confirms with it, which this page can't do: they turn it on in the app instead. Someone
    // without one confirms in the dialog, which works on any page (direct-connection.md DC-22).
    if (noPasskeysHere) throw noPasskeysHere;
    const nonce = randomBytes(32).toString('hex');
    const challenge = passkeyRemoteHelpChallengeBase64url({
      nonce,
      endpoint: principal.peerId,
      level: input.level,
      duration: input.duration,
    });
    const options = await passkeys.stepUpOptions(account.id, challenge);
    if (!options) return { nonce: null, options: null };
    session.remoteHelpBegin = {
      nonce,
      accountId: account.id,
      endpointId: endpoint.id,
      level: input.level,
      duration: input.duration,
      expiresAt: new Date(this.services.clock().getTime() + REMOTE_HELP_BEGIN_TTL_MS),
    };
    return { nonce, options };
  }

  /**
   * `remoteHelp.start {level, duration, passkey?}` (RH-04): uses up the session's begin whatever happens. A caller with
   * a passkey must send an assertion of one of theirs for this begin's exact choice (`passkey_required`, else
   * `passkey_failed`); then the service grants it (and is the only judge of Forever, RH-03).
   */
  async start(
    principal: SessionPrincipal,
    session: SessionScope | null,
    input: StartInput,
  ): Promise<RemoteHelpState> {
    const { account, endpoint } = requireEnrolled(principal);
    const begin = session?.remoteHelpBegin ?? null;
    if (session) session.remoteHelpBegin = null;
    const passkeys = this.options.passkeys;
    if (input.passkey) {
      const now = this.services.clock();
      if (
        !begin ||
        begin.expiresAt <= now ||
        begin.accountId !== account.id ||
        begin.endpointId !== endpoint.id ||
        begin.level !== input.level ||
        begin.duration !== input.duration ||
        !passkeys
      )
        throw remoteHelpRefusal('passkey_failed');
      const confirmed = await passkeys.confirm(
        account.id,
        input.passkey as WebAuthnAuthenticationResponse,
        () =>
          passkeyRemoteHelpChallengeBase64url({
            nonce: begin.nonce,
            endpoint: principal.peerId,
            level: input.level,
            duration: input.duration,
          }),
      );
      if (!confirmed) throw remoteHelpRefusal('passkey_failed');
    } else if (passkeys && (await passkeys.hasPasskey(account.id))) {
      throw remoteHelpRefusal('passkey_required');
    }
    try {
      // The service opens the box to support (CS-01): not idempotent; a refusal or a socket nobody listens on did
      // nothing.
      const state = await externalEffect(
        'remote_help.grant',
        () =>
          this.port.grant({
            level: input.level,
            duration: input.duration,
            grantedBy: { accountId: account.id, name: grantorName(account) },
          }),
        { refused: supportRefused },
      );
      this.services.log.info({ level: input.level, duration: input.duration }, 'remote help: turned on');
      return remoteHelpStateOf(this.#accept(state));
    } catch (err) {
      const refusal = refusalOf(err);
      if (refusal.details?.code === 'remote_help_busy') this.#warn(err, 'turning remote help on failed');
      throw refusal;
    }
  }

  /** `remoteHelp.stop`: never asks (RH-04); stopping what is off changes nothing. */
  async stop(principal: SessionPrincipal): Promise<RemoteHelpState> {
    const { account } = requireEnrolled(principal);
    try {
      const state = await externalEffect(
        'remote_help.stop',
        () => this.port.stop({ reason: 'owner', by: { accountId: account.id, name: grantorName(account) } }),
        { idempotent: true },
      );
      return remoteHelpStateOf(this.#accept(state));
    } catch (err) {
      this.#warn(err, 'stopping remote help failed');
      throw refusalOf(err);
    }
  }

  /** `remoteHelp.visits {before?, limit?}`: newest first, each with its newest steps. */
  async visits(principal: SessionPrincipal, input: VisitsInput): Promise<{ visits: RemoteHelpVisit[] }> {
    requireEnrolled(principal);
    try {
      const visits = await this.port.visits({
        ...(input.before !== undefined ? { before: input.before } : {}),
        limit: input.limit ?? REMOTE_HELP_VISITS_MAX,
      });
      return { visits: visits.map(remoteHelpVisitOf) };
    } catch (err) {
      this.#warn(err, 'the support service didn’t list its visits');
      throw refusalOf(err);
    }
  }

  /** `remoteHelp.transcript {visitId}` (an export stream): the visit's command line, cleaned, at most 50 MiB. */
  async transcript(
    principal: SessionPrincipal,
    input: TranscriptInput,
  ): Promise<{ stream: AsyncIterable<Uint8Array>; name: string }> {
    requireEnrolled(principal);
    let source: AsyncIterable<Uint8Array> | null;
    try {
      source = await this.port.transcript(input.visitId);
    } catch (err) {
      this.#warn(err, 'the support service didn’t give a command line');
      throw refusalOf(err);
    }
    if (!source) throw notFound('Command line');
    return {
      stream: cleanTranscriptStream(source, REMOTE_HELP_LIMITS.transcriptBytesPerVisit),
      name: remoteHelpTranscriptName(input.visitId),
    };
  }

  /* The desk (§2.4) ----------------------------------------------------------------------------------- */

  /** The desk's line now, from the state as last read (the follower keeps it fresh). */
  deskView(): DeskRemoteHelp | undefined {
    return deskRemoteHelpOf(this.#state, this.services.clock().getTime());
  }

  /** Stop at the box's screen: no unlock (RH-04), reason `desk`. Throws when the service didn't answer. */
  async stopAtDesk(): Promise<void> {
    this.#accept(await this.port.stop({ reason: 'desk' }));
    this.services.log.info('remote help: stopped at the screen');
  }
}

/* Per process ----------------------------------------------------------------------------------------------------- */

type SupportConfig = Pick<Config, 'WHOMBAT_SUPPORT' | 'WHOMBAT_SUPPORT_SOCKET'>;
type SupportServices = { config: SupportConfig; clock?: () => Date };

const ports = new WeakMap<object, SupportPort | null>();

/**
 * The process's support service (one per `Services`): the fake (`fake`: a test Whombat, `fake-prod`: a customer's), the
 * socket's client, or none (no socket: remote help isn't on this runtime).
 */
export function supportFor(services: SupportServices): SupportPort | null {
  if (ports.has(services)) return ports.get(services) ?? null;
  const { WHOMBAT_SUPPORT: mode, WHOMBAT_SUPPORT_SOCKET: socket } = services.config;
  const clock = services.clock;
  const now = clock ? () => clock().getTime() : Date.now;
  const port =
    mode === 'off'
      ? null
      : mode === 'fake' || mode === 'fake-prod'
        ? new FakeSupport(now, { environment: mode === 'fake' ? 'local' : 'prod' })
        : socket
          ? new SupportSocketClient(socket)
          : null;
  ports.set(services, port);
  return port;
}

/* The session ops (§2.2) ------------------------------------------------------------------------------------------ */

interface RemoteHelpOpContext {
  principal: SessionPrincipal;
  session: SessionScope | null;
  remoteHelp: RemoteHelpService | undefined;
  /**
   * Whombat Link (whombat-link.md LNK-07): remote help is a Link feature, its switches shown only while Link is on or in
   * grace; it says so, not “yet” (HE-S224). Absent: a runtime without Link (tests of remote help alone).
   */
  link?: { state: string } | undefined;
  /** Whether a passkey ceremony can run in this session (its relying party). Absent: tests of remote help alone. */
  trust?: Pick<TrustService, 'relyingParty' | 'community'>;
}

/** The refusal for someone with a passkey on a page that can't run its ceremony; null where passkeys work. */
function noPasskeysHere(c: RemoteHelpOpContext): ApiError | null {
  if (!c.trust || passkeysWorkHere(c.session?.transport, c.trust.relyingParty())) return null;
  return passkeysUnavailableHere(c.trust.community);
}

/** Whether remote help's switches show: Link on or in grace (LNK-07). Stopping and the visits always work. */
export function remoteHelpOffered(c: Pick<RemoteHelpOpContext, 'link'>): boolean {
  return !c.link || c.link.state === 'on' || c.link.state === 'grace';
}

/** The service, or the refusal of a runtime without one. */
function serviceOf(c: RemoteHelpOpContext): RemoteHelpService {
  requireEnrolled(c.principal);
  if (!remoteHelpOffered(c))
    throw new SessionOpError('not_allowed', COMMUNITY_TEXT.remoteHelp, { code: 'remote_help_unavailable' });
  if (!c.remoteHelp) throw remoteHelpRefusal('remote_help_unavailable');
  return c.remoteHelp;
}

// biome-ignore lint/suspicious/noExplicitAny: each handler receives its op's parsed input.
type RemoteHelpHandler = (c: RemoteHelpOpContext, input: any) => Promise<unknown>;

export const REMOTE_HELP_SESSION_HANDLERS: Readonly<Record<string, RemoteHelpHandler>> = {
  'remoteHelp.get': async (c) => {
    requireEnrolled(c.principal);
    if (!c.remoteHelp) return REMOTE_HELP_UNAVAILABLE;
    const state = await c.remoteHelp.get(c.principal);
    // Without Link on or in grace the switches go; a grant and who is connected still show, so Stop works (LNK-07).
    return remoteHelpOffered(c) ? state : { ...state, available: false, foreverAllowed: false };
  },
  'remoteHelp.confirmBegin': async (c, i: ConfirmBeginInput) =>
    serviceOf(c).confirmBegin(c.principal, c.session, i, noPasskeysHere(c)),
  'remoteHelp.start': async (c, i: StartInput) => serviceOf(c).start(c.principal, c.session, i),
  'remoteHelp.stop': async (c) => {
    requireEnrolled(c.principal);
    return c.remoteHelp ? c.remoteHelp.stop(c.principal) : REMOTE_HELP_UNAVAILABLE;
  },
  'remoteHelp.visits': async (c, i: VisitsInput) => {
    requireEnrolled(c.principal);
    return c.remoteHelp ? c.remoteHelp.visits(c.principal, i) : { visits: [] };
  },
};

/** `remoteHelp.transcript` through an export stream (`resources.ts`). */
export function remoteHelpTranscript(
  remoteHelp: RemoteHelpService | undefined,
  principal: SessionPrincipal,
  input: TranscriptInput,
) {
  requireEnrolled(principal);
  if (!remoteHelp) throw notFound('Command line');
  return remoteHelp.transcript(principal, input);
}
