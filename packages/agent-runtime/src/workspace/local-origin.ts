/**
 * Repositories created on the Whombat (docs/decisions/repositories.md RP-01…RP-04): a bare Git repository Whombat keeps
 * under `<WHOMBAT_WORKSPACES>/.origins/<burrow id>/<name>.git`, with branch `main` and a first commit (a README) made as
 * the person who created it, by their name and email. Agents' workspaces fetch from it and push to it the way they do
 * with GitHub (the workspace manager treats an absolute path as the remote), without a token.
 *
 * On an appliance the server (which creates it) and the runner (which fetches and pushes) are different users in the
 * `whombat-workspaces` group, and the workspaces root is setgid to that group: the repository is `--shared=group` and its
 * directories 2770, so both read and write it whatever their umask.
 */
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmdirSync, statSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { devNull } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { providerEnv } from '../support/env';

/** The directory under the workspaces root that holds local repos' origins; the workspace cleanup never enters it. */
export const LOCAL_ORIGINS_DIR = '.origins';

/** Where the origin of `name` in a burrow is kept. */
export function localOriginPath(workspaces: string, burrowId: string, name: string): string {
  return join(workspaces, LOCAL_ORIGINS_DIR, burrowId, `${name}.git`);
}

/** A remote that is a repository on this machine (a local repo's origin) rather than a URL. */
export function isLocalRemote(remote: string): boolean {
  return isAbsolute(remote);
}

/**
 * The git configuration a fetch from or push to a local origin needs: the file protocol (git allows it only “from the
 * user” by default) and the origin as a safe directory (the server's user owns it, the runner's reads and writes it).
 */
export function localRemoteConfig(remote: string): string[] {
  return isLocalRemote(remote) ? ['protocol.file.allow=always', `safe.directory=${remote}`] : [];
}

export class LocalOriginExistsError extends Error {
  constructor(readonly path: string) {
    super(`A repository is already kept at ${path}.`);
    this.name = 'LocalOriginExistsError';
  }
}

export interface CreateLocalOriginOptions {
  workspaces: string;
  burrowId: string;
  /** A plain folder name (`LocalRepoName`), checked by the caller. */
  name: string;
  description?: string | undefined;
  /** Who the first commit is by, and the repository's own `user.name` / `user.email`. */
  author: { name: string; email: string };
  now: Date;
  /** The git binary (tests). */
  git?: string;
  env?: NodeJS.ProcessEnv;
}

/** The README the first commit adds. */
export function localReadme(name: string, description?: string): string {
  const about = description?.trim();
  return `# ${name}\n${about ? `\n${about}\n` : ''}`;
}

/**
 * Makes the origin: a new bare repository in a temporary name next to where it goes, the first commit written with git's
 * plumbing (no working tree, no hooks), then renamed into place so nobody ever sees half of it. Refuses a name that is
 * already taken there.
 */
