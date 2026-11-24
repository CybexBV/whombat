/**
 * One pass of the 1Password sync (docs/decisions/onepassword-sync.md OPW-20…OPW-28, OPW-04, OPW-61): read first, then
 * commit. It asks for the vault's `contentVersion`; unchanged, with nothing waiting in Whombat, it is done. Otherwise it
 * lists the items, gets those that changed (50 at a time), decides each pair in core with the base's digests, checks
 * the addresses of what will come in, and applies the result in small commits through one Vault command run as the
 * person. Then it writes what Whombat changed into 1Password, worked out from the state rather than a queue: changed
 * pairs (`put` of the item just read), new entries (`create`, with the marker), and removed entries (archive). No
 * 1Password call and no DNS lookup happens while a commit holds the write lock.
 */
import { createHash } from 'node:crypto';
import {
  applyOnePasswordProjection,
  decideOnePasswordPair,
  newOnePasswordItem,
  ONEPASSWORD_GET_BATCH,
  ONEPASSWORD_NOT_IN_VAULT_MAX,
  ONEPASSWORD_WORDS,
  type OnePasswordDigests,
  type OnePasswordItem,
  type OnePasswordItemOverview,
  type OnePasswordProjection,
  type OnePasswordRemovals,
  type OnePasswordSkipReason,
  onePasswordCanonical,
  onePasswordEntryName,
  onePasswordEntryProjection,
  onePasswordItemMarker,
  onePasswordItemProjection,
  onePasswordLimitWaitMs,
  onePasswordRemovalGuard,
  onePasswordSkipText,
  VAULT_ENTRIES_MAX,
  type VaultAuth,
} from '@whombat/core';
import { connectionRow } from '../../connections/store';
import type { CatalogConnectionRow } from '../../connections/types';
import type { OnePasswordNotInVaultRow } from '../../db/schema/index';
import { thePerson } from '../../domain/the-person';
import type { PrincipalRow } from '../../read/principals';
import type { Services } from '../../services';
import { destinationProblem } from '../net';
import { entriesOf, type VaultEntryRow, vaultSecretAad, vaultTotpAad } from '../store';
import {
  applyOnePasswordOps,
  type ItemMark,
  ONEPASSWORD_ENTRY_OPS,
  type OnePasswordOp,
  type OnePasswordOpResult,
  recordOnePasswordPass,
} from './commands';
import { onePasswordDigests, storedBase } from './digests';
import { type OnePasswordApi, OnePasswordError, type OnePasswordFailure } from './pool';
import {
  entryEligible,
  ONEPASSWORD_CATALOG_ID,
  type OnePasswordLinkRow,
  type OnePasswordStateRow,
  onePasswordLinks,
  onePasswordState,
  onePasswordToken,
  onePasswordVaultId,
} from './store';

/** The words of a pass that couldn't finish, by what went wrong (the page's failing line, OPW-50). */
export const ONEPASSWORD_PASS_WORDS = {
  token: '1Password didn’t accept the token. Make a new one and paste it in this connection.',
  vault: 'Whombat can’t find the vault in 1Password any more. Choose it again in this connection.',
  readVault: 'This token can’t read the vault. Make one that can read and write it.',
  noVault: 'Choose the 1Password vault to keep in step.',
  answer: 'An answer from 1Password didn’t read. Whombat tries again soon.',
  stopsFitting: 'No longer kept in step: 1Password has no place for this sign-in.',
  unreachableAddress: 'Whombat may not reach this address',
  writeFailed: 'Whombat couldn’t write this to 1Password. It tries again at the next check.',
} as const;

/** Why an item that was in step can't come in now (OPW-28): “1Password’s item has no website now”. */
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
    default:
      return `1Password’s item can’t come in now: ${onePasswordSkipText(reason).toLowerCase()}`;
  }
}

/** How a pass ended, for the scheduler and tests. */
export type PassOutcome =
  | { ran: false; why: 'gone' | 'no_person' | 'waiting' }
  | { ran: true; outcome: 'ok' | 'paused' | 'waiting' | 'failing'; problem: string | null };

