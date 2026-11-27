/**
 * A sign-in with a code and no account (T3 Code's pairing code, Whombat t3code.md): its secret's own words wherever the
 * forms say “Password”, and signing such a connection in again on its page. The token the code was exchanged for is
 * kept as a token sign-in the form doesn't offer (`storedOnly`), so the page offers Sign in again with a new code instead
 * of Replace token, and `connections.setSecret` runs the sign-in once more with it: the connection, its level and its
 * tools stay. Pure, shared by the web's connection page and the phone's.
 */
import {
  type CatalogEntry,
  type CatalogSignIn,
  type CatalogStep,
  type ConnectionView,
  catalogSignIn,
} from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from '../i18n/catalog';
import { CONN_SIGN_IN_AGAIN_WORDS } from '../i18n/messages/connectionsHosts/connections';
import { connectFormText } from './draft';
import { reauthText, sessionSecret } from './form';

type PasswordSignIn = Extract<CatalogSignIn, { kind: 'password' }>;

/** A sign in once's secret as the form shows it: its label, placeholder, the help under it and the steps to make one. */
export interface SecretWords {
  label: string;
  placeholder: string;
  help: string;
  steps: readonly CatalogStep[];
}

/** The secret's own words (T3 Code's “Pairing code”), else the form's “Password”. */
export function secretWords(method: PasswordSignIn, locale?: string | null): SecretWords {
  const s = method.secret;
  const form = connectFormText(locale);
  return {
    label: s?.label ?? form.password,
    placeholder: s?.placeholder ?? '',
    help: s?.help ?? form.passwordHelp,
    steps: s?.steps ?? [],
  };
}

/** The secret in a sentence: “pairing code”, “password”. */
export function secretWord(method: PasswordSignIn, locale?: string | null): string {
  return lowerFirst(secretWords(method, locale).label);
}

/**
 * What the connect form says while sign in once runs: “Signing in to Proxmox VE and making Whombat’s key…”, or for a
 * secret with its own name “Signing in to T3 Code with the pairing code…”.
 */
export function signingInText(
  entry: Pick<CatalogEntry, 'name'>,
  method: CatalogSignIn,
  locale?: string | null,
): string {
  const form = connectFormText(locale);
  return method.kind === 'password' && method.secret
    ? form.signingInWith(entry.name, secretWord(method, locale))
    : form.signingIn(entry.name);
}

/** The entry's sign-in with no account whose result its kept token is (T3 Code's pairing code), or null. */
export function codeSignInOf(entry: CatalogEntry): PasswordSignIn | null {
  const kept = catalogSignIn(entry, 'token');
  if (kept?.kind !== 'token' || !kept.storedOnly) return null;
  const once = entry.signIn.find((m) => m.kind === 'password');
  return once?.kind === 'password' && once.account === null ? once : null;
}

/** The page's words for signing in again with a new code. */
export function signInAgainText(locale?: string | null) {
  const w = clientTree(locale, CONN_SIGN_IN_AGAIN_WORDS);
  return {
    button: w.button,
    submit: w.submit,
    /** “Whombat’s own sign-in is kept sealed on this Whombat. When it ends, sign in again with a new pairing code.” */
    kept: (secret: string) => interpolate(w.kept, { secret }),
    /** “T3 Code needs a new pairing code before Whombat can use it again.” */
    needs: (name: string, secret: string) => interpolate(w.needs, { name, secret }),
    signingIn: (name: string) => interpolate(w.signingIn, { name }),
    /** The toast once it worked. */
    done: (name: string) => interpolate(w.done, { name }),
  };
}

export const SIGN_IN_AGAIN_TEXT = signInAgainText('en');

/** What a connection's SIGN-IN shows when it signs in again with a new code. */
export interface CodeSignInAgain {
  /** The sign-in's name (“Pairing code”). */
  title: string;
  /** Kept sealed, or — when it needs signing in again — that it needs a new code, first. */
  line: string;
  /** Whether it needs signing in again now: Sign in again is the main button. */
  needs: boolean;
  /** The field's words and the steps to make a code. */
  words: SecretWords;
  /** The sign-in the server runs again (its refusals' words). */
  method: PasswordSignIn;
}

/**
 * Whether this connection signs in again with a new code (its token sign-in only keeps what a sign-in with no account
 * made), and what its SIGN-IN says then; null for every other connection, which keeps Replace token or Reconnect.
 */
export function codeSignInAgain(
  entry: CatalogEntry,
  conn: Pick<ConnectionView, 'signIn' | 'status'>,
  locale?: string | null,
): CodeSignInAgain | null {
  if (conn.signIn !== 'token') return null;
  const method = codeSignInOf(entry);
  if (!method) return null;
  const words = secretWords(method, locale);
  const secret = secretWord(method, locale);
  const needs = conn.status !== 'active';
  const t = signInAgainText(locale);
  return {
    title: method.label,
    line: needs ? t.needs(entry.name, secret) : t.kept(secret),
    needs,
    words,
    method,
  };
}

/** The code's own problem before it is sent: “Pairing code is needed.” */
export function codeProblemText(
  again: Pick<CodeSignInAgain, 'words'>,
  code: string,
  locale?: string | null,
): string | null {
  return code.trim()
    ? null
    : interpolate(clientTree(locale, CONN_SIGN_IN_AGAIN_WORDS).codeNeeded, { label: again.words.label });
}

/**
 * Why a catalog connection needs connecting again, with what to do (`reauthText`), or null while it works. A connection
 * that signs in again with a new code is never told to replace its token.
 */
export function connectionReason(
  entry: CatalogEntry | null,
  conn: Pick<ConnectionView, 'status' | 'reauthReason' | 'signIn' | 'label'>,
  locale?: string | null,
): string | null {
  if (conn.status === 'active') return null;
  const replaces = conn.signIn === 'token' && !(entry && codeSignInAgain(entry, conn, locale));
  // An entry only automations use (a report tracker) has one name for every tracker: its connection names this one.
  const name = entry && entry.use !== 'automations' ? entry.name : conn.label;
  return reauthText(conn.reauthReason, name, replaces, sessionSecret(entry) ?? 'token', locale);
}

/** “Pairing code” → “pairing code”; an initialism stays (“API key”). */
function lowerFirst(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? `${label[0]?.toLowerCase()}${label.slice(1)}` : label;
}
