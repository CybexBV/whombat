/** A pull request on the phone (AP-712): the screen's model, Merge into main by the web's rules, the file view. */
import { MERGE_BLOCK_HINTS, MERGE_NOTE_WITH_KEYS } from '@whombat/client';
import { mergeNote, type PullRequestDetail } from '@whombat/core';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { demoClient } from '../demo/session';
import { worldContext } from '../test/world';
import { LINE_MARKS, mergeConfirm, pullRequestModel, pullRequestTarget } from './pullRequest';

async function pr482(): Promise<PullRequestDetail> {
  const client = demoClient(createFixtureFetch());
  return client.prs.get({ params: { burrow: 'burrow-hq', number: 482 }, query: {} });
}

const lookup = (id: string) => worldContext().people.get(id);

describe('the pull request screen (AP-712)', () => {
  it('title, state, branch, checks, reviewers and files with the minus sign', async () => {
    const detail = await pr482();
    const model = pullRequestModel(detail, { lookup, agentsMayMerge: false, agent: 'Dusty' });
    expect(model.title).toBe('Invoice PDF export');
    expect(model.label).toBe('whombat/billing · PR #482');
    expect(model.status).toEqual({ text: 'Open · changes requested', tone: 'warn' });
    expect(model.branch).toBe('feat/invoice-pdf → main');
    expect(model.checks.map((c) => c.passed)).toEqual([true, true, false, false]);
    expect(model.reviewers[0]?.state).toBe('Changes requested');
    const format = model.files.find((f) => f.path === 'billing/pdf/format.ts');
    expect(format).toMatchObject({ add: '+34', del: '−9' });
    expect(model.diff).toContain('−12');
  });

  it('Merge into main follows the server’s block, and the note says how the agent merges', async () => {
    const detail = await pr482();
    const blocked = pullRequestModel(detail, { lookup, agentsMayMerge: false, agent: 'Dusty' });
    expect(blocked.merge).toMatchObject({ canMerge: false, hint: MERGE_BLOCK_HINTS.checks });
    expect(blocked.mergeNote).toBe(mergeNote('Dusty'));
    const ready = pullRequestModel(
      { ...detail, mergeBlock: null },
      { lookup, agentsMayMerge: true, agent: 'Dusty' },
    );
    expect(ready.merge).toMatchObject({ canMerge: true, look: 'ready', label: 'Merge into main' });
    expect(ready.mergeNote).toBe(MERGE_NOTE_WITH_KEYS);
    const merged = pullRequestModel(
      { ...detail, pr: { ...detail.pr, state: 'merged' }, mergeBlock: 'not_open' },
      { lookup, agentsMayMerge: false, agent: 'Dusty' },
    );
    expect(merged.merge).toMatchObject({ label: 'Merged into main', canMerge: false });
    expect(mergeConfirm(detail)).toEqual({
      title: 'Merge PR #482 into main?',
      body: 'feat/invoice-pdf goes into main. This can’t be undone from here.',
    });
  });

  it('a run’s PR opens with its repository when one room has the number', () => {
    const rooms = [
      { prNumber: 482, repo: 'whombat/billing' },
      { prNumber: 7, repo: 'a/x' },
      { prNumber: 7, repo: 'b/y' },
    ];
    expect(pullRequestTarget(rooms, 482)).toEqual({ number: 482, repo: 'whombat/billing' });
    expect(pullRequestTarget(rooms, 7)).toEqual({ number: 7 });
    expect(pullRequestTarget(rooms, 7, 'b/y')).toEqual({ number: 7, repo: 'b/y' });
    expect(pullRequestTarget([], 9)).toEqual({ number: 9 });
  });

  it('marks lines as the web does, with the minus sign', () => {
    expect(LINE_MARKS).toEqual({ context: ' ', add: '+', del: '−' });
  });
});
