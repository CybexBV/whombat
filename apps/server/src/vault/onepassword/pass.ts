/**
 * One pass of the 1Password sync (docs/decisions/onepassword-sync.md): read first, then
 * commit. It works out what waits in Whombat first: a pass asked for only by a change to an entry (or to where the
 * Vault may connect) makes no 1Password call when nothing waits for it. Otherwise it asks for the vault's
 * `contentVersion`; unchanged, with nothing waiting in Whombat, it is done. Otherwise it lists the items, gets those that
 * changed (50 at a time), decides each pair in core with the base's digests, checks the addresses of what will come in,
 * and applies the result in small commits through one Vault command run as the person. Then it writes what Whombat
 * changed into 1Password, worked out from the state rather than a queue: changed pairs (`put` of the item just read),
 * new entries (`create`, with the marker), and removed entries (archive). Before each write it checks that the
 * connection is still there with the same token and vault and that the box isn't paused. No 1Password call and no DNS
 * lookup happens while a commit holds the write lock.
 */
import { createHash } from 'node:crypto';
import {
  decideOnePasswordPair,
  newOnePasswordItem,
  ONEPASSWORD_GET_BATCH,
  ONEPASSWORD_WORDS,
  type OnePasswordItem,
  type OnePasswordItemOverview,
  type OnePasswordProjection,
  type OnePasswordRemovals,
  type OnePasswordSkipReason,
  onePasswordCanonical,
  onePasswordCanonicalUrl,
  onePasswordCategorySkip,
  onePasswordEntryName,
  onePasswordItemMarker,
  onePasswordItemProjection,
  onePasswordLimitWaitMs,
  onePasswordRemovalGuard,
  onePasswordSkipText,
  onePasswordTotpFieldId,
  VAULT_ENTRIES_MAX,
  writeOnePasswordItem,
} from '@whombat/core';
import { connectionRow } from '../../connections/store';
import type { CatalogConnectionRow } from '../../connections/types';
import type { OnePasswordNotInVaultRow } from '../../db/schema/index';
import { thePerson } from '../../domain/the-person';
import type { PrincipalRow } from '../../read/principals';
import type { Services } from '../../services';
import { destinationProblem } from '../net';
import { entriesOf, type VaultEntryRow } from '../store';
import {
  applyOnePasswordOps,
  type ItemMark,
  newLinkId,
  ONEPASSWORD_ENTRY_OPS,
  ONEPASSWORD_REMEMBERED_MAX,
  type OnePasswordOp,
  type OnePasswordOpResult,
  recordOnePasswordPass,
} from './commands';
import { onePasswordDigests, onePasswordEntryValues, sameOnePasswordDigests, storedBase } from './digests';
import { type OnePasswordApi, OnePasswordError, type OnePasswordFailure } from './pool';
import {
  ONEPASSWORD_CATALOG_ID,
  type OnePasswordLinkRow,
  type OnePasswordStateRow,
  onePasswordLink,
  onePasswordLinks,
  onePasswordState,
  onePasswordToken,
  onePasswordVaultId,
} from './store';
import { ONEPASSWORD_PASS_WORDS } from './words';

export { ONEPASSWORD_PASS_WORDS } from './words';

/** Why an item that was in step can't come in now: “1Password’s item has no website now”. */
export function itemStopsFittingText(reason: OnePasswordSkipReason): string {
  switch (reason) {
    case 'no_website':
      return '1Password’s item has no website now';
    case 'no_hostname':
      return '1Password’s item has no hostname now';
    case 'no_username':
      return '1Password’s item has no username now';
    case 'no_password':
      return '1Password’s item has no password now';
    case 'no_credential':
      return '1Password’s item has no credential now';
    case 'unreadable':
      return ONEPASSWORD_PASS_WORDS.unreadableItem;
    default:
      return `1Password’s item can’t come in now: ${onePasswordSkipText(reason).toLowerCase()}`;
  }
}

/**
 * Why a pass runs: `change` (an entry changed: only when something waits in Whombat), `network` (where the Vault may
 * connect changed: only when an item or a pair is held for an address Whombat may not reach), `tick` (the regular pass,
 * the connection added), `now` (Sync now or a new token: reads the vault in full whatever its version says).
 */
export type OnePasswordPassReason = 'change' | 'network' | 'tick' | 'now';

/** How a pass ended, for the scheduler and tests. */
export type PassOutcome =
  | { ran: false; why: 'gone' | 'no_person' | 'waiting' | 'nothing' | 'stopped' }
  | { ran: true; outcome: 'ok' | 'paused' | 'waiting' | 'failing'; problem: string | null };

/** Whether a write to 1Password may start now; one that may counts as writing until `leave` (the scheduler's). */
export interface OnePasswordWriteGate {
  enter(): boolean;
  leave(): void;
}

export interface PassOptions {
  api: OnePasswordApi;
  /** In [0, 1): the limit's jitter. */
  random?: () => number;
  /** Why it runs (absent: the regular pass). */
  reasons?: ReadonlySet<OnePasswordPassReason>;
  /** Writes wait for a disconnect or a drain (absent: only the box's own pause is looked at). */
  gate?: OnePasswordWriteGate;
}

/** A change to make in 1Password once the commits are in. */
type Push =
  | {
      kind: 'create';
      entry: VaultEntryRow;
      projection: OnePasswordProjection;
      link: OnePasswordLinkRow | null;
    }
  | {
      kind: 'put';
      link: OnePasswordLinkRow;
      entry: VaultEntryRow;
      item: OnePasswordItem;
      projection: OnePasswordProjection;
    }
  | { kind: 'archive'; link: OnePasswordLinkRow; itemId: string };

const markOf = (item: Pick<OnePasswordItem, 'id' | 'version' | 'updatedAt'>): ItemMark => ({
  itemId: item.id,
  version: item.version,
  updatedAt: item.updatedAt,
});

/**
 * A pass that stopped: on 1Password's answer (limit, refused token, gone vault, unreachable), or `gone` (the connection
 * was removed or changed, or the box paused, before a write: nothing more is written).
 */
class PassStop extends Error {
  constructor(readonly failure: OnePasswordFailure | 'answer' | 'gone') {
    super(failure);
  }
}

function stopFor(err: unknown): PassStop {
  if (err instanceof PassStop) return err;
  if (err instanceof OnePasswordError) return new PassStop(err.kind);
  // A Zod error: an answer that didn't read.
  return new PassStop('answer');
}

