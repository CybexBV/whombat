/**
 * The connect form's draft as both forms keep it (Whombat connections-setup.md CS-50; app AP-843; phone-connect.md
 * PC-03, PC-04, AP-2903): the fields it starts with, what it refuses before asking the Whombat, the body each sign-in
 * sends, and every word of the form that isn't the catalog's. The web's steps form and the phone's Connect {Name} read
 * it, so the two say and check the same. Pure.
 */
import type {
  CreateConnectionBody,
  SetConnectionSecretBody,
  StartServiceLoginBody,
} from '@whombat/core/contracts';
import {
  type CatalogEntry,
  type CatalogSignIn,
  type ConnectionAccessLevel,
  type ConnectionView,
  fieldProblem,
  type fieldsFor,
  type TokenAuth,
} from '@whombat/core/domain';
import { withBurrow } from '../paths';
import { asksTwoStepCode, type SignInChoice, usedByAgents } from './form';

type Field = ReturnType<typeof fieldsFor>[number];

/** Fields the steps place themselves: the address in step 1, the certificate under it (and under More options). */
export const PLACED_FIELDS: ReadonlySet<string> = new Set(['url', 'fingerprint']);

/** The form's own words (the catalog's are the entry's): the same on the web and the phone. */
export const CONNECT_FORM_TEXT = {
  identifying: 'Looking at the address…',
  checkAddress: 'Check the address',
  continue: 'Continue',
  moreOptions: 'More options',
  howSignsIn: 'How Whombat signs in',
  recommended: 'Recommended',
  chooseOne: 'Choose one',
  name: 'Name',
  password: 'Password',
  passwordHelp: 'Used once to make Whombat’s own key, then forgotten.',
  code: 'Two-step code',
  codeOptional: 'Two-step code (optional)',
  codeHelp: 'Only if this account signs in with a code too.',
  codePlaceholder: '123456',
  ownCertificate: 'It uses a certificate of its own. Its fingerprint:',
  unverifiable:
    'Its certificate can’t be verified (self-signed, expired or for another name). Its fingerprint:',
  trust: 'Trust this certificate',
  trusted: 'Whombat trusts this certificate and only this one.',
  undo: 'Undo',
  addNetwork: 'Add this network',
  useFingerprint: 'Use this fingerprint',
  nextcloud:
    'Nextcloud opens in a new tab: log in there and choose Grant access. This page carries on by itself.',
  /** The phone's Nextcloud line: its browser where the web has a tab (AP-2914). */
  nextcloudPhone:
    'Nextcloud opens in your browser: log in there and choose Grant access. This screen carries on by itself.',
  /** Signing in on the service's own page (SG-05, AP-3905): Nextcloud's line in the entry's words. */
  serviceLogin: (name: string) =>
    `${name} opens in a new tab: sign in there and allow Whombat. This page carries on by itself.`,
  /** The phone's: its browser where the web has a tab. */
  serviceLoginPhone: (name: string) =>
    `${name} opens in your browser: sign in there and allow Whombat. This screen carries on by itself.`,
  homeAssistant: 'Your browser needs to reach Home Assistant at this address.',
  notThrough: 'That didn’t go through. Try again.',
  cantStart: 'Couldn’t start the sign-in in this tab. Try again in a moment.',
  pasteNothing: 'Whombat couldn’t find a key in that. Paste only the key, or fill in the fields below.',
  fileTooBig: 'That file is too big to be a key.',
  chooseFile: 'Choose a file',
  copy: 'Copy',
  parameterName: 'Parameter name',
  headerName: 'Header name',
  parameterHelp: 'The query parameter the token goes in.',
  headerHelp: 'The header the token goes in.',
  /** “Signing in to Proxmox VE and making Whombat’s key…”, while sign in once runs. */
  signingIn: (name: string) => `Signing in to ${name} and making Whombat’s key…`,
  /** A secret with its own name (T3 Code's): “Signing in to T3 Code with the pairing code…”. */
  signingInWith: (name: string, secret: string) => `Signing in to ${name} with the ${secret}…`,
  /** The toast once it's connected (PC-10). */
  connected: (label: string) => `${label} connected.`,
  /** The toast once Add this network added it. */
  networkAdded: (cidr: string, port: number) => `${cidr} port ${port} added to the home network list.`,
  copied: (label: string) => `${label} copied.`,
  /** More options folded: “Named “Proxmox VE · pve.local:8006””. */
  moreSummary: (label: string) => `Named “${label}”`,
  /** The guided steps' list, for a screen reader: “Making the token”. */
  making: (secretLabel: string) => `Making the ${secretLabel.toLowerCase()}`,
} as const;

