/**
 * Making, listing and stopping links with control (docs/decisions/share-links.md): the copy is built and sealed here,
 * control keeps the sealed bytes through the manager (`share.put`), and the row says the link works once it did. A
 * Whombat without the manager's share routes (a development box, the community edition) can't share; the person is told
 * so in plain words.
 */

import { SHARE_IDS_MAX, type ShareViews } from '@whombat/control-contracts/device';
import type { SharedLink } from '@whombat/core';
import { sealSnapshot, shareFromBase64url, shareLink, shareToBase64url } from '@whombat/core/share';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { answerAfterApproval, grantedResult } from '../approvals/result';
import { approvalThread } from '../approvals/wake';
import { conversations, shares } from '../db/schema/index';
import { ApiError, notFound } from '../lib/errors';
import { iso } from '../lib/time';
import { ManagerCallError, type ManagerPort } from '../managed/ports';
import type { Services } from '../services';
import { expiryWords, shareDiscard, shareKeyAad, sharePublished, shareStop, shareStopDone } from './commands';
import { buildSnapshot, fitsAtControl, loadShareThread } from './snapshot';

export type SharePort = Required<Pick<ManagerPort, 'sharePut' | 'shareDelete' | 'shareViews'>>;

const ports = new WeakMap<Services, SharePort>();

/** The manager's share routes for this runtime (boot hands them over); none on a Whombat without control. */
export function useShares(services: Services, manager: Partial<SharePort> | null | undefined): void {
  if (manager?.sharePut && manager.shareDelete && manager.shareViews)
    ports.set(services, {
      sharePut: manager.sharePut.bind(manager),
      shareDelete: manager.shareDelete.bind(manager),
      shareViews: manager.shareViews.bind(manager),
    });
}

export function sharePortOf(services: Services): SharePort | null {
  return ports.get(services) ?? null;
}

/** The plain words for a failed call to control. */
export const SHARE_WORDS = {
  noCloud: 'Sharing needs Whombat’s servers, and this Whombat can’t use them.',
  unreachable: 'Couldn’t reach Whombat’s servers. Try again in a moment.',
  refused: 'Whombat’s servers didn’t take the link. Try again in a moment.',
  limit: 'You have 500 links that still work. Stop some in Settings first.',
  tooBig: 'This thread is too big to share with its pictures. Try it without them.',
  tooBigAlways: 'This thread is too big to share.',
  stopLater: 'Couldn’t reach Whombat’s servers. The link stops as soon as they can be reached.',
} as const;

function controlFailure(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ManagerCallError) {
    if (err.status === 404 || err.status === 501) return new ApiError('unavailable', SHARE_WORDS.noCloud);
    if (err.status === 0 || err.status === 503) return new ApiError('unavailable', SHARE_WORDS.unreachable);
    if (/share_limit/.test(err.message)) return new ApiError('conflict', SHARE_WORDS.limit);
    return new ApiError('unavailable', SHARE_WORDS.refused);
  }
  return new ApiError('unavailable', SHARE_WORDS.refused);
}

type Row = typeof shares.$inferSelect;

/** A row as the person reads it. */
export function linkView(services: Services, row: Row, now: Date, views: number | null = null): SharedLink {
  const key = shareFromBase64url(services.custody.open(shareKeyAad(row.id), row.keyEnc));
  const state = row.stoppedAt ? 'stopped' : row.expiresAt && row.expiresAt <= now ? 'expired' : 'live';
  return {
    id: row.id,
    title: row.title,
    url: row.viewerUrl && key ? shareLink(row.viewerUrl, key) : '',
    rootId: row.rootId,
    messages: row.messages,
    pictures: row.pictures,
    createdAt: iso(row.createdAt),
    expiresAt: row.expiresAt ? iso(row.expiresAt) : null,
    stoppedAt: row.stoppedAt ? iso(row.stoppedAt) : null,
    state,
    stopping: row.stopPending,
    views: state === 'live' ? views : null,
  };
}

async function loadRow(services: Services, burrowId: string, id: string): Promise<Row> {
  const [row] = await services.db.select().from(shares).where(eq(shares.id, id));
  if (!row || row.burrowId !== burrowId) throw notFound('Link');
  return row;
}

/**
 * Builds and seals the copy of a link `share_create` kept, hands it to control and records that the link works. When
 * that doesn't happen the row is dropped and the error says why in the person's words.
 */
export async function publishShare(
  services: Services,
  burrowId: string,
  id: string,
  actorId: string,
): Promise<SharedLink> {
  const row = await loadRow(services, burrowId, id);
  if (row.viewerUrl) return linkView(services, row, new Date());
  const commit = { burrowId, actorId };
  try {
    const port = sharePortOf(services);
    if (!port) throw new ApiError('unavailable', SHARE_WORDS.noCloud);
    const [conv] = await services.db
      .select({ dmPersonId: conversations.dmPersonId })
      .from(conversations)
      .where(eq(conversations.id, row.conversationId));
    if (!conv?.dmPersonId) throw notFound('Thread');
    const thread = await loadShareThread(services.db, burrowId, conv.dmPersonId, {
      rootId: row.rootId,
      ...(row.fromMessageId ? { fromMessageId: row.fromMessageId } : {}),
    });
    const now = new Date();
    const built = await buildSnapshot(thread, services.files.store, { pictures: row.pictures, now });
    if (!fitsAtControl(built.sealedBytes))
      throw new ApiError('too_large', row.pictures ? SHARE_WORDS.tooBig : SHARE_WORDS.tooBigAlways);
    const key = shareFromBase64url(services.custody.open(shareKeyAad(row.id), row.keyEnc));
    if (!key) throw new ApiError('internal', SHARE_WORDS.refused);
    const sealed = sealSnapshot(built.snapshot, row.id, key);
    const answer = await port
      .sharePut({
        shareId: row.id,
        envelope: shareToBase64url(sealed),
        ...(row.expiresAt ? { expiresAt: Math.floor(row.expiresAt.getTime() / 1000) } : {}),
      })
      .catch((err: unknown) => {
        throw controlFailure(err);
      });
    const done = await services.pipeline.commit(
      sharePublished,
      { id: row.id, viewerUrl: answer.url, messages: built.snapshot.messages.length, bytes: sealed.length },
      commit,
    );
    if (done.status !== 'ok') throw new ApiError('internal', SHARE_WORDS.refused);
    return linkView(services, await loadRow(services, burrowId, id), now);
  } catch (err) {
    await services.pipeline.commit(shareDiscard, { id: row.id }, commit).catch(() => undefined);
    throw controlFailure(err);
  }
}

