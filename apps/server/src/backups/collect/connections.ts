/**
 * Connections (`connections.jsonl`, BF-05, BF-06): the burrow's connections with their sign-ins unsealed (the file is
 * encrypted), the maker's Google or Microsoft accounts, the connector apps (OAuth clients), feedback sources with their
 * tokens, and the burrow's GitHub connection — its sign-in only when it is the maker's own. Since 0.117 (BF-19, BF-20) tools' limits, what
 * a connection runs on, a device's profile and choices, and built-in connections without a sign-in; a sign-in that
 * doesn't open is in the file as needing one, and the manifest says how many (`sign_in_left_out`).
 */
import { type BackupConnectionsLine, catalogEntry } from '@whombat/core';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { clientAad, openConnectionSecret, openJson } from '../../connections/crypto';
import { openAppSecret, openConnectionToken } from '../../connectors/crypto';
import {
  catalogConnections,
  connectionClients,
  connections,
  connectionTools,
  connectorApps,
  deviceSkills,
  feedbackIntegrations,
  githubConnections,
  principals,
} from '../../db/schema/index';
import { DEVICE_CATALOG_ID } from '../../devices/store';
import { iso } from '../../lib/time';
import { providerLogins } from '../../managed/providers/service';
import type { CategoryOut, CollectScope } from './scope';

const rec = (v: BackupConnectionsLine) =>
  v as BackupConnectionsLine & { type: string } & Record<string, unknown>;

/** A sealed value opened, or null when it doesn't open (a box-bound or damaged one: the restore asks to sign in). */
function opened(open: () => string): string | null {
  try {
    const v = open();
    return v ? v : null;
  } catch {
    return null;
  }
}

/** Opens the sealed values of one record, remembering whether one that was there didn't open (BF-19, BF-S12). */
class Opener {
  failed = false;
  open(sealed: string | null | undefined, open: (sealed: string) => string): string | null {
    if (!sealed) return null;
    const v = opened(() => open(sealed));
    if (v === null) this.failed = true;
    return v;
  }
}

/** A built-in connection (Servers, a device): its tools come with it, nobody signs in to it (BF-19). */
const isBuiltin = (catalogId: string) => catalogEntry(catalogId)?.transport === 'builtin';

const cap = (v: string | null, max: number) => (v && v.length <= max ? v : null);

