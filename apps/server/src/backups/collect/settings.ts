/**
 * Settings (`settings.jsonl`, BF-05; one-person.md OP-S75): the burrow's settings (its backup defaults and this
 * Whombat's home network list among them) and the connected repositories' settings; since 0.117 the person's Dashboard
 * widgets, preferences and photo (the photo's bytes as a blob, whatever else the file holds).
 */
import type { BackupSettingsLine } from '@whombat/core';
import { and, asc, eq } from 'drizzle-orm';
import { accounts, repos, vaultNetworks, widgets } from '../../db/schema/index';
import { blobKey } from '../../files/store';
import { iso } from '../../lib/time';
import { localModelKeyOf } from '../../local-model/store';
import { webSearchKeyOf } from '../../web-search/store';
import type { CategoryOut, CollectScope } from './scope';

const rec = (v: BackupSettingsLine) => v as BackupSettingsLine & { type: string } & Record<string, unknown>;

/** Web search with its key, unsealed like every secret in the file; left out when the key doesn't open. */
function webSearchOf(scope: CollectScope) {
  const { burrow } = scope;
  const secret = burrow.webSearch ? webSearchKeyOf(scope.services.custody, burrow) : null;
  return burrow.webSearch && secret ? { provider: burrow.webSearch.provider, secret } : null;
}

export async function collectSettings(scope: CollectScope, out: CategoryOut): Promise<void> {
  const { db, burrow } = scope;
  const networks = await db.select().from(vaultNetworks).orderBy(asc(vaultNetworks.addedAt));
  const gateway = burrow.aiGateway as { connectionId?: string; claude?: boolean; codex?: boolean } | null;
  if (gateway?.connectionId) out.ref(gateway.connectionId);
  await out.record(
    rec({
      type: 'settings',
      name: burrow.name.slice(0, 200),
      slug: burrow.slug.slice(0, 200),
      timeZone: burrow.timeZone || 'UTC',
      linkPreviews: burrow.linkPreviews ?? true,
      agentsReachLan: burrow.agentsReachLan ?? true,
      aiGateway: gateway?.connectionId
        ? { connection: gateway.connectionId, claude: !!gateway.claude, codex: !!gateway.codex }
        : null,
      // The model on the person's network with its key, unsealed like every secret in the file (CT-1177); a key that
      // doesn't open (another master key) is left out.
      localModel: burrow.localModel
        ? {
            baseUrl: burrow.localModel.baseUrl,
            model: burrow.localModel.model,
            label: burrow.localModel.label,
            secret: localModelKeyOf(scope.services.custody, burrow),
          }
        : null,
      webSearch: webSearchOf(scope),
      backupDefaults: burrow.backupDefaults ?? null,
      homeNetworks: networks.slice(0, 32).map((n) => ({
        cidr: n.cidr,
        ports: n.ports.slice(0, 16),
        note: (n.note ?? '').slice(0, 200),
      })),
    }),
  );

  // The person's Dashboard widgets (BF-20, BF-S17).
  const own = await db
    .select()
    .from(widgets)
    .where(and(eq(widgets.burrowId, burrow.id), eq(widgets.ownerId, scope.maker.id)))
    .orderBy(asc(widgets.position), asc(widgets.createdAt));
  for (const w of own) {
    const thingConnection = /^(connection|device):(con_[A-Za-z0-9_-]{1,64})$/.exec(w.thingId ?? '')?.[2];
    const sourceConnection = w.source.kind === 'connection_tool' ? w.source.connectionId : null;
    const from =
      w.fromConversationId && scope.readable.has(w.fromConversationId) ? w.fromConversationId : null;
    out.ref(thingConnection, sourceConnection, from);
    await out.record(
      rec({
        type: 'widget',
        id: w.id,
        thing: w.thingId ?? null,
        title: w.title.slice(0, 80),
        subtitle: w.subtitle ? w.subtitle.slice(0, 120) : null,
        kind: w.kind,
        source: w.source as unknown as Record<string, never>,
        series: w.series as unknown as Record<string, never>[],
        refreshSec: w.refreshSec,
        position: w.position,
        fromConversation: from,
        createdAt: iso(w.createdAt),
      }),
    );
  }

  // The maker's own preferences and photo (BF-20, BF-S18): their account's, restored only to them.
  const [account] = scope.maker.accountId
    ? await db
        .select({ preferences: accounts.preferences, avatar: accounts.avatar })
        .from(accounts)
        .where(eq(accounts.id, scope.maker.accountId))
    : [];
  if (account) {
    const photo = account.avatar;
    if (photo) {
      const key = blobKey(photo.sha256);
      out.blob({
        sha256: photo.sha256,
        size: photo.size,
        open: async () => {
          const s = await scope.source.openBlob(key);
          if (!s) throw new Error('a photo’s bytes are missing from the file store');
          return s;
        },
      });
    }
    await out.record(
      rec({
        type: 'account_profile',
        preferences: account.preferences as unknown as Record<string, never>,
        photo: photo
          ? {
              sha256: photo.sha256,
              size: photo.size,
              contentType: photo.contentType,
              width: photo.width || null,
              height: photo.height || null,
            }
          : null,
      }),
    );
  }

  const repoRows = await db
    .select()
    .from(repos)
    .where(eq(repos.burrowId, burrow.id))
    .orderBy(asc(repos.position), asc(repos.fullName));
  for (const r of repoRows) {
    out.ref(r.id);
    await out.record(
      rec({
        type: 'repo',
        id: r.id,
        fullName: r.fullName,
        source: r.source,
        enabled: r.enabled,
        defaultBranch: r.defaultBranch || 'main',
        description: (r.description ?? '').slice(0, 1000),
        position: r.position,
      }),
    );
  }
}
