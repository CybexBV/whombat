/**
 * Google sign-in (`GoogleOAuth`, types.ts; docs/decisions/connectors.md CN-04, CN-05, CN-08).
 * - `RealGoogleOAuth`: plain `fetch` against accounts.google.com / oauth2.googleapis.com /
 *   openidconnect.googleapis.com. PKCE S256, `access_type=offline`, `prompt=consent`,
 *   `include_granted_scopes=true`.
 * - `FakeGoogleOAuth` (`WHOMBAT_GOOGLE=fake`): connect skips Google. The consent URL is the callback with a
 *   fake code, which signs in `you@example.com` with the scopes that were asked for.
 * - `WHOMBAT_GOOGLE=off`: every call fails.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { GoogleMode } from '@whombat/core';
import { type FetchLike, googleFetch, readJson } from './google-http';
import {
  type AuthorizeUrlInput,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  type GoogleAppCredentials,
  type GoogleOAuth,
  GoogleOAuthError,
  type GoogleOAuthErrorCode,
  type GoogleTokens,
  type GoogleUserInfo,
} from './types';

/* PKCE ------------------------------------------------------------------------------------------ */

/** A PKCE code verifier: 64 random bytes, base64url (86 characters, inside RFC 7636's 43–128). */
export function newCodeVerifier(): string {
  return randomBytes(64).toString('base64url');
}

/** The S256 challenge of a verifier: base64url(sha256(verifier)). */
export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/* Real ------------------------------------------------------------------------------------------ */

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

const OAUTH_CODES: Record<string, GoogleOAuthErrorCode> = {
  invalid_grant: 'invalid_grant',
  access_denied: 'access_denied',
  invalid_client: 'invalid_client',
  unauthorized_client: 'invalid_client',
};

/** Google's OAuth endpoints over plain `fetch`. */
export class RealGoogleOAuth implements GoogleOAuth {
  constructor(
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly now: () => Date = () => new Date(),
  ) {}

  authorizeUrl(input: AuthorizeUrlInput): string {
    const url = new URL(GOOGLE_AUTHORIZE_URL);
    const q = url.searchParams;
    q.set('client_id', input.app.clientId);
    q.set('redirect_uri', input.redirectUri);
    q.set('response_type', 'code');
    q.set('scope', input.scopes.join(' '));
    q.set('access_type', 'offline');
    q.set('prompt', 'consent');
    q.set('include_granted_scopes', 'true');
    q.set('state', input.state);
    q.set('code_challenge', input.codeChallenge);
    q.set('code_challenge_method', 'S256');
    if (input.loginHint) q.set('login_hint', input.loginHint);
    return url.toString();
  }