export async function collectConnections(scope: CollectScope, out: CategoryOut): Promise<void> {
  const { db, burrow, services } = scope;
  const custody = services.custody;
  const accountId = scope.maker.accountId ?? '';
  const rows = await db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.burrowId, burrow.id))
    .orderBy(asc(catalogConnections.createdAt));
  const tools = rows.length
    ? await db
        .select()
        .from(connectionTools)
        .where(
          inArray(
            connectionTools.connectionId,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(asc(connectionTools.position))
    : [];
  const devices = rows.some((r) => r.catalogId === DEVICE_CATALOG_ID)
    ? await db
        .select()
        .from(deviceSkills)
        .where(
          and(
            eq(deviceSkills.status, 'on'),
            inArray(
              deviceSkills.connectionId,
              rows.filter((r) => r.catalogId === DEVICE_CATALOG_ID).map((r) => r.id),
            ),
          ),
        )
    : [];
  let leftOut = 0;
  for (const r of rows) {
    const seal = new Opener();
    let oauthClient: {
      issuer: string;
      clientId: string;
      clientSecret: string | null;
      redirectUri: string;
      method: 'dcr' | 'metadata';
    } | null = null;
    if (r.clientId?.startsWith('ccl_')) {
      const [client] = await db.select().from(connectionClients).where(eq(connectionClients.id, r.clientId));
      if (client) {
        try {
          const c = openJson<{ clientId: string; clientSecret?: string }>(
            custody,
            clientAad(client.id),
            client.clientEnc,
          );
          seal.failed ||= !c.clientId;
          oauthClient = {
            issuer: client.issuer.slice(0, 2000),
            clientId: c.clientId.slice(0, 500),
            clientSecret: cap(c.clientSecret ?? null, 2000),
            redirectUri: client.redirectUri.slice(0, 2000),
            method: client.method === 'metadata' ? 'metadata' : 'dcr',
          };
        } catch {
          oauthClient = null;
          seal.failed = true;
        }
      }
    } else if (r.clientId && /^https?:\/\//.test(r.clientId) && r.issuer)
      oauthClient = {
        issuer: r.issuer.slice(0, 2000),
        clientId: r.clientId.slice(0, 500),
        clientSecret: null,
        redirectUri: '',
        method: 'metadata',
      };
    const credential = {
      secret: cap(
        seal.open(r.secretEnc, (v) => openConnectionSecret(custody, r.id, 'secret', v)),
        8000,
      ),
      clientSecret: cap(
        seal.open(r.clientSecretEnc, (v) => openConnectionSecret(custody, r.id, 'client', v)),
        8000,
      ),
      refreshToken: cap(
        seal.open(r.refreshTokenEnc, (v) => openConnectionSecret(custody, r.id, 'refresh', v)),
        8000,
      ),
      // An access token that doesn't open is refreshed (or asked for) like an expired one: not a sign-in left out.
      accessToken: cap(
        r.accessTokenEnc
          ? opened(() => openConnectionSecret(custody, r.id, 'access', r.accessTokenEnc as string))
          : null,
        8000,
      ),
      accessExpiresAt: r.accessExpiresAt ? iso(r.accessExpiresAt) : null,
      oauthClient: oauthClient?.redirectUri ? oauthClient : null,
      issuer: r.issuer ?? null,
      resource: r.resource ?? null,
      scopes: (r.scopes ?? []).slice(0, 100),
      externalName: r.externalName ? r.externalName.slice(0, 320) : null,
    };
    const builtin = isBuiltin(r.catalogId);
    const device = devices.find((d) => d.connectionId === r.id) ?? null;
    if (seal.failed) leftOut++;
    out.ref(r.id, r.connectedById);
    await out.record(
      rec({
        type: 'connection',
        id: r.id,
        catalogId: r.catalogId,
        connectedBy: r.connectedById ?? null,
        label: (r.label || r.catalogId).slice(0, 200),
        handle: r.handle,
        transport: r.transport,
        signIn: r.signIn,
        baseUrl: r.baseUrl.slice(0, 2000),
        fields: r.fields ?? {},
        auth: r.auth ?? null,
        access: r.access,
        tools: tools
          .filter((t) => t.connectionId === r.id)
          .slice(0, 256)
          .map((t) => ({
            name: t.name.slice(0, 200),
            tier: t.tier,
            hash: t.hash.slice(0, 128),
            limits: t.limits && Object.keys(t.limits.args ?? {}).length ? t.limits : null,
          })),
        credential: builtin ? null : credential,
        runsOn: r.runsOn ?? null,
        builtin,
        device: device
          ? {
              name: device.name.slice(0, 200),
              profile: device.profile as unknown as Record<string, never>,
              host: device.host,
              port: device.port,
              unitId: device.unitId ?? null,
              choices: device.choices ?? null,
            }
          : null,
        needsSignIn: seal.failed,
        createdAt: iso(r.createdAt),
      }),
    );
  }

  if (accountId) {
    const accounts = await db.select().from(connections).where(eq(connections.accountId, accountId));
    for (const c of accounts) {
      // An Email (IMAP) account isn't in the file (connections-more-mail.md CM-M13): its record has no place for its
      // servers, and connecting it again is an address and a password.
      if (c.provider === 'imap') continue;
      // One whose token doesn't open comes along needing a sign-in (BF-19, BF-S12), not left out without a word.
      const refresh = opened(() => openConnectionToken(custody, c.id, 'refresh', c.refreshTokenEnc));
      if (!refresh) leftOut++;
      out.ref(c.id);
      await out.record(
        rec({
          type: 'connector_account',
          id: c.id,
          provider: c.provider,
          externalId: c.externalId.slice(0, 200),
          email: c.email.slice(0, 320),
          name: (c.name ?? '').slice(0, 200),
          services: (c.services ?? []).slice(0, 20),
          scopes: (c.scopes ?? []).slice(0, 100),
          refreshToken: refresh ? refresh.slice(0, 8000) : null,
          needsSignIn: !refresh,
          grantedAt: iso(c.grantedAt),
        }),
      );
    }
  }

  // The OAuth clients the person set up (CN-02, CX-14): this Whombat's, not one burrow's — what the burrow's connections use.
  const apps = await db.select().from(connectorApps);
  for (const app of apps) {
    const secret = opened(() => openAppSecret(custody, app.provider, app.clientSecretEnc));
    if (!secret) leftOut++;
    await out.record(
      rec({
        type: 'connector_app',
        provider: app.provider,
        clientId: app.clientId.slice(0, 500),
        clientSecret: secret ? secret.slice(0, 2000) : null,
        userType: app.userType === 'internal' ? 'internal' : 'external',
        needsSignIn: !secret,
      }),
    );
  }

  const sources = await db
    .select({ i: feedbackIntegrations })
    .from(feedbackIntegrations)
    .where(eq(feedbackIntegrations.burrowId, burrow.id))
    .orderBy(asc(feedbackIntegrations.createdAt));
  for (const { i } of sources) {
    if (!scope.readable.has(i.channelId)) continue;
    out.ref(i.id, i.channelId);
    await out.record(
      rec({
        type: 'feedback_source',
        id: i.id,
        intake: i.intake,
        assessment: i.assessment,
        conversation: i.channelId,
        settings: i.settings as unknown as Record<string, never>,
        token: null,
        needsSignIn: false,
      }),
    );
  }
  // What couldn't go in is said in the restore preview (BF-19, BF-S12).
  out.note('sign_in_left_out', leftOut);

  const [github] = await db.select().from(githubConnections).where(eq(githubConnections.burrowId, burrow.id));
  if (github) {
    const connectedBy =
      github.connectedById === scope.maker.id ? scope.makerEmail : await emailOf(scope, github.connectedById);
    let token: string | null = null;
    if (github.connectedById === scope.maker.id && accountId)
      token = await providerLogins(services)
        .githubToken()
        .catch(() => null);
    if (connectedBy)
      await out.record(
        rec({ type: 'github', login: github.login ?? null, connectedBy, token: cap(token, 2000) }),
      );
  }
}

async function emailOf(scope: CollectScope, principalId: string): Promise<string | null> {
  const [row] = await scope.db
    .select({ email: principals.email })
    .from(principals)
    .where(eq(principals.id, principalId));
  return row?.email?.toLowerCase() ?? null;
}
