/**
 * A repository's own icon for the Chat list (docs/decisions/chat-inbox.md): Whombat looks in the repository's default
 * branch for the picture the project itself carries (its home-screen icon, its app icon, its favicon) and keeps it as a
 * picture attachment of the burrow, which the apps load like any image attachment.
 *
 * - One read of the branch's file list and at most one download per look; a look at most about once a day per
 *   repository, also when nothing was found. A look that failed (no connection, a rate limit, a timeout) writes nothing
 *   and is tried again after a while.
 * - Only PNG, JPEG or WebP, by their bytes, and at most `REPO_ICON_MAX_BYTES`: the phones draw those without help.
 * - Never in the way of a read: `chats.threads` answers with what is kept and asks for a look in the background.
 */
import { attachmentUrl, newId } from '@whombat/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import { attachments, repoIcons, repos } from '../db/schema/index';
import { lockBlob } from '../files/service';
import { sniffBuffer } from '../files/sniff';
import { blobKey, type StagedFile } from '../files/store';
import { forbidden } from '../lib/errors';
import { githubScope } from '../managed/providers/github-adapter';
import { loadAgentRow } from '../read/principals';
import type { Services } from '../services';
import { type GhTreeFile, GitHubError } from './adapter';

/** The largest icon kept. */
export const REPO_ICON_MAX_BYTES = 256 * 1024;
/** How long what a look found (or didn't) is kept before GitHub is asked again. */
export const REPO_ICON_KEEP_MS = 24 * 60 * 60_000;
/** After a look that failed, how long before the same repository is tried again. */
export const REPO_ICON_RETRY_MS = 30 * 60_000;
/** How long one call to GitHub may take. */
export const REPO_ICON_TIMEOUT_MS = 10_000;
/** Repositories waiting for a look at most; more are left for a later read. */
const QUEUE_MAX = 50;

/** The picture types kept. */
export const REPO_ICON_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type RepoIconType = (typeof REPO_ICON_TYPES)[number];

/** File names that are a project's icon, best first: home-screen icons, then app icons and logos, then a favicon. */
const NAME_RANKS: readonly RegExp[] = [
  /^apple-touch-icon(?:[-.][\w.-]*)?\.png$/,
  /^(?:android-chrome|icon)-(?:192|512)(?:x(?:192|512))?\.png$/,
  /^(?:app-icon[\w.-]*|icon|logo)\.(?:png|webp|jpe?g)$/,
  /^favicon(?:-\d+(?:x\d+)?)?\.png$/,
];

/** Folders whose pictures are someone else's or made by a build, never the project's own icon. */
const SKIPPED_FOLDERS = new Set([
  'node_modules',
  'vendor',
  'third_party',
  'third-party',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  'pods',
  'fixtures',
  '__fixtures__',
  'test',
  'tests',
  '__tests__',
  'examples',
]);

/** How good a name the file has (0 best), or null when it is no icon. */
function nameRank(path: string): number | null {
  const parts = path.toLowerCase().split('/');
  if (parts.slice(0, -1).some((p) => SKIPPED_FOLDERS.has(p))) return null;
  const name = parts.at(-1) ?? '';
  const rank = NAME_RANKS.findIndex((re) => re.test(name));
  return rank < 0 ? null : rank;
}

/**
 * The files of a branch that could be the project's icon, best first: by name, then the shorter path (fewer folders,
 * then fewer characters), so `web/public/apple-touch-icon.png` wins over `marketing/public/…`. Larger than the limit:
 * left out.
 */
export function iconCandidates(files: readonly GhTreeFile[]): GhTreeFile[] {
  return files
    .flatMap((f) => {
      const rank = nameRank(f.path);
      return rank === null || f.size > REPO_ICON_MAX_BYTES ? [] : [{ f, rank }];
    })
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.f.path.split('/').length - b.f.path.split('/').length ||
        a.f.path.length - b.f.path.length ||
        (a.f.path < b.f.path ? -1 : 1),
    )
    .map((c) => c.f);
}

/** The picture when the bytes are a PNG, JPEG or WebP within the limit (never by its name), else null. */
export function iconImage(
  bytes: Uint8Array,
): { contentType: RepoIconType; width: number | null; height: number | null } | null {
  if (!bytes.byteLength || bytes.byteLength > REPO_ICON_MAX_BYTES) return null;
  // Sniffed under a name without an extension, so text (an SVG) never passes as anything.
  const sniffed = sniffBuffer(Buffer.from(bytes), 'icon');
  if (!sniffed.ok || sniffed.value.kind !== 'image') return null;
  const type = REPO_ICON_TYPES.find((t) => t === sniffed.value.contentType);
  return type ? { contentType: type, width: sniffed.value.width, height: sniffed.value.height } : null;
}

/** The key a repository is kept under: its `owner/name` in lowercase. */
export const repoIconKey = (fullName: string) => fullName.toLowerCase();

