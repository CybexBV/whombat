/**
 * A pull request's file, whole (docs/decisions/pr-file-view.md PF-01…PF-08; contracts CT-241): the file view a person
 * opens from a branch room's Files changed. Two versions of the file are read — at the PR's merge base and at its
 * head — from the repo's origin on this Whombat or from GitHub, and `fileViewLines` (core) lays them out as every line
 * of the file with the removed and added lines in place. A read: nothing is written, nothing goes through the commit
 * pipeline.
 */
import { localCommitParent, localFileAt, localMergeBase } from '@whombat/agent-runtime/local-repos';
import {
  fileViewLines,
  looksBinary,
  PR_FILE_MAX_BYTES,
  PR_FILE_MAX_LINES,
  type PrFileStatus,
  type PrFileView,
} from '@whombat/core';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { prCommits, prFiles, type pullRequests, repos } from '../db/schema/index';
import { ApiError, conflict, notFound } from '../lib/errors';
import { githubScope } from '../managed/providers/github-adapter';
import type { PrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { type GhFileVersion, GitHubError, GitHubNotConnectedError } from './adapter';

type PullRequestRow = typeof pullRequests.$inferSelect;
type RepoRow = typeof repos.$inferSelect;

/** One version of a file: its bytes, or `too_large` (not read). Null is a version without the file. */
export type FileVersion = GhFileVersion;

/** Where the two versions are read: a local repo's origin or GitHub. */
export interface FileSource {
  /** The merge base of the base branch (by name) and a commit; null when there is none. */
  mergeBase(baseBranch: string, head: string): Promise<string | null>;
  /** A commit's first parent; null for a root commit. */
  commitParent(sha: string): Promise<string | null>;
  /** The file at `path` in commit `sha`, null when that version has none. */
  fileAt(sha: string, path: string): Promise<FileVersion | null>;
}

/**
 * The commit the base version is read at (PF-02): the merge base of the PR's base branch and its head, as Files
 * changed counts the PR (`base...head`). Once the head is in the base branch — merged with a merge commit, or fast-
 * forwarded — that merge base is the head itself and would show no change, so it is the parent of the PR's first
 * recorded commit instead: the commit the branch started from. When that can't be read either, the merge base stands;
 * null only when the base branch and the head share no history (every file then reads as added).
 */
export async function prBaseSha(
  source: FileSource,
  pr: { baseBranch: string; headSha: string },
  firstCommit: string | null,
): Promise<string | null> {
  const base = await source.mergeBase(pr.baseBranch, pr.headSha);
  if (base && base !== pr.headSha) return base;
  const parent = firstCommit ? await source.commitParent(firstCommit) : null;
  return parent ?? base;
}

/** The view of two versions (PF-05): binary, too large or every line. Pure. */
export function buildFileView(p: {
  path: string;
  baseSha: string | null;
  headSha: string;
  base: FileVersion | null;
  head: FileVersion | null;
}): PrFileView {
  const status: PrFileStatus = p.base === null ? 'added' : p.head === null ? 'deleted' : 'modified';
  const view = (shown: PrFileView['shown'], lines: PrFileView['lines'] = []): PrFileView => ({
    path: p.path,
    status,
    shown,
    add: lines.filter((l) => l.kind === 'add').length,
    del: lines.filter((l) => l.kind === 'del').length,
    lines,
    baseSha: p.baseSha,
    headSha: p.headSha,
  });
  const versions = [p.base, p.head].filter((v): v is FileVersion => v !== null);
  if (versions.some((v) => v.kind === 'too_large' || v.bytes.byteLength > PR_FILE_MAX_BYTES))
    return view('too_large');
  const bytes = versions.map((v) => (v.kind === 'file' ? v.bytes : new Uint8Array()));
  if (bytes.some(looksBinary)) return view('binary');
  const text = (v: FileVersion | null) =>
    v?.kind === 'file' ? new TextDecoder('utf-8').decode(v.bytes) : null;
  const lines = fileViewLines(text(p.base), text(p.head));
  if (lines.length > PR_FILE_MAX_LINES) return view('too_large');
  return view('text', lines);
}

/** The origin of a local repo, as a file source. */
function localSource(repo: RepoRow): FileSource {
  const origin = repo.originPath;
  if (!origin) throw conflict(`${repo.fullName} has no copy on this Whombat.`);
  return {
    mergeBase: (baseBranch, head) => localMergeBase(origin, `refs/heads/${baseBranch}`, head),
    commitParent: (sha) => localCommitParent(origin, sha),
    fileAt: (sha, path) => localFileAt(origin, sha, path, { maxBytes: PR_FILE_MAX_BYTES }),
  };
}

/** GitHub, for a repo of a connected burrow (as the person who connected the burrow on a managed Whombat, PV-06). */
async function githubSource(services: Services, burrowId: string, repo: RepoRow): Promise<FileSource> {
  const adapter = services.github.adapter;
  if (!adapter) throw conflict('GitHub is off on this server, so Whombat can’t read this file.');
  if (!(await services.github.connectedRepo(burrowId, repo.fullName)))
    throw conflict(`${repo.fullName} isn’t connected to GitHub, so Whombat can’t read its files.`);
  const scoped = <T>(read: () => Promise<T>) => githubScope.run({ burrowId }, read);
  return {
    mergeBase: (baseBranch, head) => scoped(() => adapter.mergeBase(repo.fullName, baseBranch, head)),
    commitParent: (sha) => scoped(() => adapter.commitParent(repo.fullName, sha)),
    fileAt: (sha, path) => scoped(() => adapter.fileAt(repo.fullName, sha, path, PR_FILE_MAX_BYTES)),
  };
}

/** A GitHub failure as a 409 the app shows (with the fix when GitHub isn't connected), as other GitHub reads. */
function refused(err: unknown): unknown {
  if (err instanceof ApiError) return err;
  if (err instanceof GitHubNotConnectedError)
    return new ApiError('conflict', err.message, { details: { fix: err.fix } });
  if (err instanceof GitHubError)
    return new ApiError('conflict', err.message, { details: { github: err.status } });
  return err;
}

async function firstCommitSha(db: Db, prId: string): Promise<string | null> {
  const [row] = await db
    .select({ sha: prCommits.sha })
    .from(prCommits)
    .where(eq(prCommits.prId, prId))
    .orderBy(asc(prCommits.position))
    .limit(1);
  return row?.sha ?? null;
}

/**
 * `prs.file`: one of the PR's files, whole. 404 unless `path` is one of the files the PR changes (its `pr_files`,
 * what Files changed lists) — the only paths ever read (PF-03). Agents don't see PRs of repos that are switched off.
 */
export async function prFileView(
  services: Services,
  viewer: PrincipalRow,
  pr: PullRequestRow,
  path: string,
): Promise<PrFileView> {
  const db = services.db;
  const [repo] = await db.select().from(repos).where(eq(repos.id, pr.repoId));
  if (!repo || (viewer.kind === 'agent' && !repo.enabled)) throw notFound('Pull request');
  const [file] = await db
    .select({ path: prFiles.path })
    .from(prFiles)
    .where(and(eq(prFiles.prId, pr.id), eq(prFiles.path, path)));
  if (!file) throw new ApiError('not_found', `PR #${pr.number} doesn’t change ${path}.`);
  const source =
    repo.source === 'local' ? localSource(repo) : await githubSource(services, pr.burrowId, repo);
  try {
    const baseSha = await prBaseSha(source, pr, await firstCommitSha(db, pr.id));
    const [base, head] = await Promise.all([
      baseSha ? source.fileAt(baseSha, path) : null,
      source.fileAt(pr.headSha, path),
    ]);
    if (!base && !head)
      throw conflict(
        `Whombat couldn’t find ${path} in PR #${pr.number}’s base or head. The branch may be gone.`,
      );
    return buildFileView({ path, baseSha, headSha: pr.headSha, base, head });
  } catch (err) {
    throw refused(err);
  }
}