/** Answers 1Password gives a write it won't take, however often it is sent: the pair waits for a change. */
const REFUSED = new Set<OnePasswordFailure>(['invalid', 'not_found', 'failed']);

/** What an entry or item holds, compared by meaning, for pairing an unpaired entry with an unpaired item. */
const sameKey = (p: OnePasswordProjection) => JSON.stringify([p.kind, onePasswordCanonical(p)]);

/** Who an entry or item signs in as and where: the same kind, address and username (none for a bearer token). */
const identityKey = (p: OnePasswordProjection) =>
  JSON.stringify([p.kind, onePasswordCanonicalUrl(p.url), p.username ?? '']);

const sameDigests = sameOnePasswordDigests;

/**
 * Whombat's side of a pair being linked, with what only the item has filled in (a username or a one-time password key
 * the entry has none of): linking never deletes anything in 1Password.
 */
const filledFrom = (ours: OnePasswordProjection, theirs: OnePasswordProjection): OnePasswordProjection => ({
  ...ours,
  username: ours.username === null || ours.username === '' ? theirs.username : ours.username,
  totp: ours.totp ?? theirs.totp,
});

/** The same UTC day: a token that can only read is tried again once a day. */
const sameDay = (a: Date, b: Date) => a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);

/** The token naming a set of held removals: the same set keeps its token, so an answer to it still applies. */
function removalsToken(entryIds: readonly string[]): string {
  return createHash('sha256')
    .update([...entryIds].sort().join(','))
    .digest('hex')
    .slice(0, 32);
}

/** The gate when the scheduler gives none (a test's pass): only the box's own read-only mode and pause. */
function boxGate(services: Services): OnePasswordWriteGate {
  return {
    enter: () =>
      services.schemaAccess !== 'read-only' && !services.maintenance.paused && !services.maintenance.held,
    leave: () => {},
  };
}

const REGULAR: ReadonlySet<OnePasswordPassReason> = new Set(['tick']);

class Pass {
  readonly #services: Services;
  readonly #api: OnePasswordApi;
  readonly #random: () => number;
  readonly #connection: CatalogConnectionRow;
  readonly #person: PrincipalRow;
  readonly #token: string;
  readonly #vaultId: string;
  readonly #state: OnePasswordStateRow | null;
  readonly #reasons: ReadonlySet<OnePasswordPassReason>;
  readonly #gate: OnePasswordWriteGate;
  /** A read-only token is tried once a pass, and only in a pass that may try it (`#readOnlyTry`). */
  #triedReadOnly = false;
  #readOnlyTry = false;
  /** A write skipped because its pair changed since the pass read it: the next pass reads in full. */
  #moved = false;
  /** 1Password refused to archive an item: the pass ends failing, so it doesn't go on silently. */
  #archiveRefused = false;
  readOnly: boolean;

  constructor(
    services: Services,
    options: PassOptions,
    parts: {
      connection: CatalogConnectionRow;
      person: PrincipalRow;
      token: string;
      vaultId: string;
      state: OnePasswordStateRow | null;
    },
  ) {
    this.#services = services;
    this.#api = options.api;
    this.#random = options.random ?? Math.random;
    this.#connection = parts.connection;
    this.#person = parts.person;
    this.#token = parts.token;
    this.#vaultId = parts.vaultId;
    this.#state = parts.state;
    this.#reasons = options.reasons?.size ? options.reasons : REGULAR;
    this.#gate = options.gate ?? boxGate(services);
    this.readOnly = parts.state?.readOnly ?? false;
  }

  /** Commits a list of ops in batches of at most ten entries; returns each op's result in order. */
  async apply(ops: OnePasswordOp[]): Promise<OnePasswordOpResult[]> {
    const results: OnePasswordOpResult[] = [];
    let batch: OnePasswordOp[] = [];
    let entries = 0;
    const flush = async () => {
      if (!batch.length) return;
      const res = await this.#services.pipeline.commit(
        applyOnePasswordOps,
        {
          connectionId: this.#connection.id,
          credentialVersion: this.#connection.credentialVersion,
          ops: batch,
        },
        { burrowId: this.#connection.burrowId, actorId: this.#person.id },
      );
      if (res.status !== 'ok') throw new Error(`the 1Password sync's commit answered ${res.status}`);
      // The token was replaced since the pass read: nothing more of this pass is written.
      if (res.result.stale) throw new PassStop('gone');
      results.push(...res.result.results);
      batch = [];
      entries = 0;
    };
    for (const op of ops) {
      const changesEntry = ONEPASSWORD_ENTRY_OPS.has(op.op);
      if ((changesEntry && entries >= 10) || batch.length >= 100) await flush();
      batch.push(op);
      if (changesEntry) entries++;
    }
    await flush();
    return results;
  }

  async record(state: Parameters<typeof recordOnePasswordPass.apply>[2]['state']): Promise<void> {
    const res = await this.#services.pipeline.commit(
      recordOnePasswordPass,
      {
        connectionId: this.#connection.id,
        credentialVersion: this.#connection.credentialVersion,
        removalsSeen: this.#state?.removals?.token ?? null,
        state,
      },
      { burrowId: this.#connection.burrowId, actorId: this.#person.id },
    );
    if (res.status !== 'ok') throw new Error(`the 1Password sync's record answered ${res.status}`);
  }

