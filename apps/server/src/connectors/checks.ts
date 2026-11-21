/**
 * Service checks (docs/decisions/connectors.md CN-06): after connecting, and on “Check again”, each ticked
 * service makes one cheap call with the connection's access token:
 * - Gmail `users.getProfile`, Calendar `calendarList.list?maxResults=1`, Drive `about.get?fields=user`,
 *   People `people.connections.list?pageSize=1`;
 * - Docs and Sheets are covered by the Drive check plus their scopes.
 *
 * Google's 403 `SERVICE_DISABLED` / `accessNotConfigured` carries an activation link; the check keeps it so
 * the row can say “API turned off in your Google project · Turn it on”. The fake Google only checks scopes.
 *
 * `checkGoogleServices` is the real implementation; `GoogleWorkspace.checkService` can delegate to
 * `checkGoogleService` for one service.
 */
import {
  CONNECTOR_SERVICES,
  type ConnectionCheck,
  type ConnectorService,
  GOOGLE_SCOPES,
  type GoogleMode,
} from '@whombat/core';
import { type FetchLike, googleApiError, googleFetch, readJson } from './google-http';
import { GoogleApiError } from './types';

/** The one cheap call per service (Docs and Sheets use Drive's). */
export const GOOGLE_CHECK_URLS = {
  mail: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
  calendar: 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1',
  files: 'https://www.googleapis.com/drive/v3/about?fields=user',
  contacts: 'https://people.googleapis.com/v1/people/me/connections?pageSize=1&personFields=names',
} as const satisfies Partial<Record<ConnectorService, string>>;

const CALL_OF: Record<ConnectorService, keyof typeof GOOGLE_CHECK_URLS> = {
  mail: 'mail',
  calendar: 'calendar',
  files: 'files',
  docs: 'files',
  sheets: 'files',
  contacts: 'contacts',
};

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

type CallResult = { ok: true } | { ok: false; error: GoogleApiError };

async function call(fetchImpl: FetchLike, accessToken: string, url: string): Promise<CallResult> {
  try {
    const res = await googleFetch(fetchImpl, url, { headers: { authorization: `Bearer ${accessToken}` } });
    if (res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: true };
    }
    return { ok: false, error: googleApiError(res.status, await readJson(res)) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new GoogleApiError(0, `Couldn’t reach Google: ${message}`.slice(0, 500), 'other'),
    };
  }
}

function fromResult(service: ConnectorService, result: CallResult): ConnectionCheck {
  if (result.ok) return { service, state: 'ok' };
  const { error } = result;
  if (error.reason === 'api_disabled')
    return error.enableUrl
      ? { service, state: 'api_disabled', enableUrl: error.enableUrl }
      : { service, state: 'api_disabled' };
  if (error.reason === 'no_scope') return { service, state: 'no_scope' };
  return { service, state: 'error', message: error.message.slice(0, 500) };
}

/**
 * Checks each service (in service order). A service whose scope was not granted is `no_scope` without a
 * call; Docs and Sheets reuse Drive's call, and are fine on their scope alone when Drive was not granted.
 */
export async function checkGoogleServices(
  accessToken: string,
  services: readonly ConnectorService[],
  grantedScopes: readonly string[],
  fetchImpl: FetchLike = defaultFetch,
): Promise<ConnectionCheck[]> {
  const calls = new Map<string, Promise<CallResult>>();
  const once = (key: keyof typeof GOOGLE_CHECK_URLS) => {
    let pending = calls.get(key);
    if (!pending) {
      pending = call(fetchImpl, accessToken, GOOGLE_CHECK_URLS[key]);
      calls.set(key, pending);
    }
    return pending;
  };
  const picked = CONNECTOR_SERVICES.filter((s) => services.includes(s));
  return Promise.all(
    picked.map(async (service): Promise<ConnectionCheck> => {
      if (!grantedScopes.includes(GOOGLE_SCOPES[service])) return { service, state: 'no_scope' };
      if ((service === 'docs' || service === 'sheets') && !grantedScopes.includes(GOOGLE_SCOPES.files))
        return { service, state: 'ok' };
      return fromResult(service, await once(CALL_OF[service]));
    }),
  );
}

/** One service's check (`GoogleWorkspace.checkService`). Never throws. */
export async function checkGoogleService(
  accessToken: string,
  service: ConnectorService,
  grantedScopes: readonly string[],
  fetchImpl: FetchLike = defaultFetch,
): Promise<ConnectionCheck> {
  const [check] = await checkGoogleServices(accessToken, [service], grantedScopes, fetchImpl);
  return check ?? { service, state: 'error', message: 'Not checked.' };
}

/** The fake Google: every granted service works. */
export function fakeGoogleChecks(
  services: readonly ConnectorService[],
  grantedScopes: readonly string[],
): ConnectionCheck[] {
  return CONNECTOR_SERVICES.filter((s) => services.includes(s)).map((service) =>
    grantedScopes.includes(GOOGLE_SCOPES[service])
      ? { service, state: 'ok' }
      : { service, state: 'no_scope' },
  );
}

/** The checks for a mode (`off` checks nothing). */
export async function runGoogleChecks(
  mode: GoogleMode,
  accessToken: string,
  services: readonly ConnectorService[],
  grantedScopes: readonly string[],
): Promise<ConnectionCheck[]> {
  if (mode === 'fake') return fakeGoogleChecks(services, grantedScopes);
  if (mode === 'off') return [];
  return checkGoogleServices(accessToken, services, grantedScopes);
}