export async function createLocalOrigin(
  o: CreateLocalOriginOptions,
): Promise<{ path: string; head: string }> {
  const path = localOriginPath(o.workspaces, o.burrowId, o.name);
  const parent = join(o.workspaces, LOCAL_ORIGINS_DIR, o.burrowId);
  for (const dir of [join(o.workspaces, LOCAL_ORIGINS_DIR), parent]) sharedDir(dir);
  if (existsSync(path)) throw new LocalOriginExistsError(path);
  const tmp = join(parent, `.new-${randomBytes(6).toString('hex')}.git`);
  const git = (args: string[], input?: string, extraEnv: NodeJS.ProcessEnv = {}) =>
    runGit(o.git ?? 'git', args, {
      cwd: parent,
      input,
      env: { ...gitEnv(o.env), GIT_DIR: tmp, ...extraEnv },
    });
  try {
    await runGit(
      o.git ?? 'git',
      ['init', '--bare', '--quiet', '--shared=group', '--initial-branch=main', '--template=', tmp],
      { cwd: parent, env: gitEnv(o.env) },
    );
    await git(['config', 'user.name', o.author.name]);
    await git(['config', 'user.email', o.author.email]);
    const blob = (await git(['hash-object', '-w', '--stdin'], localReadme(o.name, o.description))).trim();
    const tree = (await git(['mktree'], `100644 blob ${blob}\tREADME.md\n`)).trim();
    const date = `${Math.floor(o.now.getTime() / 1000)} +0000`;
    const head = (
      await git(['commit-tree', tree, '-m', `Create ${o.name}`], undefined, {
        GIT_AUTHOR_NAME: o.author.name,
        GIT_AUTHOR_EMAIL: o.author.email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: o.author.name,
        GIT_COMMITTER_EMAIL: o.author.email,
        GIT_COMMITTER_DATE: date,
      })
    ).trim();
    await git(['update-ref', 'refs/heads/main', head]);
    if (existsSync(path)) throw new LocalOriginExistsError(path);
    await rename(tmp, path);
    return { path, head };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
}

/**
 * git writing into a shared origin (goal-first.md GF-08): under umask 007, so the folders and files it makes already let
 * the group in. Under the appliance's UMask 0077 git would make them owner-only and then chmod them with the setgid bit
 * (`core.sharedRepository`), which RestrictSUIDSGID refuses: “Could not make … writable by group”. Through `/bin/sh` on
 * POSIX (Node can't set a child's umask); elsewhere git itself.
 */
export function sharedGitCommand(git: string, args: string[]): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: git, args };
  return { file: '/bin/sh', args: ['-c', 'umask 007 && exec "$0" "$@"', git, ...args] };
}

/**
 * A folder the server and the runner share (goal-first.md GF-08): made with the group's bits, since the server's umask
 * is 0077 on an appliance, and never chmodded with the setgid bit — the runtime's RestrictSUIDSGID refuses that even to
 * the owner, and under the setgid workspaces folder the kernel gives a new folder its group and setgid bit anyway. Made
 * synchronously, so the brief umask change can't reach another file. An empty one an older runtime made without the
 * group's bits is made again (keeping the inherited setgid bit); one with content gets the group's bits added.
 */
function sharedDir(dir: string): void {
  if (!existsSync(dir)) {
    const before = process.umask(0o007);
    try {
      mkdirSync(dir, { mode: 0o770, recursive: true });
    } finally {
      process.umask(before);
    }
  }
  const mode = statSync(dir).mode;
  if ((mode & 0o070) === 0o070) return;
  if (readdirSync(dir).length === 0) {
    rmdirSync(dir);
    sharedDir(dir);
    return;
  }
  chmodSync(dir, (mode & 0o777) | 0o070);
}

/** Removes an origin this process just made (its creation couldn't be recorded). Only ever under `.origins`. */
export async function removeLocalOrigin(workspaces: string, burrowId: string, name: string): Promise<void> {
  await rm(localOriginPath(workspaces, burrowId, name), { recursive: true, force: true });
}

/** Nothing of the caller's environment (tokens, secrets) and no system or global git config. */
function gitEnv(base: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return {
    ...providerEnv(base ?? process.env, { pass: [] }),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ATTR_NOSYSTEM: '1',
  };
}

