/**
 * Nextcloud's Login Flow v2 (CX-11): Whombat `POST`s `<url>/index.php/login/v2`, the person opens the returned login
 * link (Nextcloud's own “Grant access” page) and the app polls; when Nextcloud answers `server`, `loginName` and
 * `appPassword`, the app password becomes the connection's secret (basic auth with the login name). A flow lives at most
 * 10 minutes here (Nextcloud's own token lives 20, CT-268); the poll token is kept sealed.
 */
import {
  catalogEntry,
  catalogSignIn,
  fieldsFromCheck,
  NEXTCLOUD_LOGIN_MAX_MS,
  NEXTCLOUD_POLL_MS,
  type PollNextcloudLoginResponse,
  type StartNextcloudLoginBody,
  type TokenAuth,
} from '@whombat/core';
import type { z } from 'zod';
import { ApiError } from '../lib/errors';
import { iso } from '../lib/time';
import type { Services } from '../services';
import { externalNameFrom, runCatalogCheck, trustHomeCertificate } from './checks';
import {
  cleanFields,
  connectableEntry,
  requireBaseUrl,
  requireDestination,
  requireFields,
  saveNewConnection,
  saveReconnect,
  tokenCheckCredential,
  viewerFor,
} from './connect';
import { connectionError } from './errors';
import { connectionFetch, formBody, jsonOf, outboundText, pinOf } from './http';
import { createPending, livePending, pendingState, takePending } from './pending';
import { type ConnectionViewer, connectionRow, isVisibleTo, requireRoom, visibleConnection } from './store';
import { connectionView } from './views';

interface NextcloudPendingState {
  labelGiven: string | null;
  fields: Record<string, string>;
  baseUrl: string;
  pollEndpoint: string;
  pollToken: string;
}

const AUTH: TokenAuth = { type: 'basic', usernameField: 'username' };

