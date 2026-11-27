/**
 * Changing a connection on the phone (phone-connect.md PC-09, AP-2911; the web's ConnectionPage, CX-72, AP-757, AP-845):
 * its name, what the agent may do, a new key or password (with a session's two-step code when the service asks,
 * connection-signin-android.md AP-3958), signing in again (on the service's own page too, AP-3957), Check again and
 * Remove, in the web's words, and signing a connection made with a code in again with a new one (T3 Code's pairing code).
 * Who it's for is shown, not changed (the Whombat has no way to change it; the web doesn't either). Pure.
 */
import { onePasswordAppText } from '@whombat/client';
import {
  codeSignInAgain,
  raiseNote,
  sessionSecret,
  signInAgainText,
  usedByAutomations,
  usedByGateway,
  usedByVaultSync,
} from '@whombat/client/connections';
import {
  type CatalogEntry,
  type CatalogStep,
  type ConnectionAccessLevel,
  type ConnectionView,
  catalogSignIn,
  connectionAccessLabels,
  scopeListWords,
} from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';

export function connectionChangeText(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    name: t('data.connectionChange.name'),
    rename: t('data.connectionChange.rename'),
    giveName: t('data.connectionChange.giveName'),
    renamed: (label: string) => t('data.connectionChange.renamed', { label }),
    change: t('data.connectionChange.change'),
    save: t('data.connectionChange.save'),
    cancel: t('data.common.cancel'),
    levelSaved: (label: string, level: ConnectionAccessLevel) =>
      t('data.connectionChange.levelSaved', { label, level: connectionAccessLabels(locale)[level] }),
    signInAgain: t('data.connectionChange.signInAgain'),
    signIn: t('data.connectionChange.signIn'),
    reconnect: t('data.connectionChange.reconnect'),
    /** A call needed more than the service allowed (step-up): “Allow on Cloudflare…”. */
    allowMore: (name: string) => t('data.connectionChange.allowMore', { name }),
    allowMoreLine: (agent: string, words: string) =>
      t('data.connectionChange.allowMoreLine', { agent, words }),
    remove: t('data.connectionChange.remove'),
    removeNamed: (label: string) => t('data.connectionChange.removeNamed', { label }),
    removed: (label: string) => t('data.connectionChange.removed', { label }),
    tokenReplaced: t('data.connectionChange.tokenReplaced'),
    /** “Client secret replaced.” */
    replaced: (secretLabel: string) => t('data.connectionChange.replaced', { secret: secretLabel }),
    checking: (name: string) => t('data.connectionChange.checking', { name }),
    checkAgain: t('data.connectionChange.checkAgain'),
    documentation: (name: string) => t('data.connectionChange.documentation', { name }),
  };
}

export const CONNECTION_CHANGE_TEXT = connectionChangeText();

/** What the sign-in section says and offers (the web's SIGN-IN): the sign-in's name, its line, its buttons. */
export interface SignInView {
  title: string;
  line: string;
  /**
   * Replace the token (or a session sign-in's password), sign in again with a new code (T3 Code's pairing code: its
   * words, the steps to make one, and whether it needs it now), sign in again elsewhere, or nothing (no sign-in).
   */
  action:
    | { kind: 'replace'; label: string; secretLabel: string; help: string }
    | {
        kind: 'code';
        label: string;
        secretLabel: string;
        placeholder: string;
        help: string;
        steps: readonly CatalogStep[];
        needs: boolean;
      }
    /** `primary`: something waits on it (an agent's ask for more, below). */
    | { kind: 'reconnect'; label: string; primary: boolean }
    | null;
  /**
   * Sign in again on the service's own page (Plex's, SG-02: `connectionId`), beside Replace token: a token connection of
   * an entry with a `service_login` sign-in, on a runtime that has it (AP-3957). Null otherwise.
   */
  again: { label: string } | null;
}

/**
 * The SIGN-IN section of a connection. `serviceLogin`: the runtime has `connections.service_login` (CT-744), so a token
 * that came from the service's own page can be signed in again there. A token a code was exchanged for signs in again
 * with a new code (`codeSignInAgain`); its line says first when it needs one (`status`, active when absent).
 */
