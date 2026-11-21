import type { PullRequestDetail } from '@whombat/core';
import { approval, mara, PRINCIPALS, pr, SEED_NOW } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { principalLookup } from '../messaging/model';
import { checkRows, stagingView } from './model';

const lookup = principalLookup({ principals: PRINCIPALS });
const viewer = { id: mara.id, kind: 'person' as const };
const ctx = { lookup, viewer, now: SEED_NOW, timeZone: 'Europe/Amsterdam' };

function detail(overrides: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return { pr, status: 'changes_requested', mergeBlock: 'checks', staging: approval, ...overrides };
}

describe('branch room model', () => {
  it('marks passed checks filled and everything else (failing included) with a warn ring', () => {
    expect(checkRows(pr.checks).map((c) => [c.name, c.mark, c.note])).toEqual([
      ['lint', 'passed', '12s'],
      ['typecheck', 'passed', '41s'],
      ['unit · billing', 'pending', '38/41'],
      ['pdf-snapshot', 'pending', 'queued'],
    ]);
  });

  it('summarises the staging approval and offers "Review deploy" only while nobody decided', () => {
    expect(stagingView(detail(), ctx)).toEqual({
      summary: 'Dusty is waiting for a person to approve the staging deploy.',
      number: approval.number,
      showReview: true,
      reviewLabel: 'Review deploy',
    });
    const decided = stagingView(
      detail({
        staging: { ...approval, state: 'approved', decidedById: mara.id, decidedAt: SEED_NOW.toISOString() },
      }),
      ctx,
    );
    expect(decided?.showReview).toBe(false);
    expect(decided?.summary).toMatch(/^Mara approved\./);
    expect(stagingView(detail({ staging: null }), ctx)).toBeNull();
  });
});
