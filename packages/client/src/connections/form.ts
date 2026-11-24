/**
 * Connecting a catalog entry (Whombat connections-catalog.md CX-70…CX-72; app AP-755…AP-764; phone-connect.md PC-04,
 * AP-2901): a connection's state in words, which entries are offered, how it signs in, which
 * fields show, the button's words, what a refusal means in a sentence with its fix. Pure, shared by the web's connect
 * form and the phone's Connect {Name} (moved from the web's `features/connectors/catalog.ts`, unchanged).
 */
import {
  CONNECTION_ERROR_MESSAGES,
  type ConnectionConnectError,
  ConnectionErrorDetails,
  destinationRefusedText,
} from '@whombat/core/contracts';
import {
  CATALOG,
  type CatalogConnectionState,
  type CatalogEntry,
  type CatalogReauthReason,
  type CatalogSignIn,
  type ConnectionView,
  catalogEntry,
  fieldShown,
  fieldsFor,
  isAgentConnection,
  isGatewayConnection,
  isVaultSyncConnection,
  SignInKind,
} from '@whombat/core/domain';
import { ApiError, InvalidRequestError } from '../http/errors';

type Field = ReturnType<typeof fieldsFor>[number];

/* A connection's state (CX-70, CX-72) ------------------------------------------------------------------------ */

export type StateTone = 'ok' | 'warn' | 'bad';

/** A connection's state on its row and its page: “Connected”, “Needs connecting again”, “Needs attention”. */
export const CONNECTION_STATE: Record<CatalogConnectionState, { text: string; tone: StateTone }> = {
  active: { text: 'Connected', tone: 'ok' },
  needs_reauth: { text: 'Needs you to sign in again', tone: 'warn' },
  error: { text: 'Needs attention', tone: 'bad' },
};

/**
 * A connection's state as its row and page say it: `CONNECTION_STATE`, except that a connection only automations use
 * whose token was refused “Needs a new token” (TA-03, AP-1035): that is the one thing to do there.
 */
export function connectionState(
  c: Pick<ConnectionView, 'catalogId' | 'status' | 'signIn' | 'reauthReason'>,
): { text: string; tone: StateTone } {
  const refused =
    c.status === 'needs_reauth' &&
    c.signIn === 'token' &&
    (c.reauthReason === null || c.reauthReason === 'token_invalid');
  if (refused && usedByAutomations(c.catalogId)) return { text: 'Needs a new token', tone: 'warn' };
  // A session sign-in's password was refused (Whombat connections-more.md CM-11): “Needs a new password”.
  const session = sessionSecret(catalogEntry(c.catalogId));
  if (refused && session) return { text: `Needs a new ${session}`, tone: 'warn' };
  return CONNECTION_STATE[c.status];
}

/**
 * What a session sign-in's secret is called in a sentence (contracts 0.97 CT-470, CM-10: Pi-hole's “app password”, Nginx
 * Proxy Manager's “password”): Whombat signs in with it for a session token, so it is never “the token”. Null for
 * every other entry.
 */
export function sessionSecret(entry: CatalogEntry | null | undefined): string | null {
  const method = entry?.signIn.find((m) => m.kind === 'token');
  return method?.kind === 'token' && method.auth.type === 'session' ? lowerFirst(method.secretLabel) : null;
}

/** Why a connection needs connecting again, and what to do (CX-15); `secret` names a session sign-in's (CM-11). */
export function reauthText(
  reason: CatalogReauthReason | null,
  name: string,
  token: boolean,
  secret = 'token',
): string {
  switch (reason) {
    case 'revoked':
      return `${name} signed Whombat out. Sign in again to keep using it.`;
    case 'app_removed':
      return `This Whombat’s ${name} app was removed. Sign in again once it’s set up.`;
    case 'expired':
      return `The sign-in to ${name} expired. Sign in again to keep using it.`;
    default:
      return token
        ? `${name} no longer accepts the ${secret}. Replace it to keep using it.`
        : `${name} no longer accepts the sign-in. Sign in again to keep using it.`;
  }
}

