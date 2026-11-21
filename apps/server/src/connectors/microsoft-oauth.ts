import { z } from 'zod';
import { boundedBytes } from './binary';
import type { AuthorizeUrlInput, GoogleAppCredentials, GoogleOAuth, GoogleTokens } from './types';
import { GoogleOAuthError } from './types';

const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const Token = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().optional(),
  scope: z.string(),
});

export class MicrosoftOAuth implements GoogleOAuth {
  constructor(
    private readonly fetchImpl: typeof fetch = (url, init) => fetch(url, init),
    private readonly now = () => new Date(),
  ) {}
  authorizeUrl(input: AuthorizeUrlInput): string {
    const q = new URLSearchParams({
      client_id: input.app.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: input.scopes.join(' '),
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    if (input.loginHint) q.set('login_hint', input.loginHint);
    return `${AUTHORITY}/authorize?${q}`;
  }
  private async tokens(app: GoogleAppCredentials, params: Record<string, string>): Promise<GoogleTokens> {
    const response = await this.fetchImpl(`${AUTHORITY}/token`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...params }),
    });
    const data = JSON.parse((await boundedBytes(response, 256_000)).toString('utf8'));
    if (!response.ok) {
      const code =
        data.error === 'invalid_grant'
          ? 'invalid_grant'
          : data.error === 'invalid_client'
            ? 'invalid_client'
            : data.error === 'access_denied'
              ? 'access_denied'
              : 'other';
      throw new GoogleOAuthError(
        code,
        `Microsoft authorization failed (HTTP ${response.status}).`,
        response.status,
      );
    }
    const token = Token.parse(data);
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      expiresAt: new Date(this.now().getTime() + token.expires_in * 1000),
      scopes: token.scope.split(' '),
    };
  }
  exchangeCode(input: {
    app: GoogleAppCredentials;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }) {
    return this.tokens(input.app, {
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    });
  }
  refresh(input: { app: GoogleAppCredentials; refreshToken: string }) {
    return this.tokens(input.app, { grant_type: 'refresh_token', refresh_token: input.refreshToken });
  }
  async revoke(): Promise<void> {
    /* Microsoft exposes no per-app refresh-token revoke endpoint. Disconnect forgets the sealed grant locally. */
  }
  async userinfo(accessToken: string) {
    const response = await this.fetchImpl(
      'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName',
      {
        headers: { authorization: `Bearer ${accessToken}` },
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok)
      throw new GoogleOAuthError('other', `Microsoft profile failed (HTTP ${response.status}).`);
    const profile = z
      .object({
        id: z.string(),
        mail: z.string().nullable().optional(),
        userPrincipalName: z.string(),
        displayName: z.string().nullable(),
      })
      .parse(JSON.parse((await boundedBytes(response, 256_000)).toString('utf8')));
    return {
      sub: profile.id,
      email: z.email().parse(profile.mail ?? profile.userPrincipalName),
      name: profile.displayName ?? profile.mail ?? profile.userPrincipalName,
    };
  }
}
