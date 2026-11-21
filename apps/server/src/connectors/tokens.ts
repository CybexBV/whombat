/**
 * Access tokens for connections (`ConnectionTokens`, types.ts; docs/decisions/connectors.md CN-05). The
 * sealed access token is used while more than 60 s are left; otherwise the refresh token buys a new one
 * through `GoogleOAuth`, one refresh at a time per connection, outside any caller's session command
 * (docs/decisions/command-safety.md CS-07). Google's `invalid_grant` marks the connection
 * `needs_reauth`: `testing_expired` when the grant was 6–8 days old and the app is not `internal` (Google
 * signs everyone out of a Testing app after 7 days), otherwise `revoked`.
 *
 * Tokens never leave the server: agents, the runner and the web never see one.
 *
 * Email (IMAP) has no tokens (connections-more-mail.md CM-M01): its “token” is the connection's id, handed out while
 * the connection is active, and the IMAP adapter opens the password itself. A refused password marks it
 * `needs_reauth` (`password_refused`) there.
 */
import type { ConnectorProvider, GoogleUserType, ReauthReason } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { outsideCommandScope } from '../commit/scope';
import { connections } from '../db/schema/index';
import type { Services } from '../services';
import { googleAppCredentials } from './app';
import { openConnectionToken, sealConnectionToken } from './crypto';
import { type ConnectionRow, connectionOfAccount } from './lookup';
import { providerMode, providerOAuth } from './providers';
import { markNeedsReauth } from './store';
import {
  type ConnectionTokens,
  ConnectionUnavailableError,
  type GoogleAppCredentials,
  GoogleOAuthError,
} from './types';

/** Refresh when fewer than this many ms are left. */
export const REFRESH_MARGIN_MS = 60_000;
/** `last_used_at` is written at most this often per connection. */
const TOUCH_EVERY_MS = 60_000;

const DAY_MS = 86_400_000;

/**
 * Why `invalid_grant`: a Testing app's grant dies after 7 days (so 6–8 days old, allowing for clocks and
 * when the refresh happened), and never for an `internal` app. A config app's audience is unknown (null),
 * so its 7-day deaths count as Testing too.
 */
export function invalidGrantReason(
  grantedAt: Date,
  now: Date,
  userType: GoogleUserType | null,
): ReauthReason {
  const age = now.getTime() - grantedAt.getTime();
  return userType !== 'internal' && age >= 6 * DAY_MS && age <= 8 * DAY_MS ? 'testing_expired' : 'revoked';
}

