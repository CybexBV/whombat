/**
 * Email (IMAP) on this server (docs/decisions/connections-more.md CM-19…CM-23, connections-more-mail.md): the adapter
 * bound to the database and the destination policy, finding an address's servers (`connectors.imapDiscover`) and
 * connecting a mailbox (`connectors.imapConnect`: both sides signed in before anything is kept).
 *
 * A connection is a `connections` row with provider `imap`, services `['mail']`, its servers in `mail_settings` and the
 * password sealed in `refresh_token_enc` under the purpose `password`. One per account; connecting again replaces it.
 */
import {
  type ConnectorService,
  type ImapConnectBody,
  type ImapConnectErrorDetails,
  type ImapConnectFailure,
  type ImapDiscoverResponse,
  ImapServerSettings,
  imapProviderFor,
  imapProviderHint,
  newId,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { accounts, connections, type StoredMailSettings } from '../../db/schema/index';
import { lockedConnectorCount } from '../../domain/licence-usage';
import { ApiError } from '../../lib/errors';
import type { Services } from '../../services';
import { openConnectionToken, sealConnectionToken } from '../crypto';
import type { ConnectionRow } from '../lookup';
import { markNeedsReauth } from '../store';
import { ConnectionUnavailableError } from '../types';
import { type DiscoveredSettings, discoverMail, mailDomainOf } from './discover';
import { isMicrosoftMailHost, MailError } from './errors';
import { discoverDeps, mailConnector, mailEndpoint } from './net';
import { checkMailAccount, type ImapAccount, ImapWorkspace, NEEDS_PASSWORD_TEXT } from './workspace';

/** The services an IMAP connection has: mail, nothing else (CM-19). */
export const IMAP_SERVICES: ConnectorService[] = ['mail'];

/** The adapter's view of a stored connection: the password opened, the servers as stored. */
export function accountFromRow(services: Services, row: ConnectionRow): ImapAccount {
  const settings = row.mailSettings;
  if (row.provider !== 'imap' || !settings)
    throw new ConnectionUnavailableError('not_connected', 'This account hasn’t connected a mailbox.');
  return {
    email: row.email,
    name: row.name,
    user: settings.username ?? row.email,
    password: openConnectionToken(services.custody, row.id, 'password', row.refreshTokenEnc),
    imap: settings.imap,
    smtp: settings.smtp,
    savesSent: settings.savesSent,
  };
}

async function accountOf(services: Services, connectionId: string): Promise<ImapAccount> {
  const [row] = await services.db.select().from(connections).where(eq(connections.id, connectionId));
  if (row?.provider !== 'imap')
    throw new ConnectionUnavailableError('not_connected', 'This account hasn’t connected a mailbox.');
  if (row.status !== 'active') throw new ConnectionUnavailableError('needs_reauth', NEEDS_PASSWORD_TEXT);
  return accountFromRow(services, row);
}

const workspaces = new WeakMap<Services, ImapWorkspace>();

/** The adapter of this server: a token is a connection id (`ConnectionTokens.accessFor` for `imap`). */
export function imapWorkspaceOf(services: Services): ImapWorkspace {
  let ws = workspaces.get(services);
  if (!ws) {
    ws = new ImapWorkspace({
      account: (token) => accountOf(services, token),
      // The server refused the stored password: the person enters a new one (CM-D03), told by their assistant (AG-13).
      refused: async (token) => {
        await markNeedsReauth(services, token, 'password_refused');
      },
      connector: mailConnector(services),
      now: () => services.clock(),
      warn: (message, err) => services.log.warn({ err: String(err) }, `imap: ${message}`),
    });
    workspaces.set(services, ws);
  }
  return ws;
}

/* Discovery (CM-20, CM-21) ------------------------------------------------------------------------ */

/** The servers of an address, where they came from, and what to say about its provider. */
export async function discoverImap(services: Services, email: string): Promise<ImapDiscoverResponse> {
  const found = await discoverMail(email, discoverDeps(services));
  const provider = imapProviderFor(email, found.mx);
  const settings = found.settings ? ImapServerSettings.safeParse(found.settings) : null;
  return {
    settings: settings?.success ? settings.data : null,
    source: settings?.success ? found.source : null,
    hint: provider ? imapProviderHint(provider) : null,
  };
}

/* Connecting (CM-22) ---------------------------------------------------------------------------- */

function failureOf(err: MailError): ImapConnectFailure {
  if (err.reason === 'not_allowed') return 'not_allowed';
  if (err.reason === 'certificate') return 'certificate';
  if (err.reason === 'refused') return err.side === 'imap' ? 'imap_refused' : 'smtp_refused';
  return err.side === 'imap' ? 'imap_unreachable' : 'smtp_unreachable';
}

/** The form's refusal: why (`ImapConnectErrorDetails`), which server, in words (never the server's own). */
export function imapConnectError(err: MailError): ApiError {
  const reason = failureOf(err);
  const details: ImapConnectErrorDetails = { reason, host: err.host.slice(0, 253), port: err.port };
  return new ApiError(reason === 'not_allowed' ? 'not_allowed' : 'conflict', err.message, { details });
}

/** Who an account is at its provider: the user name at the IMAP server (a reconnect to another one is a new account). */
function externalIdOf(email: string, settings: DiscoveredSettings): string {
  return `${(settings.username ?? email).toLowerCase()}@${settings.imap.host}`.slice(0, 500);
}

/**
 * Connects the account's mailbox: the servers given (else the ones it has for the same address, else the ones discovery
 * finds), the destination checked for both
 * with the reason in full, both sides signed in (CM-22), then the connection stored with the password sealed. Throws
 * the form's refusal (`imapConnectError`), or `validation_failed` when there are no servers to try.
 */
export async function connectImap(
  services: Services,
  accountId: string,
  body: ImapConnectBody,
): Promise<ConnectionRow> {
  const email = body.email.trim();
  const domain = mailDomainOf(email);
  let settings: DiscoveredSettings | null = body.settings
    ? { ...body.settings, username: body.settings.username ?? null }
    : null;
  let savesSent: boolean | null = null;
  // A new password for the same address (“Change password”, CM-M18): the servers it has stay as they are.
  const [existing] = await services.db
    .select()
    .from(connections)
    .where(and(eq(connections.accountId, accountId), eq(connections.provider, 'imap')));
  if (!settings && existing?.mailSettings && existing.email.toLowerCase() === email.toLowerCase()) {
    const { savesSent: kept, ...servers } = existing.mailSettings;
    settings = servers;
    savesSent = kept;
  }
  let mx: string[] = [];
  if (!settings) {
    const found = await discoverMail(email, discoverDeps(services));
    settings = found.settings;
    mx = found.mx;
  } else if (domain && savesSent === null) {
    const records = await discoverDeps(services)
      .mx(domain)
      .catch(() => []);
    mx = records.map((r) => r.exchange.toLowerCase().replace(/\.$/, ''));
  }
  if (!settings)
    throw new ApiError('validation_failed', 'Give the mail servers for this address.', {
      fields: { settings: ['Give the mail servers for this address.'] },
    });
  const [account] = await services.db.select().from(accounts).where(eq(accounts.id, accountId));
  savesSent ??= imapProviderFor(email, mx)?.savesSent ?? false;
  const candidate: ImapAccount = {
    email,
    name: account?.name ?? '',
    user: settings.username ?? email,
    password: body.password,
    imap: settings.imap,
    smtp: settings.smtp,
    savesSent,
  };
  // Microsoft's own servers take no password over IMAP, not even an app password: said before one is sent (SG-18b).
  if (isMicrosoftMailHost(settings.imap.host))
    throw imapConnectError(new MailError('imap', 'refused', settings.imap.host, settings.imap.port));
  try {
    // Where it may go first, with the reason in full (the network to add for a home-network server).
    await mailEndpoint(services, 'imap', settings.imap, 'save');
    await mailEndpoint(services, 'smtp', settings.smtp, 'save');
  } catch (err) {
    if (err instanceof MailError) throw imapConnectError(err);
    throw err;
  }
  const failure = await checkMailAccount(mailConnector(services), candidate);
  if (failure) throw imapConnectError(failure);
  return storeImapConnection(services, {
    accountId,
    email,
    name: candidate.name,
    password: body.password,
    settings: { ...settings, savesSent },
  });
}

/**
 * Stores a mailbox that signed in: a new connection, or the account's IMAP connection replaced (one per account). Its
 * checks are the one that just passed.
 */
export async function storeImapConnection(
  services: Services,
  input: { accountId: string; email: string; name: string; password: string; settings: StoredMailSettings },
): Promise<ConnectionRow> {
  const { accountId } = input;
  const now = services.clock();
  const [existing] = await services.db
    .select()
    .from(connections)
    .where(and(eq(connections.accountId, accountId), eq(connections.provider, 'imap')));
  const id = existing?.id ?? newId('connection');
  const values = {
    externalId: externalIdOf(input.email, input.settings),
    email: input.email,
    name: input.name.slice(0, 200),
    services: IMAP_SERVICES,
    scopes: [],
    refreshTokenEnc: sealConnectionToken(services.custody, id, 'password', input.password),
    accessTokenEnc: null,
    accessExpiresAt: null,
    grantedAt: now,
    status: 'active' as const,
    reauthReason: null,
    checks: [{ service: 'mail' as const, state: 'ok' as const }],
    checkedAt: now,
    mailSettings: input.settings,
    repairNotifiedAt: null,
    updatedAt: now,
  };
  return services.pipeline.transactAccount(async (tx) => {
    // A new connector, within the plan's connectors and counted under the count's lock so two at once can't both take
    // the last place.
    if (!existing) await services.licence.assertCanAdd('connectors', lockedConnectorCount(tx));
    const [row] = existing
      ? await tx.update(connections).set(values).where(eq(connections.id, id)).returning()
      : await tx
          .insert(connections)
          .values({ id, accountId, provider: 'imap', createdAt: now, ...values })
          .returning();
    if (!row) throw new Error('connection upsert failed');
    return row;
  });
}
