/**
 * Sign in on the service's own page, Whombat waits (docs/decisions/connection-signin.md SG-01…SG-05, contracts CT-730,
 * CT-738): `connections.startServiceLogin` and `connections.pollServiceLogin`, generic over one adapter per catalog id
 * (`ADAPTERS`: Plex). Nextcloud's Login Flow v2 has the same shape and keeps its own endpoints (`nextcloud.ts`).
 *
 * - Start: the entry's `service_login` sign-in, the token sign-in it is stored as (`tokenMethod`) and an adapter; whose
 *   it is (a reconnect keeps the connection's label and fields), the fields, the room, the address and the
 *   adapter's own sign-in origins checked first (`destination_refused`); then the adapter starts and the flow is a
 *   `connection_pending` row bound to the account (single use, the service's lifetime, at most 10 minutes) with its
 *   state sealed.
 * - Poll: the account's own live flow; the adapter asks the service. A token is taken once (single use), checked as the
 *   entry's token sign-in against the connection's address (a refusal in the adapter's words), and saved as that token
 *   (`signIn: 'token'`, CT-730), at the level asked for a new connection, so checks, tools and Replace token work as for
 *   a pasted one.
 */
import {
  catalogSignIn,
  type PollServiceLoginResponse,
  resolveMcpUrl,
  SERVICE_LOGIN_MAX_MS,
  type StartServiceLoginBody,
  type StartServiceLoginResponse,
  storedTokenSignIn,
} from '@whombat/core';
import type { z } from 'zod';
import { ApiError } from '../../lib/errors';
import { iso } from '../../lib/time';
import type { Services } from '../../services';
import { externalNameFrom, runCatalogCheck, trustHomeCertificate } from '../checks';
import {
  chooseServiceFields,
  cleanFields,
  connectableEntry,
  requireBaseUrl,
  requireDestination,
  requireFields,
  saveNewConnection,
  saveReconnect,
  tokenCheckCredential,
  viewerFor,
} from '../connect';
import { connectionError } from '../errors';
import { connectionFetch, outboundText } from '../http';
import { createPending, livePending, pendingState, takePending } from '../pending';
import { PROVISIONED_NAME, provisionClientId } from '../provision/run';
import { type ConnectionViewer, connectionRow, isVisibleTo, requireRoom, visibleConnection } from '../store';
import { connectionView } from '../views';
import { plexServiceLogin } from './plex';
import { type ServiceLoginAdapter, type ServiceLoginContext, ServiceLoginError } from './types';

/** The adapters by catalog id (SG-01). */
export const ADAPTERS: Readonly<Record<string, ServiceLoginAdapter>> = {
  plex: plexServiceLogin(),
};

/** Tests' stand-ins, by catalog id (`useServiceLoginForTests`). */
const testAdapters = new Map<string, ServiceLoginAdapter>();

/** Tests only: a stand-in adapter for an entry (null removes it). Refused outside `NODE_ENV=test`. */
export function useServiceLoginForTests(catalogId: string, adapter: ServiceLoginAdapter | null): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('The service-login seam is for tests only.');
  if (adapter) testAdapters.set(catalogId, adapter);
  else testAdapters.delete(catalogId);
}

export function serviceLoginAdapterFor(catalogId: string): ServiceLoginAdapter | null {
  return testAdapters.get(catalogId) ?? ADAPTERS[catalogId] ?? null;
}

/** The flow's sealed state (`connection_pending:<id>`). */
interface ServiceLoginState {
  labelGiven: string | null;
  fields: Record<string, string>;
  baseUrl: string;
  access: 'read' | 'manage';
  adapter: Record<string, unknown>;
}

/** What `connection_pending.sign_in` holds for these flows. */
const SIGN_IN = 'service_login';

/** The adapter's world: the connection's entry and address, Whombat's name and client id, the policed fetch. */
function contextFor(
  services: Services,
  burrowId: string | null,
  entry: ServiceLoginContext['entry'],
  baseUrl: string,
  fields: Readonly<Record<string, string>>,
): ServiceLoginContext {
  return {
    entry,
    baseUrl,
    fields,
    name: PROVISIONED_NAME,
    clientId: provisionClientId(services, burrowId ?? undefined),
    fetch: (url, init) =>
      connectionFetch(services, url, init, {
        effect: 'connections.service_login',
        // Making a PIN changes nothing anyone decided; a poll reads.
        idempotent: true,
      }),
  };
}

/** The entry's `service_login` sign-in with the token sign-in it is stored as and its adapter, or `not_supported`. */
function serviceLoginOf(entryId: string) {
  const entry = connectableEntry(entryId);
  const method = catalogSignIn(entry, 'service_login');
  const tokenMethod = method?.kind === 'service_login' ? storedTokenSignIn(entry, method) : null;
  const adapter = serviceLoginAdapterFor(entry.id);
  if (method?.kind !== 'service_login' || !tokenMethod || !adapter)
    throw connectionError('not_supported', { catalogId: entry.id });
  return { entry, tokenMethod, adapter };
}

