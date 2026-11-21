/**
 * Restoring connections (BF-04, BF-06): a connection is matched by its service and address (else its handle) and
 * brought back through `catalog_connection.add` with its sign-in sealed again under this Whombat's master key with the
 * new row's AAD (one kind, one-person.md OP-S50). Google and Microsoft accounts come back to the restorer's account;
 * connector apps only where none is set up; feedback sources through `feedback.create_integration` with their token.
 * Every restored connection is checked afterwards (the job): one whose sign-in doesn't work here needs the person
 * (Connections → Needs you).
 */
import {
  type BackupConnectionRecord,
  type BackupConnectionsLine,
  type BackupConnectorAccountRecord,
  type BackupConnectorAppRecord,
  type BackupFeedbackSourceRecord,
  type BackupGitHubRecord,
  canonicalJson,
  catalogEntry,
  DeviceProfile,
  type FeedbackIntegrationSettings,
  newId,
  type SignInKind,
} from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import { addConnection, type NewConnection, setToolLimits, setToolTier } from '../../connections/commands';
import { clientAad, sealConnectionSecret, sealJson } from '../../connections/crypto';
import { emitConnectionLifecycle } from '../../connections/lifecycle';
import { limitsSummary, type ToolLimits } from '../../connections/limits';
import { sealAppSecret, sealConnectionToken } from '../../connectors/crypto';
import {
  catalogConnections,
  connectionClients,
  connections,
  connectionTools,
  connectorApps,
  deviceSkills,
  feedbackIntegrations,
  githubConnections,
  type StoredRunsOn,
} from '../../db/schema/index';
import { deviceSlug, profileHash } from '../../devices/profile';
import { newProposalId, toolRowsFor } from '../../devices/skills';
import { DEVICE_CATALOG_ID, type DeviceSkillRow, skillOfConnection } from '../../devices/store';
import { createFeedbackIntegration } from '../../feedback/integrations';
import { SERVERS_CATALOG_ID } from '../../hosts/provision';
import type { RecordOutcome, RestoreRun } from './run';

export async function restoreConnections(
  run: RestoreRun,
  record: BackupConnectionsLine,
): Promise<RecordOutcome> {
  switch (record.type) {
    case 'connection':
      return connection(run, record);
    case 'connector_account':
      return connectorAccount(run, record);
    case 'connector_app':
      return connectorApp(run, record);
    case 'feedback_source':
      return feedbackSource(run, record);
    case 'github':
      return github(run, record);
  }
}

/** The OAuth client a connection signed in with, registered here by issuer (made when this Whombat has none). */
async function oauthClientHere(
  run: RestoreRun,
  c: NonNullable<NonNullable<BackupConnectionRecord['credential']>['oauthClient']>,
): Promise<string> {
  const [existing] = await run.tx
    .select({ id: connectionClients.id })
    .from(connectionClients)
    .where(eq(connectionClients.issuer, c.issuer));
  if (existing) return existing.id;
  const id = `ccl_${newId('connection').slice(4)}`;
  await run.tx.insert(connectionClients).values({
    id,
    issuer: c.issuer,
    clientEnc: sealJson(run.services.custody, clientAad(id), {
      clientId: c.clientId,
      ...(c.clientSecret ? { clientSecret: c.clientSecret } : {}),
      authMethod: c.clientSecret ? 'client_secret_post' : 'none',
    }),
    redirectUri: c.redirectUri,
    method: c.method,
    registeredAt: run.ctx.now,
  });
  return id;
}

/** The record's sign-in as sealed columns for row `id` (BF-06: sealed again with this row's AAD). */
async function sealedCredential(run: RestoreRun, id: string, r: BackupConnectionRecord) {
  const custody = run.services.custody;
  const c = r.credential;
  if (!c) return {};
  return {
    secretEnc: c.secret ? sealConnectionSecret(custody, id, 'secret', c.secret) : null,
    clientSecretEnc: c.clientSecret ? sealConnectionSecret(custody, id, 'client', c.clientSecret) : null,
    refreshTokenEnc: c.refreshToken ? sealConnectionSecret(custody, id, 'refresh', c.refreshToken) : null,
    accessTokenEnc: c.accessToken ? sealConnectionSecret(custody, id, 'access', c.accessToken) : null,
    accessExpiresAt: c.accessExpiresAt ? new Date(c.accessExpiresAt) : null,
    clientId: c.oauthClient ? await oauthClientHere(run, c.oauthClient) : null,
    issuer: c.issuer,
    resource: c.resource,
    scopes: c.scopes,
    externalName: c.externalName,
  };
}