/** After the person's yes to the assistant's ask: the link is made and the assistant woken with it (or why not). */
export async function publishForAssistant(
  services: Services,
  burrowId: string,
  call: { shareId: string; agentId: string; approvalId: string; conversationId: string },
): Promise<void> {
  let result: ReturnType<typeof grantedResult>;
  let fallback: string;
  try {
    const link = await publishShare(services, burrowId, call.shareId, call.agentId);
    const until = expiryWords(link.expiresAt ? new Date(link.expiresAt) : null);
    // For the assistant: the link exactly, so it gives it as it is.
    result = grantedResult('done', `The link: ${link.url}\n${until} The person can stop it in Settings.`);
    fallback = `Here’s the link: ${link.url}`;
  } catch (err) {
    const message = err instanceof ApiError ? err.message : SHARE_WORDS.refused;
    result = grantedResult('failed', message);
    fallback = `I couldn’t make the link. ${message}`;
  }
  const threadRootId = await approvalThread(services.db, call.approvalId, call.conversationId).catch(
    () => null,
  );
  await answerAfterApproval(services, {
    burrowId,
    agentId: call.agentId,
    approvalId: call.approvalId,
    postIn: call.conversationId,
    threadRootId,
    result,
    fallback,
  });
}

/** How long a list waits for control's view counts before showing the links without them. */
const VIEWS_WAIT_MS = 2_500;

/** The person's links, newest first, with how often the working ones were opened. */
export async function listShares(services: Services, burrowId: string): Promise<SharedLink[]> {
  const rows = await services.db
    .select()
    .from(shares)
    .where(and(eq(shares.burrowId, burrowId), isNotNull(shares.viewerUrl)))
    .orderBy(desc(shares.createdAt));
  const now = new Date();
  const live = rows.filter((r) => !r.stoppedAt && !(r.expiresAt && r.expiresAt <= now)).map((r) => r.id);
  const views = new Map<string, number>();
  const port = sharePortOf(services);
  if (port && live.length) {
    const ask = async () => {
      for (let i = 0; i < live.length; i += SHARE_IDS_MAX) {
        const answer = await port.shareViews({ shareIds: live.slice(i, i + SHARE_IDS_MAX) });
        for (const v of answer.shares as ShareViews[]) views.set(v.shareId, v.views);
      }
    };
    await Promise.race([
      ask().catch(() => undefined),
      new Promise((r) => setTimeout(r, VIEWS_WAIT_MS).unref()),
    ]);
  }
  return rows.map((r) => linkView(services, r, now, views.get(r.id) ?? (port ? 0 : null)));
}

/** Asks control to delete these copies, and records it for those it did. Never throws; false when control didn't. */
export async function deleteAtControl(
  services: Services,
  burrowId: string,
  actorId: string,
  ids: readonly string[],
) {
  const port = sharePortOf(services);
  if (!port || ids.length === 0) return ids.length === 0;
  try {
    for (let i = 0; i < ids.length; i += SHARE_IDS_MAX) {
      const batch = ids.slice(i, i + SHARE_IDS_MAX);
      await port.shareDelete({ shareIds: batch });
      await services.pipeline.commit(shareStopDone, { ids: batch }, { burrowId, actorId });
    }
    return true;
  } catch (err) {
    services.log.warn(
      { err: err instanceof Error ? err.name : 'error' },
      'could not stop shared links at control',
    );
    return false;
  }
}

/** Stops links of the person: marked stopped here at once, deleted at control now or by the round later. */
export async function stopShares(
  services: Services,
  burrowId: string,
  actorId: string,
  ids: readonly string[],
): Promise<{ stopped: string[]; reached: boolean }> {
  if (ids.length === 0) return { stopped: [], reached: true };
  const res = await services.pipeline.commit(
    shareStop,
    { ids: [...ids], why: 'person' },
    { burrowId, actorId },
  );
  const stopped = res.status === 'ok' ? res.result.stopped : [];
  const pending = await services.db
    .select({ id: shares.id })
    .from(shares)
    .where(and(eq(shares.burrowId, burrowId), eq(shares.stopPending, true)));
  const reached = await deleteAtControl(
    services,
    burrowId,
    actorId,
    pending.map((p) => p.id).filter((id) => ids.includes(id)),
  );
  return { stopped, reached };
}

/** The ids of the person's links that still work. */
export async function liveShareIds(services: Services, burrowId: string): Promise<string[]> {
  const now = new Date();
  const rows = await services.db
    .select({ id: shares.id, expiresAt: shares.expiresAt })
    .from(shares)
    .where(and(eq(shares.burrowId, burrowId), isNull(shares.stoppedAt), isNotNull(shares.viewerUrl)));
  return rows.filter((r) => !(r.expiresAt && r.expiresAt <= now)).map((r) => r.id);
}
