/**
 * Connecting, changing and removing catalog connections (docs/decisions/connections-catalog.md CX-03, CX-05, CX-10,
 * CX-17, CX-22, CX-24, CX-40, CX-41; one-person.md OP-S50): the person's, the fields and the destination checked before
 * anything is stored, the entry's check run with the credential (refused with a sentence when it fails), a
 * `fromService` field picked from the service's answer (`field_choice_needed` when there are several), the label and
 * handle, the commit (signed burrow events), then the tools read (`syncTools`, the tools side) and the check recorded.
 *
 * Sign in once (docs/decisions/connections-setup.md CS-01…CS-09): `signIn: 'password'` checks the address and the
 * certificate first (CS-05), lets the entry's provisioner sign in and make Whombat's own key (`provision/`), checks that
 * key and stores it as the entry's token sign-in; the password is passed to the provisioner and dropped with the call.
 * `client_credentials` (CS-12) exchanges an OAuth client's secret for a token and checks with it. Every connection
 * keeps the level agents get, Look only or Manage (`access`, CS-10, CS-11).
 */
import {
  AI_GATEWAY_COPY,
  type CatalogCheckResult,
  type CatalogEntry,
  type ConnectionAccessLevel,
  type ConnectionToolTier,
  type CreateConnectionBody,
  catalogEntry,
  connectionTransport,
  defaultConnectionLabel,
  destinationRefusedText,
  fieldsFor,
  fieldsProblems,
  gatewayClientLabel,
  isVaultSyncConnection,
  newId,
  ONEPASSWORD_BASE_URL,
  type OnePasswordDisconnectChoice,
  resolveBaseUrl,
  resolveMcpUrl,
  type SignInKind,
  sessionLoginRequest,
  sessionTemplateFields,
  sessionTwoStepAgainText,
  type TokenAuth,
  tokenAuthProblem,
  tokenCredential,
  type UpdateConnectionBody,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { CommandStopped } from '../commit/scope';
import { burrows, catalogConnections, principals } from '../db/schema/index';
import {
  type FuseboxTarget,
  type GatewayKeyMade,
  provisionFusebox,
  removeFuseboxClient,
} from '../gateway/provision';
import { gatewayConnectionOf, gatewayName, isGatewayCatalogId } from '../gateway/store';
import { FIND_MY_CONNECTION_TEXT, findMyConnections } from '../hosts/findmy-connection';
import { serverLabel } from '../hosts/self';
import { OutboundError } from '../lib/outbound';
import { ok } from '../routes/define';
import type { Services } from '../services';
import { ONEPASSWORD_CONNECTION_EXISTS, onePasswordConnectionOf } from '../vault/onepassword/store';
import {
  type CheckCredential,
  type CheckOutcome,
  certificateFirst,
  externalNameFrom,
  NO_CREDENTIAL,
  recordFromCheck,
  runCatalogCheck,
  serviceChoices,
  trustHomeCertificate,
} from './checks';
import {
  type ClientCredentialsMethod,
  clientCredentialsMethod,
  exchangeForConnect,
} from './client-credentials';
import { clientForRow, endpointsForRow } from './clients';
import {
  addConnection,
  type ConnectionChanges,
  changeConnection,
  markNeedsReauth,
  type NewConnection,
  removeConnection,
  setToolTier,
} from './commands';
import { credentialFor } from './credentials';
import {
  type ConnectionSecretKind,
  openConnectionSecret,
  openJson,
  sealConnectionSecret,
  sealJson,
} from './crypto';
import { connectionDestinationProblem } from './destination';
import { connectionError, connectionFieldError, fieldProblemsError } from './errors';
import { connectionFetch, outboundText, pinOf } from './http';
import { emitConnectionLifecycle } from './lifecycle';
import { findLogoLater } from './look';
import { revokeToken } from './oauth';
import { provisionerFor } from './provision/index';
import { runProvisioner } from './provision/run';
import { ProvisionError, type Provisioned, type Provisioner } from './provision/types';
import {
  endConnectionSession,
  rememberedOf,
  sessionAuthOf,
  TWO_STEP_CODE_TEXT,
  WRONG_TWO_STEP_CODE_TEXT,
} from './session';
import { type ConnectionViewer, connectionRow, requireRoom, visibleConnection } from './store';
import { syncTools } from './sync';
import { type CatalogConnectionRow, ConnectionAuthError } from './types';

/* Who --------------------------------------------------------------------------------------------- */

/** The viewer for an account's person in a burrow, or null when they aren't (any more) a member there. */
export async function viewerFor(
  services: Services,
  accountId: string,
  burrowId: string,
): Promise<ConnectionViewer | null> {
  const [principal] = await services.db
    .select()
    .from(principals)
    .where(
      and(
        eq(principals.burrowId, burrowId),
        eq(principals.accountId, accountId),
        eq(principals.kind, 'person'),
      ),
    );
  if (!principal) return null;
  return { accountId, burrowId, principal };
}

/* Checks before saving ------------------------------------------------------------------------------ */

/** The entry, or `not_supported` (unknown to this build, or builtin: those keep their own pages, CX-02). */
export function connectableEntry(catalogId: string): CatalogEntry {
  const entry = catalogEntry(catalogId);
  if (!entry || entry.transport === 'builtin') throw connectionError('not_supported', { catalogId });
  return entry;
}

/**
 * Every address the connection will call is allowed now (CX-40), or `destination_refused` with what to add (CX-41).
 * The hosts service's own base (a connection through a Mac) and 1Password's (its SDK talks to 1Password itself, in the
 * sync's worker) aren't addresses anything is sent to.
 */
export async function requireDestination(
  services: Services,
  urls: readonly (string | null)[],
): Promise<void> {
  for (const url of new Set(
    urls.filter((u): u is string => !!u && u !== HOSTS_BASE && u !== ONEPASSWORD_BASE_URL),
  )) {
    const problem = await connectionDestinationProblem(services, url, 'save');
    if (!problem) continue;
    const s = problem.suggestion;
    throw connectionError(
      'destination_refused',
      // The person adds the network themselves (CT-1553).
      { problem: problem.code, ...(s ? { cidr: s.cidr, port: s.port } : {}) },
      s ? destinationRefusedText(s.cidr, s.port) : problem.message,
    );
  }
}

/** The fields without empty values, trimmed. */
export function cleanFields(fields: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    const t = v.trim();
    if (t !== '') out[k] = t;
  }
  return out;
}