/** The token store over the `connections` table. */
export class StoredConnectionTokens implements ConnectionTokens {
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly services: Services) {}

  async accessFor(
    accountId: string,
    provider: ConnectorProvider,
    options: { forceRefresh?: boolean } = {},
  ): Promise<string> {
    const row = await connectionOfAccount(this.services.db, accountId, provider);
    if (!row) throw new ConnectionUnavailableError('not_connected', 'This account hasn’t connected Google.');
    if (provider === 'imap') {
      if (row.status !== 'active')
        throw new ConnectionUnavailableError('needs_reauth', 'This mail account needs a new password.');
      await this.touch(row);
      return row.id;
    }
    return this.accessForRow(row, options.forceRefresh ?? false);
  }

  /**
   * `force`: Google refused the stored token (401) before it expired, so buy a new one now. A forced call
   * joins a refresh already under way for the connection (that one's token is new as well).
   */
  private async accessForRow(row: ConnectionRow, force: boolean): Promise<string> {
    if (row.status !== 'active')
      throw new ConnectionUnavailableError(
        'needs_reauth',
        'This Google connection needs you to sign in again.',
      );
    const fresh = force ? null : this.freshAccess(row);
    if (fresh) {
      await this.touch(row);
      return fresh;
    }
    let pending = this.inflight.get(row.id);
    if (!pending) {
      // Shared by every caller that joins it, so it belongs to none of them: never part of the first caller's session
      // command, whose cancel would roll back the tokens Google just issued and fail the others (command-safety.md
      // CS-07). It commits on its own.
      pending = outsideCommandScope(() => this.refresh(row.id, force)).finally(() =>
        this.inflight.delete(row.id),
      );
      this.inflight.set(row.id, pending);
    }
    return pending;
  }

  /** The stored access token while more than a minute is left. */
  private freshAccess(row: ConnectionRow): string | null {
    const now = this.services.clock().getTime();
    if (!row.accessTokenEnc || !row.accessExpiresAt) return null;
    if (row.accessExpiresAt.getTime() - now <= REFRESH_MARGIN_MS) return null;
    return openConnectionToken(this.services.custody, row.id, 'access', row.accessTokenEnc);
  }

  private async touch(row: ConnectionRow): Promise<void> {
    const now = this.services.clock();
    if (row.lastUsedAt && now.getTime() - row.lastUsedAt.getTime() < TOUCH_EVERY_MS) return;
    await this.services.db.update(connections).set({ lastUsedAt: now }).where(eq(connections.id, row.id));
  }

  /**
   * Buys a new access token with the stored refresh token. Every write is conditional on the row still
   * holding the refresh token that was used (IN-22): a reconnect that lands while Google answers wins, and
   * this refresh starts over once with the new grant (whose fresh access token it then simply returns).
   */
  private async refresh(id: string, force: boolean, again = false): Promise<string> {
    const { services } = this;
    // Read again: the row may have changed (reauth, another refresh) since the caller read it.
    const [row] = await services.db.select().from(connections).where(eq(connections.id, id));
    if (!row) throw new ConnectionUnavailableError('not_connected', 'This account hasn’t connected Google.');
    if (row.status !== 'active')
      throw new ConnectionUnavailableError(
        'needs_reauth',
        'This Google connection needs you to sign in again.',
      );
    const fresh = force ? null : this.freshAccess(row);
    if (fresh) return fresh;

    const app = await googleAppCredentials(services, row.provider);
    if (!app && providerMode(services, row.provider) === 'real')
      throw new ConnectionUnavailableError('no_app', 'Google isn’t set up on this Whombat.');
    const refreshToken = openConnectionToken(services.custody, row.id, 'refresh', row.refreshTokenEnc);
    let tokens: Awaited<ReturnType<typeof services.google.oauth.refresh>>;
    try {
      tokens = await providerOAuth(services, row.provider).refresh({ app: app ?? FAKE_APP, refreshToken });
    } catch (err) {
      if (err instanceof GoogleOAuthError && err.code === 'invalid_grant') {
        const marked = await markNeedsReauth(
          services,
          row.id,
          row.provider === 'google'
            ? invalidGrantReason(row.grantedAt, services.clock(), app?.userType ?? null)
            : 'revoked',
          { refreshTokenEnc: row.refreshTokenEnc },
        );
        // The old grant died, but a new one arrived meanwhile: use that.
        if (!marked && !again) return this.refresh(id, false, true);
        throw new ConnectionUnavailableError(
          'needs_reauth',
          'Google signed this connection out. Connect it again.',
        );
      }
      throw err;
    }
    const now = services.clock();
    const stored = await services.pipeline.transactAccount(async (tx) =>
      tx
        .update(connections)
        .set({
          accessTokenEnc: sealConnectionToken(services.custody, row.id, 'access', tokens.accessToken),
          accessExpiresAt: tokens.expiresAt,
          ...(tokens.refreshToken
            ? {
                refreshTokenEnc: sealConnectionToken(
                  services.custody,
                  row.id,
                  'refresh',
                  tokens.refreshToken,
                ),
              }
            : {}),
          ...(tokens.scopes.length ? { scopes: tokens.scopes } : {}),
          lastUsedAt: now,
          updatedAt: now,
        })
        .where(and(eq(connections.id, row.id), eq(connections.refreshTokenEnc, row.refreshTokenEnc)))
        .returning({ id: connections.id }),
    );
    if (stored.length === 0) {
      // Reconnected (maybe to another Google account) while Google answered: this token is the old grant's.
      if (!again) return this.refresh(id, false, true);
      throw new ConnectionUnavailableError('needs_reauth', 'This Google connection changed. Try again.');
    }
    return tokens.accessToken;
  }
}

/** The fake Google needs no app (CN-08: connect skips Google). */
const FAKE_APP: GoogleAppCredentials = {
  clientId: 'fake-client',
  clientSecret: 'fake-secret',
  userType: 'external',
  source: 'config',
};

/** The token store. `services` is complete by the time a token is asked for (db, custody, config, google). */
export function createConnectionTokens(services: Services, _oauth?: unknown): ConnectionTokens {
  return new StoredConnectionTokens(services);
}