/* Which entries are offered (TA-01, AIG-01) ----------------------------------------------------------------- */

/**
 * Whether only automations use connections of this entry (`CatalogEntry.use`, TA-02): no Look only or Manage, no
 * tools. An id the catalog doesn't know is the agent's entry, as core's `isAgentConnection` says. A gateway and the
 * Vault's sync aren't automations' either: nobody but Claude Code and Codex, or the sync, uses them.
 */
export function usedByAutomations(entry: CatalogEntry | string): boolean {
  return !isAgentConnection(entry) && !usedByGateway(entry) && !usedByVaultSync(entry);
}

/**
 * Whether connections of this entry keep the Vault in step with a vault elsewhere (`use: 'vault'`, 1Password; Whombat
 * onepassword-sync.md): the agent never uses one, so its page has none of the agent's parts (level, handle, tools, last
 * use) and shows the sync instead.
 */
export function usedByVaultSync(entry: CatalogEntry | string): boolean {
  return isVaultSyncConnection(entry);
}

/**
 * Whether connections of this entry are an AI gateway (`use: 'gateway'`, Whombat ai-gateway.md AIG-01; AP-1117): Claude
 * Code and Codex go through it when switched on; the agent never calls it, so none of its parts (level, handle,
 * tools).
 */
export function usedByGateway(entry: CatalogEntry | string): boolean {
  return isGatewayConnection(entry);
}

/** Whether a connection of this entry is one agents use: not automations' only, a gateway or the Vault's sync. */
export function usedByAgents(entry: CatalogEntry | string): boolean {
  return isAgentConnection(entry);
}

/** The connectable entries (not builtin), in the catalog's order. */
export const CONNECTABLE: readonly CatalogEntry[] = CATALOG.filter((e) => e.transport !== 'builtin');

/** A connectable catalog entry by id (`?connection=homeassistant`), or null for a builtin or unknown one. */
export function connectableEntry(id: string | undefined): CatalogEntry | null {
  const entry = id ? catalogEntry(id) : null;
  return entry && entry.transport !== 'builtin' ? entry : null;
}

/* The connect form (CX-71) ---------------------------------------------------------------------- */

/** One sign-in choice: its index in the entry's list, and — for a token one — its index among the token ones (`method`). */
export interface SignInChoice {
  index: number;
  kind: SignInKind;
  label: string;
  tokenIndex: number | null;
  method: CatalogSignIn;
}

/**
 * The entry's sign-ins, `index` being the place among them (sign in once and an OAuth client, CT-314; the service's own
 * page, CT-744). `tokenIndex` counts every token sign-in of the entry. A token sign-in that only keeps another's result
 * (`storedOnly`: T3 Code's, Whombat t3code.md T3-02) isn't offered.
 */
export function signInChoices(entry: CatalogEntry): SignInChoice[] {
  let tokens = 0;
  return entry.signIn
    .map((method, index) => ({
      index,
      kind: method.kind,
      label: method.label,
      tokenIndex: method.kind === 'token' ? tokens++ : null,
      method,
    }))
    .filter((c) => !(c.method.kind === 'token' && c.method.storedOnly));
}

/**
 * A token sign-in whose session asks for a two-step code once (`twoStep`, contracts 0.111 CT-732; Whombat
 * connection-signin.md SG-09: Synology): the form asks for the code when the service does, and sends it as `code`.
 */
export function asksTwoStepCode(method: CatalogSignIn | null | undefined): boolean {
  return method?.kind === 'token' && method.auth.type === 'session' && !!method.auth.twoStep;
}

/**
 * The fields the form shows for a sign-in (CX-01): `fieldsFor` (the method's own), without a `fromService` field (asked
 * only when the server needs the choice, CT-268), without an optional username that belongs to another token shape
 * (a Custom API's username only with “Username and password”), and, given the values typed so far, without a field
 * whose `shownWhen` doesn't hold (“Website or address”: the word to look for only for a website).
 */
