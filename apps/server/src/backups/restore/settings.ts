/**
 * Restoring settings (BF-04, BF-07; one-person.md OP-S75): the burrow's settings follow “When something is different” —
 * never its name or slug — and connected repositories keep their switches. Since 0.117 the person's Dashboard widgets,
 * preferences and photo come back to the person restoring.
 */
import {
  AVATAR_MAX_BYTES,
  AVATAR_TYPES,
  type BackupAccountProfileRecord,
  type BackupRepoRecord,
  type BackupSettingsLine,
  type BackupSettingsRecord,
  type BackupWidgetRecord,
  canonicalJson,
  newId,
  Preferences,
  sortBackupCategories,
  topics,
  WidgetSeries,
  WidgetSource,
} from '@whombat/core';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  type AccountAvatar,
  accounts,
  burrows,
  githubConnections,
  repos,
  vaultNetworks,
  widgets,
} from '../../db/schema/index';
import { replaceAvatar } from '../../files/avatars';
import { localModelKeyOf, sealLocalModelKey } from '../../local-model/store';
import { loadPrincipalRow, toPerson } from '../../read/principals';
import { sealWebSearchKey, webSearchKeyOf } from '../../web-search/store';
import { storeBlob } from './messages';
import type { RecordOutcome, RestoreRun } from './run';

export async function restoreSettings(run: RestoreRun, record: BackupSettingsLine): Promise<RecordOutcome> {
  switch (record.type) {
    case 'settings':
      return settings(run, record);
    case 'repo':
      return repo(run, record);
    case 'widget':
      // After the connections it reads: the job's `later` step (BF-S17).
      return 'detail';
    case 'account_profile':
      return accountProfile(run, record);
  }
}

async function settings(run: RestoreRun, r: BackupSettingsRecord): Promise<RecordOutcome> {
  const b = run.burrow;
  const gateway = r.aiGateway ? await run.resolve(r.aiGateway.connection) : null;
  const wantGateway =
    r.aiGateway && gateway && !run.isStandIn(gateway)
      ? { connectionId: gateway, claude: r.aiGateway.claude, codex: r.aiGateway.codex }
      : null;
  const stored = b.aiGateway as { connectionId?: string; claude?: boolean; codex?: boolean } | null;
  const networks = await run.db.select({ cidr: vaultNetworks.cidr }).from(vaultNetworks);
  const haveCidrs = new Set(networks.map((n) => n.cidr));
  const sameDefaults =
    JSON.stringify(b.backupDefaults ? sortBackupCategories(b.backupDefaults) : null) ===
    JSON.stringify(r.backupDefaults ? sortBackupCategories(r.backupDefaults) : null);
  // The model on the person's network (CT-1177): put back as it was, untested. One missing here comes back whatever
  // “When something is different” says (`localModelAbsent`); one that differs here follows it.
  const localModel = r.localModel ? restoredLocalModel(run, r.localModel) : null;
  const localModelAbsent = !!localModel && !b.localModel;
  if (localModelAbsent && localModel && !run.dry)
    await run.tx.update(burrows).set(localModel).where(eq(burrows.id, b.id));
  const sameLocalModel =
    !r.localModel ||
    localModelAbsent ||
    (b.localModel?.baseUrl === r.localModel.baseUrl &&
      b.localModel.model === r.localModel.model &&
      b.localModel.label === r.localModel.label &&
      localModelKeyOf(run.services.custody, b) === r.localModel.secret);
  // Web search with its key, the same way: missing here, it comes back; one that differs follows “When something is
  // different”.
  const webSearch = r.webSearch ? restoredWebSearch(run, r.webSearch) : null;
  const webSearchAbsent = !!webSearch && !b.webSearch;
  if (webSearchAbsent && webSearch && !run.dry)
    await run.tx.update(burrows).set(webSearch).where(eq(burrows.id, b.id));
  const sameWebSearch =
    !r.webSearch ||
    webSearchAbsent ||
    (b.webSearch?.provider === r.webSearch.provider &&
      webSearchKeyOf(run.services.custody, b) === r.webSearch.secret);
  const same =
    b.timeZone === r.timeZone &&
    (b.linkPreviews ?? true) === r.linkPreviews &&
    (b.agentsReachLan ?? true) === r.agentsReachLan &&
    sameDefaults &&
    (!wantGateway ||
      (stored?.connectionId === wantGateway.connectionId &&
        !!stored.claude === wantGateway.claude &&
        !!stored.codex === wantGateway.codex)) &&
    r.homeNetworks.every((n) => haveCidrs.has(n.cidr)) &&
    sameLocalModel &&
    sameWebSearch;
  if (same) return 'detail';
  await run.different(async () => {
    await run.tx
      .update(burrows)
      .set({
        timeZone: r.timeZone,
        linkPreviews: r.linkPreviews,
        agentsReachLan: r.agentsReachLan,
        ...(r.backupDefaults
          ? { backupDefaults: sortBackupCategories(r.backupDefaults), backupDefaultsAt: run.ctx.now }
          : {}),
        ...(wantGateway ? { aiGateway: wantGateway } : {}),
        ...(localModel ?? {}),
        ...(webSearch ?? {}),
      })
      .where(eq(burrows.id, b.id));
    // This Whombat's home network list is the person's: added to the restorer's (never removed) after the batch.
    for (const n of r.homeNetworks)
      if (!haveCidrs.has(n.cidr))
        run.followUps.homeNetworks.push({ cidr: n.cidr, ports: n.ports, note: n.note });
  });
  return 'detail';
}