/** What is kept of each repository's icon: its URL (null: none), and whether it is time to look again. */
export async function storedRepoIcons(
  db: Db,
  burrowId: string,
  fullNames: readonly string[],
): Promise<Map<string, { iconUrl: string | null; due: boolean }>> {
  const out = new Map<string, { iconUrl: string | null; due: boolean }>();
  const keys = [...new Set(fullNames.map(repoIconKey))];
  if (!keys.length) return out;
  const rows = await db
    .select({
      repo: repoIcons.repo,
      attachmentId: repoIcons.attachmentId,
      url: attachments.url,
      due: sql<boolean>`${repoIcons.nextCheckAt} <= now()`,
    })
    .from(repoIcons)
    .leftJoin(attachments, and(eq(attachments.id, repoIcons.attachmentId), eq(attachments.state, 'ready')))
    .where(and(eq(repoIcons.burrowId, burrowId), inArray(repoIcons.repo, keys)));
  for (const r of rows)
    out.set(r.repo, {
      iconUrl: r.url ?? null,
      // A kept picture whose row is gone (an older release's sweep took it) is looked for again.
      due: r.due || (r.attachmentId !== null && !r.url),
    });
  for (const key of keys) if (!out.has(key)) out.set(key, { iconUrl: null, due: true });
  return out;
}

/** What a look found: a new picture (its bytes staged), the same one as before, or none. */
const Found = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('new'),
    path: z.string().min(1).max(1000),
    blobSha: z.string().min(1).max(64),
    contentType: z.enum(REPO_ICON_TYPES),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    staged: z.object({
      token: z.string().min(1),
      size: z.number().int().nonnegative(),
      sha256: z.string().min(1),
    }),
  }),
  z.object({ kind: z.literal('same') }),
  z.object({ kind: z.literal('none') }),
]);

/**
 * Keeps what a look at a repository found: the picture's bytes as a blob and a ready image attachment without a
 * conversation (as a person's photo is), the previous picture's row removed, and when to look again. Only the burrow's
 * agent writes it; nothing is signed or published, the next read of the list carries it.
 */
export const recordRepoIcon = defineCommand({
  name: 'github.repo_icon',
  schema: z.object({ repo: z.string().min(3).max(255), found: Found }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent keeps repository icons.');
    const repo = repoIconKey(input.repo);
    const [kept] = await tx
      .select()
      .from(repoIcons)
      .where(and(eq(repoIcons.burrowId, ctx.burrow.id), eq(repoIcons.repo, repo)))
      .for('update');
    let attachmentId = kept?.attachmentId ?? null;
    let path = kept?.path ?? null;
    let sha = kept?.blobSha ?? null;
    const found = input.found;
    if (found.kind === 'new') {
      const key = blobKey(found.staged.sha256);
      await lockBlob(tx, key);
      await ctx.services.files.store.commit(found.staged as StagedFile, key);
      const id = newId('attachment');
      await tx.insert(attachments).values({
        id,
        burrowId: ctx.burrow.id,
        conversationId: null,
        name: `icon.${found.contentType === 'image/jpeg' ? 'jpg' : found.contentType.slice(6)}`,
        declaredType: found.contentType,
        contentType: found.contentType,
        kind: 'image',
        size: found.staged.size,
        sha256: found.staged.sha256,
        blobKey: key,
        width: found.width,
        height: found.height,
        state: 'ready',
        url: attachmentUrl(ctx.burrow.slug, id),
        uploadedById: ctx.actor.id,
        messageId: null,
        createdAt: ctx.now,
        uploadedAt: ctx.now,
      });
      attachmentId = id;
      path = found.path;
      sha = found.blobSha;
    } else if (found.kind === 'none') {
      attachmentId = null;
      path = null;
      sha = null;
    }
    const values = {
      attachmentId,
      path,
      blobSha: sha,
      checkedAt: ctx.now,
      nextCheckAt: new Date(ctx.now.getTime() + REPO_ICON_KEEP_MS),
    };
    await tx
      .insert(repoIcons)
      .values({ burrowId: ctx.burrow.id, repo, ...values })
      .onConflictDoUpdate({ target: [repoIcons.burrowId, repoIcons.repo], set: values });
    const previous = kept?.attachmentId;
    if (previous && previous !== attachmentId) {
      const [gone] = await tx
        .delete(attachments)
        .where(and(eq(attachments.id, previous), eq(attachments.burrowId, ctx.burrow.id)))
        .returning({ blobKey: attachments.blobKey });
      const files = ctx.services.files;
      if (gone?.blobKey) {
        const key = gone.blobKey;
        ctx.after(async () => {
          await files.removeIfUnused(key);
        });
      }
    }
    return { repo, attachmentId };
  },
});

/** A call to GitHub that gives up after `ms`. */
function timed<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new GitHubError('GitHub took too long to answer.')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Looks for repositories' icons in the background, one repository at a time: a repository is queued once however many
 * reads ask for it, and one tried in the last half hour waits (so a burst of reads, or a failing GitHub, asks nothing
 * more).
 */
export class RepoIcons {
  readonly #queue: { burrowId: string; repo: string }[] = [];
  readonly #queued = new Set<string>();
  readonly #tried = new Map<string, number>();
  #running: Promise<void> | null = null;

