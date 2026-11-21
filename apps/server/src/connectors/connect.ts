/**
 * Connecting a Google account (docs/decisions/connectors.md CN-04):
 * - `startGoogle` stores a single-use `oauth_states` row (10 minutes, bound to the account, the PKCE verifier,
 *   the ticked services and the return path) and answers Google's consent URL (the callback itself with a
 *   fake code in fake mode, CN-08);
 * - `finishGoogle` is Google's redirect: it checks the state against the signed-in account, exchanges the
 *   code, reads who the account is, stores the connection, runs the service checks and says where to send
 *   the browser (`connected=google` or `connect_error=<code>`).
 */
import {
  type ConnectErrorCode,
  type ConnectorProvider,
  type ConnectorService,
  googleScopesFor,
  googleServicesGranted,
  MICROSOFT_SERVICES,
  microsoftScopesFor,
  microsoftServicesGranted,
  randomIdBody,
  type StartGoogleBody,
} from '@whombat/core';
import { and, eq, gt, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { externalEffect } from '../commit/scope';
import { returnAddressProblem } from '../connections/redirect';
import { oauthStates } from '../db/schema/index';
import { conflict } from '../lib/errors';
import type { Services } from '../services';
import { googleAppCredentials } from './app';
import { connectionOfAccount } from './lookup';
import { codeChallengeS256, newCodeVerifier } from './oauth';
import { providerMode, providerOAuth, providerRedirectUri } from './providers';
import { checkConnection, storeGoogleConnection } from './store';
import { type GoogleAppCredentials, GoogleOAuthError, type GoogleTokens, type GoogleUserInfo } from './types';

/** How long a started sign-in may take. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

/** The fake Google needs no app (CN-08). */
const FAKE_APP: GoogleAppCredentials = {
  clientId: 'fake-client',
  clientSecret: 'fake-secret',
  userType: 'external',
  source: 'config',
};

/** The client to sign in with: none in real mode without one; the fake needs none. */
async function appFor(services: Services, provider: ConnectorProvider): Promise<GoogleAppCredentials | null> {
  const app = await googleAppCredentials(services, provider);
  return app ?? (providerMode(services, provider) === 'fake' ? FAKE_APP : null);
}

/** Starts connecting: the consent URL for the ticked services. 409 when Google is off or not set up. */
export async function startGoogle(
  services: Services,
  accountId: string,
  body: StartGoogleBody,
  provider: ConnectorProvider = 'google',
): Promise<{ authorizeUrl: string }> {
  if (
    provider === 'microsoft' &&
    body.services.some((s) => !MICROSOFT_SERVICES.includes(s as (typeof MICROSOFT_SERVICES)[number]))
  )
    throw conflict('Microsoft supports mail, calendar, files and contacts.');
  if (providerMode(services, provider) === 'off')
    throw conflict('Google is turned off on this Whombat (WHOMBAT_GOOGLE=off).');
  const app = await appFor(services, provider);
  if (!app)
    throw conflict(
      `${provider === 'google' ? 'Google' : 'Microsoft'} isn’t set up on this Whombat yet. You can set it up in Settings → Connections.`,
    );
  // Where the sign-in comes back to (whombat-link.md LNK-16): a secure page of this box, and for a client set in the
  // image's config only the hosted UI it was registered with. The fake signs in without leaving.
  if (providerMode(services, provider) !== 'fake') {
    const noReturn = returnAddressProblem(services.config, app.source === 'config');
    if (noReturn) throw conflict(noReturn);
  }
  const now = services.clock();
  const state = `oas_${randomIdBody(43)}`;
  const verifier = newCodeVerifier();
  const existing = await connectionOfAccount(services.db, accountId, provider);
  await services.pipeline.transactAccount(async (tx) => {
    // Housekeeping: the account's finished or expired sign-ins.
    await tx
      .delete(oauthStates)
      .where(
        and(
          eq(oauthStates.accountId, accountId),
          or(lt(oauthStates.expiresAt, now), isNotNull(oauthStates.usedAt)),
        ),
      );
    await tx.insert(oauthStates).values({
      id: state,
      accountId,
      provider,
      services: body.services,
      codeVerifier: verifier,
      returnPath: currentReturnPath(body.returnTo),
      createdAt: now,
      expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS),
    });
  });
  const authorizeUrl = providerOAuth(services, provider).authorizeUrl({
    app,
    redirectUri: providerRedirectUri(services, provider),
    scopes: (provider === 'google' ? googleScopesFor : microsoftScopesFor)(body.services),
    state,
    codeChallenge: codeChallengeS256(verifier),
    ...(existing ? { loginHint: existing.email } : {}),
  });
  return { authorizeUrl };
}

export interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
}

export interface CallbackOutcome {
  /** Where the browser goes: the return path with `connected=google` or `connect_error=<code>`. */
  location: string;
}

const LOCAL_ORIGIN = 'http://whombat.invalid';

/**
 * `path?…&key=value`, keeping what the path already has. A path that would leave this Whombat once normalized
 * (`/.//evil.com` → `//evil.com`, a protocol-relative redirect) goes to `fallback` instead (IN-19).
 */
export function withParam(path: string, key: string, value: string, fallback = '/'): string {
  const url = new URL(path, LOCAL_ORIGIN);
  if (url.origin !== LOCAL_ORIGIN || !url.pathname.startsWith('/') || url.pathname.startsWith('//'))
    return fallback === '/' ? `/?${new URLSearchParams({ [key]: value })}` : withParam(fallback, key, value);
  url.searchParams.delete('connected');
  url.searchParams.delete('connect_error');
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * A connect card's `returnTo` as the apps read it: a card posted before the Chat had its own address says
 * `/{burrow}/dm/{agent}?guide=<card>`, a path the apps no longer have; it becomes `/{burrow}/chat` with the card's
 * thread open (those cards were all at the top of the Chat, so the card is its thread). Any other path is kept.
 */
export function currentReturnPath(returnTo: string): string {
  const m = /^\/([^/?#]+)\/dm\/[^/?#]+(\?[^#]*)?$/.exec(returnTo);
  if (!m) return returnTo;
  const query = new URLSearchParams(m[2] ?? '');
  const guide = query.get('guide');
  if (guide) query.set('thread', guide);
  const rest = query.toString();
  return `/${m[1]}/chat${rest ? `?${rest}` : ''}`;
}

/** How a state stood when the callback came: taken now, used or expired before, or unknown to this account. */
type StateOutcome =
  | { kind: 'taken'; row: typeof oauthStates.$inferSelect }
  | { kind: 'used' | 'expired'; returnPath: string; services: ConnectorService[] }
  | { kind: 'unknown' };

/**
 * Takes the state for good: it must exist, be unused, unexpired, and belong to the signed-in account (a
 * sign-in started by someone else must not connect their Google account to this one, or this account's
 * Google to theirs). Someone else's state is left alone (it stays usable by its own account) and reads as unknown.
 */
async function takeState(
  services: Services,
  state: string | undefined,
  accountId: string | null,
  provider: ConnectorProvider,
): Promise<StateOutcome> {
  if (!state || !accountId || !/^oas_[A-Za-z0-9_-]{1,64}$/.test(state)) return { kind: 'unknown' };
  const now = services.clock();
  const [row] = await services.pipeline.transactAccount((tx) =>
    tx
      .update(oauthStates)
      .set({ usedAt: now })
      .where(
        and(
          eq(oauthStates.id, state),
          eq(oauthStates.provider, provider),
          eq(oauthStates.accountId, accountId),
          isNull(oauthStates.usedAt),
          gt(oauthStates.expiresAt, now),
        ),
      )
      .returning(),
  );
  if (row) return { kind: 'taken', row };
  // Used or expired: still send the browser back where it came from when it is this account's.
  const [known] = await services.db.select().from(oauthStates).where(eq(oauthStates.id, state));
  if (!known || known.accountId !== accountId || known.provider !== provider) return { kind: 'unknown' };
  // An expired sign-in is reported once (the retry in the DM, AG-21); it is used up then, so a reload says nothing.
  const [first] = known.usedAt
    ? []
    : await services.pipeline.transactAccount((tx) =>
        tx
          .update(oauthStates)
          .set({ usedAt: now })
          .where(and(eq(oauthStates.id, state), isNull(oauthStates.usedAt)))
          .returning({ id: oauthStates.id }),
      );
  return {
    kind: first ? 'expired' : 'used',
    returnPath: known.returnPath,
    services: known.services as ConnectorService[],
  };
}

/**
 * Google's redirect after consent — the browser callback (self-hosted) and `connections.finishGoogle` (the hosted
 * UI hands over what Google put on its address bar, AG-14) run exactly this. `accountId` is the signed-in account
 * (cookie or session), `fallbackPath` where to go when the state says nothing (the account's first burrow's
 * Connections tab). When the return path is the person's Chat with a guide marker, the result lands there (AG-08).
 */
export async function finishGoogle(
  services: Services,
  query: CallbackQuery,
  accountId: string | null,
  fallbackPath: string,
  provider: ConnectorProvider = 'google',
): Promise<CallbackOutcome> {
  const taken = await takeState(services, query.state, accountId, provider);
  const returnPath =
    taken.kind === 'taken' ? taken.row.returnPath : taken.kind === 'unknown' ? null : taken.returnPath;
  const requested = (
    taken.kind === 'taken' ? taken.row.services : taken.kind === 'unknown' ? [] : taken.services
  ) as ConnectorService[];
  const fail = async (code: ConnectErrorCode): Promise<CallbackOutcome> => {
    // A second visit of a finished sign-in (a reload) says nothing in the DM; everything else explains itself there.
    if (provider === 'google' && accountId && returnPath && taken.kind !== 'used' && taken.kind !== 'unknown')
      await services.guides.afterGoogle({ accountId, returnPath, requested, outcome: { error: code } });
    return { location: withParam(returnPath ?? fallbackPath, 'connect_error', code, fallbackPath) };
  };
  if (taken.kind !== 'taken' || !accountId) return fail('invalid_state');
  const row = taken.row;
  if (query.error) return fail(query.error === 'access_denied' ? 'access_denied' : 'exchange_failed');
  if (!query.code) return fail('invalid_state');
  if (providerMode(services, provider) === 'off') return fail('no_app');
  const app = await appFor(services, provider);
  if (!app) return fail('no_app');

  const oauth = providerOAuth(services, provider);
  const code = query.code;
  let tokens: GoogleTokens & { refreshToken: string };
  let user: GoogleUserInfo;
  try {
    // The code is single-use: exchanging it is an effect (after the state's commit, CS-01).
    const exchanged = await externalEffect('google.exchange', () =>
      oauth.exchangeCode({
        app,
        code,
        codeVerifier: row.codeVerifier,
        redirectUri: providerRedirectUri(services, provider),
      }),
    );
    // `prompt=consent` makes Google send a refresh token; without one the connection could not last an hour.
    if (!exchanged.refreshToken) throw new GoogleOAuthError('other', 'Google sent no refresh token.');
    tokens = { ...exchanged, refreshToken: exchanged.refreshToken };
    // People can untick services on Google's consent screen; with none of the asked-for ones left there is
    // nothing to connect (an existing connection stays as it was).
    if (
      !(provider === 'google' ? googleServicesGranted : microsoftServicesGranted)(tokens.scopes).some((s) =>
        requested.includes(s),
      )
    )
      throw new GoogleOAuthError('access_denied', 'None of the asked-for services were granted.');
    user = await oauth.userinfo(tokens.accessToken);
  } catch (err) {
    services.log.warn(
      { accountId, err: err instanceof GoogleOAuthError ? `${err.code}: ${err.message}` : String(err) },
      'google connect: exchange failed',
    );
    return fail(
      err instanceof GoogleOAuthError && err.code === 'access_denied' ? 'access_denied' : 'exchange_failed',
    );
  }
  let stored = await storeGoogleConnection(services, {
    accountId,
    provider,
    requested,
    tokens,
    user,
  });
  try {
    stored = await checkConnection(services, stored);
  } catch (err) {
    services.log.warn({ connectionId: stored.id, err: String(err) }, 'google connect: checks failed');
  }
  services.log.info({ accountId, connectionId: stored.id, services: stored.services }, 'google connected');
  if (provider === 'google')
    await services.guides.afterGoogle({
      accountId,
      returnPath: row.returnPath,
      requested,
      outcome: { connectionId: stored.id },
    });
  return { location: withParam(row.returnPath, 'connected', provider, fallbackPath) };
}