/** A built-in connection (Servers, a device): nobody signs in to it, so it is never checked again (BF-19). */
export function isBuiltinConnection(catalogId: string): boolean {
  return catalogEntry(catalogId)?.transport === 'builtin';
}

/**
 * The Servers connection (BF-19, BF-S01): never added — the server makes it where the hosts service is
 * (`ensureServersConnection`) — and never signed in again. The one here is the file's (its references follow it) and
 * takes the file's tiers and limits with “Use the backup”; where there is none, nothing of it comes back.
 */
async function serversConnection(run: RestoreRun, r: BackupConnectionRecord): Promise<RecordOutcome> {
  const [here] = await run.db
    .select()
    .from(catalogConnections)
    .where(
      and(
        eq(catalogConnections.burrowId, run.burrow.id),
        eq(catalogConnections.catalogId, SERVERS_CATALOG_ID),
      ),
    );
  if (!here) return 'detail';
  run.remember(r.id, here.id, 'connection');
  return builtinHere(run, here, r);
}

const limitsKey = (limits: ToolLimits | null | undefined) =>
  limits && Object.keys(limits.args ?? {}).length ? canonicalJson(limits) : '';

/** The file's tools whose tier or limits differ from the tools here of the same name. */
async function toolsThatDiffer(run: RestoreRun, id: string, r: BackupConnectionRecord) {
  const have = await run.db
    .select({ name: connectionTools.name, tier: connectionTools.tier, limits: connectionTools.limits })
    .from(connectionTools)
    .where(eq(connectionTools.connectionId, id));
  const byName = new Map(have.map((t) => [t.name, t]));
  return r.tools
    .map((t) => ({ file: t, here: byName.get(t.name) }))
    .filter(
      (x): x is { file: BackupConnectionRecord['tools'][number]; here: (typeof have)[number] } =>
        !!x.here && (x.here.tier !== x.file.tier || limitsKey(x.here.limits) !== limitsKey(x.file.limits)),
    );
}

/**
 * A built-in connection that is here (Servers, a device; BF-19, BF-S02): its tiers and limits as the file has them,
 * set directly through the tier and limit commands' own signed events for the tools this Whombat has under the same
 * name (they need no check to be found), and what it runs on; a device's choices follow. Nothing to sign in to.
 */
async function builtinHere(
  run: RestoreRun,
  row: typeof catalogConnections.$inferSelect,
  r: BackupConnectionRecord,
): Promise<RecordOutcome> {
  const changed = await toolsThatDiffer(run, row.id, r);
  const runsOnDiffers = !!r.runsOn && runsOnKey(row.runsOn) !== runsOnKey(r.runsOn);
  const skill = r.device ? await skillOfConnection(run.db, row.id) : null;
  const choicesDiffer =
    !!skill && !!r.device?.choices && canonicalJson(skill.choices ?? {}) !== canonicalJson(r.device.choices);
  if (changed.length === 0 && !runsOnDiffers && !choicesDiffer) return 'unchanged';
  return run.different(async () => {
    await setTools(run, row.id, changed);
    if (runsOnDiffers)
      await run.tx
        .update(catalogConnections)
        .set({ runsOn: r.runsOn, updatedAt: run.ctx.now })
        .where(eq(catalogConnections.id, row.id));
    if (skill && choicesDiffer && r.device?.choices)
      await run.tx
        .update(deviceSkills)
        .set({
          choices: r.device.choices,
          decidedById: run.restorer.id,
          decidedAt: run.ctx.now,
          updatedAt: run.ctx.now,
        })
        .where(eq(deviceSkills.id, skill.id));
  });
}

