/**
 * A delegation task's picture link on the box's direct listener (docs/decisions/delegate.md DLG-27, as the council's
 * builder's was, council.md CNL-31, CNL-32): the task, a coding agent on the person's computer, POSTs each before and
 * after screenshot to `/shots/<token>/shot` and its notes to `/shots/<token>/notes`. Only this path takes a POST on the
 * direct listener, and only with the token of a task of a live delegation (its hash kept, for at most 48 hours). A shot
 * is kept as an attachment of the delegation's conversation (the agent's, as its upload); once a screen has both,
 * Whombat finds what changed and draws the one picture the card shows, and answers with the numbered areas so the task
 * can write a note for each.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ARTIFACT_MAX_BYTES } from '@whombat/core';
import { and, eq, gt } from 'drizzle-orm';
import { hashToken } from '../council/run';
import { ShotJobError, shotRunnerFor } from '../council/shots-pool';
import {
  attachments,
  type DelegationRow,
  type DelegationTaskRow,
  delegationShots,
  delegations,
  delegationTasks,
} from '../db/schema/index';
import { publishArtifact } from '../files/commands';
import { sniffBuffer } from '../files/sniff';
import { makeThumbnail } from '../files/thumbnails';
import type { Services } from '../services';
import { delegationCompare, delegationNotes, delegationShot } from './shots';

/** The largest shot the link takes. */
const SHOT_MAX_BYTES = ARTIFACT_MAX_BYTES;
const NOTES_MAX_BYTES = 32 * 1024;
/** Requests one link takes per hour (12 screens, two shots and notes each, sent again a few times). */
const PER_HOUR = 200;

const PATH = /^\/shots\/([A-Za-z0-9_-]{20,100})\/(shot|notes)$/;

const recent = new Map<string, number[]>();

function tooOften(hash: string, now: number): boolean {
  const times = (recent.get(hash) ?? []).filter((t) => now - t < 3_600_000);
  times.push(now);
  recent.set(hash, times);
  if (recent.size > 500) recent.delete(recent.keys().next().value as string);
  return times.length > PER_HOUR;
}

function answer(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': String(Buffer.byteLength(text)),
  });
  res.end(text);
}

const fail = (res: ServerResponse, status: number, error: string) => answer(res, status, { error });

