/**
 * Secrets in answers (docs/decisions/vault.md VT-42, amended by VT-D20…VT-D22).
 *
 * - **Forms.** Core's `vaultSecretForms` (the value, its URL encodings, its JSON-escaped form, base64 and a login's
 *   `username:password` base64) plus the JSON escapes servers really write: `\/` for `/`, `\uXXXX` for non-ASCII
 *   (Python's `ensure_ascii`), for `<`, `>`, `&` (Go's encoder) and for every character, in lower- and uppercase hex.
 * - **Withheld, not scrubbed.** An answer that holds any form is withheld whole (`holdsSecret`, `bytesHoldSecret`):
 *   scrubbing an echo would tell an agent where the secret was, and a server that reflects the agent's own input
 *   would let it test guesses. The scrubbing functions stay for text the person sees (a check's tool list) and as a
 *   second line.
 * - **Cut after checking.** Callers check the whole answer, then cut it (`cutText`) and drop any tail that is the start
 *   of a form, so a cut can never reveal part of one.
 */
import { VAULT_SCRUBBED, vaultSecretForms } from '@whombat/core';

export interface SecretForms {
  secret: string;
  username?: string | undefined;
}

const hex = (code: number, upper: boolean) => {
  const h = code.toString(16).padStart(4, '0');
  return `\\u${upper ? h.toUpperCase() : h}`;
};

/** The JSON-escaped variants core doesn't list: `\/`, `\uXXXX` for non-ASCII, HTML characters or everything. */
function jsonForms(value: string): string[] {
  const json = JSON.stringify(value).slice(1, -1);
  const out: string[] = [json.replace(/\//g, '\\/')];
  for (const upper of [false, true]) {
    const ascii = json.replace(/[\u007f-\uffff]/g, (c) => hex(c.charCodeAt(0), upper));
    const html = json.replace(/[<>&\u2028\u2029]/g, (c) => hex(c.charCodeAt(0), upper));
    const both = ascii.replace(/[<>&]/g, (c) => hex(c.charCodeAt(0), upper));
    let all = '';
    for (let i = 0; i < value.length; i++) all += hex(value.charCodeAt(i), upper);
    out.push(ascii, ascii.replace(/\//g, '\\/'), html, both, both.replace(/\//g, '\\/'), all);
  }
  return out;
}

/** Every form of one secret, longest first (VT-42 with VT-D21's JSON escapes). */
export function secretForms(s: SecretForms): string[] {
  if (!s.secret) return [];
  const forms = new Set(vaultSecretForms(s.secret, s.username));
  for (const f of jsonForms(s.secret)) if (f) forms.add(f);
  return [...forms].sort((a, b) => b.length - a.length);
}

function allForms(secrets: readonly SecretForms[]): string[] {
  return [...new Set(secrets.flatMap(secretForms))].sort((a, b) => b.length - a.length);
}

/** Whether a text holds any form of any secret. */
export function holdsSecret(text: string, secrets: readonly SecretForms[]): boolean {
  return allForms(secrets).some((f) => text.includes(f));
}

/** Whether raw bytes hold any form of any secret (as UTF-8). */
export function bytesHoldSecret(body: Buffer, secrets: readonly SecretForms[]): boolean {
  return allForms(secrets).some((f) => body.indexOf(Buffer.from(f, 'utf8')) !== -1);
}

/** Whether any string of a JSON value (keys too) holds a form. */
export function jsonHoldsSecret(value: unknown, secrets: readonly SecretForms[]): boolean {
  return holdsSecret(JSON.stringify(value) ?? '', secrets) || holdsSecret(flatten(value), secrets);
}

function flatten(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flatten).join('\n');
  if (value && typeof value === 'object')
    return Object.entries(value)
      .map(([k, v]) => `${k}\n${flatten(v)}`)
      .join('\n');
  return '';
}

/** Scrubs a text with every secret given (a pack attachment may bind several). */
export function scrubText(text: string, secrets: readonly SecretForms[]): string {
  let out = text;
  for (const form of allForms(secrets)) out = out.split(form).join(VAULT_SCRUBBED);
  return out;
}

/** Scrubs every string of a JSON value (keys too). */
export function scrubJson<T>(value: T, secrets: readonly SecretForms[]): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return scrubText(v, secrets);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[scrubText(k, secrets)] = walk(inner);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/**
 * The length of the longest tail of `text` that is a proper start of `form` (0 when none), in linear time: the prefix
 * function of `form` + a separator + the last `form.length - 1` characters of `text`.
 */
export function startTail(text: string, form: string): number {
  if (form.length < 2 || !text) return 0;
  const tail = text.slice(-(form.length - 1));
  const joined = `${form}\u0000${tail}`;
  const pi = new Array<number>(joined.length).fill(0);
  for (let i = 1; i < joined.length; i++) {
    let k = pi[i - 1] ?? 0;
    while (k > 0 && joined[i] !== joined[k]) k = pi[k - 1] ?? 0;
    if (joined[i] === joined[k]) k++;
    pi[i] = k;
  }
  // A border longer than the tail spans the separator (a form holding U+0000): follow the chain down to one inside it.
  let k = pi[joined.length - 1] ?? 0;
  while (k > tail.length) k = pi[k - 1] ?? 0;
  return Math.min(k, form.length - 1);
}

/** The longest tail of `text` that starts any form (0 when none). */
function formTail(text: string, forms: readonly string[]): number {
  return forms.reduce((n, f) => Math.max(n, startTail(text, f)), 0);
}

/**
 * A checked text cut to `maxBytes` (UTF-8), without a tail that starts a form. `cut`: it was longer.
 */
export function cutText(
  text: string,
  maxBytes: number,
  secrets: readonly SecretForms[],
): { text: string; cut: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, cut: false };
  let out = Buffer.from(text).subarray(0, maxBytes).toString('utf8');
  // A character split by the cut decodes as U+FFFD: drop it.
  if (out.endsWith('�')) out = out.slice(0, -1);
  const tail = formTail(out, allForms(secrets));
  return { text: tail ? out.slice(0, -tail) : out, cut: true };
}

/**
 * Request headers with the credential added last (VT-41): any header of the same name, whatever its case, is replaced,
 * so nothing sent before it can shadow or duplicate the credential.
 */
export function withCredentialHeaders(
  headers: Readonly<Record<string, string>>,
  credential: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = { 'User-Agent': 'Whombat Vault' };
  const names = new Set(Object.keys(credential).map((n) => n.toLowerCase()));
  for (const [name, value] of Object.entries(headers)) {
    if (names.has(name.toLowerCase())) continue;
    for (const k of Object.keys(out)) if (k.toLowerCase() === name.toLowerCase()) delete out[k];
    out[name] = value;
  }
  for (const [name, value] of Object.entries(credential)) {
    for (const k of Object.keys(out)) if (k.toLowerCase() === name.toLowerCase()) delete out[k];
    out[name] = value;
  }
  return out;
}