function sameFields(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/** The fields are acceptable for this sign-in method (`validation_failed` per field, `fields.<id>`). */
export function requireFields(entry: CatalogEntry, kind: SignInKind, fields: Record<string, string>): void {
  const problems = fieldsProblems(entry, kind, fields);
  if (Object.keys(problems).length) throw fieldProblemsError(problems);
}

/** Whether an entry works through one of the person's Macs (Find My): no address of its own, nothing sent there. */
const throughMac = (entry: CatalogEntry) => entry.check?.kind === 'mac';

/** The base of a connection through the hosts service (the Servers connection's and Find My's): never requested. */
const HOSTS_BASE = 'whombat-hosts:';

/**
 * The base URL with the fields filled in, or a field error on the address. A connection through a Mac keeps the
 * entry's own base (the Servers connection's), which is never requested.
 */
export function requireBaseUrl(entry: CatalogEntry, fields: Record<string, string>): string {
  if (throughMac(entry)) return entry.baseUrl ?? HOSTS_BASE;
  if (isVaultSyncConnection(entry)) return ONEPASSWORD_BASE_URL;
  const base = resolveBaseUrl(entry, fields);
  if (base) return base;
  const urlField = fieldsFor(entry, 'token').find((f) => f.kind === 'url')?.id ?? 'url';
  throw fieldProblemsError({ [urlField]: 'Whombat can’t use that address.' });
}

/** A token that travels in a header can't hold line breaks. */
function secretProblem(auth: TokenAuth, secret: string): string | null {
  if (auth.type !== 'query' && /[\r\n]/.test(secret)) return 'Paste the token on one line.';
  if (!secret.trim()) return 'Paste the token.';
  return null;
}

/**
 * The headers and query a token adds, or a field error (a field it needs is missing). A session's password (CM-10)
 * signs in when the check runs (`CheckCredential.session`), with a two-step code the person typed or the trusted-device
 * token the connection keeps (`twoStep`, connection-signin.md SG-09).
 */
export function tokenCheckCredential(
  entry: CatalogEntry,
  auth: TokenAuth,
  secret: string,
  fields: Readonly<Record<string, string>>,
  twoStep: { code?: string | undefined; remembered?: string | null | undefined } = {},
): CheckCredential {
  const problem = secretProblem(auth, secret);
  if (problem) throw connectionFieldError({ secret: problem }, problem);
  const session = sessionAuthOf(auth);
  if (session) {
    if (!sessionLoginRequest(entry, session, secret.trim(), fields)) {
      // The field the sign-in names that is empty (the account name, NS-02).
      const named = [...Object.values(session.login.body), ...Object.values(session.login.query ?? {})]
        .flatMap(sessionTemplateFields)
        .filter((id) => id !== 'secret');
      const missing = named.find((id) => !fields[id]?.trim()) ?? named[0] ?? 'username';
      throw connectionFieldError({ [`fields.${missing}`]: 'This is needed to sign in.' });
    }
    return {
      headers: {},
      query: {},
      secret: secret.trim(),
      session: {
        auth: session,
        ...(twoStep.code ? { code: twoStep.code } : {}),
        ...(twoStep.remembered ? { remembered: twoStep.remembered } : {}),
      },
    };
  }
  const credential = tokenCredential(entry, auth, secret.trim(), fields);
  if (!credential) {
    const field = auth.type === 'basic' ? auth.usernameField : 'secret';
    throw connectionFieldError({
      [field === 'secret' ? 'secret' : `fields.${field}`]: 'This is needed to sign in.',
    });
  }
  return { ...credential, secret: secret.trim() };
}

/** The session a check signed in for, as the connection keeps it (sealed in the access-token columns, CM-11). */
function sessionTokens(outcome: CheckOutcome): NewConnectionInput['tokens'] {
  return outcome.session
    ? {
        accessToken: outcome.session.token,
        refreshToken: null,
        expiresAt: outcome.session.expiresAt,
        scopes: [],
      }
    : null;
}

/**
 * How a stored connection proves itself now: the tools side's credential (`credentials.ts`: its token, an OAuth access
 * token refreshed when due, or nothing). A token connection that needs connecting again is still tried (“Check again”).
 */
export async function credentialOf(
  services: Services,
  row: CatalogConnectionRow,
  opts: { force?: boolean } = {},
): Promise<CheckCredential> {
  connectableEntry(row.catalogId);
  const { headers, query, secret } = await credentialFor(services, row, {
    forceRefresh: opts.force === true,
    evenIfNeedsReauth: true,
  });
  return { headers, query, ...(secret ? { secret } : {}) };
}

/**
 * Refuses a failed check with the form's sentence (`check_failed`, the HTTP status when there was one, and the
 * fingerprint a home-network server presented when its certificate couldn't be verified, CX-D33).
 */
export function requireCheckPassed(outcome: CheckOutcome): void {
  if (outcome.ok) return;
  // A session's two-step code (SG-09): asked for, or the one sent refused.
  if (outcome.twoStep === 'asked')
    throw connectionError('second_factor_needed', {}, outcome.message ?? TWO_STEP_CODE_TEXT);
  if (outcome.twoStep === 'wrong_code')
    throw connectionError('sign_in_refused', { reason: 'code' }, outcome.message ?? WRONG_TWO_STEP_CODE_TEXT);
  throw connectionError(
    'check_failed',
    {
      ...(outcome.status !== null ? { status: outcome.status } : {}),
      ...(outcome.certificateSha256 ? { certificateSha256: outcome.certificateSha256 } : {}),
    },
    outcome.message ?? 'Whombat couldn’t sign in with that.',
  );
}

/**
 * Fills a `fromService` field from the check's answer (CT-268): a given value must be one of the choices; none given
 * takes the only one, or refuses with `field_choice_needed` and the choices.
 */
export function chooseServiceFields(
  entry: CatalogEntry,
  kind: SignInKind,
  fields: Record<string, string>,
  outcome: CheckOutcome,
): Record<string, string> {
  const field = fieldsFor(entry, kind).find((f) => f.fromService);
  if (!field) return fields;
  const options = serviceChoices(outcome.json);
  const given = fields[field.id];
  if (given) {
    if (options.some((o) => o.value === given)) return fields;
    throw fieldProblemsError({
      [field.id]: `That ${field.label.toLowerCase()} isn’t one this token can use.`,
    });
  }
  if (options.length === 1) return { ...fields, [field.id]: (options[0] as { value: string }).value };
  if (options.length === 0)
    throw connectionError('check_failed', {}, `This token can’t use any ${field.label.toLowerCase()}.`);
  throw connectionError('field_choice_needed', { field: field.id, options });
}

/* Saving ------------------------------------------------------------------------------------------- */

export interface NewConnectionInput {
  entry: CatalogEntry;
  signIn: SignInKind;
  labelGiven: string | null;
  fields: Record<string, string>;
  baseUrl: string;
  auth?: TokenAuth | null;
  secret?: string | null;
  tokens?: {
    accessToken: string;
    refreshToken: string | null;
    expiresAt: Date | null;
    scopes: string[];
  } | null;
  clientId?: string | null;
  issuer?: string | null;
  resource?: string | null;
  externalName?: string | null;
  /** What agents may do with it (CS-10); OAuth and Nextcloud sign-ins manage. */
  access?: ConnectionAccessLevel;
  checks: CatalogCheckResult[];
  /**
   * What the check's answer filled (its `fromCheck` fields, connection-signin.md SG-15a): added to the fields as they
   * are saved.
   */
  fromCheck?: Record<string, string>;
  /** A Fusebox: the client key Whombat made in it (ai-gateway.md AIG-02); null for an open one and every other entry. */
  clientSecret?: string | null;
  /** A session's trusted-device token from its sign-in with a code (SG-09); null for every other connection. */
  remembered?: string | null;
  /**
   * When a token itself ends, for a service that gives one Whombat can't renew (T3 Code's sign-in, 30 days,
   * docs/decisions/t3code.md T3-05): kept as `accessExpiresAt`, with no access token beside it. Null for every other.
   */
  expiresAt?: Date | null;
}

/** The credential columns of a connection, sealed for its id. */
function credentialColumns(
  services: Services,
  id: string,
  input: Pick<
    NewConnectionInput,
    | 'secret'
    | 'tokens'
    | 'clientId'
    | 'issuer'
    | 'resource'
    | 'auth'
    | 'clientSecret'
    | 'remembered'
    | 'expiresAt'
  >,
): ConnectionChanges {
  const seal = (kind: ConnectionSecretKind, v: string) => sealConnectionSecret(services.custody, id, kind, v);
  return {
    auth: input.auth ?? null,
    secretEnc: input.secret ? seal('secret', input.secret) : null,
    clientSecretEnc: input.clientSecret ? seal('client', input.clientSecret) : null,
    rememberedEnc: input.remembered ? seal('remembered', input.remembered) : null,
    refreshTokenEnc: input.tokens?.refreshToken ? seal('refresh', input.tokens.refreshToken) : null,
    accessTokenEnc: input.tokens ? seal('access', input.tokens.accessToken) : null,
    accessExpiresAt: input.tokens?.expiresAt ?? input.expiresAt ?? null,
    scopes: input.tokens?.scopes ?? [],
    // A new connection has asked for nothing beyond its sign-in yet (a reconnect keeps what was granted of it).
    scopesWanted: [],
    clientId: input.clientId ?? null,
    issuer: input.issuer ?? null,
    resource: input.resource ?? null,
  };
}

/** Stores a new connection (signed `connection.added`), then reads its tools and records the check. */
export async function saveNewConnection(
  services: Services,
  viewer: ConnectionViewer,
  input: NewConnectionInput,
): Promise<{ row: CatalogConnectionRow; eventId: string | null }> {
  const id = newId('connection');
  const now = services.clock();
  const values: NewConnection = {
    id,
    catalogId: input.entry.id,
    burrowId: viewer.burrowId,
    label: input.labelGiven ?? defaultConnectionLabel(input.entry, input.fields),
    transport: connectionTransport(input.entry, input.signIn),
    signIn: input.signIn,
    baseUrl: input.baseUrl,
    fields: { ...input.fields, ...(input.fromCheck ?? {}) },
    ...credentialColumns(services, id, input),
    externalName: input.externalName ?? null,
    access: input.access ?? 'manage',
    status: 'active',
    checks: input.checks,
    checkedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const { row, eventId } = ok(
    await services.pipeline.commit(
      addConnection,
      { values, labelGiven: input.labelGiven },
      { burrowId: viewer.burrowId, actorId: viewer.principal.id },
    ),
  );
  const synced = await syncAndRecord(services, row, input.checks);
  // A Custom connection looks for its service's own logo in the background (connection-looks.md).
  findLogoLater(services, synced, viewer.principal.id);
  return { row: synced, eventId };
}

/**
 * A connection signed in again (an OAuth reconnect, a Nextcloud login, CX-72's Reconnect): the new credential replaces
 * the old one, it is active again, pooled clients reconnect, and its tools are read again.
 */
export async function saveReconnect(
  services: Services,
  viewer: ConnectionViewer,
  row: CatalogConnectionRow,
  input: Omit<NewConnectionInput, 'entry' | 'labelGiven' | 'baseUrl'> & { baseUrl?: string },
): Promise<{ row: CatalogConnectionRow; eventId: string | null }> {
  const entry = connectableEntry(row.catalogId);
  const set: ConnectionChanges = {
    signIn: input.signIn,
    transport: connectionTransport(entry, input.signIn),
    fields: { ...input.fields, ...(input.fromCheck ?? {}) },
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...credentialColumns(services, row.id, input),
    // What calls asked for and the person allowed stays asked at the next sign-in; what they declined is dropped, so a
    // call that needs it again asks again.
    scopesWanted: row.scopesWanted.filter((s) => input.tokens?.scopes.includes(s)),
    ...(input.externalName ? { externalName: input.externalName } : {}),
    status: 'active',
    reauthReason: null,
    repairNotifiedAt: null,
    credentialVersion: row.credentialVersion + 1,
    checks: input.checks,
    checkedAt: services.clock(),
  };
  const res = await applyChanges(services, viewer, row, set, ['reconnected']);
  await emitConnectionLifecycle(services, { type: 'credential', connectionId: row.id });
  return { row: await syncAndRecord(services, res.row, input.checks), eventId: res.eventId };
}

/** Writes a change: a signed `connection.changed`. */
export async function applyChanges(
  services: Services,
  viewer: ConnectionViewer,
  row: CatalogConnectionRow,
  set: ConnectionChanges,
  what: string[],
  options: { text?: string } = {},
): Promise<{ row: CatalogConnectionRow; eventId: string | null }> {
  return ok(
    await services.pipeline.commit(
      changeConnection,
      { connectionId: row.id, set, what, ...(options.text ? { text: options.text } : {}) },
      { burrowId: viewer.burrowId, actorId: viewer.principal.id },
    ),
  );
}

function mergeChecks(...lists: readonly CatalogCheckResult[][]): CatalogCheckResult[] {
  const seen = new Set<string>();
  const out: CatalogCheckResult[] = [];
  for (const list of lists)
    for (const c of list) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
  return out;
}

/**
 * Reads the connection's tools (`syncTools`, the tools side: discovered from its MCP server, its adapter's and
 * `request`) and records the check lines with the tools' own. A sync that fails leaves the connection as it is, with a
 * warning line. No signed event: a check changes no state anyone decided.
 */
export async function syncAndRecord(
  services: Services,
  row: CatalogConnectionRow,
  credentialChecks: CatalogCheckResult[],
): Promise<CatalogConnectionRow> {
  let synced: Awaited<ReturnType<typeof syncTools>> | null = null;
  try {
    synced = await syncTools(services, row.id);
  } catch (err) {
    services.log.warn({ connectionId: row.id, err: String(err) }, 'connection tools sync failed');
  }
  const checks = mergeChecks(
    credentialChecks,
    synced?.checks ?? [
      {
        id: 'tools',
        state: 'warning',
        message: 'Whombat couldn’t read its tools yet. Check again in a moment.',
      },
    ],
  );
  const now = services.clock();
  const [updated] = await services.pipeline.transactAccount((tx) =>
    tx
      .update(catalogConnections)
      .set({ checks, checkedAt: now, ...(synced ? { toolCount: synced.count, toolsSyncedAt: now } : {}) })
      .where(eq(catalogConnections.id, row.id))
      .returning(),
  );
  return updated ?? row;
}

/* Endpoints ---------------------------------------------------------------------------------------- */

/** `connections.create`: with a token (or nothing), by signing in once, or with an OAuth client's secret. */
export async function createConnection(
  services: Services,
  viewer: ConnectionViewer,
  body: z.output<typeof CreateConnectionBody>,
): Promise<{ row: CatalogConnectionRow; eventId: string | null }> {
  switch (body.signIn) {
    case 'password':
      return createPasswordConnection(services, viewer, body);
    case 'client_credentials':
      return createClientCredentialsConnection(services, viewer, body);
    default:
      return createTokenConnection(services, viewer, body);
  }
}

/** `connections.create` with a token or without a sign-in. */
export async function createTokenConnection(
  services: Services,
  viewer: ConnectionViewer,
  body: z.output<typeof CreateConnectionBody>,
): Promise<{ row: CatalogConnectionRow; eventId: string | null }> {
  const entry = connectableEntry(body.catalogId);
  if (body.signIn !== 'token' && body.signIn !== 'none')
    throw connectionError('not_supported', { catalogId: entry.id });
  await requireNoOtherGateway(services, viewer, entry);
  await requireNoOtherVaultSync(services, viewer, entry);
  let auth: TokenAuth | null = null;
  if (body.signIn === 'none') {
    if (!entry.signIn.some((m) => m.kind === 'none'))
      throw connectionError('not_supported', { catalogId: entry.id });
  } else {
    const methods = entry.signIn.filter((m) => m.kind === 'token');
    const method = methods[body.method ?? 0];
    if (method?.kind !== 'token') throw connectionError('not_supported', { catalogId: entry.id });
    auth = method.auth;
    if (body.auth) {
      // Only the Custom entries take a person's own header shape (CX-61, CX-62).
      if (entry.category !== 'custom') throw connectionError('not_supported', { catalogId: entry.id });
      const problem = tokenAuthProblem(entry, body.auth);
      if (problem) throw connectionFieldError({ auth: problem }, problem);
      auth = body.auth;
    }
    if (!body.secret) throw connectionFieldError({ secret: 'Paste the token.' }, 'Paste the token.');
  }
  const kind: SignInKind = body.signIn;
  const given = cleanFields(body.fields);
  requireFields(entry, kind, given);
  await requireRoom(services.db, viewer.burrowId);
  const baseUrl = requireBaseUrl(entry, given);
  const mcpUrl = resolveMcpUrl(entry, given, kind);
  await requireDestination(services, [baseUrl, mcpUrl]);
  const fields = await trustHomeCertificate(services, { entry, baseUrl, fields: given });
  // A session's two-step code (SG-09).
  const code = body.code;
  const credential =
    auth && body.secret ? tokenCheckCredential(entry, auth, body.secret, fields, { code }) : NO_CREDENTIAL;
  const outcome = await runCatalogCheck(services, {
    entry,
    signIn: kind,
    baseUrl,
    mcpUrl,
    fields,
    credential,
  });
  requireCheckPassed(outcome);
  const chosen = chooseServiceFields(entry, kind, fields, outcome);
  await requireFreeMac(services, viewer.burrowId, entry, chosen);
  const labelGiven = body.label ?? (await macLabel(services, viewer.burrowId, entry, chosen));
  // A field picked from the service may be in the base (none in v1, but the template decides).
  const base = resolveBaseUrl(entry, chosen) ?? baseUrl;
  // A Fusebox: Whombat's own client key, made with the management key that just passed (ai-gateway.md AIG-02).
  const made = await provisionGatewayKey(services, viewer, entry, {
    baseUrl: base,
    fields: chosen,
    credential,
  });
  const target = made ? fuseboxTarget(base, chosen, credential) : null;
  try {
    return await saveNewConnection(services, viewer, {
      entry,
      signIn: kind,
      labelGiven,
      fields: made?.clientId ? { ...chosen, clientId: made.clientId } : chosen,
      baseUrl: base,
      auth,
      secret: body.secret?.trim() ?? null,
      tokens: sessionTokens(outcome),
      // A 1Password connection's row names the vault it keeps in step (from the vaults its check listed).
      externalName: isVaultSyncConnection(entry)
        ? (serviceChoices(outcome.json).find((c) => c.value === chosen.vault)?.label ?? null)
        : externalNameFrom(outcome.json),
      access: body.access,
      checks: outcome.checks,
      fromCheck: outcome.fromCheck ?? {},
      clientSecret: made?.clientKey ?? null,
      remembered: outcome.session?.remembered ?? null,
    });
  } catch (err) {
    // Not saved: the key it made goes again (best effort), so none is left behind in Fusebox (AIG-03).
    if (target && made?.clientId) await removeFuseboxClient(services, target, made.clientId);
    throw err;
  }
}

/* The AI gateway (ai-gateway.md AIG-01…AIG-03) ------------------------------------------------------------------------ */

/**
 * One Find My connection per Mac (each Mac is signed in to its own Apple Account): another on the same Mac is refused
 * with the Mac's name. `except`: the connection being changed.
 */
export async function requireFreeMac(
  services: Services,
  burrowId: string,
  entry: CatalogEntry,
  fields: Readonly<Record<string, string>>,
  except: string | null = null,
): Promise<void> {
  const mac = throughMac(entry) ? fields.mac?.trim() : undefined;
  if (!mac) return;
  const taken = (await findMyConnections(services.db, { burrowId, mac })).some((r) => r.id !== except);
  if (taken) {
    const text = FIND_MY_CONNECTION_TEXT.taken(serverLabel(mac));
    throw fieldProblemsError({ mac: text });
  }
}

/**
 * A Find My connection's name when the burrow has one already: “Find My · Studio”, by the Mac it reads (as other
 * services get their address then). Null: the service's name does.
 */
async function macLabel(
  services: Services,
  burrowId: string,
  entry: CatalogEntry,
  fields: Readonly<Record<string, string>>,
): Promise<string | null> {
  const mac = throughMac(entry) ? fields.mac?.trim() : undefined;
  if (!mac || !(await findMyConnections(services.db, { burrowId })).length) return null;
  return `${entry.name} · ${serverLabel(mac)}`.slice(0, 80);
}

/** At most one gateway connection per burrow (AIG-01): connecting a second is refused with the first one's name. */
export async function requireNoOtherGateway(
  services: Services,
  viewer: Pick<ConnectionViewer, 'burrowId'>,
  entry: CatalogEntry,
): Promise<void> {
  if (!isGatewayCatalogId(entry.id)) return;
  const existing = await gatewayConnectionOf(services.db, viewer.burrowId);
  if (existing) throw connectionError('gateway_exists', {}, AI_GATEWAY_COPY.exists(gatewayName(existing)));
}

/**
 * At most one 1Password connection per Whombat (onepassword-sync.md OPW-01): a Vault kept in step with two vaults would
 * have two sides that each win. A second is refused before its token is tried.
 */
export async function requireNoOtherVaultSync(
  services: Services,
  viewer: Pick<ConnectionViewer, 'burrowId'>,
  entry: CatalogEntry,
): Promise<void> {
  if (!isVaultSyncConnection(entry)) return;
  if (await onePasswordConnectionOf(services.db, viewer.burrowId))
    throw connectionError('limit_reached', { max: 1 }, ONEPASSWORD_CONNECTION_EXISTS);
}

/** Where Fusebox's management API is, with the management key as the entry sends it and the pinned certificate. */
function fuseboxTarget(
  baseUrl: string,
  fields: Readonly<Record<string, string>>,
  credential: CheckCredential,
): FuseboxTarget {
  return { baseUrl, credential, ...pinOf({ fields: { ...fields } }) };
}

/** The burrow's slug and name, for Whombat's client in Fusebox (`whombat-<slug>`, “Whombat · <name>”). */
async function burrowNaming(
  services: Services,
  burrowId: string,
): Promise<{ id: string; slug: string; name: string }> {
  const [row] = await services.db
    .select({ slug: burrows.slug, name: burrows.name })
    .from(burrows)
    .where(eq(burrows.id, burrowId));
  return { id: burrowId, ...(row ?? { slug: burrowId.toLowerCase(), name: burrowId }) };
}

/**
 * A Fusebox's client key for Whombat (AIG-02), made (or replaced) with a management key that passed the check; null for
 * every other entry. Throws the form's refusal (`check_failed`, `gateway_too_old`).
 */
async function provisionGatewayKey(
  services: Services,
  viewer: Pick<ConnectionViewer, 'burrowId'>,
  entry: CatalogEntry,
  input: { baseUrl: string; fields: Readonly<Record<string, string>>; credential: CheckCredential },
): Promise<GatewayKeyMade | null> {
  if (entry.id !== 'fusebox') return null;
  return provisionFusebox(
    services,
    fuseboxTarget(input.baseUrl, input.fields, input.credential),
    await burrowNaming(services, viewer.burrowId),
  );
}

/** A connection's fields without what Whombat keeps there itself (a Fusebox's `clientId`), for the entry's checks. */
function entryFields(row: Pick<CatalogConnectionRow, 'catalogId' | 'fields'>): Record<string, string> {
  if (row.catalogId !== 'fusebox') return { ...row.fields };
  const { clientId: _clientId, ...rest } = row.fields;
  return rest;
}

/**
 * Takes Whombat's client out of a removed Fusebox (AIG-03), with its management key. The page's notice when Fusebox
 * didn't answer (the connection is removed anyway); null when there was nothing to do or it went.
 */
async function removeGatewayKey(services: Services, row: CatalogConnectionRow): Promise<string | null> {
  const clientId = row.catalogId === 'fusebox' ? row.fields.clientId : undefined;
  if (!clientId) return null;
  const naming = await burrowNaming(services, row.burrowId ?? '');
  const notice = AI_GATEWAY_COPY.removeByHand(gatewayName(row), gatewayClientLabel(naming.name));
  if (!row.secretEnc || !row.auth) return notice;
  let credential: CheckCredential;
  try {
    const entry = connectableEntry(row.catalogId);
    const secret = openConnectionSecret(services.custody, row.id, 'secret', row.secretEnc);
    credential = tokenCheckCredential(entry, row.auth, secret, entryFields(row));
  } catch {
    return notice;
  }
  const removed = await removeFuseboxClient(
    services,
    fuseboxTarget(row.baseUrl, row.fields, credential),
    clientId,
  );
  return removed ? null : notice;
}

/* A second factor's challenge (connection-signin.md SG-06) ------------------------------------------- */

/** The AAD a handed-back challenge is sealed under (SG-06). */
const CHALLENGE_AAD = 'provision-challenge';
/** How long a handed-back challenge opens (SG-06; UniFi's own lasts about as long). */
export const CHALLENGE_TTL_MS = 10 * 60_000;
/** A sealed challenge longer than this isn't handed back (the contract's bound): the next try starts fresh. */
const CHALLENGE_SEALED_MAX = 4096;

/** What a challenge belongs to: the entry, the base URL's origin and the account, lowercased (SG-06). */
export interface ChallengeBinding {
  entryId: string;
  baseUrl: string;
  account: string;
}

interface SealedChallenge {
  entryId: string;
  origin: string;
  account: string;
  value: string;
  expiresAt: number;
}

function originOrNull(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The challenge a provisioner handed back, sealed for the form (custody `sealJson`, AAD `provision-challenge`) with
 * what it belongs to and an expiry of 10 minutes; null when there is none or it is too long to hand back. Useless
 * without the password, and never the password.
 */
export function sealChallenge(
  services: Pick<Services, 'custody' | 'clock'>,
  bound: ChallengeBinding,
  value: string | null,
): string | null {
  const origin = originOrNull(bound.baseUrl);
  if (!value || !origin) return null;
  const sealed = sealJson(services.custody, CHALLENGE_AAD, {
    entryId: bound.entryId,
    origin,
    account: bound.account.trim().toLowerCase(),
    value,
    expiresAt: services.clock().getTime() + CHALLENGE_TTL_MS,
  } satisfies SealedChallenge);
  return sealed.length <= CHALLENGE_SEALED_MAX ? sealed : null;
}

/**
 * The challenge the form sent back, opened (SG-06): null when there is none, it doesn't open, it belongs to another
 * entry, address or account, or it expired. The sign-in then starts fresh, as before.
 */
export function openChallenge(
  services: Pick<Services, 'custody' | 'clock'>,
  bound: ChallengeBinding,
  sealed: string | null | undefined,
): string | null {
  if (!sealed) return null;
  let opened: Partial<SealedChallenge>;
  try {
    opened = openJson<Partial<SealedChallenge>>(services.custody, CHALLENGE_AAD, sealed);
  } catch {
    return null;
  }
  if (
    opened.entryId !== bound.entryId ||
    opened.origin !== originOrNull(bound.baseUrl) ||
    opened.account !== bound.account.trim().toLowerCase() ||
    typeof opened.expiresAt !== 'number' ||
    opened.expiresAt <= services.clock().getTime() ||
    typeof opened.value !== 'string' ||
    !opened.value
  )
    return null;
  return opened.value;
}

/* Sign in once (CS-01…CS-09) ------------------------------------------------------------------------- */

/**
 * A provisioner's failure as the form's refusal: its words for a second factor or a refusal, ours for anything else. A
 * challenge it handed back goes to the form sealed (`details.challenge`, SG-06).
 */
function provisionRefusal(
  services: Services,
  entry: CatalogEntry,
  err: unknown,
  bound: ChallengeBinding,
  wayOut = 'Try again, or make a token instead.',
): unknown {
  if (err instanceof CommandStopped) return err;
  if (err instanceof ProvisionError) {
    const message = err.message.slice(0, 500);
    const challenge = sealChallenge(services, bound, err.challenge);
    const handed = challenge ? { challenge } : {};
    if (err.code === 'second_factor_needed')
      return connectionError('second_factor_needed', { ...handed }, message);
    return connectionError(
      'sign_in_refused',
      {
        reason: err.reason ?? 'unsupported',
        ...(err.method ? { method: err.method.slice(0, 40) } : {}),
        ...handed,
      },
      message,
    );
  }

  if (err instanceof OutboundError) return connectionError('check_failed', {}, outboundText(err));
  // A provisioner's own mistake: its name only, never its message (it might quote the service, or worse).
  services.log.warn(
    { catalogId: entry.id, err: err instanceof Error ? err.name : 'error' },
    'sign in once failed',
  );
  return connectionError(
    'check_failed',
    {},
    `Whombat couldn’t finish signing in to ${entry.name}. ${wayOut}`,
  );
}

/** What the person reads when the key Whombat made doesn't pass the entry's check. */
function madeKeyRefusal(
  entry: CatalogEntry,
  outcome: CheckOutcome,
  wayOut = 'Try again, or make a token instead.',
): unknown {
  return connectionError(
    'check_failed',
    outcome.status !== null ? { status: outcome.status } : {},
    outcome.refused
      ? `Whombat made its key in ${entry.name}, but ${entry.name} refused it. ${wayOut}`
      : `Whombat made its key in ${entry.name}, but checking it failed: ${outcome.message ?? 'it didn’t answer as expected.'}`,
  );
}

/**
 * What to do when sign in once didn't work out: make a token by hand, or, where the token is only ever a sign-in's
 * result (T3 Code), try again with a new secret of that sign-in.
 */
function wayOutOf(tokenMethod: TokenSignIn, secretLabel: string | undefined): string {
  return tokenMethod.storedOnly
    ? `Try again with a new ${(secretLabel ?? 'password').toLowerCase()}.`
    : 'Try again, or make a token instead.';
}

/**
 * The provisioner's note on the check (CS-08): the credential line becomes a warning with it (the check passed; the
 * person should read this). The next “Check again” records the check as it is then (CS-D13).
 */
export function withProvisionNote(
  checks: CatalogCheckResult[],
  note: string | null | undefined,
): CatalogCheckResult[] {
  const text = note?.trim();
  if (!text) return checks;
  const line: CatalogCheckResult = { id: 'credential', state: 'warning', message: text.slice(0, 500) };
  return checks.some((c) => c.id === 'credential')
    ? checks.map((c) => (c.id === 'credential' && c.state === 'ok' ? line : c))
    : [line, ...checks];
}

type TokenSignIn = Extract<CatalogEntry['signIn'][number], { kind: 'token' }>;

/**
 * Sign in once's provisioner run (45 s, `provision/run.ts`) and its key checked as the entry's token sign-in
 * `tokenMethod`: what it made, the fields with what it filled, and the check. Refusals in the form's words.
 */
async function provisionAndCheck(
  services: Services,
  provisioner: Provisioner,
  input: {
    entry: CatalogEntry;
    tokenMethod: TokenSignIn;
    baseUrl: string;
    mcpUrl: string | null;
    fields: Record<string, string>;
    account: string;
    password: string;
    code: string | null;
    challenge: string | null | undefined;
    access: ConnectionAccessLevel;
    burrowId: string;
    /** The sign-in's own words for its secret (“Pairing code”), when it has them. */
    secretLabel: string | undefined;
  },
): Promise<{ made: Provisioned; merged: Record<string, string>; outcome: CheckOutcome }> {
  const { entry, baseUrl, fields } = input;
  const wayOut = wayOutOf(input.tokenMethod, input.secretLabel);
  const bound: ChallengeBinding = { entryId: entry.id, baseUrl, account: input.account };
  let made: Provisioned;
  try {
    made = await runProvisioner(services, provisioner, {
      entry,
      baseUrl,
      fields,
      account: input.account,
      password: input.password,
      code: input.code,
      challenge: openChallenge(services, bound, input.challenge),
      access: input.access,
      // A stable client id per burrow, for services that list their clients (CM-06).
      burrowId: input.burrowId,
    });
  } catch (err) {
    throw provisionRefusal(services, entry, err, bound, wayOut);
  }
  const merged = cleanFields({ ...fields, ...made.fields });
  let credential: CheckCredential;
  try {
    if (Object.keys(fieldsProblems(entry, 'token', merged)).length) throw new Error('fields');
    credential = tokenCheckCredential(entry, input.tokenMethod.auth, made.secret, merged);
  } catch {
    services.log.warn(
      { catalogId: entry.id, fields: Object.keys(made.fields) },
      'sign in once made a key that doesn’t fit',
    );
    throw connectionError(
      'check_failed',
      {},
      input.tokenMethod.storedOnly
        ? `Whombat made a key in ${entry.name} it can’t use.`
        : `Whombat made a key in ${entry.name} it can’t use. Make a token instead.`,
    );
  }
  const outcome = await runCatalogCheck(services, {
    entry,
    signIn: 'token',
    baseUrl,
    mcpUrl: input.mcpUrl,
    fields: merged,
    credential,
  });
  if (!outcome.ok) throw madeKeyRefusal(entry, outcome, wayOut);
  return { made, merged, outcome };
}

/**
 * `connections.create` with `signIn: 'password'` (sign in once, CS-01…CS-09): the entry's fields, room, address and
 * destination as for a token; the certificate first on https (CS-05: the password never reaches a server whose
 * certificate didn't verify or isn't the pinned one); the provisioner signs in and makes Whombat's key at the level
 * asked (45 s, `provision/run.ts`); the key is checked as the entry's token sign-in `tokenMethod` and stored as that
 * token (`signIn: 'token'`), with the provisioner's note as a warning line. The password goes to the provisioner only.
 */
export async function createPasswordConnection(
  services: Services,
  viewer: ConnectionViewer,
  body: z.output<typeof CreateConnectionBody>,
): Promise<{ row: CatalogConnectionRow; eventId: string | null }> {
  const entry = connectableEntry(body.catalogId);
  const method = entry.signIn.find((m) => m.kind === 'password');
  // An older app may still offer sign in once where the entry dropped it (Plex since 0.111, SG-04).
  if (method?.kind !== 'password')
    throw connectionError(
      'not_supported',
      { catalogId: entry.id },
      entry.signIn.some((m) => m.kind === 'token')
        ? `Whombat can’t sign in to ${entry.name} with a password. Make a token instead.`
        : undefined,
    );
  const tokenMethod = entry.signIn.filter((m) => m.kind === 'token')[method.tokenMethod];
  if (tokenMethod?.kind !== 'token') throw connectionError('not_supported', { catalogId: entry.id });
  const provisioner = provisionerFor(entry.id);
  if (!provisioner)
    throw connectionError(
      'not_supported',
      { catalogId: entry.id },
      `Whombat can’t sign in to ${entry.name} by itself yet. Make a token instead.`,
    );
  const login = body.login;
  if (!login)
    throw connectionFieldError(
      {
        ...(!method.account || method.account.fixed
          ? {}
          : { 'login.account': `${method.account.label} is needed.` }),
        'login.password': method.secret
          ? `Enter the ${method.secret.label.toLowerCase()}.`
          : 'Enter the password.',
      },
      'Enter the account and its password.',
    );
  const given = cleanFields(body.fields);
  requireFields(entry, 'password', given);
  await requireRoom(services.db, viewer.burrowId);
  const baseUrl = requireBaseUrl(entry, given);
  const mcpUrl = resolveMcpUrl(entry, given, 'token');
  await requireDestination(services, [baseUrl, mcpUrl]);
  const fields = await trustHomeCertificate(services, { entry, baseUrl, fields: given });
  const certificate = await certificateFirst(services, { entry, baseUrl, fields });
  if (certificate) requireCheckPassed(certificate);
  // No account (T3 Code's pairing code, t3code.md T3-02): the secret alone signs in.
  const account = method.account ? (method.account.fixed ?? login.account) : '';
  if (method.account && !account)
    throw connectionFieldError(
      { 'login.account': `${method.account.label} is needed.` },
      `${method.account.label} is needed.`,
    );
  const { made, merged, outcome } = await provisionAndCheck(services, provisioner, {
    entry,
    tokenMethod,
    baseUrl,
    mcpUrl,
    fields,
    account,
    password: login.password,
    code: login.code ?? null,
    challenge: login.challenge,
    access: body.access,
    burrowId: viewer.burrowId,
    secretLabel: method.secret?.label,
  });
  const chosen = chooseServiceFields(entry, 'token', merged, outcome);
  return saveNewConnection(services, viewer, {
    entry,
    signIn: 'token',
    labelGiven: body.label ?? null,
    fields: chosen,
    baseUrl: resolveBaseUrl(entry, chosen) ?? baseUrl,
    auth: tokenMethod.auth,
    secret: made.secret.trim(),
    tokens: sessionTokens(outcome),
    externalName: made.externalName?.trim().slice(0, 200) || externalNameFrom(outcome.json),
    access: body.access,
    checks: withProvisionNote(outcome.checks, made.note),
    fromCheck: outcome.fromCheck ?? {},
    expiresAt: made.expiresAt ?? null,
  });
}

/* An OAuth client's secret (CS-12) ------------------------------------------------------------------- */

/** The client secret of a form, or a field error. */
function requireClientSecret(secret: string | undefined): string {
  const value = secret?.trim() ?? '';
  if (!value) throw connectionFieldError({ secret: 'Paste the client secret.' }, 'Paste the client secret.');
  if (/[\r\n]/.test(value))
    throw connectionFieldError({ secret: 'Paste the secret on one line.' }, 'Paste the secret on one line.');
  return value;
}

/** The entry's check with a token the client secret was just exchanged for. */
async function clientCredentialsCheck(
  services: Services,
  input: { entry: CatalogEntry; baseUrl: string; fields: Record<string, string>; accessToken: string },
): Promise<CheckOutcome> {
  return runCatalogCheck(services, {
    entry: input.entry,
    signIn: 'client_credentials',
    baseUrl: input.baseUrl,
    mcpUrl: resolveMcpUrl(input.entry, input.fields, 'client_credentials'),
    fields: input.fields,
    credential: { headers: { Authorization: `Bearer ${input.accessToken}` }, query: {} },
  });
}

/**
 * `connections.create` with `signIn: 'client_credentials'` (Tailscale's OAuth client, CS-12): the secret is exchanged
 * at the method's token URL for the level's scopes, the entry's check runs with that token, and the connection keeps the
 * secret (sealed) and the token with its expiry (sealed in the access-token columns) until it is due again.
 */
export async function createClientCredentialsConnection(
  services: Services,
  viewer: ConnectionViewer,
  body: z.output<typeof CreateConnectionBody>,
): Promise<{ row: CatalogConnectionRow; eventId: string | null }> {
  const entry = connectableEntry(body.catalogId);
  const method = clientCredentialsMethod(entry);
  if (!method) throw connectionError('not_supported', { catalogId: entry.id });
  const secret = requireClientSecret(body.secret);
  const fields = cleanFields(body.fields);
  requireFields(entry, 'client_credentials', fields);
  await requireRoom(services.db, viewer.burrowId);
  const baseUrl = requireBaseUrl(entry, fields);
  const mcpUrl = resolveMcpUrl(entry, fields, 'client_credentials');
  await requireDestination(services, [baseUrl, mcpUrl, method.tokenUrl]);
  const token = await exchangeForConnect(services, entry, method, secret, body.access);
  const outcome = await clientCredentialsCheck(services, {
    entry,
    baseUrl,
    fields,
    accessToken: token.accessToken,
  });
  requireCheckPassed(outcome);
  const chosen = chooseServiceFields(entry, 'client_credentials', fields, outcome);
  return saveNewConnection(services, viewer, {
    entry,
    signIn: 'client_credentials',
    labelGiven: body.label ?? null,
    fields: chosen,
    baseUrl: resolveBaseUrl(entry, chosen) ?? baseUrl,
    auth: null,
    secret,
    tokens: {
      accessToken: token.accessToken,
      refreshToken: null,
      expiresAt: token.expiresAt,
      scopes: token.scopes,
    },
    externalName: externalNameFrom(outcome.json),
    access: body.access,
    checks: outcome.checks,
    fromCheck: outcome.fromCheck ?? {},
  });
}

/**
 * A client secret exchanged and checked on a connection that has one (Replace token, a new level): the columns to set.
 * Throws the form's `check_failed`.
 */
async function exchangedColumns(
  services: Services,
  row: CatalogConnectionRow,
  entry: CatalogEntry,
  method: ClientCredentialsMethod,
  secret: string,
  level: ConnectionAccessLevel,
): Promise<{ set: ConnectionChanges; checks: CatalogCheckResult[] }> {
  await requireDestination(services, [row.baseUrl, method.tokenUrl]);
  const token = await exchangeForConnect(services, entry, method, secret, level);
  const outcome = await clientCredentialsCheck(services, {
    entry,
    baseUrl: row.baseUrl,
    fields: row.fields,
    accessToken: token.accessToken,
  });
  requireCheckPassed(outcome);
  return {
    set: {
      accessTokenEnc: sealConnectionSecret(services.custody, row.id, 'access', token.accessToken),
      accessExpiresAt: token.expiresAt,
      scopes: token.scopes,
      credentialVersion: row.credentialVersion + 1,
      checks: outcome.checks,
      checkedAt: services.clock(),
      externalName: externalNameFrom(outcome.json) ?? row.externalName,
    },
    checks: outcome.checks,
  };
}

/**
 * `connections.update`: the label, the fields (a new address or field is checked again with the credential), the
 * level (CS-11: Whombat's own limit; an OAuth client is exchanged at the new level's scopes and checked first) or who
 * looks after a shared one (agent-responsibilities.md OW-09: the burrow's agent, or null for nobody).
 */
export async function updateConnection(
  services: Services,
  viewer: ConnectionViewer,
  id: string,
  body: z.output<typeof UpdateConnectionBody>,
): Promise<{ row: CatalogConnectionRow; eventId: string | null }> {
  const row = await visibleConnection(services.db, viewer, id);
  const entry = connectableEntry(row.catalogId);
  const kind = row.signIn as SignInKind;
  const set: ConnectionChanges = {};
  const what: string[] = [];
  if (body.label !== undefined && body.label !== row.label) {
    set.label = body.label;
    what.push('label');
  }
  let fieldsChanged = false;
  /** A session-signed connection's old session, signed out once the new address is saved (CM-11). */
  let replacedSession: CatalogConnectionRow | null = null;
  if (body.fields !== undefined) {
    const current = entryFields(row);
    const next = cleanFields({ ...current, ...body.fields });
    for (const [k, v] of Object.entries(body.fields)) if (v.trim() === '') delete next[k];
    // Whombat's client key lives in that Fusebox (ai-gateway.md AIG-02): another address is connected again.
    if (row.catalogId === 'fusebox' && next.url !== current.url)
      throw connectionError(
        'not_supported',
        { catalogId: entry.id },
        'Connect it again to use another address.',
      );
    if (!sameFields(next, current)) {
      // An MCP sign-in's tokens are for one server (its `resource`); an app's have no fields to change.
      if (kind === 'mcp_oauth' || kind === 'app_oauth')
        throw connectionError(
          'not_supported',
          { catalogId: entry.id },
          'Connect it again to use another address.',
        );
      requireFields(entry, kind, next);
      const baseUrl = requireBaseUrl(entry, next);
      const mcpUrl = resolveMcpUrl(entry, next, kind);
      await requireDestination(services, [baseUrl, mcpUrl]);
      let credential: CheckCredential;
      const session = sessionAuthOf(row.auth);
      try {
        // A session is the old address's: the stored password signs in at the new one (CM-11).
        credential =
          session && row.secretEnc
            ? {
                headers: {},
                query: {},
                secret: openConnectionSecret(services.custody, row.id, 'secret', row.secretEnc),
                // The device the service trusts stays trusted at its new address (SG-09).
                session: { auth: session, remembered: rememberedOf(services, row) },
              }
            : await credentialOf(services, { ...row, fields: next });
      } catch (err) {
        if (err instanceof ConnectionAuthError) throw connectionError('check_failed', {}, err.message);
        throw err;
      }
      const outcome = await runCatalogCheck(services, {
        entry,
        signIn: kind,
        baseUrl,
        mcpUrl,
        fields: next,
        credential,
      });
      // A new address can't take a code: the password is replaced with one (SG-09).
      if (session && outcome.twoStep)
        throw connectionError('check_failed', {}, sessionTwoStepAgainText(entry, session));
      requireCheckPassed(outcome);
      const chosen = { ...chooseServiceFields(entry, kind, next, outcome), ...(outcome.fromCheck ?? {}) };
      await requireFreeMac(services, viewer.burrowId, entry, chosen, row.id);
      Object.assign(set, {
        fields:
          row.fields.clientId && row.catalogId === 'fusebox'
            ? { ...chosen, clientId: row.fields.clientId }
            : chosen,
        baseUrl: resolveBaseUrl(entry, chosen) ?? baseUrl,
        credentialVersion: row.credentialVersion + 1,
        checks: outcome.checks,
        checkedAt: services.clock(),
        externalName: externalNameFrom(outcome.json) ?? row.externalName,
        ...(session ? sessionColumns(services, row.id, outcome) : {}),
      } satisfies ConnectionChanges);
      if (session) replacedSession = row;
      what.push('fields');
      fieldsChanged = true;
    }
  }
  if (body.access !== undefined && body.access !== row.access) {
    set.access = body.access;
    what.push('access');
    const method = kind === 'client_credentials' ? clientCredentialsMethod(entry) : null;
    if (method && row.secretEnc) {
      const secret = openConnectionSecret(services.custody, row.id, 'secret', row.secretEnc);
      const exchanged = await exchangedColumns(
        services,
        { ...row, ...(set.fields ? { fields: set.fields } : {}) },
        entry,
        method,
        secret,
        body.access,
      );
      Object.assign(set, exchanged.set);
      fieldsChanged = true;
    }
  }
  if (!what.length) return { row, eventId: null };
  const res = await applyChanges(services, viewer, row, set, what);
  if (!fieldsChanged) {
    if (set.access !== undefined)
      await emitConnectionLifecycle(services, { type: 'tiers', connectionId: row.id });
    return res;
  }
  await emitConnectionLifecycle(services, { type: 'credential', connectionId: row.id });
  endReplacedSession(services, replacedSession);
  return { row: await syncAndRecord(services, res.row, set.checks ?? []), eventId: res.eventId };
}

/**
 * The session columns of a check that signed in (CM-11), sealed for the connection, with a new trusted-device token the
 * service gave (SG-09). `newPassword`: the old token goes with the old password, whatever the service answered.
 */
function sessionColumns(
  services: Services,
  id: string,
  outcome: CheckOutcome,
  options: { newPassword?: boolean } = {},
): ConnectionChanges {
  const remembered = outcome.session?.remembered;
  return {
    ...(outcome.session
      ? {
          accessTokenEnc: sealConnectionSecret(services.custody, id, 'access', outcome.session.token),
          accessExpiresAt: outcome.session.expiresAt,
        }
      : { accessTokenEnc: null, accessExpiresAt: null }),
    ...(remembered
      ? { rememberedEnc: sealConnectionSecret(services.custody, id, 'remembered', remembered) }
      : options.newPassword
        ? { rememberedEnc: null }
        : {}),
  };
}

/** Signs out the session a connection had before its password or address changed (best effort, CM-11). */
function endReplacedSession(services: Services, before: CatalogConnectionRow | null): void {
  if (!before?.accessTokenEnc || !sessionAuthOf(before.auth)) return;
  services.guides.track('connection session', () => endConnectionSession(services, before));
}

/**
 * How a connection kept as a token signs in again when that token was only ever a sign-in's result (T3 Code's pairing
 * code, docs/decisions/t3code.md T3-05): the entry's sign in once without an account, whose token sign-in is kept only
 * (`storedOnly`), and its provisioner. Null for every other entry: its token is replaced as pasted.
 */
function signInAgainOf(
  entry: CatalogEntry,
): { secretLabel: string | undefined; tokenMethod: TokenSignIn; provisioner: Provisioner } | null {
  const method = entry.signIn.find((m) => m.kind === 'password');
  if (method?.kind !== 'password' || method.account !== null) return null;
  const tokenMethod = entry.signIn.filter((m) => m.kind === 'token')[method.tokenMethod];
  if (tokenMethod?.kind !== 'token' || !tokenMethod.storedOnly) return null;
  const provisioner = provisionerFor(entry.id);
  if (!provisioner) return null;
  return { secretLabel: method.secret?.label, tokenMethod, provisioner };
}

/**
 * Sign in again with a new secret for the sign-in that made the connection (T3 Code's new pairing code, T3-05): the
 * provisioner runs at the connection's own level, address and fields, the new token is checked, then it replaces the
 * old one with its end and the name the service gave; the connection, its tools' tiers and its page stay. The old
 * sign-in isn't ended in the service: T3 Code ends an outside agent's sign-in only for a sign-in that may manage access,
 * which an outside agent never gets, so it runs out by itself (30 days) or the person removes it in T3 Code.
 */
async function signInAgain(
  services: Services,
  viewer: ConnectionViewer,
  row: CatalogConnectionRow,
  entry: CatalogEntry,
  how: NonNullable<ReturnType<typeof signInAgainOf>>,
  secret: string,
): Promise<{ row: CatalogConnectionRow; eventId: string | null }> {
  if (!secret.trim()) {
    const problem = `Enter the ${(how.secretLabel ?? 'password').toLowerCase()}.`;
    throw connectionFieldError({ secret: problem }, problem);
  }
  const fields = entryFields(row);
  const mcpUrl = resolveMcpUrl(entry, fields, 'token');
  await requireDestination(services, [row.baseUrl, mcpUrl]);
  const certificate = await certificateFirst(services, { entry, baseUrl: row.baseUrl, fields });
  if (certificate) requireCheckPassed(certificate);
  const { made, merged, outcome } = await provisionAndCheck(services, how.provisioner, {
    entry,
    tokenMethod: how.tokenMethod,
    baseUrl: row.baseUrl,
    mcpUrl,
    fields,
    account: '',
    password: secret,
    code: null,
    challenge: null,
    access: row.access,
    burrowId: row.burrowId,
    secretLabel: how.secretLabel,
  });
  const filled = { ...(outcome.fromCheck ?? {}) };
  const checks = withProvisionNote(outcome.checks, made.note);
  const res = await applyChanges(
    services,
    viewer,
    row,
    {
      ...(Object.keys(made.fields).length || Object.keys(filled).length
        ? { fields: { ...row.fields, ...merged, ...filled } }
        : {}),
      secretEnc: sealConnectionSecret(services.custody, row.id, 'secret', made.secret.trim()),
      accessExpiresAt: made.expiresAt ?? null,
      credentialVersion: row.credentialVersion + 1,
      status: 'active',
      reauthReason: null,
      repairNotifiedAt: null,
      checks,
      checkedAt: services.clock(),
      externalName:
        made.externalName?.trim().slice(0, 200) || externalNameFrom(outcome.json) || row.externalName,
    },
    ['secret'],
  );
  await emitConnectionLifecycle(services, { type: 'credential', connectionId: row.id });
  return { row: await syncAndRecord(services, res.row, checks), eventId: res.eventId };
}

/**
 * `connections.setSecret` (“Replace token”): checked first, then sealed; a connection that needed it is active again. A
 * session's new password may come with a two-step code (`code`, SG-09): its old trusted-device token isn't sent and goes.
 */
export async function replaceConnectionSecret(
  services: Services,
  viewer: ConnectionViewer,
  id: string,
  secret: string,
  code?: string,
): Promise<{ row: CatalogConnectionRow; eventId: string | null }> {
  const row = await visibleConnection(services.db, viewer, id);
  const entry = connectableEntry(row.catalogId);
  const clientMethod = row.signIn === 'client_credentials' ? clientCredentialsMethod(entry) : null;
  if (clientMethod) {
    // An OAuth client's new secret (CS-12): exchanged and checked first, then sealed with its token.
    const value = requireClientSecret(secret);
    const exchanged = await exchangedColumns(services, row, entry, clientMethod, value, row.access);
    const res = await applyChanges(
      services,
      viewer,
      row,
      {
        ...exchanged.set,
        secretEnc: sealConnectionSecret(services.custody, row.id, 'secret', value),
        status: 'active',
        reauthReason: null,
        repairNotifiedAt: null,
      },
      ['secret'],
    );
    await emitConnectionLifecycle(services, { type: 'credential', connectionId: row.id });
    return { row: await syncAndRecord(services, res.row, exchanged.checks), eventId: res.eventId };
  }
  // A new pairing code for T3 Code: the sign-in runs again (T3-05).
  const again = row.signIn === 'token' ? signInAgainOf(entry) : null;
  if (again) return signInAgain(services, viewer, row, entry, again, secret);
  if ((row.signIn !== 'token' && row.signIn !== 'nextcloud_login') || !row.auth)
    throw connectionError(
      'not_supported',
      { catalogId: entry.id },
      'This connection signs in another way: connect it again.',
    );
  const kind = row.signIn as SignInKind;
  const fields = entryFields(row);
  await requireDestination(services, [row.baseUrl, resolveMcpUrl(entry, fields, kind)]);
  const credential = tokenCheckCredential(entry, row.auth, secret, fields, { code });
  const outcome = await runCatalogCheck(services, {
    entry,
    signIn: kind,
    baseUrl: row.baseUrl,
    mcpUrl: resolveMcpUrl(entry, fields, kind),
    fields,
    credential,
  });
  requireCheckPassed(outcome);
  // A Fusebox's new management key makes Whombat's client key again, in place of the old one (ai-gateway.md AIG-03).
  const made = await provisionGatewayKey(services, viewer, entry, {
    baseUrl: row.baseUrl,
    fields,
    credential,
  });
  const filled = outcome.fromCheck ?? {};
  const res = await applyChanges(
    services,
    viewer,
    row,
    {
      ...(made
        ? {
            fields: { ...(made.clientId ? { ...fields, clientId: made.clientId } : fields), ...filled },
            clientSecretEnc: made.clientKey
              ? sealConnectionSecret(services.custody, row.id, 'client', made.clientKey)
              : null,
          }
        : Object.keys(filled).length
          ? { fields: { ...row.fields, ...filled } }
          : {}),
      secretEnc: sealConnectionSecret(services.custody, row.id, 'secret', secret.trim()),
      ...(sessionAuthOf(row.auth) ? sessionColumns(services, row.id, outcome, { newPassword: true }) : {}),
      credentialVersion: row.credentialVersion + 1,
      status: 'active',
      reauthReason: null,
      repairNotifiedAt: null,
      checks: outcome.checks,
      checkedAt: services.clock(),
      externalName: externalNameFrom(outcome.json) ?? row.externalName,
    },
    ['secret'],
  );
  await emitConnectionLifecycle(services, { type: 'credential', connectionId: row.id });
  endReplacedSession(services, row);
  return { row: await syncAndRecord(services, res.row, outcome.checks), eventId: res.eventId };
}

/**
 * `connections.recheck` (“Check again”): the entry's check with the stored credential, the tools read again, the result
 * recorded. A refused token marks it `needs_reauth`; a failure that isn't the token's makes it `error`; a pass makes a
 * token connection active again. Only a change of state is signed.
 */
export async function recheckConnection(
  services: Services,
  viewer: ConnectionViewer,
  id: string,
): Promise<{ row: CatalogConnectionRow; checks: CatalogCheckResult[] }> {
  const row = await visibleConnection(services.db, viewer, id);
  const entry = connectableEntry(row.catalogId);
  const kind = row.signIn as SignInKind;
  const oauth = kind === 'ha_oauth' || kind === 'mcp_oauth' || kind === 'app_oauth';
  if (row.status === 'needs_reauth' && oauth) {
    const fresh = (await connectionRow(services.db, row.id)) ?? row;
    return { row: fresh, checks: fresh.checks };
  }
  let outcome: CheckOutcome;
  try {
    const credential = await credentialOf(services, row);
    outcome = await runCatalogCheck(services, {
      entry,
      signIn: kind,
      baseUrl: row.baseUrl,
      mcpUrl: resolveMcpUrl(entry, row.fields, kind),
      fields: row.fields,
      credential,
    });
  } catch (err) {
    if (!(err instanceof ConnectionAuthError)) throw err;
    const fresh = (await connectionRow(services.db, row.id)) ?? row;
    return { row: fresh, checks: fresh.checks };
  }
  if (outcome.refused) {
    await markNeedsReauth(services, row, oauth ? 'revoked' : 'token_invalid', {
      message: outcome.message,
      ...(oauth ? { refreshTokenEnc: row.refreshTokenEnc } : {}),
    });
    const fresh = (await connectionRow(services.db, row.id)) ?? row;
    return { row: fresh, checks: fresh.checks };
  }
  const nextStatus = outcome.ok ? 'active' : 'error';
  let current = await recordFromCheck(services, row, outcome);
  if (nextStatus !== row.status && row.status !== 'needs_reauth') {
    current = (await applyChanges(services, viewer, current, { status: nextStatus }, ['status'])).row;
  } else if (row.status === 'needs_reauth' && outcome.ok) {
    current = (
      await applyChanges(
        services,
        viewer,
        current,
        { status: 'active', reauthReason: null, repairNotifiedAt: null },
        ['status'],
      )
    ).row;
  }
  const recorded = outcome.ok
    ? await syncAndRecord(services, current, outcome.checks)
    : await recordChecks(services, current, outcome.checks);
  return { row: recorded, checks: recorded.checks };
}

async function recordChecks(
  services: Services,
  row: CatalogConnectionRow,
  checks: CatalogCheckResult[],
): Promise<CatalogConnectionRow> {
  const now = services.clock();
  const [updated] = await services.pipeline.transactAccount((tx) =>
    tx
      .update(catalogConnections)
      .set({ checks, checkedAt: now })
      .where(eq(catalogConnections.id, row.id))
      .returning(),
  );
  return updated ?? row;
}

/**
 * `connections.disconnect` (CX-24): its tools, pending asks, pending sign-ins and secret go with the row; OAuth tokens
 * are revoked best effort afterwards; pooled clients are dropped. A Fusebox's client key is taken out of it (AIG-03).
 */
export async function disconnectConnection(
  services: Services,
  viewer: ConnectionViewer,
  id: string,
  /** A 1Password connection's entries: kept in the Vault (absent, `keep`) or removed with it (OPW-50). */
  vaultEntries?: OnePasswordDisconnectChoice,
): Promise<{ eventId: string | null; notice: string | null }> {
  const row = await visibleConnection(services.db, viewer, id);
  const { eventId } = ok(
    await services.pipeline.commit(
      removeConnection,
      { connectionId: row.id, ...(vaultEntries ? { vaultEntries } : {}) },
      { burrowId: viewer.burrowId, actorId: viewer.principal.id },
    ),
  );
  await emitConnectionLifecycle(services, { type: 'removed', connectionId: row.id });
  services.guides.track('connection revoke', () => revokeConnectionTokens(services, row));
  // A Fusebox loses Whombat's client key (AIG-03); when it doesn't answer, the page says to remove it there by hand.
  const notice = await removeGatewayKey(services, row);
  return { eventId, notice };
}

/** Revokes a removed connection's OAuth tokens where the service has a way to (best effort, never throws). */
export async function revokeConnectionTokens(services: Services, row: CatalogConnectionRow): Promise<void> {
  if (!row.refreshTokenEnc && !row.accessTokenEnc) return;
  // A session is signed out (CM-11): Pi-hole keeps a few seats.
  if (sessionAuthOf(row.auth)) return endConnectionSession(services, row);
  try {
    const [client, endpoints] = await Promise.all([
      clientForRow(services, row),
      endpointsForRow(services, row),
    ]);
    if (!endpoints?.revoke) return;
    if (row.signIn === 'app_oauth' && row.accessTokenEnc) {
      // Dropbox: `POST /2/auth/token/revoke` with the access token as bearer (revokes the whole grant).
      const access = openConnectionSecret(services.custody, row.id, 'access', row.accessTokenEnc);
      await connectionFetch(
        services,
        endpoints.revoke,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${access}` },
        },
        { effect: 'connections.revoke' },
      );
      return;
    }
    const token = row.refreshTokenEnc
      ? openConnectionSecret(services.custody, row.id, 'refresh', row.refreshTokenEnc)
      : openConnectionSecret(services.custody, row.id, 'access', row.accessTokenEnc as string);
    await revokeToken(
      services,
      endpoints.revoke,
      client,
      token,
      row.refreshTokenEnc ? 'refresh_token' : 'access_token',
    );
  } catch (err) {
    services.log.warn({ connectionId: row.id, err: String(err) }, 'connection revoke failed');
  }
}

/** `connections.setTool`: one tool's tier (clears its New mark). */
export async function setConnectionTool(
  services: Services,
  viewer: ConnectionViewer,
  id: string,
  tool: string,
  tier: ConnectionToolTier,
): Promise<CatalogConnectionRow> {
  const row = await visibleConnection(services.db, viewer, id);
  ok(
    await services.pipeline.commit(
      setToolTier,
      { connectionId: row.id, tool, tier },
      { burrowId: viewer.burrowId, actorId: viewer.principal.id },
    ),
  );
  await emitConnectionLifecycle(services, { type: 'tiers', connectionId: row.id });
  return row;
}