/** The burrow's columns for a restored model on the network: its key sealed for this burrow, its test forgotten. */
function restoredLocalModel(run: RestoreRun, m: NonNullable<BackupSettingsRecord['localModel']>) {
  return {
    localModel: {
      baseUrl: m.baseUrl,
      model: m.model,
      label: m.label,
      check: null,
      updatedAt: run.dry ? new Date(0).toISOString() : run.ctx.at,
    },
    localModelKeyEnc: m.secret ? sealLocalModelKey(run.services.custody, run.burrow.id, m.secret) : null,
  };
}

/** The burrow's columns for restored web search: its key sealed for this burrow, its check forgotten. */
function restoredWebSearch(run: RestoreRun, w: NonNullable<BackupSettingsRecord['webSearch']>) {
  return {
    webSearch: {
      provider: w.provider,
      check: null,
      updatedAt: run.dry ? new Date(0).toISOString() : run.ctx.at,
    },
    webSearchKeyEnc: sealWebSearchKey(run.services.custody, run.burrow.id, w.secret),
  };
}

async function repo(run: RestoreRun, r: BackupRepoRecord): Promise<RecordOutcome> {
  const here = await run.resolve(r.id);
  if (here && !run.isStandIn(here)) {
    const [row] = await run.db.select().from(repos).where(eq(repos.id, here));
    if (!row) return 'detail';
    if (row.enabled === r.enabled && (row.description ?? '') === r.description) return 'detail';
    await run.different(async () => {
      await run.tx
        .update(repos)
        .set({ enabled: r.enabled, description: r.description })
        .where(eq(repos.id, here));
    });
    return 'detail';
  }
  // A local repository comes back with its history (Repositories); a GitHub one only where GitHub is connected.
  if (r.source !== 'github' || run.dry) return 'detail';
  const [github] = await run.db
    .select({ burrowId: githubConnections.burrowId })
    .from(githubConnections)
    .where(eq(githubConnections.burrowId, run.burrow.id));
  if (!github) return 'detail';
  const id = newId('repo');
  const [{ max } = { max: -1 }] = await run.tx
    .select({ max: sql<number>`coalesce(max(${repos.position}), -1)::int` })
    .from(repos)
    .where(eq(repos.burrowId, run.burrow.id));
  await run.tx.insert(repos).values({
    id,
    burrowId: run.burrow.id,
    fullName: r.fullName,
    description: r.description,
    defaultBranch: r.defaultBranch,
    enabled: r.enabled,
    position: max + 1,
    source: 'github',
  });
  run.remember(r.id, id, 'repo');
  return 'detail';
}

/**
 * A Dashboard widget (BF-20, BF-S17) for the person restoring: on Home or the page of the thing it was
 * on, reading the same connection (the one here) or server. Its source and series are checked as a pinned widget's;
 * one that points at a connection that isn't here stays out. The restore map makes a second restore add nothing.
 */
export async function restoreWidget(run: RestoreRun, r: BackupSettingsLine): Promise<void> {
  if (r.type === 'widget') await widget(run, r);
}