export function signInView(
  entry: CatalogEntry,
  conn: Pick<ConnectionView, 'signIn'> & Partial<Pick<ConnectionView, 'status' | 'permissionAsked'>>,
  serviceLogin = false,
  /** The agent's name, for what it asked the service for (step-up). */
  agent = 'Whombat',
  locale?: string,
): SignInView {
  const { t } = mobileTranslator(locale);
  const text = connectionChangeText(locale);
  const code = codeSignInAgain(entry, { signIn: conn.signIn, status: conn.status ?? 'active' }, locale);
  if (code)
    return {
      title: code.title,
      line: code.line,
      action: {
        kind: 'code',
        label: signInAgainText(locale).button,
        secretLabel: code.words.label,
        placeholder: code.words.placeholder,
        help: code.words.help,
        steps: code.words.steps,
        needs: code.needs,
      },
      again: null,
    };
  const method = catalogSignIn(entry, conn.signIn);
  const secretWord = sessionSecret(entry) ?? 'token';
  const title = method?.label ?? t('data.connectionChange.signInTitle');
  if (conn.signIn === 'token' && method?.kind === 'token')
    return {
      title,
      line: t('data.connectionChange.sealed', { word: secretWord }),
      action: {
        kind: 'replace',
        label: t('data.connectionChange.replace', { word: secretWord }),
        secretLabel: method.secretLabel,
        help: t('data.connectionChange.replaceHelp', { help: method.secretHelp }),
      },
      again:
        serviceLogin && entry.signIn.some((m) => m.kind === 'service_login')
          ? { label: text.signInAgain }
          : null,
    };
  if (conn.signIn === 'none')
    return { title, line: t('data.connectionChange.noSignIn'), action: null, again: null };
  // An OAuth client (CS-12): its new secret replaces the old one on this connection, checked first, as a token's does.
  if (conn.signIn === 'client_credentials' && method?.kind === 'client_credentials') {
    const word = lowerFirst(method.secretLabel);
    return {
      title,
      line: t('data.connectionChange.sealed', { word }),
      action: {
        kind: 'replace',
        label: t('data.connectionChange.replace', { word }),
        secretLabel: method.secretLabel,
        help: t('data.connectionChange.replaceHelp', { help: method.secretHelp }),
      },
      again: null,
    };
  }
  // A sign-in elsewhere signs in again on this connection (`connectionId`). Anything else (sign in once is kept as the
  // key it made, a token) has no way to sign in again here that keeps the same connection: no Reconnect (AP-2920).
  if (reconnectWay(conn.signIn) === null) return { title, line: '', action: null, again: null };
  // A call needed more than the service allowed: signing in again asks it, what was allowed before staying.
  const asked =
    conn.signIn === 'mcp_oauth' && (conn.status ?? 'active') === 'active' ? (conn.permissionAsked ?? []) : [];
  if (asked.length)
    return {
      title,
      line: text.allowMoreLine(agent, scopeListWords(asked)),
      action: { kind: 'reconnect', label: text.allowMore(entry.name), primary: true },
      again: null,
    };
  return {
    title,
    line: t('data.connectionChange.signedInWith', { name: entry.name }),
    action: { kind: 'reconnect', label: text.reconnect, primary: false },
    again: null,
  };
}

/**
 * Whether SIGN-IN's buttons stack full width instead of sitting side by side with Remove (AP-3964): when Replace's words
 * are longer than “Replace token”, they don't fit half a 368dp card (“Replace password”, “Replace app password”).
 */
export function stacksActions(view: Pick<SignInView, 'action'>, locale?: string): boolean {
  const a = view.action;
  const fits = mobileTranslator(locale).t('data.connectionChange.replace', { word: 'token' }).length;
  return (a?.kind === 'replace' || a?.kind === 'reconnect') && a.label.length > fits;
}

/** “Client secret” → “client secret”; an initialism stays (“API key”). */
function lowerFirst(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? `${label[0]?.toLowerCase()}${label.slice(1)}` : label;
}

/**
 * What Remove asks first (the web's words, by what stops; the agent by its name). The Vault's sync
 * (1Password) asks it above its two choices for the entries it kept in step.
 */
export function removeAsk(
  entry: CatalogEntry,
  conn: Pick<ConnectionView, 'label'>,
  agent: string,
  locale?: string,
): string {
  const { t } = mobileTranslator(locale);
  const label = conn.label;
  if (usedByVaultSync(entry)) return onePasswordAppText(locale).removeAsk(label);
  if (usedByGateway(entry)) return t('data.connectionChange.removeGateway', { label });
  if (usedByAutomations(entry)) return t('data.connectionChange.removeAutomations', { label });
  return t('data.connectionChange.removeAgent', { label, agent });
}

/** The secret's own problem before it is sent (a code with spaces only is none). */
export function replaceProblem(view: SignInView, secret: string, locale?: string): string | null {
  const { t } = mobileTranslator(locale);
  if (view.action?.kind === 'code')
    return secret.trim() ? null : t('data.connectionChange.needed', { label: view.action.secretLabel });
  if (secret) return null;
  return t('data.connectionChange.needed', {
    label: view.action?.kind === 'replace' ? view.action.secretLabel : t('data.connectionChange.theToken'),
  });
}

/**
 * The toast once Replace worked: “Token replaced.”, an OAuth client's “Client secret replaced.”, and a session sign-in's
 * own word (“Password replaced.” for Synology, “App password replaced.” for Pi-hole; AP-3958): Whombat signs in with it,
 * so it is never “the token” (CM-10). Signed in again with a new code: “Signed in to T3 Code again.”
 */
export function replacedText(
  entry: CatalogEntry,
  conn: Pick<ConnectionView, 'signIn'>,
  view: Pick<SignInView, 'action'>,
  locale?: string,
): string {
  const text = connectionChangeText(locale);
  if (view.action?.kind === 'code') return signInAgainText(locale).done(entry.name);
  if (view.action?.kind !== 'replace') return text.tokenReplaced;
  if (conn.signIn === 'token' && !sessionSecret(entry)) return text.tokenReplaced;
  return text.replaced(view.action.secretLabel);
}

/** Raising it to Manage where sign in once asked the service for a key at the level (CS-11): the note, else null. */
export function raisedNote(
  entry: CatalogEntry,
  raised: boolean,
  access: ConnectionAccessLevel,
  locale?: string,
): string | null {
  return raised && access === 'manage' ? raiseNote(entry, locale) : null;
}

/**
 * How a connection signs in again on the same connection (PC-05, PC-09): an OAuth sign-in or Nextcloud's login with its
 * `connectionId`; null for every other sign-in, which gets no Reconnect (AP-2920).
 */
export function reconnectWay(signIn: ConnectionView['signIn']): 'oauth' | 'nextcloud' | null {
  if (signIn === 'ha_oauth' || signIn === 'mcp_oauth' || signIn === 'app_oauth') return 'oauth';
  if (signIn === 'nextcloud_login') return 'nextcloud';
  return null;
}
