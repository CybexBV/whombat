/**
 * The sign-in card (`vault_ask`, topic `secret`; Whombat vault-simplify.md VLT-40…VLT-49, contracts CT-1660…CT-1666):
 * what the web and the phone share around its form — which of the card's fields show for the way a `server` card
 * signs in, which must be filled, what goes to `guides.act`, the ways' words and the authenticator key's check. The
 * words are core's (`VAULT_ASK_TEXT`); nothing here keeps a value. No DOM and no React Native.
 */
import {
  GUIDE_VAULT_SERVER_WAYS,
  type GuideCard,
  type GuideField,
  type GuideFormBlock,
  type GuideVaultAsk,
  type GuideVaultServerWay,
} from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import { type DateInput, formatAgo } from '@whombat/core/text';
import {
  VAULT_ASK_FIELDS,
  VAULT_ASK_WAY_FIELDS,
  vaultAskText,
  vaultAskWay,
  vaultTotpProblem,
} from '@whombat/core/vault';
import { clientTree } from './i18n/catalog';
import { SETTINGS_AREA_WORDS } from './i18n/messages/chatWork/settings';

const words = (locale?: string | null) => clientTree(locale, SETTINGS_AREA_WORDS).vault;

/** A sign-in card's ask: what it asks for and where it goes, or null for any other card. */
export function vaultAskOf(card: Pick<GuideCard, 'guide' | 'vaultAsk'>): GuideVaultAsk | null {
  return card.guide === 'secret' && card.vaultAsk ? card.vaultAsk : null;
}

/** One of a `server` card's ways as the choice lists it. */
export interface VaultAskWayView {
  id: GuideVaultServerWay;
  label: string;
  detail: string;
}

/** A `server` card's three ways, `key_once` first (it is the one chosen when the card opens), with the assistant's name. */
export function vaultAskWays(assistant: string, locale?: string | null): VaultAskWayView[] {
  const text = vaultAskText(locale);
  return GUIDE_VAULT_SERVER_WAYS.map((id) => ({
    id,
    label: text.ways[id](assistant),
    detail: text.wayDetails[id](assistant),
  }));
}

/** The way a card opens with: `key_once`, the safest (VLT-42). */
export const VAULT_ASK_FIRST_WAY: GuideVaultServerWay = 'key_once';

/** The field a way can't do without: the password, or the private key. */
function wayNeeds(way: GuideVaultServerWay): string {
  return way === 'own_key' ? VAULT_ASK_FIELDS.privateKey : VAULT_ASK_FIELDS.password;
}

/**
 * The fields the form shows: for a `server` card only the chosen way's (`VAULT_ASK_WAY_FIELDS`), the way's own one
 * shown as needed; every other card's as the card has them. Fields of a kind this app doesn't know never got here (the
 * card's tolerant decoding left them out).
 */
export function vaultAskShownFields(
  ask: Pick<GuideVaultAsk, 'kind'>,
  block: Pick<GuideFormBlock, 'fields'>,
  way: GuideVaultServerWay,
): GuideField[] {
  if (ask.kind !== 'server') return [...block.fields];
  const shown = VAULT_ASK_WAY_FIELDS[way] as readonly string[];
  const needed = wayNeeds(way);
  return block.fields
    .filter((f) => shown.includes(f.id))
    .map((f) => (f.id === needed ? { ...f, optional: false } : f));
}

/** The words for a needed field left empty, core's for each (`VAULT_ASK_TEXT.empty`). */
function emptyText(ask: Pick<GuideVaultAsk, 'kind'>, field: GuideField, locale?: string | null): string {
  const e = vaultAskText(locale).empty;
  switch (field.id) {
    case VAULT_ASK_FIELDS.username:
      return e.username;
    case VAULT_ASK_FIELDS.secret:
      return ask.kind === 'token' ? e.token : e.secret;
    case VAULT_ASK_FIELDS.password:
      return e.password;
    case VAULT_ASK_FIELDS.privateKey:
      return e.privateKey;
    case VAULT_ASK_FIELDS.code:
      return e.code;
    default:
      return e.secret;
  }
}

/**
 * What stops the form before anything is sent, by field id: a needed field left empty (core's words), and a login's
 * authenticator key that can't be one (`vaultTotpProblem`), so a typo shows at once instead of after a round trip.
 */