async function widget(run: RestoreRun, r: BackupWidgetRecord): Promise<RecordOutcome> {
  if (run.mapped(r.id)) return 'detail';
  const restorer = run.restorer.id;
  const parsedSource = WidgetSource.safeParse(r.source);
  const series = z.array(WidgetSeries).min(1).max(3).safeParse(r.series);
  if (!parsedSource.success || !series.success) {
    run.note('unreadable', 'settings');
    return 'detail';
  }
  let source = parsedSource.data;
  if (source.kind === 'connection_tool') {
    const here = await run.resolve(source.connectionId);
    if (!here || run.isStandIn(here)) {
      run.note('missing_reference', 'settings');
      return 'detail';
    }
    source = { ...source, connectionId: here };
  }
  let thing = r.thing;
  const onConnection = /^(connection|device):(.+)$/.exec(r.thing ?? '');
  if (onConnection) {
    const here = await run.resolve(onConnection[2]);
    thing = here && !run.isStandIn(here) ? `${onConnection[1]}:${here}` : null;
  }
  if (run.dry) return 'detail';
  const [same] = await run.tx
    .select({ id: widgets.id })
    .from(widgets)
    .where(
      and(
        eq(widgets.burrowId, run.burrow.id),
        eq(widgets.ownerId, restorer),
        eq(widgets.title, r.title),
        thing ? eq(widgets.thingId, thing) : isNull(widgets.thingId),
      ),
    );
  if (same) {
    run.remember(r.id, same.id, 'widget');
    return 'detail';
  }
  const from = r.fromConversation ? await run.resolve(r.fromConversation) : null;
  const id = newId('widget');
  await run.tx.insert(widgets).values({
    id,
    burrowId: run.burrow.id,
    ownerId: restorer,
    agentId: null,
    title: r.title,
    subtitle: r.subtitle,
    kind: 'line',
    source,
    series: series.data,
    refreshSec: r.refreshSec,
    position: r.position,
    fromConversationId: from && !run.isStandIn(from) ? from : null,
    thingId: thing,
    createdAt: new Date(r.createdAt),
  });
  run.remember(r.id, id, 'widget');
  return 'detail';
}

const isDefaultPreferences = (p: Record<string, unknown>) =>
  Object.keys(p).every((k) => k === 'theme' || k === 'timeZone') &&
  (p.theme ?? 'system') === 'system' &&
  (p.timeZone ?? null) === null;

/**
 * The person's preferences and photo (BF-20, BF-S18), back to the person restoring. What nobody chose here — preferences as a
 * new account has them, no photo — takes the file's; what someone chose follows keep/replace. The photo goes on the
 * account and on its person in this burrow, as setting one does.
 */
async function accountProfile(run: RestoreRun, r: BackupAccountProfileRecord): Promise<RecordOutcome> {
  if (!run.restorer.accountId) return 'detail';
  const [account] = await run.db.select().from(accounts).where(eq(accounts.id, run.restorer.accountId));
  if (!account) return 'detail';
  const prefs = r.preferences ? Preferences.safeParse(r.preferences) : null;
  const wantedPrefs = prefs?.success ? prefs.data : null;
  const prefsDiffer = !!wantedPrefs && canonicalJson(account.preferences) !== canonicalJson(wantedPrefs);
  const photo =
    r.photo?.width &&
    r.photo.height &&
    r.photo.size <= AVATAR_MAX_BYTES &&
    (AVATAR_TYPES as readonly string[]).includes(r.photo.contentType)
      ? r.photo
      : null;
  const photoDiffers = !!photo && account.avatar?.sha256 !== photo.sha256;
  if ((!prefsDiffer && !photoDiffers) || run.dry) return 'detail';
  const setPrefs = async () => {
    if (wantedPrefs)
      await run.tx.update(accounts).set({ preferences: wantedPrefs }).where(eq(accounts.id, account.id));
  };
  const setPhoto = async () => {
    const path = photo ? run.blobPath(photo.sha256) : null;
    if (!photo || !path) return;
    await storeBlob(run, photo.sha256, photo.size, path);
    const avatar: AccountAvatar = {
      sha256: photo.sha256,
      contentType: photo.contentType,
      size: photo.size,
      width: photo.width as number,
      height: photo.height as number,
    };
    await run.tx.update(accounts).set({ avatar }).where(eq(accounts.id, account.id));
    const changed = await replaceAvatar(run.ctx, run.restorer, avatar);
    const updated = changed ? await loadPrincipalRow(run.tx, run.restorer.id) : null;
    if (updated)
      run.ctx.publish(topics.burrow(run.burrow.id), { type: 'person.updated', person: toPerson(updated) });
  };
  const prefsChosen = prefsDiffer && !isDefaultPreferences(account.preferences as Record<string, unknown>);
  const photoChosen = photoDiffers && !!account.avatar;
  if (prefsDiffer && !prefsChosen) await setPrefs();
  if (photoDiffers && !photoChosen) await setPhoto();
  if (prefsChosen || photoChosen)
    await run.different(async () => {
      if (prefsChosen) await setPrefs();
      if (photoChosen) await setPhoto();
    });
  return 'detail';
}
