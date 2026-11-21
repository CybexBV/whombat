/**
 * The checks wake, pure (docs/decisions/health-checks-wake.md HW-01…HW-03): when a pull request's finished round is due
 * (`checksDue`) and the words GitHub wakes the agent with (`checksWakeText`, its brief `checksWakeBrief`). The wake end to end is in
 * checks-wake.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { checksWakeBrief, checksWakeText } from './checks-wake';
import { checksOutcome, failedNames } from './checks-words';
import { checksDue } from './poll-plan';

const HEAD = '3d88d80b6e1c2a4f5d7e9b0c1a2b3c4d5e6f7a8b';
const pr = (checksHandledSha: string | null) => ({ headSha: HEAD, checksHandledSha });
const passed = { state: 'passed' as const };
const failed = { state: 'failed' as const };
const skipped = { state: 'skipped' as const };

describe('a pull request’s finished round (checksDue)', () => {
  it('is due once every check of the head has its result, unchanged in this poll', () => {
    expect(checksDue(pr(null), [passed, failed, skipped], false)).toBe(true);
    // A check still queued or running: the round isn't finished.
    expect(checksDue(pr(null), [passed, { state: 'running' }], false)).toBe(false);
    expect(checksDue(pr(null), [passed, { state: 'queued' }], false)).toBe(false);
    // No checks: nothing finishes, nobody is woken.
    expect(checksDue(pr(null), [], false)).toBe(false);
  });

  it('waits a poll after the round changed: a job that needs another shows up seconds later', () => {
    expect(checksDue(pr(null), [passed, passed], true)).toBe(false);
  });

  it('is handled once per head: the same head again is not due, a new head is', () => {
    expect(checksDue(pr(HEAD), [passed], false)).toBe(false);
    // The seed's short shas name the same commit.
    expect(checksDue(pr(HEAD.slice(0, 6)), [passed], false)).toBe(false);
    expect(checksDue(pr('e9f1140000000000000000000000000000000000'), [passed], false)).toBe(true);
  });
});

describe('what GitHub wakes the agent with', () => {
  it('counts the results and names what failed, for the agent', () => {
    expect(checksOutcome([{ name: 'lint', state: 'passed' }])).toBe('1 passed');
    expect(
      checksOutcome([
        { name: 'lint', state: 'passed' },
        { name: 'typecheck', state: 'passed' },
        { name: 'unit · billing', state: 'passed' },
        { name: 'build', state: 'failed' },
      ]),
    ).toBe('3 passed, 1 failed (build)');
    expect(
      checksOutcome([
        { name: 'docs', state: 'skipped' },
        { name: 'lint', state: 'failed' },
        { name: 'unit', state: 'failed' },
        { name: 'e2e', state: 'failed' },
        { name: 'visual', state: 'failed' },
        { name: 'build', state: 'passed' },
      ]),
    ).toBe('1 passed, 4 failed (lint, unit, e2e and 1 more), 1 skipped');
  });

  it('names failing checks the way a person would', () => {
    const f = (...names: string[]) => names.map((name) => ({ name, state: 'failed' as const }));
    expect(failedNames([{ name: 'lint', state: 'passed' }])).toBe('');
    expect(failedNames(f('build'))).toBe('build');
    expect(failedNames(f('lint', 'unit'))).toBe('lint and unit');
    expect(failedNames(f('lint', 'unit', 'e2e'))).toBe('lint, unit and e2e');
  });

  const checks = [
    { name: 'check', state: 'passed' as const },
    { name: 'build', state: 'failed' as const },
  ];

  it('posts one plain line: the pull request, linked, and what failed; no commit, no counts', () => {
    const url = 'https://github.com/acme/whombat-app/pull/1';
    const text = checksWakeText({ prNumber: 1, url, checks });
    expect(text).toContain(`[PR #1](${url})`);
    expect(text).toContain('failed (build)');
    expect(text).not.toContain('@');
    expect(text).not.toContain(HEAD.slice(0, 6));
    expect(text).not.toMatch(/\d+ passed/);
    expect(checksWakeText({ prNumber: 7, url: null, checks: [{ name: 'check', state: 'passed' }] })).toBe(
      'The checks on PR #7 passed.',
    );
  });

  it('gives the agent the commit, the branch and every result in its brief', () => {
    const brief = checksWakeBrief({ repo: 'acme/web', prNumber: 1, branch: 'feat/x', headSha: HEAD, checks });
    for (const fact of ['acme/web', 'PR #1', 'feat/x', HEAD.slice(0, 6), '1 passed, 1 failed (build)'])
      expect(brief).toContain(fact);
  });
});