export function visibleFields(
  entry: CatalogEntry,
  choice: SignInChoice,
  values?: Readonly<Record<string, string>>,
): Field[] {
  const usernameOf = (m: CatalogSignIn) =>
    m.kind === 'token' && m.auth.type === 'basic' ? m.auth.usernameField : null;
  const own = usernameOf(choice.method);
  const others = new Set(entry.signIn.map(usernameOf).filter((f): f is string => f !== null && f !== own));
  return fieldsFor(entry, choice.kind).filter(
    (f) => !f.fromService && !(others.has(f.id) && !f.required) && (!values || fieldShown(entry, f, values)),
  );
}

/**
 * The button that sends the form: Connect for a token or an OAuth client's secret, Sign in and connect for sign in once
 * (CT-314), the method's own words for a sign-in elsewhere (the service's own page: its label, “Sign in with Plex”;
 * SG-05, AP-3901).
 */
export function connectButtonText(
  entry: CatalogEntry,
  choice: Pick<SignInChoice, 'kind' | 'method'>,
): string {
  switch (choice.kind) {
    case 'token':
    case 'none':
    case 'client_credentials':
      return 'Connect';
    case 'password':
      return 'Sign in and connect';
    case 'nextcloud_login':
      return 'Sign in with Nextcloud';
    case 'service_login':
      return choice.method.label;
    default:
      return `Continue to ${entry.name}`;
  }
}

/**
 * A plain-http address on the home network: the token crosses it unencrypted (CX-40); with sign in once, the password
 * does too, then Whombat's key (CS-05), or the secret by its own name (T3 Code's pairing code).
 */
export function httpWarning(
  fields: Readonly<Record<string, string>>,
  kind?: SignInKind,
  method?: CatalogSignIn,
  _entryId?: string,
): string | null {
  if (!/^http:\/\//i.test(fields.url?.trim() ?? '')) return null;
  // Signing in on the service's own page (Plex's, SG-04) happens over https there: only the token it gives uses this
  // address, which the last line says (AP-3902; Plex's sign in once, CM-06, is gone).
  if (kind === 'password')
    return method?.kind === 'password' && method.secret
      ? `This address uses http: the ${lowerFirst(method.secret.label)} and Whombat’s key cross your network unencrypted.`
      : 'This address uses http: your password and Whombat’s key cross your network unencrypted.';
  // A session sign-in (contracts 0.97 CT-470: Pi-hole, Nginx Proxy Manager) sends the password itself.
  if (method?.kind === 'token' && method.auth.type === 'session')
    return `This address uses http: the ${lowerFirst(method.secretLabel)} crosses your network unencrypted.`;
  return 'This address uses http: the token crosses your network unencrypted.';
}

/** “App password” → “app password”; an initialism stays (“API key”). */
function lowerFirst(label: string): string {
  return /^[A-Z][a-z]/.test(label) ? `${label[0]?.toLowerCase()}${label.slice(1)}` : label;
}

/* Refusals in a sentence with the fix (CX-41, CT-269) --------------------------------------------- */

export interface ConnectProblem {
  /** The sentence above the button, or null when everything is under its field. */
  message: string | null;
  /** Under each field (`url`, `secret`, `label`…). */
  fields: Record<string, string>;
  /** An unlisted home-network address (CX-41): add it, then try again. */
  network: { cidr: string; port: number } | null;
  /** A `fromService` field with several choices (Moneybird's administration, CT-268): pick one and send again. */
  choice: { field: string; options: { value: string; label: string }[] } | null;
  /** The fingerprint a home-network server's unverifiable certificate presents (CT-313): use it and send again. */
  certificate: string | null;
  /**
   * Sign in once, or a session sign-in with `twoStep` (Synology, SG-09), wants a second factor's code
   * (`second_factor_needed`, CS-03): what to type, in the service's words (“Enter the code from your authenticator
   * app.”). The form shows the code field and sends the same again.
   */
  secondFactor: string | null;
  /**
   * The sealed challenge the code belongs to (`details.challenge`, contracts 0.111 CT-731; SG-06: UniFi's emailed code),
   * from `second_factor_needed` or a refused code that made a new one. The next submit sends it back as
   * `login.challenge` with the code; the form forgets it when the account, the password or the sign-in changes.
   */
  challenge: string | null;
  /**
   * Sign in once can't work for this account (`sign_in_refused`, CS-09): the sign-in to use instead — Nextcloud's login
   * when the server names it (`details.method`), the token made by hand for single sign-on or an unsupported setup.
   */
  switchTo: SignInKind | null;
}

export const NO_PROBLEM: ConnectProblem = {
  message: null,
  fields: {},
  network: null,
  choice: null,
  certificate: null,
  secondFactor: null,
  challenge: null,
  switchTo: null,
};

/**
 * The server's field errors (CX-D07: `fields.<id>`, `secret`, `auth`) as the form's keys: an entry's field by its id, the
 * token as `secret`, a Custom header shape's problem (`auth`, `auth.name`) on the header name (`authName`), and sign in
 * once's `login.account`, `login.password`, `login.code` as `account`, `password`, `code` (CT-314).
 */
function firstOf(fields: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, messages] of Object.entries(fields)) {
    const key = /^auth(\.|$)/.test(path) ? 'authName' : path.replace(/^(fields|login)\./, '');
    if (messages[0] && !out[key]) out[key] = messages[0];
  }
  return out;
}