function runGit(
  git: string,
  args: string[],
  o: { cwd: string; env: NodeJS.ProcessEnv; input?: string | undefined },
): Promise<string> {
  const shared = sharedGitCommand(git, [
    '-c',
    `core.hooksPath=${devNull}`,
    '-c',
    'core.fsmonitor=false',
    ...args,
  ]);
  if (o.input === undefined)
    return new Promise((resolve, reject) => {
      execFile(shared.file, shared.args, { cwd: o.cwd, env: o.env }, (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args[0]} failed: ${String(stderr).trim() || error.message}`));
        else resolve(String(stdout));
      });
    });
  return new Promise((resolve, reject) => {
    const child = spawn(shared.file, shared.args, {
      cwd: o.cwd,
      env: o.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.stderr.on('data', (d) => {
      err += String(d);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`git ${args[0]} failed: ${err.trim() || `exit ${code}`}`)),
    );
    child.stdin.end(o.input);
  });
}

/* Pull requests on a local origin (docs/decisions/runs-approvals.md MDS-D05) ------------------------------------------ */

/** What reading or merging in an origin needs: the git binary and the environment it runs with (tests). */
export interface OriginGitOptions {
  git?: string;
  env?: NodeJS.ProcessEnv;
}

/** Git on the bare origin itself (no work tree), its exit code kept: `merge-tree` answers 1 for a conflict. */
function originGit(
  origin: string,
  args: string[],
  o: OriginGitOptions & { extraEnv?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const argv = [
    '-c',
    `core.hooksPath=${devNull}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    `safe.directory=${origin}`,
    ...args,
  ];
  // A merge writes objects and refs into the origin the runner shares (GF-08).
  const shared = sharedGitCommand(o.git ?? 'git', argv);
  return new Promise((resolve, reject) => {
    execFile(
      shared.file,
      shared.args,
      { env: { ...gitEnv(o.env), GIT_DIR: origin, ...o.extraEnv }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        if (code === null) reject(error);
        else resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function must(
  origin: string,
  args: string[],
  o: OriginGitOptions & { extraEnv?: NodeJS.ProcessEnv } = {},
) {
  const res = await originGit(origin, args, o);
  if (res.code !== 0) throw new Error(`git ${args[0]} failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  return res.stdout;
}

/** The commit a branch of the origin points to, or null when the origin has no such branch. */
export async function localBranchHead(
  origin: string,
  branch: string,
  o: OriginGitOptions = {},
): Promise<string | null> {
  const res = await originGit(
    origin,
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`],
    o,
  );
  return res.code === 0 ? res.stdout.trim() || null : null;
}

export interface LocalChanges {
  files: { path: string; add: number; del: number }[];
  diff: { add: number; del: number; files: number };
  /** Oldest first, at most 250. */
  commits: { sha: string; message: string; authorName: string; authorEmail: string; at: string }[];
}

/** What `head` changes against `base` (from their merge base), the way a pull request shows it. */
export async function localChanges(
  origin: string,
  base: string,
  head: string,
  o: OriginGitOptions = {},
): Promise<LocalChanges> {
  // `-z`: paths as they are, not quoted (non-ASCII names would otherwise come back as `"caf\303\251.md"`).
  const numstat = await must(
    origin,
    ['diff', '--numstat', '-z', '--no-renames', `${base}...${head}`, '--'],
    o,
  );
  const files = numstat
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [add = '0', del = '0', ...path] = line.split('\t');
      // Binary files count no lines (`-`).
      return { path: path.join('\t'), add: Number(add) || 0, del: Number(del) || 0 };
    });
  const log = await must(
    origin,
    [
      'log',
      '--reverse',
      '--max-count=250',
      '--format=%H%x1f%s%x1f%an%x1f%ae%x1f%aI%x1e',
      `${base}..${head}`,
      '--',
    ],
    o,
  );
  const commits = log
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha = '', message = '', authorName = '', authorEmail = '', at = ''] = r.split('\x1f');
      return { sha, message, authorName, authorEmail, at };
    });
  return {
    files,
    diff: {
      add: files.reduce((n, f) => n + f.add, 0),
      del: files.reduce((n, f) => n + f.del, 0),
      files: files.length,
    },
    commits,
  };
}

/* A pull request's file, whole (Whombat docs/decisions/pr-file-view.md PF-03…PF-05; contracts CT-241) ------------------ */

/** One version of a file: its bytes, or `too_large` (bigger than the reader's limit, so not read). */
export type FileVersion = { kind: 'file'; bytes: Uint8Array } | { kind: 'too_large'; size: number };

const OBJECT_ID = /^[0-9a-f]{40,64}$/;

/** A revision git can't mistake for an option. */
function revision(rev: string): string {
  if (!rev || rev.startsWith('-')) throw new Error(`“${rev}” isn’t a revision.`);
  return rev;
}

/** Git on the bare origin with stdout as bytes (a blob), at most `maxBytes` of it. */
function originGitBytes(
  origin: string,
  args: string[],
  maxBytes: number,
  o: OriginGitOptions = {},
): Promise<Buffer> {
  const argv = [
    '-c',
    `core.hooksPath=${devNull}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    `safe.directory=${origin}`,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      o.git ?? 'git',
      [...argv, ...args],
      { env: { ...gitEnv(o.env), GIT_DIR: origin }, encoding: 'buffer', maxBuffer: maxBytes + 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args[0]} failed: ${String(stderr).trim() || error.message}`));
        else resolve(stdout);
      },
    );
  });
}