/** Tiers and limits through their commands (signed Keys events), then the connection's lifecycle event. */
async function setTools(
  run: RestoreRun,
  id: string,
  changed: {
    file: BackupConnectionRecord['tools'][number];
    here: { tier: string; limits: ToolLimits | null };
  }[],
): Promise<void> {
  if (changed.length === 0) return;
  for (const { file, here } of changed) {
    if (here.tier !== file.tier)
      await setToolTier.apply(run.tx, run.ctx, { connectionId: id, tool: file.name, tier: file.tier });
    if (limitsKey(here.limits) !== limitsKey(file.limits)) {
      const limits = limitsKey(file.limits) ? (file.limits as ToolLimits) : null;
      await setToolLimits.apply(run.tx, run.ctx, {
        connectionId: id,
        tool: file.name,
        limits,
        summary: limits ? limitsSummary(limits) : null,
      });
    }
  }
  const services = run.services;
  run.ctx.after(() => emitConnectionLifecycle(services, { type: 'tiers', connectionId: id }));
}

const runsOnKey = (v: StoredRunsOn | BackupConnectionRecord['runsOn'] | null | undefined) =>
  v ? canonicalJson(v) : '';

/**
 * A device's skill made again from the file (BF-19, BF-S11): its profile (checked as a proposal is), where it is and the
 * person's choices, switched on with this connection, which gets the tools those choices give it. Null when the profile
 * doesn't read here.
 */
async function restoreDevice(
  run: RestoreRun,
  connectionId: string,
  r: BackupConnectionRecord,
): Promise<boolean> {
  const d = r.device;
  if (!d) return false;
  const profile = DeviceProfile.safeParse(d.profile);
  if (!profile.success) return false;
  const now = run.ctx.now;
  const choices = d.choices ?? {};
  const row: DeviceSkillRow = {
    id: newProposalId(),
    burrowId: run.burrow.id,
    agentId: null,
    personId: null,
    conversationId: null,
    messageId: null,
    name: d.name.slice(0, 80),
    profile: profile.data,
    profileHash: profileHash(profile.data),
    host: d.host.toLowerCase(),
    port: d.port,
    unitId: d.unitId,
    // What the read-only test read stays with the Whombat it ran on; the next reading fills Home's facts.
    tested: [],
    testedAt: now,
    status: 'on',
    choices,
    connectionId,
    decidedById: run.restorer.id,
    decidedAt: now,
    lastRead: null,
    lastReadAt: null,
    lastReadError: null,
    createdAt: now,
    updatedAt: now,
  };
  await run.tx.insert(deviceSkills).values(row);
  const [conn] = await run.tx
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.id, connectionId));
  const slug = conn?.fields.slug ?? deviceSlug(row.name);
  await run.tx
    .update(catalogConnections)
    .set({ fields: { ...(conn?.fields ?? {}), skillId: row.id, slug } })
    .where(eq(catalogConnections.id, connectionId));
  const tools = toolRowsFor(row, slug, choices, now);
  await run.tx.delete(connectionTools).where(eq(connectionTools.connectionId, connectionId));
  if (tools.length) await run.tx.insert(connectionTools).values(tools.map((t) => ({ connectionId, ...t })));
  await run.tx
    .update(catalogConnections)
    .set({ toolCount: tools.length, toolsSyncedAt: now })
    .where(eq(catalogConnections.id, connectionId));
  return true;
}

