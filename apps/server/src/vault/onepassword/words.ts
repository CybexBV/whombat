/**
 * The 1Password sync's own words on the server (docs/decisions/onepassword-sync.md): why a pass couldn't finish,
 * the title its card and the page's head take for each kind of failure, and why a new token is refused. Core's
 * `ONEPASSWORD_WORDS` holds the words the apps share.
 */
import { ONEPASSWORD_WORDS } from '@whombat/core';

/** The words of a pass that couldn't finish, by what went wrong (the page's failing line). */
export const ONEPASSWORD_PASS_WORDS = {
  token: '1Password didn’t accept the token. Make a new one and paste it in this connection.',
  vault:
    'Whombat can’t find the vault in 1Password any more. Remove 1Password here and link it again with the vault you want.',
  readVault: 'This token can’t read the vault. Make one that can read and write it.',
  noVault: 'This connection names no vault. Remove 1Password here and link it again with the vault you want.',
  answer: 'An answer from 1Password didn’t read. Whombat tries again soon.',
  partial: 'Whombat couldn’t read everything in 1Password. It tries again at the next check.',
  archiveRefused: '1Password didn’t archive an item you removed here. Whombat tries again at the next check.',
  stopsFitting: 'No longer kept in step: 1Password has no place for this sign-in.',
  unreachableAddress: 'Whombat may not reach this address',
  writeFailed: '1Password didn’t take this change. Whombat tries again when it changes here or in 1Password.',
  unreadableItem: 'Whombat couldn’t read 1Password’s item. It tries again when the item changes.',
} as const;

/** What went wrong, as the card and the head name it. */
export type OnePasswordFailingKind =
  | 'unreachable'
  | 'token'
  | 'vault'
  | 'readVault'
  | 'noVault'
  | 'partial'
  | 'archive'
  | 'answer'
  | 'stopped';

/** The red card's and the head's title for each kind of failure: each says what its words say. */
export const ONEPASSWORD_FAILING_TITLES: Record<OnePasswordFailingKind, string> = {
  unreachable: 'Whombat can’t reach 1Password',
  token: '1Password didn’t accept the token',
  vault: 'Whombat can’t find the 1Password vault',
  readVault: 'The 1Password token can’t read the vault',
  noVault: '1Password has no vault to keep in step',
  partial: 'Whombat couldn’t read everything in 1Password',
  archive: '1Password didn’t archive an item',
  answer: 'Whombat couldn’t read 1Password’s answer',
  stopped: '1Password sync stopped unexpectedly',
};

/** The kind of a failing pass, from its stored words (anything else is “can’t reach”). */
export function onePasswordFailingKind(problem: string | null): OnePasswordFailingKind {
  switch (problem) {
    case ONEPASSWORD_PASS_WORDS.token:
      return 'token';
    case ONEPASSWORD_PASS_WORDS.vault:
      return 'vault';
    case ONEPASSWORD_PASS_WORDS.readVault:
      return 'readVault';
    case ONEPASSWORD_PASS_WORDS.noVault:
      return 'noVault';
    case ONEPASSWORD_PASS_WORDS.partial:
      return 'partial';
    case ONEPASSWORD_PASS_WORDS.archiveRefused:
      return 'archive';
    case ONEPASSWORD_PASS_WORDS.answer:
      return 'answer';
    case ONEPASSWORD_WORDS.stopped:
      return 'stopped';
    default:
      return 'unreachable';
  }
}

/** The title of a failing pass's card and head. */
export function onePasswordFailingTitle(problem: string | null): string {
  return ONEPASSWORD_FAILING_TITLES[onePasswordFailingKind(problem)];
}

/** Failing passes in a row before the card and the head turn red: one alone is usually a blip. */
export const ONEPASSWORD_FAILING_AFTER = 2;

/** A failing pass's words, or the plain “can’t reach”. */
export function onePasswordProblemText(problem: string | null): string {
  return problem ?? ONEPASSWORD_WORDS.unreachable;
}

/** A replacement token that can't see the vault the connection keeps in step. */
export function onePasswordTokenMissesVault(vaultTitle: string | null): string {
  const name = vaultTitle?.trim();
  return name
    ? `This token can’t see the vault “${name.slice(0, 100)}”. Make one that can read and write it.`
    : 'This token can’t see the vault Whombat keeps in step. Make one that can read and write it.';
}

/** Said when someone tries to change the vault of a linked 1Password connection: its pairs belong to that vault. */
export const ONEPASSWORD_VAULT_FIXED = 'To use another vault, remove 1Password and link it again.';