/** The best common ancestor of two revisions (`refs/heads/main`, a commit), or null when they have none. */
export async function localMergeBase(
  origin: string,
  a: string,
  b: string,
  o: OriginGitOptions = {},
): Promise<string | null> {
  const res = await originGit(origin, ['merge-base', revision(a), revision(b)], o);
  const sha = res.stdout.trim();
  return res.code === 0 && OBJECT_ID.test(sha) ? sha : null;
}

/** A commit's first parent, or null for a root commit or a commit the origin doesn't have. */
export async function localCommitParent(
  origin: string,
  commit: string,
  o: OriginGitOptions = {},
): Promise<string | null> {
  if (!OBJECT_ID.test(commit)) return null;
  const res = await originGit(origin, ['rev-parse', '--verify', '--quiet', `${commit}^1^{commit}`], o);
  const sha = res.stdout.trim();
  return res.code === 0 && OBJECT_ID.test(sha) ? sha : null;
}

/**
 * The file at `path` in commit `commit` (a full object id), or null when that version has no file there (or the
 * commit isn't in the origin). The path is matched literally and exactly (`GIT_LITERAL_PATHSPECS`, after `--`): no
 * pathspec magic, no globs, nothing outside the commit's tree. A version above `maxBytes` isn't read (`too_large`); a
 * submodule reads as git's diff shows it (`Subproject commit <sha>`).
 */
export async function localFileAt(
  origin: string,
  commit: string,
  path: string,
  o: OriginGitOptions & { maxBytes: number },
): Promise<FileVersion | null> {
  if (!OBJECT_ID.test(commit) || !path) return null;
  const listed = await originGit(origin, ['ls-tree', '-z', '--full-tree', commit, '--', path], {
    ...o,
    extraEnv: { GIT_LITERAL_PATHSPECS: '1' },
  });
  if (listed.code !== 0) return null;
  let entry: { type: string; object: string } | null = null;
  for (const record of listed.stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0 || record.slice(tab + 1) !== path) continue;
    const [, type = '', object = ''] = record.slice(0, tab).split(' ');
    entry = { type, object };
  }
  if (!entry || !OBJECT_ID.test(entry.object)) return null;
  if (entry.type === 'commit')
    return { kind: 'file', bytes: new TextEncoder().encode(`Subproject commit ${entry.object}\n`) };
  if (entry.type !== 'blob') return null;
  const size = Number((await must(origin, ['cat-file', '-s', entry.object], o)).trim());
  if (!Number.isFinite(size) || size > o.maxBytes) return { kind: 'too_large', size };
  const bytes = await originGitBytes(origin, ['cat-file', 'blob', entry.object], o.maxBytes, o);
  return { kind: 'file', bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
}

/** The origin didn't merge, and nothing changed in it: why, in words a person reads. */
export class LocalMergeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalMergeRefused';
  }
}

