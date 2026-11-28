/**
 * A settings copy's summary (docs/decisions/outside-changes.md): for each part of a service's settings (firewall rules,
 * block lists, proxy hosts…) each item by a key and a short hash of what it holds, with secrets and what changes by
 * itself (times, counters) left out before hashing. Two copies' summaries say what changed in counts per part; the
 * settings themselves never leave the copy, and only these counts reach the assistant.
 */
import { createHash } from 'node:crypto';
import type { SettingsPartChange } from '../../db/schema/changes';

/** `<part>/<item key>` → the item's hash. */
export type SettingsSummary = Record<string, string>;

/** The most items a summary keeps. */
const ITEMS_MAX = 5000;

/** A field whose value is a secret: never hashed, never kept. */
export const SECRET_FIELD =
  /password|passwd|passphrase|^pass$|pwhash|secret|token|totp|otp|apikey|api_key|privkey|private|^prv$|psk|bcrypt|authorizedkeys|sshkey|^(cert|crt|key|tlskey)$|[_-]key$/i;

/** A short hash of a value, the same for the same value whatever its keys' order. */
export function itemHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex').slice(0, 16);
}

function canonical(value: unknown): string {
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
 * hash is made of.
 */
export function cleaned(value: unknown, volatile: ReadonlySet<string> = new Set()): unknown {
  if (Array.isArray(value)) return value.map((v) => cleaned(v, volatile));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_FIELD.test(k) || volatile.has(k)) continue;
      out[k] = cleaned(v, volatile);
    }
    return out;
  }
  return value;
}

/** Builds a summary item by item; an item key seen twice in a part gets its number after it. */
export class SummaryBuilder {
  readonly #out: SettingsSummary = {};
  #count = 0;

  add(part: string, key: string, value: unknown): void {
    if (this.#count >= ITEMS_MAX) return;
    const base = `${part}/${key.trim().slice(0, 200) || '-'}`;
    let at = base;
    for (let n = 2; at in this.#out; n++) at = `${base}#${n}`;
    this.#out[at] = itemHash(value);
    this.#count++;
  }

  get summary(): SettingsSummary {
    return this.#out;
  }
}

/** What changed between two summaries, part by part, in the order the parts first appear. */
export function diffSummaries(before: SettingsSummary, after: SettingsSummary): SettingsPartChange[] {
  const parts = new Map<string, SettingsPartChange>();
  const part = (key: string) => {
    const name = key.slice(0, Math.max(0, key.indexOf('/'))) || 'other';
    let p = parts.get(name);
    if (!p) {
      p = { part: name, added: 0, removed: 0, changed: 0 };
      parts.set(name, p);
    }
    return p;
  };
  for (const [key, hash] of Object.entries(after)) {
    const was = before[key];
    if (was === undefined) part(key).added++;
    else if (was !== hash) part(key).changed++;
  }
  for (const key of Object.keys(before)) if (!(key in after)) part(key).removed++;
  return [...parts.values()].filter((p) => p.added || p.removed || p.changed);
}