/**
 * What a connections refusal means for the form (REST and session alike carry `error.details.code`, CT-269). `signIn`,
 * the sign-in that was tried: a password Whombat signs in with for a session keeps the server's words for a refusal
 * (AP-3805).
 */
export function connectProblem(
  error: unknown,
  fallback = 'That didn’t work. Try again in a moment.',
  signIn?: CatalogSignIn,
): ConnectProblem {
  if (error instanceof InvalidRequestError) return { ...NO_PROBLEM, fields: firstOf(error.fields) };
  if (!(error instanceof ApiError)) return { ...NO_PROBLEM, message: fallback };
  const details = ConnectionErrorDetails.safeParse(error.details);
  const d = details.success ? details.data : null;
  if (error.code === 'validation_failed' && Object.keys(error.fields).length)
    return { ...NO_PROBLEM, fields: firstOf(error.fields) };
  if (!d) return { ...NO_PROBLEM, message: error.message || fallback };
  switch (d.code) {
    case 'destination_refused':
      if (d.cidr && d.port)
        return {
          ...NO_PROBLEM,
          message: destinationRefusedText(d.cidr, d.port),
          network: { cidr: d.cidr, port: d.port },
        };
      return {
        ...NO_PROBLEM,
        fields: { url: error.message || CONNECTION_ERROR_MESSAGES.destination_refused },
      };
    case 'field_choice_needed':
      return {
        ...NO_PROBLEM,
        message: error.message || CONNECTION_ERROR_MESSAGES.field_choice_needed,
        choice: d.field && d.options?.length ? { field: d.field, options: d.options } : null,
      };
    case 'check_failed':
      return {
        ...NO_PROBLEM,
        message: checkFailedText(error.message, d.status, signIn ? signsInForSession(signIn) : false),
        certificate: d.certificateSha256 ?? null,
      };
    case 'second_factor_needed':
      return {
        ...NO_PROBLEM,
        secondFactor: error.message || CONNECTION_ERROR_MESSAGES.second_factor_needed,
        challenge: d.challenge ?? null,
      };
    case 'sign_in_refused': {
      const message = error.message || signInRefusedText(d.reason, signIn);
      // A wrong or expired code belongs under the code (with the new challenge UniFi made, SG-07); the rest above the
      // button, with the way out where there is one.
      if (d.reason === 'code')
        return { ...NO_PROBLEM, fields: { code: message }, challenge: d.challenge ?? null };
      return { ...NO_PROBLEM, message, switchTo: signInInstead(d.reason, d.method) };
    }
    default:
      return { ...NO_PROBLEM, message: error.message || CONNECTION_ERROR_MESSAGES[d.code] };
  }
}

type RefusalReason = NonNullable<ConnectionErrorDetails['reason']>;

/**
 * What a refused sign in once means when the server sends no sentence of its own (CT-314); `signIn`, the sign-in tried:
 * a secret with its own name is refused by that name (“That pairing code didn’t work.”).
 */