  async exchangeCode(input: {
    app: GoogleAppCredentials;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<GoogleTokens> {
    return this.token({
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      client_id: input.app.clientId,
      client_secret: input.app.clientSecret,
    });
  }

  async refresh(input: { app: GoogleAppCredentials; refreshToken: string }): Promise<GoogleTokens> {
    return this.token({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.app.clientId,
      client_secret: input.app.clientSecret,
    });
  }

  async revoke(token: string): Promise<void> {
    const res = await this.call(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    // 400 `invalid_token`: already revoked or expired, which is what we wanted.
    if (!res.ok && res.status !== 400)
      throw new GoogleOAuthError('other', `Google answered ${res.status}.`, res.status);
  }

  async userinfo(accessToken: string): Promise<GoogleUserInfo> {
    const res = await this.call(GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } });
    const body = (await readJson(res)) as Record<string, unknown> | null;
    if (!res.ok || !body)
      throw new GoogleOAuthError('other', `Google answered ${res.status} for userinfo.`, res.status);
    const sub = typeof body.sub === 'string' ? body.sub : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!sub || !email) throw new GoogleOAuthError('other', 'Google didn’t say which account this is.');
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
    return { sub, email, name };
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await googleFetch(this.fetchImpl, url, init);
    } catch (err) {
      throw new GoogleOAuthError(
        'network',
        `Couldn’t reach Google: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async token(form: Record<string, string>): Promise<GoogleTokens> {
    const res = await this.call(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
    const body = ((await readJson(res)) ?? {}) as TokenResponse;
    if (!res.ok || !body.access_token) {
      const code = (body.error && OAUTH_CODES[body.error]) || 'other';
      const detail = body.error_description ?? body.error ?? `status ${res.status}`;
      throw new GoogleOAuthError(
        code,
        `Google refused the token request: ${detail}`.slice(0, 500),
        res.status,
      );
    }
    const seconds = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
    return {
      accessToken: body.access_token,
      expiresAt: new Date(this.now().getTime() + seconds * 1000),
      refreshToken: body.refresh_token ?? null,
      scopes: (body.scope ?? '').split(/\s+/).filter(Boolean),
    };
  }
}

/* Fake ------------------------------------------------------------------------------------------ */

/** The account the fake Google signs in (CN-08). */
export const FAKE_GOOGLE_USER: GoogleUserInfo = {
  sub: 'fake-google-you',
  email: 'you@example.com',
  name: 'You',
};
/**
 * The fake access token of a grant, derived from its refresh token: every refresh hands out the same one, so
 * the fake Workspace (which keeps a mailbox, calendar and drive per access token) keeps its state for as long
 * as the connection lasts. A new grant (connecting again) starts afresh, as another Google account would.
 */
export function fakeAccessTokenFor(refreshToken: string): string {
  return `fake-token.${createHash('sha256').update(refreshToken).digest('base64url').slice(0, 22)}`;
}

/**
 * Connect without Google (dev, tests, the scripted demo): the consent URL is the callback itself with a code
 * that carries the asked-for scopes. Refresh tokens can be revoked (`revoke`) to play Google's
 * `invalid_grant`; `refreshes` counts refreshes for tests.
 */
export class FakeGoogleOAuth implements GoogleOAuth {
  readonly revoked = new Set<string>();
  private readonly scopesByRefresh = new Map<string, string[]>();
  private readonly granted = new Set<string>();
  refreshes = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  authorizeUrl(input: AuthorizeUrlInput): string {
    const url = new URL(input.redirectUri);
    url.searchParams.set('code', `fake.${Buffer.from(input.scopes.join(' ')).toString('base64url')}`);
    url.searchParams.set('state', input.state);
    return url.toString();
  }

  async exchangeCode(input: { code: string }): Promise<GoogleTokens> {
    if (!input.code.startsWith('fake.'))
      throw new GoogleOAuthError('invalid_grant', 'Not a fake Google code.', 400);
    const asked = Buffer.from(input.code.slice(5), 'base64url').toString('utf8').split(' ').filter(Boolean);
    // `include_granted_scopes=true`: the new token also carries what was granted before.
    for (const scope of asked) this.granted.add(scope);
    const scopes = [...this.granted];
    const refreshToken = `fake-refresh-${randomBytes(12).toString('base64url')}`;
    this.scopesByRefresh.set(refreshToken, scopes);
    return {
      accessToken: fakeAccessTokenFor(refreshToken),
      expiresAt: this.inAnHour(),
      refreshToken,
      scopes,
    };
  }

  async refresh(input: { refreshToken: string }): Promise<GoogleTokens> {
    this.refreshes += 1;
    if (this.revoked.has(input.refreshToken))
      throw new GoogleOAuthError('invalid_grant', 'Token has been expired or revoked.', 400);
    return {
      accessToken: fakeAccessTokenFor(input.refreshToken),
      expiresAt: this.inAnHour(),
      refreshToken: null,
      scopes: this.scopesByRefresh.get(input.refreshToken) ?? [],
    };
  }

  /** Like Google: revoking any token of the grant ends the whole grant. */
  async revoke(token: string): Promise<void> {
    this.revoked.add(token);
    this.granted.clear();
  }

  async userinfo(): Promise<GoogleUserInfo> {
    return { ...FAKE_GOOGLE_USER };
  }

  private inAnHour(): Date {
    return new Date(this.now().getTime() + 3_600_000);
  }
}

/* Off ------------------------------------------------------------------------------------------- */

/** `WHOMBAT_GOOGLE=off`: every call fails. */
export function offGoogleOAuth(): GoogleOAuth {
  const off = (): never => {
    throw new GoogleOAuthError('other', 'Google is turned off on this Whombat (WHOMBAT_GOOGLE=off).');
  };
  return {
    authorizeUrl: off,
    exchangeCode: async () => off(),
    refresh: async () => off(),
    revoke: async () => off(),
    userinfo: async () => off(),
  };
}

/** The `GoogleOAuth` for a mode. */
export function createGoogleOAuth(mode: GoogleMode): GoogleOAuth {
  if (mode === 'real') return new RealGoogleOAuth();
  if (mode === 'fake') return new FakeGoogleOAuth();
  return offGoogleOAuth();
}
