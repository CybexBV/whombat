/**
 * A settings copy's summary (docs/decisions/outside-changes.md): for each part of a service's settings (firewall rules,
 * block lists, proxy hosts…) each item by a hash of its key and a short hash of what it holds, with secrets and what
 * changes by itself (times, counters) left out before hashing. Two copies' summaries say what changed in counts per
 * part; the settings themselves, their names and lines included, never leave the copy, and only these counts reach the
 * assistant. Beside the items, a hash of the whole copy's settings with its secrets says whether two copies are the
 * same. On the box every hash is keyed with its master key, so neither a name nor a small value can be guessed back
 * from a list of likely ones.
 */
import { createHash } from 'node:crypto';
import type { SettingsPartChange } from '../../db/schema/changes';
import type { Services } from '../../services';

/** `<part>/~<hash of the item's key>` → the item's hash, and `CONTENT_KEY` → the copy's content hash. */
export type SettingsSummary = Record<string, string>;

/**
 * The summary's one entry that isn't an item: a hash of the settings as copied, secrets in and what changes by itself
 * out. Two copies with the same are the same settings whatever their bytes; a password changed makes them differ,
 * though no item does.
 */
export const CONTENT_KEY = '~content';

/**
 * The summary's mark of how it was made: its hashes keyed on the box and today's list of secret fields. Two summaries
 * with different marks can't be compared item by item (the same value hashes differently, and an item may now be a
 * secret left out), so the first copy after the change is kept as a different one and says nothing changed in it.
 */
export const MADE_KEY = '~made';
const MADE = '2';

/** What is kept of an item's key: a short hash, so names, addresses and whole lines stay in the sealed copy. */
export type KeyHasher = (key: string) => string;

/** How a summary hashes item keys and values (and the whole content). */
export interface CopyHasher {
  key: KeyHasher;
  value: (canonical: string) => string;
}

/** An unkeyed hash, for summaries made without the box (tests). */
export const plainKeyHasher: KeyHasher = (key) =>
  createHash('sha256').update(key, 'utf8').digest('base64url').slice(0, 16);

/** The box's own: keyed with its master key, so a key can't be guessed back from a list of likely names. */
export const copyKeyHasher =
  (services: Pick<Services, 'custody'>): KeyHasher =>
  (key) =>
    services.custody.mac('settings-copy-item', key).slice(0, 16);

/** Unkeyed, for tests. */
export const plainHasher: CopyHasher = {
  key: plainKeyHasher,
  value: (canonical) => createHash('sha256').update(canonical).digest('hex').slice(0, 16),
};

/** The box's own: keys and values (a port, a yes or no, a short name) keyed with its master key. */
export const copyHasher = (services: Pick<Services, 'custody'>): CopyHasher => ({
  key: copyKeyHasher(services),
  value: (canonical) => services.custody.mac('settings-copy-value', canonical).slice(0, 16),
});

const HASHED_KEY = /^~[A-Za-z0-9_-]{16}$/;
const itemKey = (part: string, key: string, hashKey: KeyHasher) => `${part}/~${hashKey(key)}`;

/** The most items a summary keeps. */
const ITEMS_MAX = 5000;

/**
 * A field whose value is a secret: never hashed, never kept. Besides passwords, keys and tokens: SNMP communities, an
 * LDAP server's bind password (`ldap_bindpw`), OpenVPN's static TLS key (`tls`), an IPsec or OpenVPN shared key,
 * credentials, an auth value (`auth`, `basic_auth`; not `author`, `authmode` or Nginx Proxy Manager's `pass_auth`
 * switch), a database DSN, a webhook's address, a session id or cookie (not `session_timeout`) and a seed.
 */
export const SECRET_FIELD =
  /password|passwd|passphrase|^pass$|pwhash|bindpw|secret|token|totp|otp|apikey|api_key|privkey|private|^prv$|psk|sharedkey|community|bcrypt|authorizedkeys|sshkey|^(cert|crt|key|tls|tlskey)$|[_-]key$|credentials?$|(?<!pass_)auth$|auth[_-]?(key|pass|header)$|dsn$|webhook([_-]?ur[il])?$|session[_-]?(id|cookie)s?$|seed([_-]?phrase)?$/i;