/** `connections.startServiceLogin`: the page to open, the flow to poll. */
export async function startServiceLogin(
  services: Services,
  viewer: ConnectionViewer,
  body: z.output<typeof StartServiceLoginBody>,
): Promise<StartServiceLoginResponse> {
  const { entry, adapter } = serviceLoginOf(body.catalogId);
  let labelGiven = body.label ?? null;
  let connectionId: string | null = null;
  let fields = cleanFields(body.fields);
  if (body.connectionId) {
    // Signing in again keeps the connection's label and fields; a field given replaces its own.
    const row = await visibleConnection(services.db, viewer, body.connectionId);
    if (row.catalogId !== entry.id) throw connectionError('not_supported', { catalogId: entry.id });
    labelGiven = row.label;
    connectionId = row.id;
    const own = new Set(entry.fields.map((f) => f.id));
    fields = cleanFields({
      ...Object.fromEntries(Object.entries(row.fields).filter(([k]) => own.has(k))),
      ...fields,
    });
  } else {
    await requireRoom(services.db, viewer.burrowId);
  }
  requireFields(entry, SIGN_IN, fields);
  const baseUrl = requireBaseUrl(entry, fields);
  await requireDestination(services, [baseUrl, ...adapter.origins]);
  fields = await trustHomeCertificate(services, { entry, baseUrl, fields });
  let started: Awaited<ReturnType<ServiceLoginAdapter['start']>>;
  try {
    started = await adapter.start(contextFor(services, viewer.burrowId, entry, baseUrl, fields));
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw connectionError(
      'check_failed',
      {},
      err instanceof ServiceLoginError ? err.message.slice(0, 500) : outboundText(err),
    );
  }
  const { id, expiresAt } = await createPending<ServiceLoginState>(services, {
    accountId: viewer.accountId,
    burrowId: viewer.burrowId,
    catalogId: entry.id,
    connectionId,
    signIn: SIGN_IN,
    returnPath: '/',
    state: { labelGiven, fields, baseUrl, access: body.access, adapter: started.state },
    ttlMs: Math.max(1000, Math.min(started.ttlMs, SERVICE_LOGIN_MAX_MS)),
  });
  return {
    loginUrl: started.loginUrl,
    flowId: id,
    pollEveryMs: started.pollEveryMs,
    expiresAt: iso(expiresAt),
    userCode: started.userCode,
  };
}

/** `connections.pollServiceLogin`: pending, connected (the connection made and checked), expired or failed. */
export async function pollServiceLogin(
  services: Services,
  accountId: string,
  flowId: string,
): Promise<PollServiceLoginResponse> {
  const live = await livePending(services, flowId, accountId, [SIGN_IN]);
  if (!live) throw connectionError('login_expired');
  if (live.kind !== 'live') {
    if (live.kind === 'expired') await takePending(services, flowId, accountId, [SIGN_IN]);
    return { state: 'expired' };
  }
  const st = pendingState<ServiceLoginState>(services, live.row);
  let login: ReturnType<typeof serviceLoginOf>;
  try {
    login = serviceLoginOf(live.row.catalogId);
  } catch {
    await takePending(services, flowId, accountId, [SIGN_IN]);
    return { state: 'failed', message: 'Whombat can’t sign in to that this way any more.' };
  }
  const { entry, tokenMethod, adapter } = login;
  let polled: Awaited<ReturnType<ServiceLoginAdapter['poll']>>;
  try {
    polled = await adapter.poll(
      contextFor(services, live.row.burrowId, entry, st.baseUrl, st.fields),
      st.adapter,
    );
  } catch (err) {
    return { state: 'failed', message: outboundText(err) };
  }
  if (polled.state === 'pending') return { state: 'pending' };
  // Whatever the service answered now ends the flow (its token is answered once).
  const taken = await takePending(services, flowId, accountId, [SIGN_IN]);
  if (polled.state === 'expired' || taken.kind !== 'taken') return { state: 'expired' };
  if (polled.state === 'failed') return { state: 'failed', message: polled.message.slice(0, 500) };
  const pending = taken.row;
  const viewer = pending.burrowId ? await viewerFor(services, accountId, pending.burrowId) : null;
  if (!viewer) return { state: 'failed', message: 'You’re no longer on that Whombat.' };
  const fields = cleanFields({ ...st.fields, ...(polled.fields ?? {}) });
  try {
    const credential = tokenCheckCredential(entry, tokenMethod.auth, polled.secret, fields);
    const outcome = await runCatalogCheck(services, {
      entry,
      signIn: 'token',
      baseUrl: st.baseUrl,
      mcpUrl: resolveMcpUrl(entry, fields, 'token'),
      fields,
      credential,
    });
    if (!outcome.ok)
      return {
        state: 'failed',
        message: (
          adapter.checkFailedText?.(entry, outcome) ??
          outcome.message ??
          `${entry.name} let Whombat in, but checking it failed.`
        ).slice(0, 500),
      };
    const chosen = chooseServiceFields(entry, 'token', fields, outcome);
    const input = {
      signIn: 'token' as const,
      fields: chosen,
      auth: tokenMethod.auth,
      secret: polled.secret,
      externalName: polled.externalName?.trim().slice(0, 200) || externalNameFrom(outcome.json),
      checks: outcome.checks,
      fromCheck: outcome.fromCheck ?? {},
    };
    const existing = pending.connectionId ? await connectionRow(services.db, pending.connectionId) : null;
    const saved =
      existing && isVisibleTo(existing, viewer)
        ? await saveReconnect(services, viewer, existing, { ...input, baseUrl: st.baseUrl })
        : await saveNewConnection(services, viewer, {
            ...input,
            entry,
            labelGiven: st.labelGiven,
            baseUrl: st.baseUrl,
            access: st.access,
          });
    return {
      state: 'connected',
      connection: await connectionView(services.db, saved.row),
      eventId: saved.eventId,
    };
  } catch (err) {
    if (err instanceof ApiError) return { state: 'failed', message: err.message.slice(0, 500) };
    throw err;
  }
}
