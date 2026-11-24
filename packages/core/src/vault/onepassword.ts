/**
 * A 1Password vault kept in step with the Vault, both ways (docs/decisions/onepassword-sync.md): what a 1Password item
 * looks like once 1Password's SDK has read it, the few fields both sides share and how they are compared, how an item
 * becomes an entry (or why it can't), how a change from Whombat is written into an item without losing what only
 * 1Password holds, how a pair is decided, and the guard that keeps an emptied vault from emptying the Vault. Pure: no
 * I/O and no SDK. The server's worker talks to 1Password, the server computes the base's HMACs and hands this module
 * their digests as strings.
 *
 * Facts about 1Password come from its own sources, read 2026-11-24:
 * - the SDK's types (`Item`, `ItemField`, `ItemFieldType`, `ItemCategory`, `ItemSection`, `Website`, `ItemOverview`,
 *   `VaultOverview`): https://github.com/1Password/onepassword-sdk-js/blob/v0.5.0/client/src/types.ts (the same at main);
 * - a Login's built-in fields `username` and `password`, without a section: https://www.1password.dev/cli/item-fields
 *   (“Built-in fields”, the Login template) and https://www.1password.dev/sdks/manage-items (“use the appropriate
 *   built-in field ids”; custom fields need a section, and a one-time password is a `Totp` field holding an
 *   `otpauth://` link);
 * - an API Credential's built-in fields `credential`, `username` and `hostname`, without a section: 1Password's own
 *   Terraform provider reads them by those ids (terraform-provider-onepassword, internal/provider/
 *   onepassword_item_data_source.go, and its API Credential test item in test/e2e/item_data_source_test.go).
 */
import { z } from 'zod';
import { VaultEntryId } from '../ids.js';
import { parseVaultUrl, vaultEntryAddress } from './network.js';
import { vaultSecretProblem } from './request.js';
import {
  VAULT_NAME_MAX,
  VAULT_SECRET_MAX,
  VAULT_URL_MAX,
  type VaultAuth,
  type VaultEntryKind,
  VaultUsername,
} from './schemas.js';
import { parseVaultTotp, VAULT_TOTP_DEFAULTS, type VaultTotp, vaultTotpCanonical } from './totp.js';

type EntryId = z.infer<typeof VaultEntryId>;

/* 1Password's own shapes ------------------------------------------------------------------------- */

/** An item's or a vault's id as 1Password gives it (26 letters and digits today); kept loose so a longer one parses. */
export const OnePasswordItemId = z.string().regex(/^[A-Za-z0-9]{1,64}$/);
export type OnePasswordItemId = z.infer<typeof OnePasswordItemId>;
export const OnePasswordVaultId = OnePasswordItemId;
export type OnePasswordVaultId = z.infer<typeof OnePasswordVaultId>;

/** The SDK's `ItemCategory` values Whombat reads. Categories are open text: a newer SDK's is another kind. */
export const ONEPASSWORD_CATEGORIES = {
  login: 'Login',
  apiCredentials: 'ApiCredentials',
  sshKey: 'SshKey',
} as const;

/** The SDK's `ItemFieldType` values Whombat reads or writes. */
export const ONEPASSWORD_FIELD_TYPES = {
  text: 'Text',
  concealed: 'Concealed',
  totp: 'Totp',
} as const;

/** The built-in fields Whombat maps, by their ids (sources at the top of this file). */
export const ONEPASSWORD_FIELD_IDS = {
  username: 'username',
  password: 'password',
  credential: 'credential',
  hostname: 'hostname',
} as const;

/**
 * Where a new item says it is a Whombat entry: a “Whombat entry” field in a “Whombat” section, holding the entry's id.
 * A pass that was interrupted after creating finds its item by it instead of making a second one.
 */
export const ONEPASSWORD_MARKER = {
  sectionId: 'whombat',
  sectionTitle: 'Whombat',
  fieldId: 'whombatentry',
  fieldTitle: 'Whombat entry',
} as const;

/**
 * The SDK's objects arrive as JSON from the worker: dates as ISO text, and every member Whombat doesn't name kept as it
 * is (a field's details, an item's files and document), so an item put back loses nothing.
 */
export const OnePasswordItemField = z.looseObject({
  id: z.string(),
  title: z.string(),
  /**
   * Null for built-in fields (a Login's username and password): that is what the SDK answers (checked against a real
   * account); absent or empty is taken the same way.
   */
  sectionId: z.string().nullish(),
  fieldType: z.string(),
  value: z.string(),
});
export type OnePasswordItemField = z.infer<typeof OnePasswordItemField>;