export function vaultAskProblems(
  ask: Pick<GuideVaultAsk, 'kind'>,
  shown: readonly GuideField[],
  values: Readonly<Record<string, string>>,
  locale?: string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of shown) {
    const value = values[f.id] ?? '';
    if (!value.trim()) {
      if (!f.optional) out[f.id] = emptyText(ask, f, locale);
      continue;
    }
    if (f.id === VAULT_ASK_FIELDS.totp) {
      const problem = vaultTotpProblem(value);
      if (problem) out[f.id] = problem;
    }
  }
  return out;
}

/**
 * What `guides.act` gets: the shown fields that were filled — a username and a code trimmed, a password, passphrase or
 * sign-in key as typed (a space can be part of one), a private key as it is (its line breaks too) — and, for a
 * `server` card, the chosen way as the value `way`. A field the way doesn't show is never sent, even if it was typed
 * into before the person switched ways.
 */
export function vaultAskValues(
  ask: Pick<GuideVaultAsk, 'kind'>,
  shown: readonly GuideField[],
  values: Readonly<Record<string, string>>,
  way: GuideVaultServerWay,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of shown) {
    const value = values[f.id] ?? '';
    if (!value.trim()) continue;
    const trim = f.kind === 'text' || f.id === VAULT_ASK_FIELDS.totp;
    out[f.id] = trim ? value.trim() : value;
  }
  if (ask.kind === 'server') out[VAULT_ASK_FIELDS.way] = vaultAskWay(way);
  return out;
}

/** The fields a sent form drops at once, whatever the answer: every secret (a username stays to try again with). */
export function vaultAskKept(
  shown: readonly GuideField[],
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of shown) {
    const value = values[f.id];
    if (f.kind === 'text' && f.id !== VAULT_ASK_FIELDS.code && value) out[f.id] = value;
  }
  return out;
}

/** The line that stands for a private key once it's in (it is never shown again): pasted, or the file's name. */
export function vaultAskKeyIn(locale?: string | null) {
  const w = words(locale).keyIn;
  return {
    pasted: w.pasted,
    file: (name: string) => name,
    remove: w.remove,
    pick: w.pick,
    paste: w.paste,
    /** The file is far bigger than any private key: not read at all. */
    tooBig: w.tooBig,
    unreadable: w.unreadable,
    /** The clipboard had nothing to paste. */
    nothing: w.nothing,
  };
}

export const VAULT_ASK_KEY_IN = vaultAskKeyIn();

/* The entry page ------------------------------------------------------------------------------------------------ */

/**
 * A website login's AUTHENTICATOR KEY on its page (VLT-46, CT-1663): whether one is set, never the key; Add, Replace
 * and Remove through `vault.setTotp`, a setup key or `otpauth://` link pasted. The assistant's name is a parameter.
 */
export function vaultTotpText(locale?: string | null) {
  const w = words(locale).totp;
  return {
    label: w.label,
    field: vaultAskText(locale).fields.totp,
    notSet: (assistant: string) => interpolate(w.notSet, { assistant }),
    hint: w.hint,
    placeholder: w.placeholder,
    add: w.add,
    replace: w.replace,
    remove: w.remove,
    saved: w.saved,
    removed: w.removed,
  };
}

export const VAULT_TOTP_TEXT = vaultTotpText();

/** “Set · added 2 days ago”, or null when none is set. */
export function vaultTotpLine(
  totp: { set: boolean; setAt: string | null },
  now: DateInput,
  timeZone: string,
  locale?: string | null,
): string | null {
  if (!totp.set || !totp.setAt) return null;
  return interpolate(words(locale).totp.line, { when: formatAgo(totp.setAt, now, timeZone, locale) });
}

/**
 * A server's kept password (CT-1664) where its server is listed: “Signs in with a kept password · 2 days ago”, never
 * the value; null when its commands sign in with the key alone.
 */
export function vaultKeptPasswordLine(
  password: { set: boolean; setAt: string | null } | undefined,
  now: DateInput,
  timeZone: string,
  locale?: string | null,
): string | null {
  if (!password?.set) return null;
  const w = words(locale);
  return password.setAt
    ? interpolate(w.keptPasswordWhen, { when: formatAgo(password.setAt, now, timeZone, locale) })
    : w.keptPassword;
}

/* Connections ------------------------------------------------------------------------------------------------- */

/** An entry the Vault couldn't move to Connections at start (VLT-30, `VaultEntry.moveToConnections`): its page says so. */
export function vaultEntryStaysMcp(entry: { moveToConnections?: boolean }): boolean {
  return entry.moveToConnections === true;
}

/** What an entry that stays an MCP server says on its page, in a locale (English when none). */
export function vaultMcpMoveText(locale?: string | null) {
  return words(locale).mcp;
}

export const VAULT_MCP_MOVE_TEXT = vaultMcpMoveText();