export interface LocalMergeOptions extends OriginGitOptions {
  /** The branch merged into (the pull request's base, the repo's default branch for “Merge into main”). */
  base: string;
  /** The pull request's branch; its current head is what is merged. */
  branch: string;
  /** `squash` (one commit on the base, GitHub's default here) or `merge` (a merge commit). */
  method: 'squash' | 'merge';
  /** The commit's subject and body (“Invoice PDF export (#3)”, “Merged by Mara Okafor in Whombat.”). */
  title: string;
  message: string;
  /** Who merges: the commit's author and committer. */
  author: { name: string; email: string };
  now: Date;
}

/**
 * Merges a branch into the base inside the bare origin, as GitHub would merge its pull request: `merge-tree` writes the
 * merged tree (a conflict refuses), `commit-tree` makes one commit — the squash on top of the base, or a merge commit
 * with both parents — and `update-ref` moves the base only if nobody moved it meanwhile. Nothing is checked out and no
 * hook runs. Refuses (`LocalMergeRefused`, the origin untouched) a missing branch, a branch already in the base and a
 * conflict.
 */
export async function mergeLocalBranch(
  origin: string,
  m: LocalMergeOptions,
): Promise<{ sha: string; headSha: string; baseSha: string }> {
  const baseSha = await localBranchHead(origin, m.base, m);
  if (!baseSha) throw new LocalMergeRefused(`${m.base} isn’t on this Whombat’s copy of the repository.`);
  const headSha = await localBranchHead(origin, m.branch, m);
  if (!headSha) throw new LocalMergeRefused(`${m.branch} isn’t on this Whombat’s copy of the repository.`);
  const ancestor = await originGit(origin, ['merge-base', '--is-ancestor', headSha, baseSha], m);
  if (ancestor.code === 0)
    throw new LocalMergeRefused(`${m.branch} has nothing that isn’t in ${m.base} already.`);
  const merged = await originGit(
    origin,
    ['merge-tree', '--write-tree', '--name-only', '--no-messages', baseSha, headSha],
    m,
  );
  const [tree = '', ...conflicted] = merged.stdout.split('\n').filter(Boolean);
  if (merged.code === 1) {
    const files = conflicted.slice(0, 5).join(', ');
    throw new LocalMergeRefused(
      `${m.branch} conflicts with ${m.base}${files ? ` in ${files}${conflicted.length > 5 ? ' and more' : ''}` : ''}. Bring ${m.branch} up to date with ${m.base} first.`,
    );
  }
  if (merged.code !== 0 || !/^[0-9a-f]{40,64}$/.test(tree))
    throw new Error(`git merge-tree failed: ${merged.stderr.trim() || `exit ${merged.code}`}`);
  // A squash already merged (or changes the base has otherwise): the merge would change nothing.
  if (tree === (await must(origin, ['rev-parse', `${baseSha}^{tree}`], m)).trim())
    throw new LocalMergeRefused(`${m.branch} has nothing that isn’t in ${m.base} already.`);
  const date = `${Math.floor(m.now.getTime() / 1000)} +0000`;
  const parents = m.method === 'merge' ? ['-p', baseSha, '-p', headSha] : ['-p', baseSha];
  const sha = (
    await must(origin, ['commit-tree', tree, ...parents, '-m', m.title, '-m', m.message], {
      ...m,
      extraEnv: {
        GIT_AUTHOR_NAME: m.author.name,
        GIT_AUTHOR_EMAIL: m.author.email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: m.author.name,
        GIT_COMMITTER_EMAIL: m.author.email,
        GIT_COMMITTER_DATE: date,
      },
    })
  ).trim();
  // Only from the base it was merged onto: someone else's merge meanwhile refuses this one (nothing lost).
  const moved = await originGit(origin, ['update-ref', `refs/heads/${m.base}`, sha, baseSha], m);
  if (moved.code !== 0) throw new LocalMergeRefused(`${m.base} moved while merging. Try again.`);
  return { sha, headSha, baseSha };
}
