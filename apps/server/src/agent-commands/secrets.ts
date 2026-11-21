/**
 * Values the agent holds never show in what it posts (docs/decisions/agent-computer.md AC-32): not in the person's
 * chats, nor in a reply to outsiders (one-person.md OP-17). Every value the agent can get — each entry it holds a key
 * to, in every form the Vault knows (`secretForms`: the value, its URL/JSON/base64 encodings, a login's
 * `user:password`; `sshKeyForms` for an SSH key) — is replaced with `[secret]` in whatever that agent writes, before it
 * is stored or shown.
 *
 * Where it applies (the choke points): every command an agent commits through the pipeline (its messages and replies,
 * edits, plans, run notes, handoffs, approval texts — `scrubAgentInput` on the parsed input) and the activity the
 * runner reports for its turns (`recordActivity`: object, evidence, failure). VT-42's withhold rule for brokered answers
 * stays as it is.
 *
 * The forms are kept per agent in memory and forgotten on every Vault change that could change them (a key given,
 * taken or switched, a secret replaced, an entry removed: `forgetHeldSecrets`), and after five minutes anyway.
 * Values shorter than `SCRUB_MIN_LENGTH` are not looked for: a four-letter value would garble ids and words.
 *
 * A person's assistant has also read what it saved for them from their chat (vault-self-serve.md VS-07): every entry
 * it saved (`vault_entries.saved_by_id`) is scrubbed the same way, and a server's password it used once (VS-11) for the
 * rest of that turn (`rememberTurnSecret`, forgotten when the turn ends: `forgetTurnSecrets`).
 */
import { VAULT_SCRUBBED } from '@whombat/core';
import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { dispatches, vaultEntries, vaultSshServers } from '../db/schema/index';
import type { Services } from '../services';
import { codeDispatches, forgetTurnCodes } from '../vault/login-asks';
import { secretForms } from '../vault/scrub';
import { sshKeyForms } from '../vault/ssh-keys';
import { onForAgent, type VaultEntryRow, vaultSecretAad, vaultServerPasswordAad } from '../vault/store';

/** The shortest value scrubbed (AC-D: shorter ones would replace parts of ordinary words and ids). */
export const SCRUB_MIN_LENGTH = 6;

/** How long an agent's forms are kept without a Vault change. */
const CACHE_MS = 5 * 60_000;

interface Cached {
  needles: string[];
  at: number;
}

const caches = new WeakMap<Services, Map<string, Cached>>();

function cacheOf(services: Services): Map<string, Cached> {
  let cache = caches.get(services);
  if (!cache) {
    cache = new Map();
    caches.set(services, cache);
  }
  return cache;
}

/** Values an agent used once in a turn (a server's password, VS-11), by agent, then dispatch. */
const turnSecrets = new WeakMap<Services, Map<string, Map<string, string[]>>>();

/** Scrubs a value from what the agent writes until its turn ends (VS-11: a server's password used once). */
export function rememberTurnSecret(
  services: Services,
  agentId: string,
  dispatchId: string,
  value: string,
): void {
  let byAgent = turnSecrets.get(services);
  if (!byAgent) {
    byAgent = new Map();
    turnSecrets.set(services, byAgent);
  }
  const byDispatch = byAgent.get(agentId) ?? new Map<string, string[]>();
  const forms = secretForms({ secret: value }).filter((f) => f.length >= SCRUB_MIN_LENGTH);
  byDispatch.set(dispatchId, [...new Set([...(byDispatch.get(dispatchId) ?? []), ...forms])]);
  byAgent.set(agentId, byDispatch);
}

/** The turns that ended forget what they used once. */
export function forgetTurnSecrets(services: Services, dispatchIds: readonly string[]): void {
  // A one-time code the person typed for the turn goes with it too (vault-simplify.md VLT-44).
  forgetTurnCodes(services, dispatchIds);
  const byAgent = turnSecrets.get(services);
  if (!byAgent) return;
  for (const [agentId, byDispatch] of byAgent) {
    for (const id of dispatchIds) byDispatch.delete(id);
    if (byDispatch.size === 0) byAgent.delete(agentId);
  }
}

/** The turns holding a value used once (the orphan sweep asks which still run). */
export function turnSecretDispatches(services: Services): string[] {
  return [
    ...[...(turnSecrets.get(services)?.values() ?? [])].flatMap((byDispatch) => [...byDispatch.keys()]),
    ...codeDispatches(services),
  ];
}

/** What turns that no longer run (claimed or running) used once is forgotten (the orphan sweep, VS-11). */
export async function forgetEndedTurnSecrets(services: Services): Promise<void> {
  const tracked = [...new Set(turnSecretDispatches(services))];
  if (!tracked.length) return;
  const rows = await services.db
    .select({ id: dispatches.id, state: dispatches.state })
    .from(dispatches)
    .where(inArray(dispatches.id, tracked));
  const live = new Set(rows.filter((r) => r.state === 'claimed' || r.state === 'running').map((r) => r.id));
  forgetTurnSecrets(
    services,
    tracked.filter((id) => !live.has(id)),
  );
}