export const OnePasswordItemSection = z.looseObject({ id: z.string(), title: z.string() });
export type OnePasswordItemSection = z.infer<typeof OnePasswordItemSection>;

export const OnePasswordWebsite = z.looseObject({
  url: z.string(),
  label: z.string(),
  /** `AnywhereOnWebsite`, `ExactDomain` or `Never`. */
  autofillBehavior: z.string(),
});
export type OnePasswordWebsite = z.infer<typeof OnePasswordWebsite>;

/** The SDK's `Item`. */
export const OnePasswordItem = z.looseObject({
  id: OnePasswordItemId,
  title: z.string(),
  category: z.string(),
  vaultId: OnePasswordVaultId,
  fields: z.array(OnePasswordItemField),
  sections: z.array(OnePasswordItemSection),
  notes: z.string(),
  tags: z.array(z.string()),
  websites: z.array(OnePasswordWebsite),
  /** What a `put` must carry back; a put with an older one is refused. */
  version: z.number().int().nonnegative(),
  files: z.array(z.unknown()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OnePasswordItem = z.infer<typeof OnePasswordItem>;

/** The SDK's `ItemOverview`: what listing a vault gives, without secrets. `state` is `active` or `archived`. */
export const OnePasswordItemOverview = z.looseObject({
  id: OnePasswordItemId,
  title: z.string(),
  category: z.string(),
  vaultId: OnePasswordVaultId,
  websites: z.array(OnePasswordWebsite).default([]),
  tags: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  state: z.string(),
});
export type OnePasswordItemOverview = z.infer<typeof OnePasswordItemOverview>;

/** The SDK's `VaultOverview`: `contentVersion` grows whenever an item in it changes. */
export const OnePasswordVaultOverview = z.looseObject({
  id: OnePasswordVaultId,
  title: z.string(),
  description: z.string().default(''),
  vaultType: z.string(),
  activeItemCount: z.number().int().nonnegative(),
  contentVersion: z.number().int().nonnegative(),
  attributeVersion: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OnePasswordVaultOverview = z.infer<typeof OnePasswordVaultOverview>;

/** A new item as the SDK's `items.create` takes it (`ItemCreateParams`). */
export const OnePasswordNewItem = z.object({
  category: z.string(),
  vaultId: OnePasswordVaultId,
  title: z.string(),
  fields: z.array(OnePasswordItemField),
  sections: z.array(OnePasswordItemSection),
  websites: z.array(OnePasswordWebsite),
  tags: z.array(z.string()),
  notes: z.string(),
});
export type OnePasswordNewItem = z.infer<typeof OnePasswordNewItem>;

/* Timing and limits ------------------------------------------------------------------------------ */

/** A pass while nothing asks for one: about 144 reads a day, inside the smallest plans' 1,000. */
export const ONEPASSWORD_PASS_EVERY_MS = 10 * 60_000;
/** How long after a change to a synced entry its pass starts, so a few changes make one pass. */
export const ONEPASSWORD_CHANGE_DELAY_MS = 10_000;
/** Items fetched in one `getAll` (the SDK's most). */
export const ONEPASSWORD_GET_BATCH = 50;
/** Entries changed in one commit of a pass. */
export const ONEPASSWORD_COMMIT_ENTRIES_MAX = 10;
/** Items kept in “Not in your Vault”. */
export const ONEPASSWORD_NOT_IN_VAULT_MAX = 200;
/** The worker stops after this long without work. */
export const ONEPASSWORD_WORKER_IDLE_MS = 15 * 60_000;
/** After “too many requests”: the first wait, doubling each time up to the last. */
export const ONEPASSWORD_LIMIT_WAIT_FIRST_MS = 15 * 60_000;
export const ONEPASSWORD_LIMIT_WAIT_MAX_MS = 2 * 60 * 60_000;

/**
 * How long the passes wait after 1Password's limit was hit `attempt` times in a row (0 the first): 15 minutes, doubling,
 * at most 2 hours, each shortened by up to a tenth at random (`random` in [0, 1)) so several Whombats sharing an
 * account don't come back at the same moment. Never longer than 2 hours.
 */
export function onePasswordLimitWaitMs(attempt: number, random: number): number {
  const doublings = Math.max(0, Math.min(Math.floor(attempt), 8));
  const base = Math.min(ONEPASSWORD_LIMIT_WAIT_FIRST_MS * 2 ** doublings, ONEPASSWORD_LIMIT_WAIT_MAX_MS);
  const r = Math.max(0, Math.min(random, 1));
  return Math.round(base * (1 - 0.1 * r));
}

/* What both sides share ---------------------------------------------------------------------------- */

/** The fields compared and kept in step, in order. */
export const ONEPASSWORD_SYNC_FIELDS = ['name', 'url', 'username', 'secret', 'totp'] as const;
export type OnePasswordSyncField = (typeof ONEPASSWORD_SYNC_FIELDS)[number];

/** The entry kinds that sync: a Login ↔ a `login` entry, an API Credential ↔ an `http` entry with bearer or basic. */
export type OnePasswordSyncKind = Extract<VaultEntryKind, 'login' | 'http'>;

/**
 * An entry or an item as both sides see it. `url` is the sign-in page (a Login's first website) or the API's address
 * (an API Credential's hostname); `username` is a login's, or basic's (null: a bearer token); `totp` is a login's
 * authenticator key in `vaultTotpCanonical`'s form (null: none, and always null for an API token).
 */
export interface OnePasswordProjection {
  kind: OnePasswordSyncKind;
  name: string;
  url: string;
  username: string | null;
  secret: string;
  totp: string | null;
}

/** Each field's canonical text: what the base's HMAC is taken of, and what two sides are compared by. */
export type OnePasswordCanonical = Readonly<Record<OnePasswordSyncField, string>>;

/** An address as compared: `parseVaultUrl`'s origin and path without a trailing slash; else the text trimmed. */
export function onePasswordCanonicalUrl(url: string): string {
  const parsed = parseVaultUrl(url);
  return parsed.ok ? `${parsed.url.origin}${parsed.url.basePath}` : url.trim();
}

/** An authenticator key as compared: its secret, algorithm, digits and period, never its label; else the text. */
export function onePasswordCanonicalTotp(totp: string | null): string {
  if (totp === null || totp.trim() === '') return '';
  const parsed = parseVaultTotp(totp);
  return parsed.ok ? vaultTotpCanonical(parsed.totp) : totp.trim();
}

/**
 * The canonical form of each field (names trimmed, addresses by `parseVaultUrl`, usernames and secrets as they are,
 * authenticator keys by `vaultTotpCanonical`). Compared as text, Whombat's own normal forms would look like a change on
 * every pass. An absent username or key is the empty text, which no real value can be.
 */
export function onePasswordCanonical(p: OnePasswordProjection): OnePasswordCanonical {
  return {
    name: p.name.trim(),
    url: onePasswordCanonicalUrl(p.url),
    username: p.username ?? '',
    secret: p.secret,
    totp: onePasswordCanonicalTotp(p.totp),
  };
}

/** The fields whose canonical text differs between two sides, in `ONEPASSWORD_SYNC_FIELDS` order. */
export function onePasswordChangedFields(
  a: OnePasswordCanonical,
  b: OnePasswordCanonical,
): OnePasswordSyncField[] {
  return ONEPASSWORD_SYNC_FIELDS.filter((f) => a[f] !== b[f]);
}

/* Why an item isn't in the Vault ------------------------------------------------------------------- */

/**
 * Why an item stays only in 1Password, shown under “Not in your Vault”. Most are read from the item here; `unreachable`
 * (the address's DNS, checked by the server before the commit), `vault_full` (50 entries) and `unreadable` (1Password
 * answered twice in a row that it couldn't give the item) are the server's.
 */
export const ONEPASSWORD_SKIP_REASONS = [
  'no_website',
  'no_hostname',
  'no_username',
  'no_password',
  'no_credential',
  'bad_address',
  'unreachable',
  'bad_totp',
  'too_long',
  'bad_value',
  'vault_full',
  'ssh_key',
  'other_kind',
  'unreadable',
] as const;
export const OnePasswordSkipReason = z.enum(ONEPASSWORD_SKIP_REASONS);
export type OnePasswordSkipReason = z.infer<typeof OnePasswordSkipReason>;

export const ONEPASSWORD_SKIP_TEXT: Record<OnePasswordSkipReason, string> = {
  no_website: 'No website',
  no_hostname: 'No hostname',
  no_username: 'No username',
  no_password: 'No password',
  no_credential: 'No credential',
  bad_address: 'Whombat can’t use this address',
  unreachable: 'Whombat may not reach this address',
  bad_totp: 'Whombat can’t read its one-time password',
  too_long: 'Too long for your Vault',
  bad_value: 'It holds characters Whombat can’t use',
  vault_full: 'Your Vault is full',
  ssh_key: 'SSH keys stay in 1Password',
  other_kind: 'Only logins and API credentials come in',
  unreadable: 'Whombat couldn’t read this item',
};

/* Reading an item ------------------------------------------------------------------------------------ */

const isBuiltIn = (f: OnePasswordItemField) => f.sectionId == null || f.sectionId === '';

/** A built-in field by its id: the one without a section first, as 1Password keeps them, else any with that id. */
function builtInField(fields: readonly OnePasswordItemField[], id: string): OnePasswordItemField | undefined {
  return fields.find((f) => f.id === id && isBuiltIn(f)) ?? fields.find((f) => f.id === id);
}

/** The first one-time password field with a value: the one a pair that follows none yet takes. */
function totpField(fields: readonly OnePasswordItemField[]): OnePasswordItemField | undefined {
  return fields.find((f) => f.fieldType === ONEPASSWORD_FIELD_TYPES.totp && f.value.trim() !== '');
}

/**
 * The one-time password field a login's authenticator key maps to: the one the pair follows (`followed`, its id), else
 * the first with a value. A followed field that is gone is never replaced by another one-time password field of the
 * item: the key is then none.
 */
export function onePasswordTotpField(
  fields: readonly OnePasswordItemField[],
  followed: string | null = null,
): OnePasswordItemField | undefined {
  if (followed === null) return totpField(fields);
  return fields.find((f) => f.id === followed && f.fieldType === ONEPASSWORD_FIELD_TYPES.totp);
}

/** The field id a pair follows after reading an item: the one it followed, else the field it takes now (null: none). */
export function onePasswordTotpFieldId(
  item: Pick<OnePasswordItem, 'category' | 'fields'>,
  followed: string | null,
): string | null {
  if (followed !== null) return followed;
  if (item.category !== ONEPASSWORD_CATEGORIES.login) return null;
  return totpField(item.fields)?.id ?? null;
}

/**
 * An address from 1Password as the Vault holds it: a bare host gets `https://`, and `?…` and `#…` go (the Vault's
 * addresses never hold them; a sign-in page is the same page without its tracking). Null when empty.
 */
export function onePasswordAddress(raw: string): string | null {
  const text = raw.trim();
  if (text === '') return null;
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`;
  return withScheme.replace(/[?#].*$/, '');
}

/**
 * A title as an entry's name: trimmed, and when longer than the Vault's 60 characters cut with “…” (never inside a
 * character). `shortened` says so: the link keeps it, and the shortened name is never pushed back over the title.
 */
export function onePasswordEntryName(title: string): { name: string; shortened: boolean } {
  const text = title.trim();
  if (text.length <= VAULT_NAME_MAX) return { name: text, shortened: false };
  let cut = text.slice(0, VAULT_NAME_MAX - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { name: `${cut.trimEnd()}…`, shortened: true };
}

/** What an item gives: its projection, or why it stays only in 1Password. */
export type OnePasswordItemReading =
  | { ok: true; projection: OnePasswordProjection; nameShortened: boolean }
  | { ok: false; reason: OnePasswordSkipReason };

function readAddress(
  raw: string | undefined,
  missing: OnePasswordSkipReason,
): { ok: true; url: string } | { ok: false; reason: OnePasswordSkipReason } {
  const url = onePasswordAddress(raw ?? '');
  if (url === null) return { ok: false, reason: missing };
  if (url.length > VAULT_URL_MAX) return { ok: false, reason: 'too_long' };
  return parseVaultUrl(url).ok ? { ok: true, url } : { ok: false, reason: 'bad_address' };
}

/** Why a username can't sign in from the Vault, or null. */
function usernameProblem(username: string): OnePasswordSkipReason | null {
  if (VaultUsername.safeParse(username).success) return null;
  return username.length > 200 ? 'too_long' : 'bad_value';
}

/** Why a secret can't be held for this kind of sign-in, or null. */
function secretProblem(secret: string, auth: VaultAuth['type']): OnePasswordSkipReason | null {
  if (secret.length > VAULT_SECRET_MAX) return 'too_long';
  return vaultSecretProblem({ type: auth }, secret) ? 'bad_value' : null;
}

/**
 * Why an item of this category stays in 1Password, or null for a Login and an API Credential: read from the list's
 * overview, so such an item is never fetched.
 */
export function onePasswordCategorySkip(category: string): OnePasswordSkipReason | null {
  if (category === ONEPASSWORD_CATEGORIES.sshKey) return 'ssh_key';
  if (category === ONEPASSWORD_CATEGORIES.login || category === ONEPASSWORD_CATEGORIES.apiCredentials)
    return null;
  return 'other_kind';
}

/**
 * An item as an entry would hold it, or why it can't be one. A Login needs a website, a username and a password; an API
 * Credential a hostname and a credential (a username makes it basic, none bearer). An SSH key and every other category
 * stay in 1Password. A title too long for the Vault is shortened; an empty one takes the address's host.
 */
export function onePasswordItemProjection(
  item: Pick<OnePasswordItem, 'title' | 'category' | 'fields' | 'websites'>,
  /** The one-time password field the pair follows (`onePasswordTotpField`); null: the first with a value. */
  totpFieldId: string | null = null,
): OnePasswordItemReading {
  const fail = (reason: OnePasswordSkipReason): OnePasswordItemReading => ({ ok: false, reason });
  const outside = onePasswordCategorySkip(item.category);
  if (outside) return fail(outside);
  const login = item.category === ONEPASSWORD_CATEGORIES.login;
  const address = login
    ? readAddress(item.websites.find((w) => w.url.trim() !== '')?.url, 'no_website')
    : readAddress(builtInField(item.fields, ONEPASSWORD_FIELD_IDS.hostname)?.value, 'no_hostname');
  if (!address.ok) return fail(address.reason);
  const url = address.url;
  const secret =
    builtInField(item.fields, login ? ONEPASSWORD_FIELD_IDS.password : ONEPASSWORD_FIELD_IDS.credential)
      ?.value ?? '';
  if (secret === '') return fail(login ? 'no_password' : 'no_credential');
  const rawUsername = builtInField(item.fields, ONEPASSWORD_FIELD_IDS.username)?.value ?? '';
  const username = rawUsername === '' ? null : rawUsername;
  if (login && username === null) return fail('no_username');
  const nameProblem = username === null ? null : usernameProblem(username);
  if (nameProblem) return fail(nameProblem);
  const problem = secretProblem(secret, login ? 'form' : username === null ? 'bearer' : 'basic');
  if (problem) return fail(problem);
  let totp: string | null = null;
  const otp = login ? onePasswordTotpField(item.fields, totpFieldId) : undefined;
  if (otp && otp.value.trim() !== '') {
    const parsed = parseVaultTotp(otp.value);
    if (!parsed.ok) return fail('bad_totp');
    totp = vaultTotpCanonical(parsed.totp);
  }
  const titled = onePasswordEntryName(item.title);
  const name = titled.name === '' ? vaultEntryAddress(url).slice(0, VAULT_NAME_MAX) : titled.name;
  return {
    ok: true,
    projection: { kind: login ? 'login' : 'http', name, url, username, secret, totp },
    nameShortened: titled.shortened,
  };
}

/** The Whombat entry an item says it is (its “Whombat entry” field), or null. */
export function onePasswordItemMarker(item: Pick<OnePasswordItem, 'fields' | 'sections'>): EntryId | null {
  const field =
    item.fields.find((f) => f.id === ONEPASSWORD_MARKER.fieldId) ??
    item.fields.find(
      (f) =>
        f.title === ONEPASSWORD_MARKER.fieldTitle &&
        item.sections.some((s) => s.id === f.sectionId && s.title === ONEPASSWORD_MARKER.sectionTitle),
    );
  if (!field) return null;
  const id = VaultEntryId.safeParse(field.value.trim());
  return id.success ? id.data : null;
}

/* Reading an entry ------------------------------------------------------------------------------------ */

/** Whether an entry of this kind and sign-in syncs: a website login, or an API token signing in with bearer or basic. */
export function onePasswordEntryEligible(entry: {
  kind: VaultEntryKind;
  auth: Pick<VaultAuth, 'type'> | null;
}): boolean {
  if (entry.kind === 'login') return entry.auth?.type === 'form';
  return entry.kind === 'http' && (entry.auth?.type === 'bearer' || entry.auth?.type === 'basic');
}

/** An entry's values as the server unseals them for a pass. */
export interface OnePasswordEntryValues {
  kind: VaultEntryKind;
  name: string;
  url: string | null;
  auth: VaultAuth | null;
  /** The password or token. */
  secret: string | null;
  /** A login's authenticator key as sealed (`vaultTotpCanonical`); null: none. */
  totp: string | null;
}

/** An entry as both sides compare it, or null when it doesn't sync (another kind or sign-in, or no address or secret). */
export function onePasswordEntryProjection(entry: OnePasswordEntryValues): OnePasswordProjection | null {
  if (!onePasswordEntryEligible(entry) || !entry.url || !entry.secret || !entry.auth) return null;
  const auth = entry.auth;
  if (entry.kind === 'login' && auth.type === 'form')
    return {
      kind: 'login',
      name: entry.name.trim(),
      url: entry.url,
      username: auth.username,
      secret: entry.secret,
      totp: entry.totp === null || entry.totp === '' ? null : onePasswordCanonicalTotp(entry.totp),
    };
  return {
    kind: 'http',
    name: entry.name.trim(),
    url: entry.url,
    username: auth.type === 'basic' ? auth.username : null,
    secret: entry.secret,
    totp: null,
  };
}

/** How an entry made or changed from 1Password signs in: a login's form, else basic with a username, bearer without. */
export function onePasswordEntryAuth(p: OnePasswordProjection): VaultAuth {
  if (p.kind === 'login') return { type: 'form', username: p.username ?? '' };
  return p.username === null ? { type: 'bearer' } : { type: 'basic', username: p.username };
}

/* Writing into 1Password ------------------------------------------------------------------------------ */

/** A field id the item doesn't use yet: `base`, else `base2`, `base3`, … */
function freeFieldId(fields: readonly OnePasswordItemField[], base: string): string {
  const used = new Set(fields.map((f) => f.id));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}${n}`)) return `${base}${n}`;
}

const isDefault = (t: VaultTotp, key: 'algorithm' | 'digits' | 'period') =>
  String(t[key]) === String(VAULT_TOTP_DEFAULTS[key]);

/** The parameters a link adds after the secret: only those that aren't authenticator apps' defaults. */
function totpParams(t: VaultTotp): string {
  return (['algorithm', 'digits', 'period'] as const)
    .filter((k) => !isDefault(t, k))
    .map((k) => `&${k}=${t[k]}`)
    .join('');
}

/**
 * The value a one-time password field gets for a key (`vaultTotpCanonical`'s form). The field's own `otpauth://` link
 * keeps its label (issuer and account), its issuer and every other parameter, with the secret, algorithm, digits and
 * period replaced; a bare setup key stays a bare key while the key uses the defaults; a new one is a link labelled with
 * the item's title.
 */
export function onePasswordTotpValue(existing: string | null, canonical: string, label: string): string {
  const parsed = parseVaultTotp(canonical);
  if (!parsed.ok) return canonical;
  const t = parsed.totp;
  const link = existing === null ? null : /^(otpauth:\/\/totp\/[^?#]*)(?:\?([^#]*))?/i.exec(existing.trim());
  if (link) {
    const seen = new Set<string>();
    const params: string[] = [];
    for (const part of (link[2] ?? '').split('&')) {
      if (part === '') continue;
      const name = part.split('=')[0]?.toLowerCase() ?? '';
      if (name === 'secret' || name === 'algorithm' || name === 'digits' || name === 'period') {
        if (seen.has(name)) continue;
        seen.add(name);
        params.push(`${name}=${name === 'secret' ? t.secret : t[name]}`);
      } else params.push(part);
    }
    if (!seen.has('secret')) params.unshift(`secret=${t.secret}`);
    for (const k of ['algorithm', 'digits', 'period'] as const)
      if (!seen.has(k) && !isDefault(t, k)) params.push(`${k}=${t[k]}`);
    return `${link[1]}?${params.join('&')}`;
  }
  if (existing !== null && existing.trim() !== '' && totpParams(t) === '') return t.secret;
  return `otpauth://totp/${encodeURIComponent(label.trim() || 'Whombat')}?secret=${t.secret}${totpParams(t)}`;
}

/** The section a new custom field goes in: an untitled one the item has (1Password's own), else the Whombat section. */
function customSection(sections: OnePasswordItemSection[]): string {
  const untitled = sections.find((s) => s.title === '');
  if (untitled) return untitled.id;
  if (!sections.some((s) => s.id === ONEPASSWORD_MARKER.sectionId))
    sections.push({ id: ONEPASSWORD_MARKER.sectionId, title: ONEPASSWORD_MARKER.sectionTitle });
  return ONEPASSWORD_MARKER.sectionId;
}

/** Sets a built-in field's value, adding the field without a section when the item lacks it. */
function setBuiltIn(
  fields: OnePasswordItemField[],
  id: string,
  fieldType: string,
  value: string,
  addWhenMissing = true,
): void {
  const field = builtInField(fields, id);
  if (field) field.value = value;
  else if (addWhenMissing) fields.push({ id, title: id, fieldType, value });
}

/**
 * The item with a projection written in, everything else kept (other websites, fields, sections, tags, files, notes,
 * history): only the fields whose canonical text differs from the item's own are written, so a title Whombat shortened
 * stays whole and a key's label stays when only the secret changed. Whombat then `put`s it with the item's `version`.
 */
export function applyOnePasswordProjection(
  item: OnePasswordItem,
  p: OnePasswordProjection,
  totpFieldId: string | null = null,
): OnePasswordItem {
  return writeOnePasswordItem(item, p, totpFieldId).item;
}

/**
 * `applyOnePasswordProjection`, and the one-time password field the pair follows afterwards: the field the key went
 * into, or the one it followed (kept when the key was removed, so another field never takes its place).
 */
export function writeOnePasswordItem(
  item: OnePasswordItem,
  p: OnePasswordProjection,
  totpFieldId: string | null = null,
): { item: OnePasswordItem; totpFieldId: string | null } {
  let followed = totpFieldId;
  const fields = item.fields.map((f) => ({ ...f }));
  const sections = item.sections.map((s) => ({ ...s }));
  const websites = item.websites.map((w) => ({ ...w }));
  const login = p.kind === 'login';
  const want = onePasswordCanonical(p);
  // The item's name as reading it gives (shortened, or its address's host when untitled): unchanged, the title stays.
  const own = onePasswordEntryName(item.title).name;
  const ownName = own === '' ? vaultEntryAddress(p.url).slice(0, VAULT_NAME_MAX) : own;
  const title = want.name === ownName ? item.title : p.name.trim();
  if (login) {
    const first = websites.findIndex((w) => w.url.trim() !== '');
    const current = first < 0 ? null : onePasswordAddress(websites[first]?.url ?? '');
    if (current === null || onePasswordCanonicalUrl(current) !== want.url) {
      const site = first < 0 ? undefined : websites[first];
      if (site) site.url = p.url;
      else websites.unshift({ url: p.url, label: 'website', autofillBehavior: 'AnywhereOnWebsite' });
    }
  } else {
    const current = onePasswordAddress(builtInField(fields, ONEPASSWORD_FIELD_IDS.hostname)?.value ?? '');
    if (current === null || onePasswordCanonicalUrl(current) !== want.url)
      setBuiltIn(fields, ONEPASSWORD_FIELD_IDS.hostname, ONEPASSWORD_FIELD_TYPES.text, p.url);
  }
  if ((builtInField(fields, ONEPASSWORD_FIELD_IDS.username)?.value ?? '') !== want.username)
    setBuiltIn(
      fields,
      ONEPASSWORD_FIELD_IDS.username,
      ONEPASSWORD_FIELD_TYPES.text,
      want.username,
      want.username !== '',
    );
  const secretId = login ? ONEPASSWORD_FIELD_IDS.password : ONEPASSWORD_FIELD_IDS.credential;
  if ((builtInField(fields, secretId)?.value ?? '') !== p.secret)
    setBuiltIn(fields, secretId, ONEPASSWORD_FIELD_TYPES.concealed, p.secret);
  if (login) {
    // Only the field the pair follows (or, following none, the first with a value): a second one is never touched.
    const otp = onePasswordTotpField(fields, followed);
    const current = otp && otp.value.trim() !== '' ? otp.value : null;
    if (otp) followed = otp.id;
    if (onePasswordCanonicalTotp(current) !== want.totp) {
      if (p.totp === null) {
        if (otp) fields.splice(fields.indexOf(otp), 1);
      } else if (otp) otp.value = onePasswordTotpValue(current, p.totp, title);
      else {
        followed = freeFieldId(fields, followed ?? 'onetimepassword');
        fields.push({
          id: followed,
          title: 'one-time password',
          sectionId: customSection(sections),
          fieldType: ONEPASSWORD_FIELD_TYPES.totp,
          value: onePasswordTotpValue(null, p.totp, title),
        });
      }
    }
  }
  return { item: { ...item, title, fields, sections, websites }, totpFieldId: login ? followed : null };
}

/**
 * A new item for an entry: a Login (website, username, password, a one-time password when the entry has a key) or an
 * API Credential (credential, hostname, username for basic), carrying the entry's id in its “Whombat entry” field.
 */
export function newOnePasswordItem(input: {
  vaultId: OnePasswordVaultId;
  entryId: EntryId;
  projection: OnePasswordProjection;
}): OnePasswordNewItem {
  const p = input.projection;
  const login = p.kind === 'login';
  const sections: OnePasswordItemSection[] = [
    { id: ONEPASSWORD_MARKER.sectionId, title: ONEPASSWORD_MARKER.sectionTitle },
  ];
  const fields: OnePasswordItemField[] = [];
  const builtIn = (id: string, fieldType: string, value: string) =>
    fields.push({ id, title: id, fieldType, value });
  if (p.username !== null) builtIn(ONEPASSWORD_FIELD_IDS.username, ONEPASSWORD_FIELD_TYPES.text, p.username);
  if (login) builtIn(ONEPASSWORD_FIELD_IDS.password, ONEPASSWORD_FIELD_TYPES.concealed, p.secret);
  else {
    builtIn(ONEPASSWORD_FIELD_IDS.credential, ONEPASSWORD_FIELD_TYPES.concealed, p.secret);
    builtIn(ONEPASSWORD_FIELD_IDS.hostname, ONEPASSWORD_FIELD_TYPES.text, p.url);
  }
  if (login && p.totp !== null)
    fields.push({
      id: 'onetimepassword',
      title: 'one-time password',
      sectionId: ONEPASSWORD_MARKER.sectionId,
      fieldType: ONEPASSWORD_FIELD_TYPES.totp,
      value: onePasswordTotpValue(null, p.totp, p.name),
    });
  fields.push({
    id: ONEPASSWORD_MARKER.fieldId,
    title: ONEPASSWORD_MARKER.fieldTitle,
    sectionId: ONEPASSWORD_MARKER.sectionId,
    fieldType: ONEPASSWORD_FIELD_TYPES.text,
    value: input.entryId,
  });
  return {
    category: login ? ONEPASSWORD_CATEGORIES.login : ONEPASSWORD_CATEGORIES.apiCredentials,
    vaultId: input.vaultId,
    title: p.name.trim(),
    fields,
    sections,
    websites: login ? [{ url: p.url, label: 'website', autofillBehavior: 'AnywhereOnWebsite' }] : [],
    tags: [],
    notes: '',
  };
}

/* Deciding a pair --------------------------------------------------------------------------------------- */

/**
 * Each side's fields as digests: the server's HMAC of each canonical field, with a key of the box's, separated by entry
 * and field. This module only compares them; no second copy of a secret is kept.
 */
export type OnePasswordDigests = Readonly<Record<OnePasswordSyncField, string>>;

/**
 * What a pass does with a pair: `nothing`; `take_onepassword` (1Password's fields into the entry, all of them);
 * `take_whombat` (the entry's fields into the item, all of them); `renew_base` (both sides agree, only the base is
 * written).
 */
export const ONEPASSWORD_PAIR_DECISIONS = [
  'nothing',
  'take_onepassword',
  'take_whombat',
  'renew_base',
] as const;
export type OnePasswordPairDecision = (typeof ONEPASSWORD_PAIR_DECISIONS)[number];

const sameDigests = (a: OnePasswordDigests, b: OnePasswordDigests) =>
  ONEPASSWORD_SYNC_FIELDS.every((f) => a[f] === b[f]);

/**
 * Decides a pair against the base the link keeps. Neither side changed: nothing. One side changed: that side, whole.
 * Both changed to the same: renew the base. Both changed differently: Whombat's version wins (1Password keeps the
 * replaced one in the item's history). No base (an entry relinked after a restore): 1Password's version wins, unless
 * both already agree.
 */
export function decideOnePasswordPair(input: {
  base: OnePasswordDigests | null;
  whombat: OnePasswordDigests;
  onepassword: OnePasswordDigests;
}): OnePasswordPairDecision {
  const { base, whombat, onepassword } = input;
  if (base === null) return sameDigests(whombat, onepassword) ? 'renew_base' : 'take_onepassword';
  const whombatChanged = !sameDigests(whombat, base);
  const onepasswordChanged = !sameDigests(onepassword, base);
  if (!whombatChanged && !onepasswordChanged) return 'nothing';
  if (whombatChanged && onepasswordChanged)
    return sameDigests(whombat, onepassword) ? 'renew_base' : 'take_whombat';
  return whombatChanged ? 'take_whombat' : 'take_onepassword';
}

/* The guard --------------------------------------------------------------------------------------------- */

/** More removals than this in one pass pause it. */
export const ONEPASSWORD_GUARD_MAX_REMOVALS = 3;

/**
 * Whether a pass may remove the entries whose items are gone from the vault: `none` (nothing to remove), `remove`, or
 * `pause` (remove nothing and ask the person) when it would remove more than 3 entries, more than a quarter of the
 * linked ones, or all of them, or when listing the vault met an error (then a gone item may only be unlisted).
 */
export function onePasswordRemovalGuard(input: {
  removals: number;
  linked: number;
  listingFailed: boolean;
}): 'none' | 'remove' | 'pause' {
  const { removals, linked } = input;
  if (removals <= 0) return 'none';
  if (input.listingFailed) return 'pause';
  if (removals > ONEPASSWORD_GUARD_MAX_REMOVALS) return 'pause';
  if (removals * 4 > linked) return 'pause';
  if (removals >= linked) return 'pause';
  return 'remove';
}