  /**
   * Ends the pass on a failure: the limit's wait (kept with the state), the failing line, or quietly when it was
   * stopped.
   */
  async fail(stop: PassStop): Promise<PassOutcome> {
    if (stop.failure === 'gone') return { ran: false, why: 'stopped' };
    const hits = this.#state?.limitHits ?? 0;
    if (stop.failure === 'limit') {
      const wait = onePasswordLimitWaitMs(hits, this.#random());
      const next = new Date(this.#services.clock().getTime() + wait).toISOString();
      await this.record({
        outcome: 'waiting',
        problem: null,
        readOnly: this.readOnly,
        limitHits: hits + 1,
        nextTryAt: next,
      });
      return { ran: true, outcome: 'waiting', problem: null };
    }
    const problem =
      stop.failure === 'auth'
        ? ONEPASSWORD_PASS_WORDS.token
        : stop.failure === 'not_found'
          ? ONEPASSWORD_PASS_WORDS.vault
          : stop.failure === 'forbidden'
            ? ONEPASSWORD_PASS_WORDS.readVault
            : stop.failure === 'stopped'
              ? ONEPASSWORD_WORDS.stopped
              : stop.failure === 'answer'
                ? ONEPASSWORD_PASS_WORDS.answer
                : ONEPASSWORD_WORDS.unreachable;
    await this.record({
      outcome: 'failing',
      problem,
      readOnly: this.readOnly,
      limitHits: 0,
      nextTryAt: null,
    });
    return { ran: true, outcome: 'failing', problem };
  }

  /**
   * One write to 1Password, only while it may: not while a disconnect, a drain, a restore's batch or the guard's answer
   * waits for the writes to end, and only when the connection is still there with the token and vault this pass started
   * with. `ours` says, inside the gate and right before the call, whether the link is still the one the pass read (the
   * person may have kept it here, removed or brought back its entry meanwhile); when it isn't, nothing is written (null)
   * and the next pass looks again.
   */
  async #write<T>(call: () => Promise<T>, ours: () => Promise<boolean>): Promise<T | null> {
    if (!this.#gate.enter()) throw new PassStop('gone');
    try {
      const row = await connectionRow(this.#services.db, this.#connection.id);
      if (
        !row ||
        row.catalogId !== ONEPASSWORD_CATALOG_ID ||
        onePasswordVaultId(row) !== this.#vaultId ||
        onePasswordToken(this.#services, row) !== this.#token
      )
        throw new PassStop('gone');
      if (!(await ours())) {
        this.#moved = true;
        return null;
      }
      // A token that can only read is tried once a pass: this is that try.
      if (this.readOnly) this.#triedReadOnly = true;
      return await call();
    } finally {
      this.#gate.leave();
    }
  }

  async run(): Promise<PassOutcome> {
    const services = this.#services;
    const api = this.#api;
    const token = this.#token;
    const vaultId = this.#vaultId;
    const state = this.#state;
    const reasons = this.#reasons;

    // Whombat's side first, read once (no lock): the person's entries and the pass's links.
    const links = await onePasswordLinks(services.db, this.#connection.id);
    const entries = await entriesOf(services.db, this.#connection.burrowId, this.#person.id);
    const entryById = new Map(entries.map((e) => [e.id, e]));
    const projections = new Map<string, OnePasswordProjection | null>();
    const projectionOf = (row: VaultEntryRow) => {
      if (!projections.has(row.id)) projections.set(row.id, onePasswordEntryValues(services.custody, row));
      return projections.get(row.id) ?? null;
    };
    const whombatDigests = (row: VaultEntryRow) => {
      const p = projectionOf(row);
      return p ? onePasswordDigests(services.custody, row.id, p) : null;
    };
    /**
     * Whether 1Password refused this pair's Whombat side as it is now: it isn't sent again until a side changes, except
     * on Sync now, which tries once more.
     */
    const refusedStill = (link: OnePasswordLinkRow): boolean => {
      if (reasons.has('now')) return false;
      const refused = storedBase(link.refused);
      const row = refused && link.entryId ? entryById.get(link.entryId) : undefined;
      const digests = row ? whombatDigests(row) : null;
      return digests !== null && sameDigests(refused, digests);
    };
    /** Whether Whombat's side of a pair moved from the base (or the pair has none, or the entry stopped fitting). */
    const whombatMoved = (link: OnePasswordLinkRow): boolean => {
      const row = link.entryId ? entryById.get(link.entryId) : undefined;
      if (!row) return link.itemId !== null;
      if (refusedStill(link)) return false;
      const digests = whombatDigests(row);
      return digests === null || !sameDigests(storedBase(link.base), digests);
    };
    const linkByEntry = new Map(links.filter((l) => l.entryId).map((l) => [l.entryId as string, l]));
    const unlinkedEligible = entries.filter((e) => !linkByEntry.has(e.id) && projectionOf(e) !== null);
    const held = state?.notInVault ?? [];
    const heldById = new Map(held.map((h) => [h.itemId, h]));
    const pushesWait =
      links.some((l) => l.state === 'creating' && !refusedStill(l)) ||
      links.some((l) => l.state === 'synced' && whombatMoved(l)) ||
      unlinkedEligible.length > 0;
    const roomNow = held.some((h) => h.reason === 'vault_full') && entries.length < VAULT_ENTRIES_MAX;
    // With a token that can only read, what waits to go asks 1Password nothing by itself (a change here would only be
    // refused); the regular pass still tries once.
    const waiting = (pushesWait && !this.readOnly) || roomNow;
    const heldUnreachable =
      held.some((h) => h.reason === 'unreachable') ||
      links.some((l) => l.problem === ONEPASSWORD_PASS_WORDS.unreachableAddress);
    // Asked for only by a change here or by the home networks: no 1Password call unless something waits for it.
    const lazy = [...reasons].every((r) => r === 'change' || r === 'network');
    if (lazy && !((reasons.has('change') && waiting) || (reasons.has('network') && heldUnreachable)))
      return { ran: false, why: 'nothing' };
    const force = reasons.has('now') || (reasons.has('network') && heldUnreachable);
    // After a whole-box restore Whombat's side is the older one: every pair this pass makes or finds again has no base,
    // so 1Password's values win, until a pass reads everything and finishes.
    const pullFirst = state?.pullFirst ?? false;
    // A token that can only read is tried again on Sync now and once a day (and when the vault changed, below).
    const tryReadOnly =
      this.readOnly &&
      (reasons.has('now') || !state?.checkedAt || !sameDay(state.checkedAt, services.clock()));

    let overview: Awaited<ReturnType<OnePasswordApi['overview']>>;
    try {
      overview = await api.overview(token, vaultId);
    } catch (err) {
      return this.fail(stopFor(err));
    }
    this.#readOnlyTry = tryReadOnly || state?.contentVersion !== overview.contentVersion;
    if (!force && !waiting && !tryReadOnly && state?.contentVersion === overview.contentVersion) {
      await this.record({
        vaultTitle: overview.title,
        outcome: state.removals ? 'paused' : 'ok',
        problem: null,
        readOnly: this.readOnly,
        limitHits: 0,
        nextTryAt: null,
      });
      return { ran: true, outcome: state.removals ? 'paused' : 'ok', problem: null };
    }

    let listed: OnePasswordItemOverview[];
    try {
      // Only active items are in the vault: an archived one is gone, whatever else the list says of it.
      listed = (await api.list(token, vaultId)).filter((o) => o.state === 'active');
    } catch (err) {
      return this.fail(stopFor(err));
    }
    const listedById = new Map(listed.map((o) => [o.id, o]));
    const linkByItem = new Map(links.filter((l) => l.itemId).map((l) => [l.itemId as string, l]));
    const titleOf = (o: Pick<OnePasswordItemOverview, 'title'>) => o.title.slice(0, 200);
    /** An item 1Password couldn't give twice in a row, unchanged since: not asked for again until it changes. */
    const stuck = (o: OnePasswordItemOverview) => {
      const h = heldById.get(o.id);
      return h?.reason === 'unreadable' && (h.failedReads ?? 0) >= 2 && h.updatedAt === o.updatedAt
        ? h
        : null;
    };

    // What to read in full: pairs that moved on either side (or wait for an address Whombat may now reach), and items
    // no link has (new ones, a lost create's). Items of other kinds are known from the list alone.
    const toGet = new Set<string>();
    const known = new Map<string, OnePasswordNotInVaultRow>();
    for (const link of links) {
      if (link.state !== 'synced' || !link.itemId || !link.entryId) continue;
      const o = listedById.get(link.itemId);
      if (!o) continue;
      const kept = stuck(o);
      if (kept) known.set(o.id, kept);
      else if (
        link.itemUpdatedAt !== o.updatedAt ||
        whombatMoved(link) ||
        link.problem === ONEPASSWORD_PASS_WORDS.unreachableAddress
      )
        toGet.add(o.id);
    }
    for (const o of listed) {
      if (linkByItem.has(o.id)) continue;
      const before = heldById.get(o.id);
      const kept = stuck(o);
      if (kept) {
        known.set(o.id, { ...kept, title: titleOf(o) });
        continue;
      }
      const outside = onePasswordCategorySkip(o.category);
      if (outside) {
        known.set(o.id, { itemId: o.id, title: titleOf(o), reason: outside, updatedAt: o.updatedAt });
        continue;
      }
      // An item that stays out for its own reasons is read again only when it changes; the server's own reasons (a
      // full Vault, an address it may not reach) may change without it, and one that didn't read is tried again.
      if (
        before &&
        before.updatedAt === o.updatedAt &&
        !before.failedReads &&
        before.reason !== 'vault_full' &&
        before.reason !== 'unreachable'
      ) {
        known.set(o.id, { ...before, title: titleOf(o) });
        continue;
      }
      toGet.add(o.id);
    }

    const items = new Map<string, OnePasswordItem>();
    /** Listed, but 1Password answered that it has no such item: not gone (the next list decides), not read either. */
    const missing = new Set<string>();
    /** Items 1Password answered it couldn't give, each counted. */
    const failed = new Set<string>();
    /** Items of a batch that failed as a whole (counted for nothing: 1Password didn't answer for them). */
    const unread = new Set<string>();
    let listingFailed = false;
    const ids = [...toGet];
    for (let i = 0; i < ids.length; i += ONEPASSWORD_GET_BATCH) {
      const chunk = ids.slice(i, i + ONEPASSWORD_GET_BATCH);
      try {
        const got = await api.get(token, vaultId, chunk);
        for (const item of got.items) items.set(item.id, item);
        for (const id of got.missing) missing.add(id);
        for (const id of got.failed) failed.add(id);
      } catch (err) {
        const stop = stopFor(err);
        if (stop.failure === 'limit' || stop.failure === 'auth' || stop.failure === 'stopped')
          return this.fail(stop);
        for (const id of chunk) unread.add(id);
        listingFailed = true;
      }
    }
    // An item that didn't read twice in a row stays out by itself (“Whombat couldn’t read this item”): it no longer
    // makes every pass a partial one.
    const failedReads = new Map([...failed].map((id) => [id, (heldById.get(id)?.failedReads ?? 0) + 1]));
    const unreadable = (id: string) => (failedReads.get(id) ?? 0) >= 2;
    // A read that didn't give every item the list showed: an item it missed may carry a marker, so nothing is made in
    // 1Password this pass and nothing is removed, and the page says not everything was read.
    const partial = unread.size > 0 || missing.size > 0 || [...failed].some((id) => !unreadable(id));
    if (partial) listingFailed = true;
    // An item no pair has that is held as unreadable may be one an earlier try made for an entry (its marker unread):
    // while one is, unfinished creates aren't sent again and their links aren't dropped.
    const heldUnreadable =
      [...known.values()].some((h) => h.reason === 'unreadable' && !linkByItem.has(h.itemId)) ||
      [...failedReads].some(([id, count]) => count >= 2 && !linkByItem.has(id));
    const present = (itemId: string) => listedById.has(itemId);

    const ops: OnePasswordOp[] = [];
    const pushes: Push[] = [];
    const notInVault: OnePasswordNotInVaultRow[] = [...known.values()];
    // Items it couldn't read this time keep the line they had; one that failed twice in a row says so.
    for (const id of [...unread, ...missing]) {
      const before = heldById.get(id);
      if (before) notInVault.push(before);
    }
    for (const [id, count] of failedReads) {
      const o = listedById.get(id);
      const before = heldById.get(id);
      if (count >= 2 && o)
        notInVault.push({
          itemId: id,
          title: titleOf(o),
          reason: 'unreadable',
          updatedAt: o.updatedAt,
          failedReads: count,
        });
      else if (o)
        notInVault.push({
          ...(before ?? { itemId: id, title: titleOf(o), reason: 'unreadable' as const }),
          updatedAt: o.updatedAt,
          failedReads: count,
        });
    }
    const removalCandidates: { link: OnePasswordLinkRow; entry: VaultEntryRow }[] = [];
    const claimed = new Set<string>();
    const readAt = (row: VaultEntryRow) => row.updatedAt.toISOString();
    /** Something this pass saw isn't settled (a change found its entry moved): the next pass reads in full again. */
    let unsettled = false;

    // Items no link has, read: by the Whombat entry they say they are (a lost create's, a relinked entry's).
    const unlinkedItems = [...items.values()].filter((i) => !linkByItem.has(i.id));
    const byMarker = new Map<string, OnePasswordItem>();
    for (const item of unlinkedItems) {
      const marker = onePasswordItemMarker(item);
      if (marker && !byMarker.has(marker)) byMarker.set(marker, item);
    }
    // Entries removed while their item was being made: an item naming one is archived, never brought in.
    const removedWhileCreating = new Set(
      links
        .filter((l) => l.state === 'creating' && !l.entryId && l.markerEntryId)
        .map((l) => l.markerEntryId as string),
    );

    /**
     * Decides a pair kept in step whose entry is there. `own`: Whombat's side to decide with when it isn't the entry as
     * read (a pair being linked, with what only the item has filled in).
     */
    const decidePair = async (
      link: OnePasswordLinkRow,
      entry: VaultEntryRow,
      own?: OnePasswordProjection,
    ): Promise<void> => {
      const projection = own ?? projectionOf(entry);
      if (!projection) {
        // The entry stopped fitting (a header sign-in, say): it stops following; the item stays as it was.
        ops.push({
          op: 'local',
          linkId: link.id,
          readAt: readAt(entry),
          problem: ONEPASSWORD_PASS_WORDS.stopsFitting,
        });
        return;
      }
      if (!link.itemId) return;
      if (!present(link.itemId)) {
        // Gone from the vault. A pair restored from a backup (no base), or one whose entry holds what 1Password never
        // got (changed here since the pair last agreed, or a change 1Password refused), becomes a Whombat entry like any
        // other and goes back as a new item; only an entry 1Password had as it is now is removed with its item.
        const base = storedBase(link.base);
        if (base === null || storedBase(link.refused) !== null || !sameDigests(base, whombatDigests(entry)))
          ops.push({ op: 'drop', linkId: link.id, entryId: entry.id });
        else removalCandidates.push({ link, entry });
        return;
      }
      const item = items.get(link.itemId);
      if (!item) {
        // 1Password couldn't give it twice in a row: the entry stays as it is and says so.
        if (unreadable(link.itemId) && link.problem !== ONEPASSWORD_PASS_WORDS.unreadableItem)
          ops.push({
            op: 'mark',
            linkId: link.id,
            item: null,
            problem: ONEPASSWORD_PASS_WORDS.unreadableItem,
            synced: false,
          });
        return;
      }
      const reading = onePasswordItemProjection(item, link.totpFieldId);
      const totpFieldId = onePasswordTotpFieldId(item, link.totpFieldId);
      if (!reading.ok) {
        // The item stopped fitting (its website removed, say): the entry stays as it was, the base too.
        const problem = itemStopsFittingText(reading.reason);
        ops.push({ op: 'mark', linkId: link.id, item: markOf(item), problem, synced: false });
        return;
      }
      const theirs = onePasswordDigests(services.custody, entry.id, reading.projection);
      const ours = onePasswordDigests(services.custody, entry.id, projection);
      const decision = decideOnePasswordPair({
        base: storedBase(link.base),
        whombat: ours,
        onepassword: theirs,
      });
      if (decision === 'nothing') {
        if (
          link.itemVersion !== item.version ||
          link.itemUpdatedAt !== item.updatedAt ||
          link.problem ||
          link.totpFieldId !== totpFieldId
        )
          ops.push({
            op: 'mark',
            linkId: link.id,
            item: markOf(item),
            problem: null,
            synced: true,
            totpFieldId,
          });
      } else if (decision === 'renew_base') {
        ops.push({
          op: 'mark',
          linkId: link.id,
          item: markOf(item),
          base: theirs,
          problem: null,
          synced: true,
          nameShortened: reading.nameShortened,
          totpFieldId,
          refused: null,
        });
      } else if (decision === 'take_onepassword') {
        if (await destinationProblem(services, reading.projection.url, 'save')) {
          // Left as it is until the address may be reached: a change of the home networks reads it again.
          ops.push({
            op: 'mark',
            linkId: link.id,
            item: null,
            problem: ONEPASSWORD_PASS_WORDS.unreachableAddress,
            synced: false,
          });
          return;
        }
        ops.push({
          op: 'pull',
          linkId: link.id,
          entryId: entry.id,
          readAt: readAt(entry),
          projection: reading.projection,
          item: markOf(item),
          nameShortened: reading.nameShortened,
          totpFieldId,
        });
      } else pushes.push({ kind: 'put', link, entry, item, projection });
    };

    for (const link of links) {
      const entry = link.entryId ? entryById.get(link.entryId) : undefined;
      if (link.state === 'creating') {
        if (!entry) {
          // Removed before its item was found: an item made for it is archived (never brought in), then the link goes.
          const found = link.markerEntryId ? byMarker.get(link.markerEntryId) : undefined;
          if (found && !claimed.has(found.id)) {
            claimed.add(found.id);
            pushes.push({ kind: 'archive', link, itemId: found.id });
          } else if (!partial && !heldUnreadable) ops.push({ op: 'drop', linkId: link.id, entryId: null });
          continue;
        }
        const found = byMarker.get(entry.id);
        if (found && !claimed.has(found.id)) {
          // The create went through before the pass was cut short: that item is this entry's, not a second one. Its
          // base is Whombat's side as it was sent, so what changed in 1Password since counts as 1Password's change
          // (after a whole-box restore none at all: 1Password's values win).
          const reading = onePasswordItemProjection(found);
          const sent = pullFirst
            ? null
            : (storedBase(link.base) ??
              whombatDigests(entry) ??
              (reading.ok ? onePasswordDigests(services.custody, entry.id, reading.projection) : null));
          if (!pullFirst && !sent) {
            ops.push({ op: 'drop', linkId: link.id });
            continue;
          }
          claimed.add(found.id);
          const totpFieldId = onePasswordTotpFieldId(found, null);
          ops.push({ op: 'created', linkId: link.id, item: markOf(found), base: sent, totpFieldId });
          await decidePair(
            {
              ...link,
              state: 'synced',
              itemId: found.id,
              itemVersion: found.version,
              itemUpdatedAt: found.updatedAt,
              base: sent,
              totpFieldId,
              refused: null,
              problem: null,
            },
            entry,
          );
          continue;
        }
        const projection = projectionOf(entry);
        if (!projection) ops.push({ op: 'drop', linkId: link.id });
        else if (!refusedStill(link) && !heldUnreadable)
          pushes.push({ kind: 'create', entry, projection, link });
        continue;
      }
      if (link.state === 'local_only') {
        if (!entry) ops.push({ op: 'drop', linkId: link.id, entryId: null });
        continue;
      }
      // synced
      if (!entry) {
        // Removed in Whombat: archived in 1Password (never deleted), then the link goes.
        if (link.itemId && present(link.itemId)) pushes.push({ kind: 'archive', link, itemId: link.itemId });
        else ops.push({ op: 'drop', linkId: link.id, entryId: null });
        continue;
      }
      await decidePair(link, entry);
    }

    // Entries that sync and have no link are paired with an item that is already theirs: one naming the entry first,
    // then one holding exactly what it holds, then the only item signing in as the entry does (kind, address,
    // username) when the entry is the only one signing in that way too. The item as just read is the new pair's base,
    // and the pair is decided at once: what only the item has (a one-time password key the entry has none of, say)
    // comes into the entry, and where both have a value and they differ Whombat's goes to 1Password, which keeps the old
    // one in the item's history; linking never deletes anything there. After a whole-box restore the pair has no base
    // and 1Password's values win. Otherwise an item is made.
    /** Pairs being linked whose entry takes what only the item has: their put waits for that pull. */
    const filling = new Set<string>();
    const relink = async (entry: VaultEntryRow, found: OnePasswordItem): Promise<void> => {
      claimed.add(found.id);
      const reading = onePasswordItemProjection(found);
      const base = pullFirst
        ? null
        : reading.ok
          ? onePasswordDigests(services.custody, entry.id, reading.projection)
          : whombatDigests(entry);
      if (!pullFirst && !base) return;
      const totpFieldId = onePasswordTotpFieldId(found, null);
      const nameShortened = onePasswordEntryName(found.title).shortened;
      const linkId = newLinkId();
      ops.push({
        op: 'relink',
        linkId,
        entryId: entry.id,
        vaultId,
        item: markOf(found),
        base,
        nameShortened,
        totpFieldId,
      });
      let own = projectionOf(entry) ?? undefined;
      if (own && base && reading.ok) {
        const filled = filledFrom(own, reading.projection);
        if (sameKey(filled) !== sameKey(own)) {
          // The entry takes what only the item has; the pair keeps the item as read as its base, so a put that
          // doesn't get through is sent again.
          filling.add(linkId);
          ops.push({
            op: 'pull',
            linkId,
            entryId: entry.id,
            readAt: readAt(entry),
            projection: filled,
            item: markOf(found),
            nameShortened,
            totpFieldId,
            base,
          });
          own = filled;
        }
      }
      const now = services.clock();
      await decidePair(
        {
          id: linkId,
          burrowId: this.#connection.burrowId,
          connectionId: this.#connection.id,
          entryId: entry.id,
          vaultId,
          itemId: found.id,
          state: 'synced',
          itemVersion: found.version,
          itemUpdatedAt: found.updatedAt,
          base,
          nameShortened: onePasswordEntryName(found.title).shortened,
          problem: null,
          totpFieldId,
          markerEntryId: null,
          refused: null,
          syncedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        entry,
        own,
      );
    };
    // Markers first: an item naming an entry is that entry's, and no other entry takes it.
    const unpaired: VaultEntryRow[] = [];
    for (const entry of unlinkedEligible) {
      const marked = byMarker.get(entry.id);
      if (marked && !claimed.has(marked.id)) await relink(entry, marked);
      else unpaired.push(entry);
    }
    // Under a partial read only markers pair: an item it missed may be the one that names an entry. And an item whose
    // marker names another entry Whombat has is that entry's copy, never paired by what it holds or who it signs in as.
    if (!partial) {
      const pairable = (item: OnePasswordItem) => {
        if (claimed.has(item.id)) return false;
        const marker = onePasswordItemMarker(item);
        return marker === null || (!entryById.has(marker) && !removedWhileCreating.has(marker));
      };
      const fitting = new Map<string, OnePasswordProjection>();
      for (const item of unlinkedItems) {
        const reading = onePasswordItemProjection(item);
        if (reading.ok && pairable(item)) fitting.set(item.id, reading.projection);
      }
      const bySame = new Map<string, OnePasswordItem>();
      for (const item of unlinkedItems) {
        const p = fitting.get(item.id);
        if (p && !bySame.has(sameKey(p))) bySame.set(sameKey(p), item);
      }
      const rest: VaultEntryRow[] = [];
      for (const entry of unpaired) {
        const same = bySame.get(sameKey(projectionOf(entry) as OnePasswordProjection));
        if (same && !claimed.has(same.id)) await relink(entry, same);
        else rest.push(entry);
      }
      const itemsByIdentity = new Map<string, OnePasswordItem[]>();
      for (const item of unlinkedItems) {
        const p = fitting.get(item.id);
        if (!p || claimed.has(item.id)) continue;
        const key = identityKey(p);
        itemsByIdentity.set(key, [...(itemsByIdentity.get(key) ?? []), item]);
      }
      const entriesByIdentity = new Map<string, number>();
      for (const entry of rest) {
        const key = identityKey(projectionOf(entry) as OnePasswordProjection);
        entriesByIdentity.set(key, (entriesByIdentity.get(key) ?? 0) + 1);
      }
      for (const entry of rest) {
        const projection = projectionOf(entry) as OnePasswordProjection;
        const key = identityKey(projection);
        const candidates = itemsByIdentity.get(key) ?? [];
        const only = candidates.length === 1 && entriesByIdentity.get(key) === 1 ? candidates[0] : undefined;
        if (only && !claimed.has(only.id)) await relink(entry, only);
        else pushes.push({ kind: 'create', entry, projection, link: null });
      }
    }
    // An item that would pair with an unpaired entry by what it holds or who it signs in as waits for a complete read
    // (which pairs them) instead of coming in as a second entry; one holding exactly what an entry kept only in Whombat
    // holds is that entry's copy and stays in 1Password.
    const keys = (row: VaultEntryRow | undefined) => {
      const p = row ? projectionOf(row) : null;
      return p ? [sameKey(p), identityKey(p)] : [];
    };
    const pairLater = new Set(partial ? unpaired.flatMap(keys) : []);
    const keptHere = new Set(
      links
        .filter((l) => l.state === 'local_only' && l.entryId)
        .flatMap((l) => keys(entryById.get(l.entryId as string)).slice(0, 1)),
    );

    // New items: an entry each when it fits, else a line under “Not in your Vault” with why.
    let room = VAULT_ENTRIES_MAX - entries.length;
    for (const item of unlinkedItems) {
      if (claimed.has(item.id)) continue;
      // An item made for an entry the person keeps only in Whombat (linked again with “Keep them only in Whombat”):
      // the entry stays its own and the item stays in 1Password, never a second entry. One made for an entry removed
      // while it was being made is archived, never brought back.
      const marker = onePasswordItemMarker(item);
      if (marker && linkByEntry.get(marker)?.state === 'local_only') continue;
      if (marker && removedWhileCreating.has(marker)) continue;
      const out = (reason: OnePasswordSkipReason) =>
        notInVault.push({ itemId: item.id, title: titleOf(item), reason, updatedAt: item.updatedAt });
      const reading = onePasswordItemProjection(item);
      if (!reading.ok) {
        out(reading.reason);
        continue;
      }
      const same = sameKey(reading.projection);
      if (pairLater.has(same) || pairLater.has(identityKey(reading.projection)) || keptHere.has(same))
        continue;
      if (room <= 0) {
        out('vault_full');
        continue;
      }
      // Held until the address may be reached: a change of the home networks reads it again, so the vault's version
      // is still kept.
      if (await destinationProblem(services, reading.projection.url, 'save')) {
        out('unreachable');
        continue;
      }
      room--;
      ops.push({
        op: 'add',
        vaultId,
        projection: reading.projection,
        item: markOf(item),
        nameShortened: reading.nameShortened,
        totpFieldId: onePasswordTotpFieldId(item, null),
      });
    }

    // The guard: an emptied vault or an error never empties the Vault.
    const linked = links.filter((l) => l.state === 'synced' && l.entryId && entryById.has(l.entryId)).length;
    const guard = onePasswordRemovalGuard({ removals: removalCandidates.length, linked, listingFailed });
    let removals: OnePasswordRemovals | null = null;
    if (guard === 'remove')
      for (const { link, entry } of removalCandidates)
        ops.push({ op: 'remove', linkId: link.id, entryId: entry.id, readAt: readAt(entry) });
    else if (guard === 'pause') {
      const token = removalsToken(removalCandidates.map((c) => c.entry.id));
      removals = {
        token,
        entries: removalCandidates.map((c) => ({ entryId: c.entry.id, name: c.entry.name })),
        since: state?.removals?.token === token ? state.removals.since : this.#services.clock().toISOString(),
      };
    }

    // Pulls first (nothing is pushed before this pass has read 1Password), then the pushes.
    let results: OnePasswordOpResult[];
    try {
      results = await this.apply(ops);
    } catch (err) {
      if (err instanceof PassStop) return this.fail(err);
      throw err;
    }
    // A change that found its entry or pair moved since the pass read it is taken by the next pass, which reads again.
    if (results.some((r) => r.status === 'moved')) unsettled = true;
    // A pair that couldn't be made or found again (made meanwhile), or whose entry didn't take what only the item had,
    // isn't written into.
    const lost = new Set<string>();
    ops.forEach((op, i) => {
      const done = results[i]?.status === 'done';
      if ((op.op === 'relink' || op.op === 'created') && !done) lost.add(op.linkId);
      if (op.op === 'pull' && filling.has(op.linkId) && !done) lost.add(op.linkId);
      if (op.op === 'add' && results[i]?.status === 'full')
        notInVault.push({
          itemId: op.item.itemId,
          title: (items.get(op.item.itemId)?.title ?? op.projection.name).slice(0, 200),
          reason: 'vault_full',
          updatedAt: op.item.updatedAt,
        });
    });

    let stop: PassStop | null = null;
    for (const push of pushes) {
      if (stop) break;
      // A read that missed an item may have missed the one this entry was already made as: nothing new this pass.
      if (partial && push.kind === 'create') continue;
      if (push.kind === 'put' && lost.has(push.link.id)) continue;
      try {
        await this.push(push);
      } catch (err) {
        const s = stopFor(err);
        if (s.failure === 'gone') return this.fail(s);
        if (s.failure === 'forbidden') {
          // The token can only read: the item stays as it is, pulling goes on, the page says so.
          this.readOnly = true;
          break;
        }
        if (
          s.failure === 'limit' ||
          s.failure === 'auth' ||
          s.failure === 'stopped' ||
          s.failure === 'network' ||
          // A new item 1Password says has nowhere to go: the vault is gone.
          (push.kind === 'create' && s.failure === 'not_found')
        )
          stop = s;
        else {
          // An item removed here that 1Password won't archive: the pass says so instead of trying for ever unseen.
          if (push.kind === 'archive') this.#archiveRefused = true;
          services.log.warn(
            { connectionId: this.#connection.id, kind: s.failure },
            'a 1Password write failed',
          );
        }
      }
    }
    if (stop) return this.fail(stop);

    notInVault.sort((a, b) => a.title.localeCompare(b.title));
    const outcome = removals ? 'paused' : partial || this.#archiveRefused ? 'failing' : 'ok';
    const problem =
      outcome !== 'failing'
        ? null
        : partial
          ? ONEPASSWORD_PASS_WORDS.partial
          : ONEPASSWORD_PASS_WORDS.archiveRefused;
    const settled = !partial && !listingFailed && !unsettled && !this.#moved;
    await this.record({
      vaultTitle: overview.title,
      // Kept only when everything seen was settled: otherwise the next pass reads in full again.
      contentVersion: settled ? overview.contentVersion : null,
      // A pass that read everything and finished ends the restore's “1Password first”.
      ...(pullFirst && settled && outcome !== 'failing' ? { pullFirst: false } : {}),
      outcome,
      problem,
      readOnly: this.readOnly,
      notInVault: notInVault.slice(0, ONEPASSWORD_REMEMBERED_MAX),
      removals,
      limitHits: 0,
      nextTryAt: null,
    });
    return { ran: true, outcome, problem };
  }

  /** One write to 1Password, then its commit: the new version, time and base together. */
  async push(push: Push): Promise<void> {
    const api = this.#api;
    const token = this.#token;
    const db = this.#services.db;
    // A token that can only read is tried with one write, in a pass that may try it (the vault changed, Sync now, once
    // a day): when it can write again, the pushes go on by themselves.
    if (this.readOnly && (this.#triedReadOnly || !this.#readOnlyTry)) return;
    if (push.kind === 'archive') {
      let archived: boolean | null;
      try {
        // Only while the link still has no entry: one brought back from a backup meanwhile takes the pair again and
        // its item stays. A restore takes the same gate, so this holds until the call is answered.
        archived = await this.#write(
          () => api.archive(token, this.#vaultId, push.itemId).then(() => true),
          async () => (await onePasswordLink(db, push.link.id))?.entryId === null,
        );
        if (archived) this.readOnly = false;
      } catch (err) {
        if (!(err instanceof OnePasswordError && err.kind === 'not_found')) throw err;
        archived = true;
      }
      if (archived) await this.apply([{ op: 'drop', linkId: push.link.id, entryId: null }]);
      return;
    }
    const digests = onePasswordDigests(this.#services.custody, push.entry.id, push.projection);
    if (push.kind === 'create') {
      let linkId = push.link?.id ?? null;
      if (!linkId) {
        // Written before the item is made, so a pass cut short in between finds the item by its marker; its base is
        // what is sent.
        const [made] = await this.apply([
          { op: 'creating', entryId: push.entry.id, vaultId: this.#vaultId, base: digests },
        ]);
        if (made?.status !== 'done' || !made.linkId) return;
        linkId = made.linkId;
      } else if (!sameDigests(storedBase(push.link?.base ?? null), digests)) {
        // A retry sends the entry as it is now: the base is what is sent this time, so a lost answer's item is
        // compared with exactly that.
        await this.apply([
          {
            op: 'mark',
            linkId,
            item: null,
            base: digests,
            problem: push.link?.problem ?? null,
            synced: false,
          },
        ]);
      }
      const creating = linkId;
      let item: OnePasswordItem | null;
      try {
        item = await this.#write(
          () =>
            api.create(
              token,
              newOnePasswordItem({
                vaultId: this.#vaultId,
                entryId: push.entry.id,
                projection: push.projection,
              }),
            ),
          // Still this entry's item to make: not removed meanwhile, nor its item found.
          async () => {
            const link = await onePasswordLink(db, creating);
            return link?.state === 'creating' && link.entryId === push.entry.id;
          },
        );
      } catch (err) {
        // Refused outright (a token that can only read): nothing was made, so nothing is waiting to be found.
        if (err instanceof OnePasswordError && err.kind === 'forbidden')
          await this.apply([{ op: 'drop', linkId }]);
        // Refused for what it holds: not sent again until the entry changes (a marker found meanwhile still pairs).
        // The vault gone (`not_found`) stops the pass instead: the entry isn't at fault.
        else if (err instanceof OnePasswordError && REFUSED.has(err.kind) && err.kind !== 'not_found')
          await this.apply([
            {
              op: 'mark',
              linkId,
              item: null,
              problem: ONEPASSWORD_PASS_WORDS.writeFailed,
              synced: false,
              refused: digests,
            },
          ]);
        throw err;
      }
      if (!item) return;
      this.readOnly = false;
      await this.apply([
        {
          op: 'created',
          linkId,
          item: markOf(item),
          base: digests,
          totpFieldId: onePasswordTotpFieldId(item, null),
        },
      ]);
      return;
    }
    let item = push.item;
    // Still the pair the pass read: the entry follows the same item (not kept only here, nor paired anew meanwhile).
    const ours = async () => {
      const link = await onePasswordLink(db, push.link.id);
      return link?.state === 'synced' && link.itemId === push.link.itemId && link.entryId === push.entry.id;
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const writing = writeOnePasswordItem(item, push.projection, push.link.totpFieldId);
        const written = await this.#write(() => api.put(token, writing.item), ours);
        if (!written) return;
        this.readOnly = false;
        await this.apply([
          {
            op: 'mark',
            linkId: push.link.id,
            item: markOf(written),
            base: digests,
            problem: null,
            synced: true,
            nameShortened: onePasswordEntryName(written.title).shortened,
            totpFieldId: writing.totpFieldId,
            refused: null,
          },
        ]);
        return;
      } catch (err) {
        if (!(err instanceof OnePasswordError) || err.kind !== 'failed' || attempt > 0) {
          // 1Password keeps refusing it: the pair waits until either side changes, with the words saying so.
          if (err instanceof OnePasswordError && REFUSED.has(err.kind))
            await this.apply([
              {
                op: 'mark',
                linkId: push.link.id,
                item: markOf(item),
                problem: ONEPASSWORD_PASS_WORDS.writeFailed,
                synced: false,
                refused: digests,
              },
            ]);
          throw err;
        }
        // A put that failed (a newer version, say): read the item again, decide again, try once more.
        const again = await api.get(token, this.#vaultId, [item.id]);
        const fresh = again.items[0];
        if (!fresh) return;
        const reading = onePasswordItemProjection(fresh, push.link.totpFieldId);
        if (!reading.ok) return;
        const theirs = onePasswordDigests(this.#services.custody, push.entry.id, reading.projection);
        const decision = decideOnePasswordPair({
          base: storedBase(push.link.base),
          whombat: digests,
          onepassword: theirs,
        });
        if (decision !== 'take_whombat') return;
        item = fresh;
      }
    }
  }
}

/**
 * Runs one pass for a 1Password connection, as the box's person. Never throws for 1Password's answers: they end in
 * the state the page shows. A database error does throw (the scheduler logs it; the next pass tries again).
 */
export async function runOnePasswordPass(
  services: Services,
  connectionId: string,
  options: PassOptions,
): Promise<PassOutcome> {
  const connection = await connectionRow(services.db, connectionId);
  if (!connection || connection.catalogId !== ONEPASSWORD_CATALOG_ID) return { ran: false, why: 'gone' };
  const person = await thePerson(services.db, connection.burrowId);
  if (!person) return { ran: false, why: 'no_person' };
  const state = await onePasswordState(services.db, connection.id);
  // 1Password's limit: the passes wait until the time kept with the state, a restart included.
  if (state?.nextTryAt && state.nextTryAt.getTime() > services.clock().getTime())
    return { ran: false, why: 'waiting' };
  const token = onePasswordToken(services, connection);
  const vaultId = onePasswordVaultId(connection);
  const pass = new Pass(services, options, {
    connection,
    person,
    token: token ?? '',
    vaultId: vaultId ?? '',
    state,
  });
  if (!token || !vaultId) {
    await pass.record({
      outcome: 'failing',
      problem: token ? ONEPASSWORD_PASS_WORDS.noVault : ONEPASSWORD_PASS_WORDS.token,
      limitHits: 0,
      nextTryAt: null,
    });
    return {
      ran: true,
      outcome: 'failing',
      problem: token ? ONEPASSWORD_PASS_WORDS.noVault : ONEPASSWORD_PASS_WORDS.token,
    };
  }
  return pass.run();
}