  constructor(private readonly services: Services) {}

  /** Queues a look at each repository not looked at lately; returns at once. */
  refresh(burrowId: string, fullNames: readonly string[]): void {
    if (!this.services.github?.adapter) return;
    const now = this.services.clock().getTime();
    for (const name of fullNames) {
      const key = `${burrowId}\u0000${repoIconKey(name)}`;
      const tried = this.#tried.get(key);
      if (this.#queued.has(key) || (tried !== undefined && now - tried < REPO_ICON_RETRY_MS)) continue;
      if (this.#queue.length >= QUEUE_MAX) break;
      this.#queued.add(key);
      this.#queue.push({ burrowId, repo: name });
    }
    // Forget old tries, so the map stays small.
    if (this.#tried.size > 1000)
      for (const [key, at] of this.#tried) if (now - at >= REPO_ICON_RETRY_MS) this.#tried.delete(key);
    this.#running ??= this.#drain().finally(() => {
      this.#running = null;
    });
  }

  /** Resolves once nothing is queued or being looked at (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#running) await this.#running;
  }

  async #drain(): Promise<void> {
    for (let next = this.#queue.shift(); next; next = this.#queue.shift()) {
      const key = `${next.burrowId}\u0000${repoIconKey(next.repo)}`;
      this.#tried.set(key, this.services.clock().getTime());
      try {
        await this.lookUp(next.burrowId, next.repo);
      } catch (err) {
        // Quiet: tried again after a while.
        this.services.log.info({ err: String(err), repo: next.repo }, 'repository icon not looked up');
      } finally {
        this.#queued.delete(key);
      }
    }
  }

  /** Looks at one repository now, unless what is kept is still fresh. Throws when GitHub couldn't be asked. */
  async lookUp(burrowId: string, fullName: string): Promise<void> {
    const github = this.services.github;
    const adapter = github?.adapter;
    if (!adapter) return;
    const db = this.services.db;
    const repo = repoIconKey(fullName);
    const [kept] = await db
      .select({ blobSha: repoIcons.blobSha, attachmentId: repoIcons.attachmentId, url: attachments.url })
      .from(repoIcons)
      .leftJoin(attachments, and(eq(attachments.id, repoIcons.attachmentId), eq(attachments.state, 'ready')))
      .where(
        and(
          eq(repoIcons.burrowId, burrowId),
          eq(repoIcons.repo, repo),
          sql`${repoIcons.nextCheckAt} > ${this.services.clock().toISOString()}::timestamptz`,
        ),
      );
    if (kept && !(kept.attachmentId && !kept.url)) return;
    if (!(await github.isConnected(burrowId))) return;
    const agent = await loadAgentRow(db, burrowId);
    if (!agent) return;
    const [known] = await db
      .select({ defaultBranch: repos.defaultBranch })
      .from(repos)
      .where(and(eq(repos.burrowId, burrowId), sql`lower(${repos.fullName}) = ${repo}`))
      .limit(1);
    const found = await githubScope.run({ burrowId }, async () => {
      const tree = await timed(
        adapter.branchTree(fullName, known?.defaultBranch ?? 'HEAD'),
        REPO_ICON_TIMEOUT_MS,
      );
      const best = tree ? iconCandidates(tree.files)[0] : undefined;
      if (!best) return { kind: 'none' as const };
      const [before] = await db
        .select({ blobSha: repoIcons.blobSha, url: attachments.url })
        .from(repoIcons)
        .leftJoin(
          attachments,
          and(eq(attachments.id, repoIcons.attachmentId), eq(attachments.state, 'ready')),
        )
        .where(and(eq(repoIcons.burrowId, burrowId), eq(repoIcons.repo, repo)));
      if (before?.url && before.blobSha === best.sha) return { kind: 'same' as const };
      const blob = await timed(adapter.blobAt(fullName, best.sha, REPO_ICON_MAX_BYTES), REPO_ICON_TIMEOUT_MS);
      const image = blob?.kind === 'file' ? iconImage(blob.bytes) : null;
      if (blob?.kind !== 'file' || !image) return { kind: 'none' as const };
      return { kind: 'new' as const, path: best.path, blobSha: best.sha, image, bytes: blob.bytes };
    });
    let staged: StagedFile | null = null;
    try {
      let input: z.input<typeof Found> = found.kind === 'new' ? { kind: 'none' } : found;
      if (found.kind === 'new') {
        staged = await this.services.files.store.stage([found.bytes], { maxBytes: REPO_ICON_MAX_BYTES });
        input = {
          kind: 'new',
          path: found.path.slice(0, 1000),
          blobSha: found.blobSha,
          ...found.image,
          staged: { token: staged.token, size: staged.size, sha256: staged.sha256 },
        };
      }
      await this.services.pipeline.commit(
        recordRepoIcon,
        { repo, found: input },
        { burrowId, actorId: agent.id },
      );
      staged = null;
    } finally {
      if (staged) await this.services.files.store.discard(staged).catch(() => {});
    }
  }
}