export interface PassOptions {
  api: OnePasswordApi;
  /** In [0, 1): the limit's jitter (OPW-26). */
  random?: () => number;
  /** Filled with the entries the pass changed, so the scheduler tells its own changes from the person's. */
  touched?: Set<string>;
}

/** A change to make in 1Password once the commits are in. */
type Push =
  | { kind: 'create'; entry: VaultEntryRow; projection: OnePasswordProjection; linkId: string | null }
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

/** A pass that stopped on 1Password's answer: limit, refused token, gone vault, unreachable. */
class PassStop extends Error {
  constructor(readonly failure: OnePasswordFailure | 'answer') {
    super(failure);
  }
}

function stopFor(err: unknown): PassStop {
  if (err instanceof PassStop) return err;
  if (err instanceof OnePasswordError) return new PassStop(err.kind);
  // A Zod error: an answer that didn't read.
  return new PassStop('answer');
}

/** The entry's values as both sides compare them, unsealed for this pass only; null when it doesn't sync. */
function entryProjection(
  services: Pick<Services, 'custody'>,
  row: VaultEntryRow,
): OnePasswordProjection | null {
  if (!entryEligible(row)) return null;
  const secret = row.sealed ? services.custody.open(vaultSecretAad(row.id), row.sealed) : null;
  const totp =
    row.kind === 'login' && row.totpSealed
      ? services.custody.open(vaultTotpAad(row.id), row.totpSealed)
      : null;
  return onePasswordEntryProjection({
    kind: row.kind,
    name: row.name,
    url: row.url,
    auth: row.auth as VaultAuth | null,
    secret,
    totp,
  });
}

/** What an entry or item holds, compared by meaning, for pairing an unpaired entry with an unpaired item. */
const sameKey = (p: OnePasswordProjection) => JSON.stringify([p.kind, onePasswordCanonical(p)]);

const sameDigests = (a: OnePasswordDigests | null, b: OnePasswordDigests) =>
  a !== null &&
  Object.keys(b).every((k) => a[k as keyof OnePasswordDigests] === b[k as keyof OnePasswordDigests]);

/** The token naming a set of held removals: the same set keeps its token, so an answer to it still applies. */
function removalsToken(entryIds: readonly string[]): string {
  return createHash('sha256')
    .update([...entryIds].sort().join(','))
    .digest('hex')
    .slice(0, 32);
}

