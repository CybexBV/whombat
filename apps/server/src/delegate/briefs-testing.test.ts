import { describe, expect, it } from 'vitest';
import { DEPLOY_AFTER_MERGE, deployBrief, finalBrief, mergeBrief, taskBrief } from './briefs';

const task = (pullRequest: boolean) =>
  taskBrief({
    lead: 'Dusty',
    goal: 'A change',
    items: [{ n: 1, title: 'Change', brief: 'Implement it' }],
    branch: 'task',
    base: null,
    pullRequest,
    merge: false,
  });

describe('how a checklist tests its work', () => {
  it('has its threads run fast-test, or the quick checks the repository names, never the full suite', () => {
    for (const brief of [task(true), task(false)]) {
      expect(brief).toContain('`fast-test`');
      expect(brief).toContain('.fast-test.json');
      expect(brief).toContain('Never the full test suite');
      expect(brief).not.toContain('whombat-check');
    }
  });

  it('checks the combined work with fast-test when GitHub requires no checks, and does not wait for CI', () => {
    const final = finalBrief({
      lead: 'Dusty',
      goal: 'A change',
      branch: 'candidate',
      merged: [],
      gate: 'local',
    });
    expect(final).toContain('`fast-test`');
    expect(final).toContain('Don’t watch or wait for CI');
    expect(final).toContain('local: fast-test');
    expect(final).not.toContain('project’s full check');
    expect(final).toContain('Never the full test suite');
    const ci = finalBrief({ lead: 'Dusty', goal: 'A change', branch: 'candidate', merged: [], gate: 'ci' });
    expect(ci).toContain('required checks');
  });

  it('puts merged work on DEV as the repository says, never on production', () => {
    expect(DEPLOY_AFTER_MERGE).toContain('DEV');
    expect(DEPLOY_AFTER_MERGE).toContain('AGENTS.md');
    expect(DEPLOY_AFTER_MERGE).toContain('Never deploy to production');
    const merge = mergeBrief({
      lead: 'Dusty',
      pr: 'https://github.com/o/r/pull/1',
      branch: 'task',
      after: DEPLOY_AFTER_MERGE,
    });
    expect(merge).toContain(DEPLOY_AFTER_MERGE);
    expect(merge).toContain('Merged: yes');
    const again = deployBrief({
      lead: 'Dusty',
      pr: 'https://github.com/o/r/pull/1',
      revision: 'abc',
      after: DEPLOY_AFTER_MERGE,
    });
    expect(again).toContain(DEPLOY_AFTER_MERGE);
    expect(again).toContain('Don’t merge, push or change anything');
  });
});