/** What the person has typed and picked. Secrets live here only while the form is open. */
export interface ConnectDraft {
  fields: Record<string, string>;
  secret: string;
  account: string;
  password: string;
  code: string;
  /** The service asked for a second factor's code (CS-03; a session's two-step code, SG-09). */
  codeAsked: boolean;
  /**
   * The sealed challenge the code answers (`ConnectProblem.challenge`, CT-731; SG-06): sent back as `login.challenge`
   * with the code. Optional, so a form that doesn't keep one sends none (the sign-in starts fresh, as before).
   */
  challenge?: string | null;
  /** A Custom entry's header or query parameter name (CT-269). */
  authName: string;
  label: string;
  access: ConnectionAccessLevel;
}

/** The fields a form starts with: the entry's defaults, and the address a link filled in (`&url=`, CS-51). */
export function initialFields(entry: CatalogEntry, initialUrl?: string | null): Record<string, string> {
  const urlField = entry.fields.find((f) => f.id === 'url');
  return {
    ...Object.fromEntries(entry.fields.filter((f) => f.default).map((f) => [f.id, f.default as string])),
    ...(initialUrl && urlField ? { url: initialUrl } : {}),
  };
}

/** A Custom entry names its own header or query parameter (CT-269: `auth` checked with `tokenAuthProblem`). */
export function ownsAuth(entry: CatalogEntry, method: CatalogSignIn): boolean {
  return entry.category === 'custom' && method.kind === 'token' && method.auth.type !== 'bearer';
}

/** The header or parameter name a Custom sign-in starts with. */
export function authNameOf(choice: Pick<SignInChoice, 'method'> | undefined): string {
  const m = choice?.method;
  if (m?.kind !== 'token') return '';
  return m.auth.type === 'header' || m.auth.type === 'query' ? m.auth.name : '';
}

/** The account sign in once signs in as when the entry fixes it (Plex's `plex.tv` account …); null when asked. */
export function fixedAccountOf(method: CatalogSignIn): string | null {
  return method.kind === 'password' ? (method.account?.fixed ?? null) : null;
}

/**
 * Whether the form shows the code: sign in once when the service asked for one, or from the start where it's optional;
 * a session's two-step code (`twoStep`, SG-09: Synology) only once the service asked (AP-3906).
 */
export function codeShown(method: CatalogSignIn, codeAsked: boolean): boolean {
  if (asksTwoStepCode(method)) return codeAsked;
  return method.kind === 'password' && (codeAsked || method.secondFactor === 'optional');
}

/** The non-empty values of the fields this sign-in asks for, plus a picked choice of a `fromService` field. */
export function connectValues(
  entry: CatalogEntry,
  shown: readonly Pick<Field, 'id'>[],
  current: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of entry.fields) {
    const v = current[f.id]?.trim();
    if (v && (shown.some((s) => s.id === f.id) || f.fromService)) out[f.id] = v;
  }
  return out;
}

/**
 * What the form refuses before it asks the Whombat (the steps form's rules): a field's own problem, the secret of a
 * token or an OAuth client, sign in once's account, password and code, a Custom header's or parameter's name.
 */
export function draftProblems(
  entry: CatalogEntry,
  choice: Pick<SignInChoice, 'method'>,
  shown: readonly Field[],
  draft: Pick<ConnectDraft, 'fields' | 'secret' | 'account' | 'password' | 'code' | 'codeAsked' | 'authName'>,
): Record<string, string> {
  const method = choice.method;
  const out: Record<string, string> = {};
  for (const f of shown) {
    const p = fieldProblem(f, draft.fields[f.id]);
    if (p) out[f.id] = p;
  }
  if ((method.kind === 'token' || method.kind === 'client_credentials') && !draft.secret.trim())
    out.secret = `${method.secretLabel} is needed.`;
  if (method.kind === 'password') {
    // A sign-in with no account (T3 Code's pairing code, Whombat t3code.md T3-02) asks for its secret alone.
    if (method.account && !fixedAccountOf(method) && !draft.account.trim())
      out.account = `${method.account.label} is needed.`;
    if (!draft.password) out.password = `${method.secret?.label ?? 'Password'} is needed.`;
  }
  if (method.kind === 'password' || asksTwoStepCode(method)) {
    const p = codeProblem(draft.code, draft.codeAsked);
    if (p) out.code = p;
  }
  if (ownsAuth(entry, method) && !/^[A-Za-z0-9_.-]{1,64}$/.test(draft.authName.trim()))
    out.authName =
      method.kind === 'token' && method.auth.type === 'query' ? 'Name the parameter.' : 'Name the header.';
  return out;
}

/** A typed code's problem: none when asked, too short to be one (`TwoStepCode` takes 4…64). */
export function codeProblem(code: string, asked: boolean): string | null {
  const typed = code.trim();
  if (asked && !typed) return 'Enter the code.';
  if (typed && typed.length < 4) return 'Enter the whole code.';
  return null;
}