/** The request's body, at most `max` bytes (null: larger). */
function bodyOf(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 'NaN');
    if (Number.isFinite(declared) && declared > max) {
      req.resume();
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** A task and its delegation a link's token belongs to: the delegation at work, and its link not ended. */
interface Owner {
  task: DelegationTaskRow;
  d: DelegationRow;
}

async function taskOfToken(services: Services, token: string): Promise<Owner | null> {
  const [row] = await services.db
    .select({ task: delegationTasks, d: delegations })
    .from(delegationTasks)
    .innerJoin(delegations, eq(delegations.id, delegationTasks.delegationId))
    .where(
      and(
        eq(delegationTasks.uploadHash, hashToken(token)),
        eq(delegations.stage, 'working'),
        gt(delegationTasks.uploadUntil, services.clock()),
      ),
    )
    .limit(1);
  return row ?? null;
}

const opts = ({ d }: Owner) => ({ burrowId: d.burrowId, actorId: d.agentId });

/** Keeps bytes as an attachment of the delegation's conversation, the agent's own upload (not on a message yet). */
async function keep(
  services: Services,
  owner: Owner,
  name: string,
  bytes: Buffer,
  type: 'image/png' | 'image/jpeg',
): Promise<string> {
  const files = services.files;
  const sniffed = sniffBuffer(bytes, name);
  if (!sniffed.ok) throw new ShotProblem('That isn’t a picture Whombat can read.');
  const staged = await files.store.stage([bytes], { maxBytes: Math.min(SHOT_MAX_BYTES, files.maxBytes) });
  try {
    const res = await services.pipeline.commit(
      publishArtifact,
      {
        conversationId: owner.d.conversationId,
        name,
        declaredType: type,
        staged: { token: staged.token, size: staged.size, sha256: staged.sha256 },
        sniffed: sniffed.value,
      },
      opts(owner),
    );
    if (res.status !== 'ok') throw new ShotProblem('Whombat couldn’t keep the picture.');
    await makeThumbnail(services, res.result).catch(() => null);
    return res.result.id;
  } catch (err) {
    await files.store.discard(staged).catch(() => {});
    throw err;
  }
}

class ShotProblem extends Error {}

/** The bytes of a kept attachment. */
async function bytesOf(services: Services, attachmentId: string): Promise<Buffer | null> {
  const [row] = await services.db
    .select({ blobKey: attachments.blobKey })
    .from(attachments)
    .where(eq(attachments.id, attachmentId));
  if (!row?.blobKey) return null;
  const stream = await services.files.store.open(row.blobKey);
  if (!stream) return null;
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

const typeOf = (bytes: Buffer): 'image/png' | 'image/jpeg' | null =>
  bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ? 'image/png'
    : bytes[0] === 0xff && bytes[1] === 0xd8
      ? 'image/jpeg'
      : null;

async function shot(services: Services, owner: Owner, url: URL, req: IncomingMessage, res: ServerResponse) {
  const view = (url.searchParams.get('view') ?? '').trim().replace(/\s+/g, ' ');
  const when = url.searchParams.get('when');
  if (!view || view.length > 80)
    return fail(res, 400, 'Name the screen in a few words (view=…, at most 80 characters).');
  if (when !== 'before' && when !== 'after') return fail(res, 400, 'Say when=before or when=after.');
  const bytes = await bodyOf(req, SHOT_MAX_BYTES);
  if (!bytes) return fail(res, 413, 'A picture is at most 10 MB.');
  const type = typeOf(bytes);
  if (!type) return fail(res, 415, 'Send a PNG or JPEG picture as the body.');
  const shots = shotRunnerFor(services, (why, err) =>
    services.log.warn({ err: err instanceof Error ? err.message : String(err) }, `shots: ${why}`),
  );
  // Read in the picture worker first: a picture Whombat can't read is never kept.
  try {
    await shots.check(bytes, type);
  } catch (err) {
    return shotRefused(res, err);
  }
  const name = `${view} · ${when}.${type === 'image/png' ? 'png' : 'jpg'}`;
  const attachmentId = await keep(services, owner, name, bytes, type);
  const kept = await services.pipeline.commit(
    delegationShot,
    { taskId: owner.task.id, view, when, attachmentId },
    opts(owner),
  );
  if (kept.status !== 'ok') return fail(res, 409, 'The picture wasn’t kept.');
  const { beforeId, afterId } = kept.result;
  if (!beforeId || !afterId) return answer(res, 200, { view, kept: when, areas: [] });
  const other = await bytesOf(services, when === 'before' ? afterId : beforeId);
  const otherType = other ? typeOf(other) : null;
  if (!other || !otherType) return answer(res, 200, { view, kept: when, areas: [] });
  const mine = { bytes, type };
  const theirs = { bytes: other, type: otherType };
  let drawn: Awaited<ReturnType<typeof shots.compare>>;
  try {
    drawn = await shots.compare(when === 'before' ? mine : theirs, when === 'after' ? mine : theirs);
  } catch (err) {
    return shotRefused(res, err);
  }
  const compareId = await keep(services, owner, `${view}.png`, drawn.png, 'image/png');
  const compared = await services.pipeline.commit(
    delegationCompare,
    {
      taskId: owner.task.id,
      view,
      compareId,
      beforeId,
      afterId,
      width: drawn.width,
      height: drawn.height,
      areas: drawn.areas.map((a) => ({
        n: a.n,
        x: Math.round(a.x),
        y: Math.round(a.y),
        w: Math.max(1, Math.round(a.w)),
        h: Math.max(1, Math.round(a.h)),
        where: a.where,
      })),
    },
    opts(owner),
  );
  // A newer picture of this screen came in meanwhile: its own answer is the one that counts.
  if (compared.status === 'ok' && compared.result.stale)
    return answer(res, 200, { view, kept: when, areas: [], next: 'A newer picture of this screen came in.' });
  return answer(res, 200, {
    view,
    kept: when,
    areas: drawn.areas.map((a) => ({ n: a.n, where: a.where })),
    next: drawn.areas.length
      ? 'Send one plain-words note per number to …/notes.'
      : 'Nothing changed that Whombat can see on this screen.',
  });
}

/** A picture the worker refused (its words), Whombat too busy, or a failure of Whombat's. */
function shotRefused(res: ServerResponse, err: unknown): void {
  if (err instanceof ShotJobError && err.kind === 'busy') fail(res, 503, err.message);
  else if (err instanceof ShotJobError && err.kind === 'refused') fail(res, 400, err.message);
  else fail(res, 500, 'Whombat couldn’t compare that picture.');
}

async function notes(services: Services, owner: Owner, req: IncomingMessage, res: ServerResponse) {
  const bytes = await bodyOf(req, NOTES_MAX_BYTES);
  if (!bytes) return fail(res, 413, 'Notes are at most 32 KB.');
  let body: unknown;
  try {
    body = JSON.parse(bytes.toString('utf8'));
  } catch {
    return fail(res, 400, 'Send JSON: {"view": "…", "notes": {"1": "…"}}.');
  }
  const b = (body ?? {}) as { view?: unknown; notes?: unknown };
  const view = typeof b.view === 'string' ? b.view.trim().replace(/\s+/g, ' ') : '';
  if (!view || view.length > 80 || !b.notes || typeof b.notes !== 'object')
    return fail(res, 400, 'Send JSON: {"view": "…", "notes": {"1": "…"}}.');
  const list = Object.entries(b.notes as Record<string, unknown>).flatMap(([k, v]) => {
    const n = Number(k);
    const text = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, 300) : '';
    return Number.isInteger(n) && n >= 1 && n <= 9 && text ? [{ n, text }] : [];
  });
  const [screen] = await services.db
    .select({ view: delegationShots.view })
    .from(delegationShots)
    .where(and(eq(delegationShots.taskId, owner.task.id), eq(delegationShots.view, view)));
  if (!screen) return fail(res, 404, 'Send that screen’s pictures first.');
  const kept = await services.pipeline.commit(
    delegationNotes,
    { taskId: owner.task.id, view, notes: list },
    opts(owner),
  );
  return answer(res, 200, { view, kept: kept.status === 'ok' ? kept.result.kept : 0 });
}

/**
 * Answers a POST on the direct listener when it is for a task's picture link; false for any other path (the listener
 * then refuses it as before).
 */
export function shotUploads(services: Services) {
  return (req: IncomingMessage, res: ServerResponse, path: string): boolean => {
    const m = PATH.exec(path);
    if (!m || req.method !== 'POST') return false;
    // A browser page never sends here: refuse one that says where it is from.
    if (req.headers.origin) {
      fail(res, 403, 'Not from a page.');
      return true;
    }
    const [, token, what] = m as unknown as [string, string, 'shot' | 'notes'];
    void (async () => {
      const owner = await taskOfToken(services, token);
      if (!owner)
        return fail(res, 404, 'This link doesn’t work (its list ended, or it is not this Whombat’s).');
      if (tooOften(owner.task.uploadHash ?? token, services.clock().getTime()))
        return fail(res, 429, 'Too many pictures for now: wait a little.');
      const url = new URL(req.url ?? '/', 'http://box.invalid');
      if (what === 'shot') return shot(services, owner, url, req, res);
      return notes(services, owner, req, res);
    })().catch((err: unknown) => {
      if (err instanceof ShotProblem) return fail(res, 400, err.message);
      services.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'shots: a picture failed');
      if (!res.headersSent) fail(res, 500, 'Whombat couldn’t take that picture.');
    });
    return true;
  };
}