/** The text a value's hash is made of, the same for the same value whatever its keys' order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}

/**
 * A value without its secret fields and the fields named in `volatile` (times, counters), at any depth: what an item's
 * hash is made of. With `secrets: 'keep'` only the volatile fields go: what a copy's content hash is made of.
 */
export function cleaned(
  value: unknown,
  volatile: ReadonlySet<string> = new Set(),
  secrets: 'drop' | 'keep' = 'drop',
): unknown {
  if (Array.isArray(value)) return value.map((v) => cleaned(v, volatile, secrets));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if ((secrets === 'drop' && SECRET_FIELD.test(k)) || volatile.has(k)) continue;
      out[k] = cleaned(v, volatile, secrets);
    }
    return out;
  }
  return value;
}

/** Builds a summary item by item; an item key seen twice in a part gets its number after it, then is hashed. */
export class SummaryBuilder {
  readonly #out: SettingsSummary = {};
  readonly #keys = new Set<string>();
  #count = 0;

  constructor(private readonly hasher: CopyHasher = plainHasher) {
    this.#out[MADE_KEY] = MADE;
  }

  add(part: string, key: string, value: unknown): void {
    if (this.#count >= ITEMS_MAX) return;
    const base = key.trim().slice(0, 200) || '-';
    let at = base;
    for (let n = 2; this.#keys.has(`${part}/${at}`); n++) at = `${base}#${n}`;
    this.#keys.add(`${part}/${at}`);
    this.#out[itemKey(part, at, this.hasher.key)] = this.hasher.value(canonical(value));
    this.#count++;
  }

  /** The whole copy's settings, secrets in (`cleaned(…, 'keep')`): `CONTENT_KEY`. */
  content(value: unknown): void {
    this.#out[CONTENT_KEY] = this.hasher.value(canonical(value));
  }

  get summary(): SettingsSummary {
    return this.#out;
  }
}

/** Whether a summary was kept before item keys were hashed: its keys still name the items. */
export function hasClearKeys(summary: SettingsSummary): boolean {
  return Object.keys(summary).some((key) => {
    const at = key.indexOf('/');
    return at >= 0 && !HASHED_KEY.test(key.slice(at + 1));
  });
}

/** A summary with every item's key hashed: one kept before keys were hashed compares with one made now. */
export function hashedSummary(summary: SettingsSummary, hashKey: KeyHasher): SettingsSummary {
  const out: SettingsSummary = {};
  for (const [key, hash] of Object.entries(summary)) {
    const at = key.indexOf('/');
    out[
      at < 0 || HASHED_KEY.test(key.slice(at + 1))
        ? key
        : itemKey(key.slice(0, at), key.slice(at + 1), hashKey)
    ] = hash;
  }
  return out;
}

/**
 * What changed between two summaries, part by part, in the order the parts first appear: nothing told when they were
 * made differently (`MADE_KEY`), as their items can't be compared.
 */
export function diffSummaries(before: SettingsSummary, after: SettingsSummary): SettingsPartChange[] {
  if (before[MADE_KEY] !== after[MADE_KEY]) return [];
  const parts = new Map<string, SettingsPartChange>();
  const part = (key: string) => {
    const name = key.slice(0, key.indexOf('/')) || 'other';
    let p = parts.get(name);
    if (!p) {
      p = { part: name, added: 0, removed: 0, changed: 0 };
      parts.set(name, p);
    }
    return p;
  };
  // Only items count: the content hash (no part) isn't one.
  const item = (key: string) => key.includes('/');
  for (const [key, hash] of Object.entries(after)) {
    if (!item(key)) continue;
    const was = before[key];
    if (was === undefined) part(key).added++;
    else if (was !== hash) part(key).changed++;
  }
  for (const key of Object.keys(before)) if (item(key) && !(key in after)) part(key).removed++;
  return [...parts.values()].filter((p) => p.added || p.removed || p.changed);
}