/** A Custom entry's own header or parameter (CT-269); nothing for every other sign-in. */
export function draftAuth(
  entry: CatalogEntry,
  method: CatalogSignIn,
  authName: string,
): TokenAuth | undefined {
  if (!ownsAuth(entry, method) || method.kind !== 'token') return undefined;
  const name = authName.trim();
  if (method.auth.type === 'header') return { type: 'header', name, template: method.auth.template };
  if (method.auth.type === 'query') return { type: 'query', name };
  return undefined;
}

/** What every way of connecting sends: the entry, its name when typed, the fields' values. */
export function connectBase(
  entry: CatalogEntry,
  shown: readonly Pick<Field, 'id'>[],
  draft: Pick<ConnectDraft, 'fields' | 'label'>,
) {
  return {
    catalogId: entry.id,
    ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
    fields: connectValues(entry, shown, draft.fields),
  };
}

/** Whether a sign-in connects here, with `connections.create` (the rest sign in elsewhere). */
export function connectsHere(choice: Pick<SignInChoice, 'kind'>): boolean {
  return (
    choice.kind === 'token' ||
    choice.kind === 'none' ||
    choice.kind === 'password' ||
    choice.kind === 'client_credentials'
  );
}

/**
 * `connections.create`'s body for a sign-in made here (the steps form, CT-314): the level where agents use it (never
 * for an automations' connection or a gateway), which token sign-in, a Custom header, the secret, sign in once's login
 * — its code with the challenge it answers (CT-731, SG-06) — and a session's two-step code (`code`, CT-733, SG-09).
 */
export function createBody(
  entry: CatalogEntry,
  choice: Pick<SignInChoice, 'kind' | 'method' | 'tokenIndex'>,
  shown: readonly Pick<Field, 'id'>[],
  draft: ConnectDraft,
): CreateConnectionBody {
  const method = choice.method;
  const own = draftAuth(entry, method, draft.authName);
  const typed = draft.code.trim();
  const fixed = fixedAccountOf(method);
  return {
    ...connectBase(entry, shown, draft),
    signIn: method.kind as 'token' | 'none' | 'password' | 'client_credentials',
    // Agents never use an automations' connection (TA-02) or a gateway (AIG-01): no level to send.
    ...(usedByAgents(entry) ? { access: draft.access } : {}),
    ...(choice.tokenIndex !== null ? { method: choice.tokenIndex } : {}),
    ...(own ? { auth: own } : {}),
    ...(method.kind === 'token' || method.kind === 'client_credentials'
      ? { secret: draft.secret.trim() }
      : {}),
    ...(method.kind === 'password'
      ? {
          login: {
            account: fixed ?? draft.account.trim(),
            password: draft.password,
            ...(typed ? { code: typed, ...(draft.challenge ? { challenge: draft.challenge } : {}) } : {}),
          },
        }
      : {}),
    ...(asksTwoStepCode(method) && typed ? { code: typed } : {}),
  };
}

/**
 * `connections.startServiceLogin`'s body (contracts 0.111 CT-738; SG-02, AP-3907): what every way of connecting sends,
 * and the level where agents use it (set on save).
 */
export function serviceLoginBody(
  entry: CatalogEntry,
  shown: readonly Pick<Field, 'id'>[],
  draft: Pick<ConnectDraft, 'fields' | 'label' | 'access'>,
): StartServiceLoginBody {
  return {
    ...connectBase(entry, shown, draft),
    ...(usedByAgents(entry) ? { access: draft.access } : {}),
  };
}

/**
 * Signing a connection in again on the service's own page (SG-02: `connectionId` keeps its entry and fields; its
 * level is sent as it is, so the start never changes it).
 */
export function reconnectServiceLoginBody(
  conn: Pick<ConnectionView, 'id' | 'catalogId' | 'fields' | 'access'>,
): StartServiceLoginBody {
  return {
    catalogId: conn.catalogId,
    fields: conn.fields,
    access: conn.access,
    connectionId: conn.id,
  };
}

/** Replace token or password's body: the secret, and a session's two-step code once the service asked (CT-733, SG-09). */
export function setSecretBody(
  method: CatalogSignIn | null | undefined,
  secret: string,
  code = '',
): SetConnectionSecretBody {
  const typed = code.trim();
  return { secret, ...(asksTwoStepCode(method) && typed ? { code: typed } : {}) };
}

/** Where a sign-in elsewhere comes back to: this entry's form in this burrow (AP-756; the server adds the outcome). */
export function connectReturnTo(entryId: string, burrow: string): string {
  return withBurrow(`/settings?tab=connections&connection=${entryId}`, burrow);
}