/** `connections.startNextcloud`: the login link to open and the flow to poll. */
export async function startNextcloudLogin(
  services: Services,
  viewer: ConnectionViewer,
  body: z.output<typeof StartNextcloudLoginBody>,
) {
  const entry = connectableEntry('nextcloud');
  const method = catalogSignIn(entry, 'nextcloud_login');
  if (method?.kind !== 'nextcloud_login') throw connectionError('not_supported', { catalogId: entry.id });
  let labelGiven = body.label ?? null;
  let connectionId: string | null = null;
  let fields = cleanFields(body.fields);
  if (body.connectionId) {
    const row = await visibleConnection(services.db, viewer, body.connectionId);
    if (row.catalogId !== entry.id) throw connectionError('not_supported', { catalogId: entry.id });
    labelGiven = row.label;
    connectionId = row.id;
    const pin = fields.fingerprint ?? row.fields.fingerprint;
    fields = { url: fields.url ?? row.fields.url ?? '', ...(pin ? { fingerprint: pin } : {}) };
  } else {
    await requireRoom(services.db, viewer.burrowId);
  }
  fields = { url: fields.url ?? '', ...(fields.fingerprint ? { fingerprint: fields.fingerprint } : {}) };
  requireFields(entry, 'nextcloud_login', fields);
  const baseUrl = requireBaseUrl(entry, fields);
  await requireDestination(services, [baseUrl]);
  fields = await trustHomeCertificate(services, { entry, baseUrl, fields });
  let doc: Record<string, unknown> | null;
  try {
    const res = await connectionFetch(
      services,
      `${baseUrl}${method.startPath}`,
      { method: 'POST', headers: { accept: 'application/json' } },
      { effect: 'connections.nextcloud_start', idempotent: true, ...pinOf({ fields }) },
    );
    if (res.status !== 200)
      throw connectionError(
        'check_failed',
        { status: res.status },
        `That address answered ${res.status}: is it your Nextcloud?`,
      );
    doc = jsonOf(res) as Record<string, unknown> | null;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw connectionError('check_failed', {}, outboundText(err));
  }
  const poll = doc?.poll as { token?: unknown; endpoint?: unknown } | undefined;
  const login = typeof doc?.login === 'string' ? doc.login : null;
  const token = typeof poll?.token === 'string' ? poll.token : null;
  const endpoint = typeof poll?.endpoint === 'string' ? poll.endpoint : null;
  // Nextcloud names its own address in the answer, which behind a proxy may be another scheme or host: the poll goes to
  // its path on the address Whombat uses, never elsewhere (connection-signin.md SG-15d). The login link is the
  // person's browser's.
  const pollEndpoint = endpoint ? nextcloudPollUrl(baseUrl, endpoint) : null;
  if (!login || !token || !pollEndpoint || !/^https?:\/\//.test(login))
    throw connectionError('check_failed', {}, 'That address didn’t answer like a Nextcloud.');
  await requireDestination(services, [pollEndpoint]);
  const { id, expiresAt } = await createPending<NextcloudPendingState>(services, {
    accountId: viewer.accountId,
    burrowId: viewer.burrowId,
    catalogId: entry.id,
    connectionId,
    signIn: 'nextcloud_login',
    returnPath: '/',
    state: { labelGiven, fields, baseUrl, pollEndpoint, pollToken: token },
    ttlMs: NEXTCLOUD_LOGIN_MAX_MS,
  });
  return { loginUrl: login, flowId: id, pollEveryMs: NEXTCLOUD_POLL_MS, expiresAt: iso(expiresAt) };
}

/**
 * Where to poll (SG-15d): the poll path Nextcloud named (only one ending in `/login/v2/poll`), on the address Whombat
 * uses. Behind a proxy Nextcloud may name `http://` or its own host name (`overwriteprotocol`, `overwritehost` unset),
 * or a path without the proxy's prefix: a path under the address's own keeps its place, any other keeps only the
 * route (`/index.php/login/v2/poll`). Null for anything else.
 */
export function nextcloudPollUrl(baseUrl: string, endpoint: string): string | null {
  let path: string;
  let base: URL;
  try {
    path = new URL(endpoint).pathname;
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  const route = /\/(?:index\.php\/)?login\/v2\/poll$/.exec(path);
  if (!route) return null;
  const root = base.pathname.replace(/\/+$/, '');
  if (root && path.startsWith(`${root}/`)) return `${base.origin}${path}`;
  return `${base.origin}${root}${route[0]}`;
}

/** `connections.pollNextcloud`: pending, connected (the connection made and checked), expired or failed. */
export async function pollNextcloudLogin(
  services: Services,
  accountId: string,
  flowId: string,
): Promise<PollNextcloudLoginResponse> {
  const live = await livePending(services, flowId, accountId, ['nextcloud_login']);
  if (!live) throw connectionError('login_expired');
  if (live.kind !== 'live') {
    if (live.kind === 'expired') await takePending(services, flowId, accountId, ['nextcloud_login']);
    return { state: 'expired' };
  }
  const st = pendingState<NextcloudPendingState>(services, live.row);
  let res: Awaited<ReturnType<typeof connectionFetch>>;
  try {
    res = await connectionFetch(
      services,
      st.pollEndpoint,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: formBody({ token: st.pollToken }),
      },
      { effect: 'connections.nextcloud_poll', idempotent: false, ...pinOf({ fields: st.fields }) },
    );
  } catch (err) {
    return { state: 'failed', message: outboundText(err) };
  }
  // 404 until the person granted access.
  if (res.status === 404) return { state: 'pending' };
  if (res.status !== 200) return { state: 'failed', message: `Nextcloud answered ${res.status}.` };
  const doc = jsonOf(res) as Record<string, unknown> | null;
  const loginName = typeof doc?.loginName === 'string' ? doc.loginName : null;
  const appPassword = typeof doc?.appPassword === 'string' ? doc.appPassword : null;
  if (!loginName || !appPassword)
    return { state: 'failed', message: 'Nextcloud didn’t send an app password.' };
  // Nextcloud answers the password once: the flow is used up whatever happens next.
  const taken = await takePending(services, flowId, accountId, ['nextcloud_login']);
  if (taken.kind !== 'taken') return { state: 'expired' };
  const pending = taken.row;
  const entry = catalogEntry('nextcloud');
  const viewer = pending.burrowId ? await viewerFor(services, accountId, pending.burrowId) : null;
  if (!entry || !viewer) return { state: 'failed', message: 'You’re no longer on that Whombat.' };
  const fields = { ...st.fields, username: loginName };
  try {
    const credential = tokenCheckCredential(entry, AUTH, appPassword, fields);
    const outcome = await runCatalogCheck(services, {
      entry,
      signIn: 'nextcloud_login',
      baseUrl: st.baseUrl,
      mcpUrl: null,
      fields,
      credential,
    });
    if (!outcome.ok)
      return { state: 'failed', message: outcome.message ?? 'Nextcloud refused the app password.' };
    const input = {
      signIn: 'nextcloud_login' as const,
      // The user id the check answered (connection-signin.md SG-15a): DAV paths name it, not the login name.
      fields: { ...fields, ...fieldsFromCheck(entry, outcome.json) },
      auth: AUTH,
      secret: appPassword,
      externalName: externalNameFrom(outcome.json) ?? loginName,
      checks: outcome.checks,
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