export function signInRefusedText(reason: RefusalReason | undefined, signIn?: CatalogSignIn): string {
  switch (reason) {
    case 'password':
      return signIn?.kind === 'password' && signIn.secret
        ? `That ${lowerFirst(signIn.secret.label)} didn’t work. Make a new one and try again.`
        : 'Wrong username or password.';
    case 'code':
      return 'That code didn’t work. Enter the newest one.';
    case 'rights':
      return 'This account may not make keys. Sign in with an admin account.';
    case 'locked':
      return 'The service paused sign-ins after too many tries. Wait a few minutes, then try again.';
    case 'single_sign_on':
      return 'This account signs in somewhere else. Make a token by hand instead.';
    case 'unsupported':
      return 'This version or setting can’t make keys this way. Make a token by hand instead.';
    case 'second_factor':
      return 'This account uses two-step sign-in, which this way can’t do.';
    default:
      return CONNECTION_ERROR_MESSAGES.sign_in_refused;
  }
}

/** The sign-in to switch to after a refusal (CS-09): the one the server names, else the token for SSO or unsupported. */
function signInInstead(reason: RefusalReason | undefined, method: string | undefined): SignInKind | null {
  const named = SignInKind.safeParse(method);
  if (named.success) return named.data;
  return reason === 'single_sign_on' || reason === 'unsupported' || reason === 'second_factor'
    ? 'token'
    : null;
}

/** The button that switches to another sign-in after a refusal (CS-09). */
export function switchText(kind: SignInKind, entry: CatalogEntry): string {
  switch (kind) {
    case 'nextcloud_login':
      return 'Sign in with Nextcloud instead';
    case 'token':
      return 'Make a token by hand instead';
    case 'ha_oauth':
    case 'mcp_oauth':
    case 'app_oauth':
    case 'service_login':
      return `Sign in with ${entry.name} instead`;
    default:
      return 'Use another way';
  }
}

/**
 * “Whombat couldn’t sign in with that …”, with the service's answer when there was one (401/403 say the token). A
 * password Whombat signs in with for a session (`session`: Pi-hole, Nginx Proxy Manager, Synology, QNAP) keeps the
 * server's sentence, which says why in the person's words — wrong name or password, account disabled, two-step sign-in
 * on, too many tries, password expired (Whombat desk-found.md NS-04; AP-3805) — and never names a token.
 */
export function checkFailedText(message: string, status: number | undefined, session = false): string {
  if (session) return message || SESSION_CHECK_FAILED;
  if (status === 401 || status === 403)
    return 'The service didn’t accept that token. Check that you copied all of it and that it may read.';
  return message || CONNECTION_ERROR_MESSAGES.check_failed;
}

/** A session's refusal without a sentence of the server's (AP-3805). */
export const SESSION_CHECK_FAILED =
  'Whombat couldn’t sign in with that. Check the address, the account and the password.';

/** A token sign-in whose secret is a password Whombat signs in with for a session (CT-470): Pi-hole, Synology, QNAP. */
export function signsInForSession(signIn: CatalogSignIn): boolean {
  return signIn.kind === 'token' && signIn.auth.type === 'session';
}

/** What `connect_error=` means after an OAuth sign-in (CX-15), with what to do. */
export const CONNECTION_CONNECT_ERROR_TEXT: Record<ConnectionConnectError, string> = {
  access_denied: 'The service didn’t connect: access wasn’t allowed. Try again and choose Allow.',
  invalid_state: 'That sign-in expired or was already used. Try signing in again.',
  exchange_failed: 'The service didn’t finish the sign-in. Try again in a moment.',
  no_app: 'This service isn’t set up on this Whombat. Set it up in Settings → Connections first.',
  issuer_mismatch: 'The sign-in came back from a different server than it started at. Try again.',
  check_failed: 'Signed in, but Whombat couldn’t reach the service with it. Check the address and try again.',
  destination_refused: 'That address isn’t allowed. Check the address, or add it to the home network list.',
  limit_reached: 'That’s as many connections as there can be. Remove one first.',
};
