/**
 * A change to the releases runbook of whombat-ops (`runbooks/appliance/releases.md`), committed where the maintainers'
 * tooling lives: what `candidate` and `promote` write about each release.
 *
 * A copy of whombat-ops that stands alone, without a remote: changed and committed there, as it is. The `ops/` folder
 * of a repository with a remote (whombat-cloud): changed in a fresh worktree of its `origin/main`, committed and
 * pushed, and the checkout fast-forwarded when it is on `main` without changes. People work in that checkout: a commit
 * made in whatever is checked out there would land on another branch or carry someone's staged work.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { TMP_DIR } from '../lib/paths.ts';
import { must, run } from '../lib/proc.ts';

const git = async (cwd: string, ...args: string[]) => (await must('git', args, { cwd })).stdout.trim();
const ok = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).code === 0;

export interface RunbookChange {
  /** whombat-ops' folder. */
  ops: string;
  /** The commit message. */
  message: string;
  /** The runbook's new text from its text so far ('' when it doesn't exist yet). */
  change: (text: string) => string;
  /**
   * Other files of whombat-ops written in the same commit (paths from its folder; a release's record,
   * `records/releases/<version>.json`): each one's new text from its text so far.
   */
  also?: Record<string, (text: string) => string>;
  say?: (line: string) => void;
}

/**
 * Where it was committed: `checkout` (in the copy itself) or `origin` (pushed to its repository's main); `unchanged`
 * when the files say it all already (a command run again after it finished), and nothing is committed.
 */
export async function commitRunbook(o: RunbookChange): Promise<'checkout' | 'origin' | 'unchanged'> {
  const top = await git(o.ops, 'rev-parse', '--show-toplevel');
  const changes: [string, (text: string) => string][] = [
    [relative(top, join(o.ops, 'runbooks', 'appliance', 'releases.md')), o.change],
    ...Object.entries(o.also ?? {}).map(([path, change]): [string, (text: string) => string] => [
      relative(top, join(o.ops, path)),
      change,
    ]),
  ];
  const files = changes.map(([file]) => file);
  const write = (root: string) => {
    for (const [file, change] of changes) {
      const path = join(root, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, change(existsSync(path) ? readFileSync(path, 'utf8') : ''));
    }
  };
  if (!(await ok(top, 'remote', 'get-url', 'origin'))) {
    write(top);
    await git(top, 'add', '--', ...files);
    if (await ok(top, 'diff', '--cached', '--quiet', '--', ...files)) return 'unchanged';
    // Only these files: whatever else is staged there stays staged.
    await git(top, 'commit', '-q', '-m', o.message, '--', ...files);
    return 'checkout';
  }
  await git(top, 'fetch', '-q', 'origin');
  const wt = join(TMP_DIR, `releases-runbook-${process.pid}-${Date.now()}`);
  await git(top, 'worktree', 'add', '-q', '--detach', wt, 'origin/main');
  try {
    for (let attempt = 0; ; attempt++) {
      write(wt);
      await git(wt, 'add', '--', ...files);
      if (await ok(wt, 'diff', '--cached', '--quiet', '--', ...files)) return 'unchanged';
      await git(wt, 'commit', '-q', '-m', o.message);
      if (await ok(wt, 'push', '-q', 'origin', 'HEAD:main')) break;
      if (attempt === 2) throw new Error('origin refused the releases runbook three times');
      // main moved meanwhile: the same change again on what it is now.
      await git(wt, 'fetch', '-q', 'origin');
      await git(wt, 'reset', '-q', '--hard', 'origin/main');
    }
  } finally {
    await run('git', ['worktree', 'remove', '--force', wt], { cwd: top });
  }
  const branch = (await run('git', ['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: top })).stdout.trim();
  const clean = (await git(top, 'status', '--porcelain', '--untracked-files=no')) === '';
  if (!(branch === 'main' && clean && (await ok(top, 'merge', '--ff-only', '-q', 'origin/main'))))
    o.say?.(
      `${top} left as it is (${branch || 'detached'}${clean ? '' : ', with changes'}); origin/main has the runbook's section`,
    );
  return 'origin';
}