class Pass {
  readonly #services: Services;
  readonly #api: OnePasswordApi;
  readonly #random: () => number;
  readonly #connection: CatalogConnectionRow;
  readonly #person: PrincipalRow;
  readonly #token: string;
  readonly #vaultId: string;
  readonly #state: OnePasswordStateRow | null;
  readonly #touched: Set<string>;
  /** Each link's entry, for telling which entries a batch changed. */
  readonly #linkEntries = new Map<string, string>();
  /** A read-only token is tried once a pass (OPW-04). */
  #triedReadOnly = false;
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
    this.#touched = options.touched ?? new Set();
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
        { connectionId: this.#connection.id, ops: batch },
        { burrowId: this.#connection.burrowId, actorId: this.#person.id },
      );
      if (res.status !== 'ok') throw new Error(`the 1Password sync's commit answered ${res.status}`);
      batch.forEach((op, i) => {
        const result = res.result.results[i];
        const entryId =
          ('entryId' in op ? op.entryId : undefined) ??
          (result?.status === 'done' ? result.entryId : undefined) ??
          ('linkId' in op ? this.#linkEntries.get(op.linkId) : undefined);
        if (entryId) this.#touched.add(entryId);
        if (result?.status === 'done' && result.linkId && result.entryId)
          this.#linkEntries.set(result.linkId, result.entryId);
      });
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
      { connectionId: this.#connection.id, state },
      { burrowId: this.#connection.burrowId, actorId: this.#person.id },
    );
    if (res.status !== 'ok') throw new Error(`the 1Password sync's record answered ${res.status}`);
  }

  /** Ends the pass on a failure: the limit's wait (kept, OPW-26), or the failing line. */
  async fail(stop: PassStop): Promise<PassOutcome> {
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

  async run(): Promise<PassOutcome> {
    const services = this.#services;
    const api = this.#api;
    const token = this.#token;
    const vaultId = this.#vaultId;
    const state = this.#state;

    let overview: Awaited<ReturnType<OnePasswordApi['overview']>>;
    try {
      overview = await api.overview(token, vaultId);
    } catch (err) {
      return this.fail(stopFor(err));
    }

    // Whombat's side, read once (no lock): the person's entries and the pass's links.
    let links = await onePasswordLinks(services.db, this.#connection.id);
    for (const l of links) if (l.entryId) this.#linkEntries.set(l.id, l.entryId);
    // Links of another vault (the connection now names a new one): they go, and the entries follow the new vault.
    const elsewhere = links.filter((l) => l.vaultId !== vaultId);
    if (elsewhere.length) {
      await this.apply(elsewhere.map((l) => ({ op: 'drop' as const, linkId: l.id })));
      links = links.filter((l) => l.vaultId === vaultId);
    }
    const entries = await entriesOf(services.db, this.#connection.burrowId, this.#person.id);
    const entryById = new Map(entries.map((e) => [e.id, e]));
    const linkByEntry = new Map(links.filter((l) => l.entryId).map((l) => [l.entryId as string, l]));
    const projections = new Map<string, OnePasswordProjection | null>();
    const projectionOf = (row: VaultEntryRow) => {
      if (!projections.has(row.id)) projections.set(row.id, entryProjection(services, row));
      return projections.get(row.id) ?? null;
    };
    const whombatDigests = (row: VaultEntryRow) => {
      const p = projectionOf(row);
      return p ? onePasswordDigests(services.custody, row.id, p) : null;
    };
    /** Whether Whombat's side of a pair moved from the base (or the pair has none, or the entry stopped fitting). */
    const whombatMoved = (link: OnePasswordLinkRow): boolean => {
      const row = link.entryId ? entryById.get(link.entryId) : undefined;
      if (!row) return link.itemId !== null;
      const digests = whombatDigests(row);
      return digests === null || !sameDigests(storedBase(link.base), digests);
    };
    const unlinkedEligible = entries.filter((e) => !linkByEntry.has(e.id) && projectionOf(e) !== null);
    const held = state?.notInVault ?? [];
    const waiting =
      links.some((l) => l.state === 'creating') ||
      links.some((l) => l.state === 'synced' && whombatMoved(l)) ||
      unlinkedEligible.length > 0 ||
      (held.some((h) => h.reason === 'vault_full') && entries.length < VAULT_ENTRIES_MAX);
    if (!waiting && state?.contentVersion === overview.contentVersion) {
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
      listed = await api.list(token, vaultId);
    } catch (err) {
      return this.fail(stopFor(err));
    }
    const listedById = new Map(listed.map((o) => [o.id, o]));
    const linkByItem = new Map(links.filter((l) => l.itemId).map((l) => [l.itemId as string, l]));

    // What to read in full: pairs that moved on either side, and items no link has (new ones, a lost create's).
    const toGet = new Set<string>();
    const known = new Map<string, OnePasswordNotInVaultRow>();
    for (const link of links) {
      if (link.state !== 'synced' || !link.itemId || !link.entryId) continue;
      const o = listedById.get(link.itemId);
      if (!o) continue;
      if (link.itemUpdatedAt !== o.updatedAt || whombatMoved(link)) toGet.add(o.id);
    }
    for (const o of listed) {
      if (linkByItem.has(o.id)) continue;
      const before = held.find((h) => h.itemId === o.id);
      // An item that stays out for its own reasons is read again only when it changes; the server's own reasons (a
      // full Vault, an address it may not reach) may change without it.
      if (
        before &&
        before.updatedAt === o.updatedAt &&
        before.reason !== 'vault_full' &&
        before.reason !== 'unreachable'
      ) {
        known.set(o.id, { ...before, title: o.title.slice(0, 200) });
        continue;
      }
      toGet.add(o.id);
    }

    const items = new Map<string, OnePasswordItem>();
    const missing = new Set<string>();
    let listingFailed = false;
    const ids = [...toGet];
    for (let i = 0; i < ids.length; i += ONEPASSWORD_GET_BATCH) {
      const chunk = ids.slice(i, i + ONEPASSWORD_GET_BATCH);
      try {
        const got = await api.get(token, vaultId, chunk);
        for (const item of got.items) items.set(item.id, item);
        for (const id of got.missing) missing.add(id);
        if (got.failed.length) listingFailed = true;
      } catch (err) {
        const stop = stopFor(err);
        if (stop.failure === 'limit' || stop.failure === 'auth' || stop.failure === 'stopped')
          return this.fail(stop);
        listingFailed = true;
      }
    }
    const present = (itemId: string) => listedById.has(itemId) && !missing.has(itemId);

    const ops: OnePasswordOp[] = [];
    const pushes: Push[] = [];
    const notInVault: OnePasswordNotInVaultRow[] = [...known.values()];
    const removalCandidates: { link: OnePasswordLinkRow; entry: VaultEntryRow }[] = [];
    const claimed = new Set<string>();
    const readAt = (row: VaultEntryRow) => row.updatedAt.toISOString();

    // Items no link has, read: by the Whombat entry they say they are (a lost create's, a relinked entry's).
    const unlinkedItems = [...items.values()].filter((i) => !linkByItem.has(i.id));
    const byMarker = new Map<string, OnePasswordItem>();
    for (const item of unlinkedItems) {
      const marker = onePasswordItemMarker(item);
      if (marker && !byMarker.has(marker)) byMarker.set(marker, item);
    }

    for (const link of links) {
      const entry = link.entryId ? entryById.get(link.entryId) : undefined;
      if (link.state === 'creating') {
        if (!entry) {
          ops.push({ op: 'drop', linkId: link.id });
          continue;
        }
        const projection = projectionOf(entry);
        const found = byMarker.get(entry.id);
        if (found) {
          // The create went through before the pass was cut short: that item is this entry's, not a second one.
          claimed.add(found.id);
          const reading = onePasswordItemProjection(found);
          const base = reading.ok ? onePasswordDigests(services.custody, entry.id, reading.projection) : null;
          if (base) ops.push({ op: 'created', linkId: link.id, item: markOf(found), base });
          else ops.push({ op: 'drop', linkId: link.id });
          continue;
        }
        if (projection) pushes.push({ kind: 'create', entry, projection, linkId: link.id });
        else ops.push({ op: 'drop', linkId: link.id });
        continue;
      }
      if (link.state === 'local_only') {
        if (!entry) ops.push({ op: 'drop', linkId: link.id });
        continue;
      }
      // synced
      if (!entry) {
        // Removed in Whombat: archived in 1Password (never deleted), then the link goes (OPW-24).
        if (link.itemId && present(link.itemId)) pushes.push({ kind: 'archive', link, itemId: link.itemId });
        else ops.push({ op: 'drop', linkId: link.id });
        continue;
      }
      const projection = projectionOf(entry);
      if (!projection) {
        // The entry stopped fitting (a header sign-in, say): it stops following; the item stays as it was (OPW-27).
        ops.push({
          op: 'local',
          linkId: link.id,
          readAt: readAt(entry),
          problem: ONEPASSWORD_PASS_WORDS.stopsFitting,
        });
        continue;
      }
      if (!link.itemId) continue;
      if (!present(link.itemId)) {
        // A pair restored from a backup whose item isn't in the vault any more: a Whombat entry like any other (OPW-42).
        if (storedBase(link.base) === null) ops.push({ op: 'drop', linkId: link.id });
        else removalCandidates.push({ link, entry });
        continue;
      }
      const item = items.get(link.itemId);
      if (!item) continue;
      const reading = onePasswordItemProjection(item);
      if (!reading.ok) {
        // The item stopped fitting (its website removed, say): the entry stays as it was, the base too (OPW-28).
        const problem = itemStopsFittingText(reading.reason);
        ops.push({ op: 'mark', linkId: link.id, item: markOf(item), problem, synced: false });
        continue;
      }
      const theirs = onePasswordDigests(services.custody, entry.id, reading.projection);
      const ours = onePasswordDigests(services.custody, entry.id, projection);
      const decision = decideOnePasswordPair({
        base: storedBase(link.base),
        whombat: ours,
        onepassword: theirs,
      });
      if (decision === 'nothing') {
        if (link.itemVersion !== item.version || link.itemUpdatedAt !== item.updatedAt || link.problem)
          ops.push({ op: 'mark', linkId: link.id, item: markOf(item), problem: null, synced: true });
      } else if (decision === 'renew_base') {
        ops.push({
          op: 'mark',
          linkId: link.id,
          item: markOf(item),
          base: theirs,
          problem: null,
          synced: true,
          nameShortened: reading.nameShortened,
        });
      } else if (decision === 'take_onepassword') {
        const where = await destinationProblem(services, reading.projection.url, 'save');
        if (where) {
          // Left as it is until the address may be reached; the item is read again next time.
          ops.push({
            op: 'mark',
            linkId: link.id,
            item: null,
            problem: ONEPASSWORD_PASS_WORDS.unreachableAddress,
            synced: false,
          });
          continue;
        }
        ops.push({
          op: 'pull',
          linkId: link.id,
          entryId: entry.id,
          readAt: readAt(entry),
          projection: reading.projection,
          item: markOf(item),
          nameShortened: reading.nameShortened,
        });
      } else pushes.push({ kind: 'put', link, entry, item, projection });
    }

    // Unpaired items by what they hold, for an unpaired entry holding the same (a vault linked again).
    const bySame = new Map<string, OnePasswordItem>();
    for (const item of unlinkedItems) {
      const reading = onePasswordItemProjection(item);
      if (!reading.ok) continue;
      const key = sameKey(reading.projection);
      if (!bySame.has(key)) bySame.set(key, item);
    }

    // Entries that sync and have no link: an item naming the entry, or holding exactly what it holds, is paired with it
    // (no base: the next pass reads it, and where both agree only the base is written); otherwise an item is made.
    for (const entry of unlinkedEligible) {
      const marked = byMarker.get(entry.id);
      const same = bySame.get(sameKey(projectionOf(entry) as OnePasswordProjection));
      const found = marked && !claimed.has(marked.id) ? marked : same;
      if (found && !claimed.has(found.id)) {
        claimed.add(found.id);
        ops.push({
          op: 'relink',
          entryId: entry.id,
          vaultId,
          item: markOf(found),
          nameShortened: onePasswordEntryName(found.title).shortened,
        });
        continue;
      }
      pushes.push({
        kind: 'create',
        entry,
        projection: projectionOf(entry) as OnePasswordProjection,
        linkId: null,
      });
    }

    // New items: an entry each when it fits, else a line under “Not in your Vault” with why (OPW-14).
    let room = VAULT_ENTRIES_MAX - entries.length;
    for (const item of unlinkedItems) {
      if (claimed.has(item.id)) continue;
      // An item made for an entry the person keeps only in Whombat (linked again with “Keep them only in Whombat”):
      // the entry stays its own and the item stays in 1Password, never a second entry.
      const marker = onePasswordItemMarker(item);
      if (marker && linkByEntry.get(marker)?.state === 'local_only') continue;
      const title = item.title.slice(0, 200);
      const out = (reason: OnePasswordSkipReason) =>
        notInVault.push({ itemId: item.id, title, reason, updatedAt: item.updatedAt });
      const reading = onePasswordItemProjection(item);
      if (!reading.ok) {
        out(reading.reason);
        continue;
      }
      if (room <= 0) {
        out('vault_full');
        continue;
      }
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
      });
    }

    // The guard (OPW-24): an emptied vault or an error never empties the Vault.
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

    // Pulls first (OPW-42: nothing is pushed before this pass has read 1Password), then the pushes.
    const results = await this.apply(ops);
    const full = results.some((r) => r.status === 'full');
    if (full)
      ops.forEach((op, i) => {
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
      try {
        await this.push(push);
      } catch (err) {
        const s = stopFor(err);
        if (s.failure === 'forbidden') {
          // The token can only read (OPW-04): the item stays as it is, pulling goes on, the page says so.
          this.readOnly = true;
          break;
        }
        if (
          s.failure === 'limit' ||
          s.failure === 'auth' ||
          s.failure === 'stopped' ||
          s.failure === 'network'
        )
          stop = s;
        else
          services.log.warn(
            { connectionId: this.#connection.id, kind: s.failure },
            'a 1Password write failed',
          );
      }
    }
    if (stop) return this.fail(stop);

    notInVault.sort((a, b) => a.title.localeCompare(b.title));
    const outcome = removals ? 'paused' : 'ok';
    await this.record({
      vaultTitle: overview.title,
      // A listing that met an error is read in full again next time.
      contentVersion: listingFailed ? null : overview.contentVersion,
      outcome,
      problem: null,
      readOnly: this.readOnly,
      notInVault: notInVault.slice(0, ONEPASSWORD_NOT_IN_VAULT_MAX),
      removals,
      limitHits: 0,
      nextTryAt: null,
    });
    return { ran: true, outcome, problem: null };
  }

  /** One write to 1Password, then its commit: the new version, time and base together (OPW-22). */
  async push(push: Push): Promise<void> {
    const api = this.#api;
    const token = this.#token;
    // A read-only token is tried once a pass: when it can write again, the pushes go on by themselves.
    if (this.readOnly && push.kind !== 'archive' && this.#triedReadOnly) return;
    this.#triedReadOnly = this.readOnly;
    if (push.kind === 'archive') {
      try {
        await api.archive(token, this.#vaultId, push.itemId);
      } catch (err) {
        if (!(err instanceof OnePasswordError && err.kind === 'not_found')) throw err;
      }
      await this.apply([{ op: 'drop', linkId: push.link.id }]);
      return;
    }
    const digests = onePasswordDigests(this.#services.custody, push.entry.id, push.projection);
    this.#touched.add(push.entry.id);
    if (push.kind === 'create') {
      let linkId = push.linkId;
      if (!linkId) {
        // Written before the item is made, so a pass cut short in between finds the item by its marker (OPW-22).
        const [made] = await this.apply([{ op: 'creating', entryId: push.entry.id, vaultId: this.#vaultId }]);
        if (made?.status !== 'done' || !made.linkId) return;
        linkId = made.linkId;
      }
      let item: OnePasswordItem;
      try {
        item = await api.create(
          token,
          newOnePasswordItem({ vaultId: this.#vaultId, entryId: push.entry.id, projection: push.projection }),
        );
      } catch (err) {
        // Refused outright (a token that can only read): nothing was made, so nothing is waiting to be found.
        if (err instanceof OnePasswordError && err.kind === 'forbidden')
          await this.apply([{ op: 'drop', linkId }]);
        throw err;
      }
      this.readOnly = false;
      await this.apply([{ op: 'created', linkId, item: markOf(item), base: digests }]);
      return;
    }
    let item = push.item;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const written = await api.put(token, applyOnePasswordProjection(item, push.projection));
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
          },
        ]);
        return;
      } catch (err) {
        if (!(err instanceof OnePasswordError) || err.kind !== 'failed' || attempt > 0) {
          if (err instanceof OnePasswordError && err.kind === 'failed')
            await this.apply([
              {
                op: 'mark',
                linkId: push.link.id,
                item: null,
                problem: ONEPASSWORD_PASS_WORDS.writeFailed,
                synced: false,
              },
            ]);
          throw err;
        }
        // A put that failed (a newer version, say): read the item again, decide again, try once more (OPW-22).
        const again = await api.get(token, this.#vaultId, [item.id]);
        const fresh = again.items[0];
        if (!fresh) return;
        const reading = onePasswordItemProjection(fresh);
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
  // 1Password's limit: the passes wait until the time kept with the state (OPW-26), a restart included.
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