async function connection(run: RestoreRun, r: BackupConnectionRecord): Promise<RecordOutcome> {
  if (r.catalogId === SERVERS_CATALOG_ID) return serversConnection(run, r);
  const builtin = r.builtin || isBuiltinConnection(r.catalogId);
  const here = await run.resolve(r.id);
  if (here && !run.isStandIn(here)) {
    const [row] = await run.db.select().from(catalogConnections).where(eq(catalogConnections.id, here));
    if (!row) return 'skipped';
    // A built-in one (a device) has no sign-in to bring back or check: its tools and choices are what can differ.
    if (builtin) return builtinHere(run, row, r);
    const same =
      row.label === r.label &&
      row.access === r.access &&
      JSON.stringify(row.fields ?? {}) === JSON.stringify(r.fields ?? {}) &&
      (!r.runsOn || runsOnKey(row.runsOn) === runsOnKey(r.runsOn));
    if (same) return 'unchanged';
    return run.different(async () => {
      const sealed = await sealedCredential(run, here, r);
      const signIn = r.credential && !r.needsSignIn;
      await run.tx
        .update(catalogConnections)
        .set({
          label: r.label,
          access: r.access,
          fields: r.fields,
          ...(r.runsOn ? { runsOn: r.runsOn } : {}),
          ...(signIn ? sealed : {}),
          ...(signIn
            ? {
                status: 'active',
                reauthReason: null,
                credentialVersion: sql`${catalogConnections.credentialVersion} + 1`,
              }
            : {}),
          updatedAt: run.ctx.now,
        })
        .where(eq(catalogConnections.id, here));
      if (signIn)
        run.followUps.checkConnections.push({ id: here, source: 'catalog', label: r.label, tools: r.tools });
    });
  }
  // A device without its device (a file made before 0.117) can't read anything here.
  if (r.catalogId === DEVICE_CATALOG_ID && !r.device) {
    run.note('missing_reference', 'connections');
    return 'skipped';
  }
  if (run.dry) {
    run.remember(r.id, run.standIn(r.id), 'connection');
    return 'added';
  }
  const id = newId('connection');
  const values: NewConnection = {
    id,
    catalogId: r.catalogId,
    burrowId: run.burrow.id,
    connectedById: run.restorer.id,
    label: r.label,
    transport: r.transport,
    // As the record says (an open slug in the backup contract); the Servers connection never comes this way.
    signIn: r.signIn as SignInKind,
    baseUrl: r.baseUrl,
    fields: r.fields,
    auth: r.auth,
    access: r.access,
    status: 'active',
    runsOn: r.runsOn,
    createdAt: new Date(r.createdAt),
    updatedAt: run.ctx.now,
    ...(builtin ? {} : await sealedCredential(run, id, r)),
  };
  try {
    await run.tx.transaction(async () => {
      await addConnection.apply(run.tx, run.ctx, { values, labelGiven: r.label });
      // A device comes back with its skill and works (BF-19); its tools are its choices'.
      if (r.catalogId === DEVICE_CATALOG_ID && !(await restoreDevice(run, id, r)))
        throw new Error('a device’s profile doesn’t read here');
    });
  } catch (err) {
    run.services.log.info(
      { err: String(err), catalogId: r.catalogId },
      'backup restore: a connection was not added',
    );
    run.note(r.catalogId === DEVICE_CATALOG_ID ? 'unreadable' : 'too_large', 'connections');
    return 'skipped';
  }
  run.remember(r.id, id, 'connection');
  if (builtin) {
    // A built-in one is never checked (BF-19); a device's tools came with its choices.
    if (r.catalogId !== DEVICE_CATALOG_ID)
      run.followUps.checkConnections.push({
        id,
        source: 'catalog',
        label: r.label,
        tools: r.tools,
        builtin: true,
      });
    return 'added';
  }
  // A sign-in that couldn't go in the file is asked for straight away, without a check that can't work (BF-S12).
  run.followUps.checkConnections.push({
    id,
    source: 'catalog',
    label: r.label,
    tools: r.tools,
    ...(r.needsSignIn ? { needsSignIn: true } : {}),
  });
  return 'added';
}

async function connectorAccount(run: RestoreRun, r: BackupConnectorAccountRecord): Promise<RecordOutcome> {
  // The person's account, whoever made the file (one-person.md OP-S54).
  const accountId = run.restorer.accountId;
  if (!accountId) return 'skipped';
  const [here] = await run.db
    .select()
    .from(connections)
    .where(and(eq(connections.accountId, accountId), eq(connections.provider, r.provider as never)));
  // Its token couldn't go in the file (BF-S12): it comes back asking for a sign-in.
  const token = r.refreshToken && !r.needsSignIn ? r.refreshToken : null;
  if (here) {
    run.remember(r.id, here.id, 'connector_account');
    if (here.externalId === r.externalId) return 'unchanged';
    return run.different(async () => {
      await run.tx
        .update(connections)
        .set({
          externalId: r.externalId,
          email: r.email,
          name: r.name,
          services: r.services as never,
          scopes: r.scopes,
          refreshTokenEnc: sealConnectionToken(run.services.custody, here.id, 'refresh', token ?? ''),
          accessTokenEnc: null,
          accessExpiresAt: null,
          status: 'active',
          reauthReason: null,
          updatedAt: run.ctx.now,
        })
        .where(eq(connections.id, here.id));
      run.followUps.checkConnections.push({
        id: here.id,
        source: 'connector',
        label: r.email,
        ...(token ? {} : { needsSignIn: true }),
      });
    });
  }
  if (run.dry) return 'added';
  const id = newId('connection');
  await run.tx.insert(connections).values({
    id,
    accountId,
    provider: r.provider as never,
    externalId: r.externalId,
    email: r.email,
    name: r.name,
    services: r.services as never,
    scopes: r.scopes,
    refreshTokenEnc: sealConnectionToken(run.services.custody, id, 'refresh', token ?? ''),
    grantedAt: new Date(r.grantedAt),
    status: 'active',
    createdAt: run.ctx.now,
    updatedAt: run.ctx.now,
  });
  run.remember(r.id, id, 'connector_account');
  run.followUps.checkConnections.push({
    id,
    source: 'connector',
    label: r.email,
    ...(token ? {} : { needsSignIn: true }),
  });
  return 'added';
}

