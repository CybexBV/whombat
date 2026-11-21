import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitRunbook } from './runbook.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
const RUNBOOK = 'runbooks/appliance/releases.md';
const add = (text: string) => `${text}one more\n`;

/** A repository with whombat-ops in `folder` ('' when ops is the repository itself) and one commit on main. */
function repository(folder: string): { top: string; ops: string } {
  const top = mkdtempSync(join(tmpdir(), 'runbook-'));
  git(top, 'init', '-q', '-b', 'main');
  git(top, 'config', 'user.name', 't');
  git(top, 'config', 'user.email', 't@example.com');
  const ops = join(top, folder);
  mkdirSync(join(ops, 'runbooks', 'appliance'), { recursive: true });
  writeFileSync(join(ops, RUNBOOK), '# Releases\n');
  git(top, 'add', '-A');
  git(top, 'commit', '-q', '-m', 'first');
  return { top, ops };
}

describe('the releases runbook’s commit', () => {
  it('is made in a copy of whombat-ops that stands alone, and takes nothing else that is staged', async () => {
    const { top, ops } = repository('');
    writeFileSync(join(top, 'other.txt'), 'someone’s work\n');
    git(top, 'add', 'other.txt');
    expect(await commitRunbook({ ops, message: 'runbooks: x', change: add })).toBe('checkout');
    expect(git(top, 'show', '--stat', '--format=%s', 'HEAD')).toMatch(
      /^runbooks: x\n\n ?runbooks\/appliance\/releases\.md/,
    );
    expect(git(top, 'status', '--porcelain')).toBe('A  other.txt');
  });

  it('commits nothing when the files say it all already', async () => {
    const { top, ops } = repository('');
    const once = (text: string) => (text.includes('one more') ? text : add(text));
    expect(await commitRunbook({ ops, message: 'runbooks: x', change: once })).toBe('checkout');
    const head = git(top, 'rev-parse', 'HEAD');
    expect(await commitRunbook({ ops, message: 'runbooks: x again', change: once })).toBe('unchanged');
    expect(git(top, 'rev-parse', 'HEAD')).toBe(head);
    // The same for the ops folder of a repository with a remote: nothing is pushed.
    const cloud = repository('ops');
    const origin = mkdtempSync(join(tmpdir(), 'runbook-origin-'));
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    git(cloud.top, 'remote', 'add', 'origin', origin);
    git(cloud.top, 'push', '-q', 'origin', 'main');
    expect(await commitRunbook({ ops: cloud.ops, message: 'runbooks: y', change: (text) => text })).toBe(
      'unchanged',
    );
    expect(git(origin, 'rev-parse', 'main')).toBe(git(cloud.top, 'rev-parse', 'main'));
    expect(git(cloud.top, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('goes to origin’s main for the ops folder of a repository people work in, whatever is checked out', async () => {
    const { top, ops } = repository('ops');
    const origin = mkdtempSync(join(tmpdir(), 'runbook-origin-'));
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    git(top, 'remote', 'add', 'origin', origin);
    git(top, 'push', '-q', 'origin', 'main');
    // Someone works there: another branch, with a change of their own.
    git(top, 'switch', '-q', '-c', 'work');
    writeFileSync(join(top, 'wip.txt'), 'wip\n');
    git(top, 'add', 'wip.txt');
    const said: string[] = [];
    expect(await commitRunbook({ ops, message: 'runbooks: y', change: add, say: (l) => said.push(l) })).toBe(
      'origin',
    );
    expect(git(origin, 'log', '-1', '--format=%s', 'main')).toBe('runbooks: y');
    expect(git(origin, 'show', `main:ops/${RUNBOOK}`)).toBe('# Releases\none more');
    // Their checkout is as they left it.
    expect(git(top, 'symbolic-ref', '--short', 'HEAD')).toBe('work');
    expect(git(top, 'status', '--porcelain')).toBe('A  wip.txt');
    expect(readFileSync(join(ops, RUNBOOK), 'utf8')).toBe('# Releases\n');
    expect(said.join()).toContain('left as it is (work, with changes)');
    expect(git(top, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('fast-forwards a checkout that is on main without changes', async () => {
    const { top, ops } = repository('ops');
    const origin = mkdtempSync(join(tmpdir(), 'runbook-origin-'));
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    git(top, 'remote', 'add', 'origin', origin);
    git(top, 'push', '-q', 'origin', 'main');
    await commitRunbook({ ops, message: 'runbooks: z', change: add });
    expect(git(top, 'log', '-1', '--format=%s')).toBe('runbooks: z');
    expect(readFileSync(join(ops, RUNBOOK), 'utf8')).toBe('# Releases\none more\n');
  });
});