function turnNeedles(services: Services, agentId: string): string[] {
  return [...(turnSecrets.get(services)?.get(agentId)?.values() ?? [])].flat();
}

/** Forgets the forms (an agent's, or everyone's): call after any change to Vault keys or secrets. */
export function forgetHeldSecrets(services: Services, agentId?: string): void {
  const cache = caches.get(services);
  if (!cache) return;
  if (agentId) cache.delete(agentId);
  else cache.clear();
}

/**
 * Every form of one entry's value, longest first: `secretForms` for a valued entry (with a login's or basic auth's
 * username), `sshKeyForms` for an SSH key. Empty for an entry without a value.
 */
export function entryValueForms(services: Services, entry: VaultEntryRow): string[] {
  if (entry.sealed === null) return [];
  const value = services.custody.open(vaultSecretAad(entry.id), entry.sealed);
  if (entry.kind === 'ssh') {
    const forms = sshKeyForms(entry.id, value);
    return [...new Set([...forms.forms, ...forms.aligned])].sort((a, b) => b.length - a.length);
  }
  const auth = entry.auth as { type?: string; username?: string } | null;
  const username = auth?.type === 'basic' || auth?.type === 'form' ? auth.username : undefined;
  return secretForms({ secret: value, username });
}

/**
 * The forms to scrub from what this agent writes: the values its keys deliver and those it saved for its person (cached),
 * and what it used once in a turn that is still going.
 */
export async function heldNeedles(services: Services, db: Db | Tx, agentId: string): Promise<string[]> {
  const once = turnNeedles(services, agentId);
  const cached = await storedNeedles(services, db, agentId);
  if (!once.length) return cached;
  return [...new Set([...cached, ...once])].sort((a, b) => b.length - a.length);
}

async function storedNeedles(services: Services, db: Db | Tx, agentId: string): Promise<string[]> {
  const cache = cacheOf(services);
  const hit = cache.get(agentId);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_MS) return hit.needles;
  const [held, saved] = await Promise.all([
    db
      .select({ entry: vaultEntries })
      .from(vaultEntries)
      // Every entry switched on reaches the agent in the person's turns (HE-43): its commands, its tools, its browser.
      .where(and(onForAgent(agentId), ne(vaultEntries.kind, 'secret'))),
    // What it saved from the person's chat (VS-07), whether or not it is still switched on.
    db.select({ entry: vaultEntries }).from(vaultEntries).where(eq(vaultEntries.savedById, agentId)),
  ]);
  // A server's kept password reaches the commands with its key (vault-simplify.md VLT-42): scrubbed the same way.
  const sshIds = held.filter((r) => r.entry.kind === 'ssh').map((r) => r.entry.id);
  const kept = sshIds.length
    ? await db
        .select({
          id: vaultSshServers.id,
          entryId: vaultSshServers.entryId,
          sealed: vaultSshServers.passwordSealed,
        })
        .from(vaultSshServers)
        .where(and(inArray(vaultSshServers.entryId, sshIds), isNotNull(vaultSshServers.passwordSealed)))
    : [];
  const needles = [
    ...new Set(
      [
        ...[...held, ...saved].flatMap((r) => entryValueForms(services, r.entry)),
        ...kept.flatMap((k) => secretForms({ secret: openKept(services, k) })),
      ].filter((f) => f.length >= SCRUB_MIN_LENGTH),
    ),
  ].sort((a, b) => b.length - a.length);
  cache.set(agentId, { needles, at: now });
  return needles;
}

/** A server's kept password, or '' when it doesn't open (nothing to look for). */
function openKept(services: Services, k: { id: string; entryId: string; sealed: string | null }): string {
  try {
    return k.sealed ? services.custody.open(vaultServerPasswordAad(k.entryId, k.id), k.sealed) : '';
  } catch {
    return '';
  }
}

/** A text with every needle replaced by `[secret]`. */
export function scrubWith(text: string, needles: readonly string[]): string {
  let out = text;
  for (const needle of needles) if (out.includes(needle)) out = out.split(needle).join(VAULT_SCRUBBED);
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Every string of a value scrubbed (arrays and plain objects walked, keys kept; other objects left as they are). */
export function scrubValue<T>(value: T, needles: readonly string[]): T {
  if (!needles.length) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return scrubWith(v, needles);
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[k] = walk(inner);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** What an agent wrote, scrubbed of the values it holds (unchanged for an agent that holds no key). */
export async function scrubForAgent<T>(
  services: Services,
  db: Db | Tx,
  agentId: string,
  value: T,
): Promise<T> {
  const needles = await heldNeedles(services, db, agentId);
  return scrubValue(value, needles);
}