async function connectorApp(run: RestoreRun, r: BackupConnectorAppRecord): Promise<RecordOutcome> {
  const [here] = await run.db
    .select()
    .from(connectorApps)
    .where(eq(connectorApps.provider, r.provider as never));
  if (here) {
    // Another client here would send every account signed in with it to “Sign in again”: what's here stays.
    return 'detail';
  }
  // A secret that couldn't go in the file (BF-S12): the person sets the client up again; the preview said so.
  const clientSecret = r.needsSignIn ? null : r.clientSecret;
  if (run.dry || !clientSecret || !run.restorer.accountId) return 'detail';
  const secret = sealAppSecret(run.services.custody, r.provider, clientSecret);
  await run.tx
    .insert(connectorApps)
    .values({
      provider: r.provider as never,
      clientId: r.clientId,
      clientSecretEnc: secret,
      userType: r.userType,
      updatedByAccountId: run.restorer.accountId,
      updatedAt: run.ctx.now,
    })
    .onConflictDoNothing();
  return 'detail';
}

async function feedbackSource(run: RestoreRun, r: BackupFeedbackSourceRecord): Promise<RecordOutcome> {
  const here = run.mapped(r.id);
  if (here) return 'unchanged';
  if (run.sameBurrow) {
    const [same] = await run.db
      .select({ id: feedbackIntegrations.id })
      .from(feedbackIntegrations)
      .where(and(eq(feedbackIntegrations.id, r.id), eq(feedbackIntegrations.burrowId, run.burrow.id)));
    if (same) {
      run.remember(r.id, same.id, 'feedback_source');
      return 'unchanged';
    }
  }
  const channel = await run.resolve(r.conversation);
  if (!channel) {
    run.note('missing_reference', 'connections');
    return 'skipped';
  }
  if (run.dry) return 'added';
  if (run.isStandIn(channel)) return 'skipped';
  // An integration that read a connected system instead of a website (gone since the report trackers): not restored.
  const source = (r.settings as { source?: { kind?: unknown } }).source?.kind;
  if (typeof source === 'string' && source !== 'widget') return 'skipped';
  const settings = (await run.remapJson(r.settings)).value as unknown as FeedbackIntegrationSettings;
  let id: string;
  try {
    id = await run.tx.transaction(async () => {
      const made = (await createFeedbackIntegration.apply(run.tx, run.ctx, {
        ...settings,
        channelId: channel,
      } as FeedbackIntegrationSettings)) as { id: string };
      return made.id;
    });
  } catch (err) {
    run.services.log.info({ err: String(err) }, 'backup restore: a feedback source was not added');
    return 'skipped';
  }
  await run.tx
    .update(feedbackIntegrations)
    .set({ intake: r.intake, assessment: r.assessment })
    .where(eq(feedbackIntegrations.id, id));
  run.remember(r.id, id, 'feedback_source');
  return 'added';
}

async function github(run: RestoreRun, r: BackupGitHubRecord): Promise<RecordOutcome> {
  const [here] = await run.db
    .select()
    .from(githubConnections)
    .where(eq(githubConnections.burrowId, run.burrow.id));
  if (here) return (here.login ?? null) === r.login ? 'unchanged' : 'kept';
  // GitHub is connected with a live sign-in of a person here (Settings → Connections → GitHub), never from a file.
  return 'skipped';
}
