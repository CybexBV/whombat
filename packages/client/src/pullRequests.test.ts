import { describe, expect, it } from 'vitest';
import { ApiError } from './http/errors';
import {
  changeStarts,
  gutterDigits,
  MERGE_BLOCK_HINTS,
  mergeButton,
  mergeErrorText,
  mergeOutcomeText,
  neighbours,
} from './pullRequests';

const pr = (state: 'open' | 'merged' | 'closed') => ({ state }) as never;

describe('Merge into main on the web and the phone (AP-712)', () => {
  it('ready, blocked with why, merged', () => {
    expect(mergeButton({ pr: pr('open'), mergeBlock: null })).toEqual({
      label: 'Merge into main',
      look: 'ready',
      canMerge: true,
      hint: null,
    });
    expect(mergeButton({ pr: pr('open'), mergeBlock: 'review' })).toMatchObject({
      canMerge: false,
      look: 'blocked',
      hint: MERGE_BLOCK_HINTS.review,
    });
    expect(mergeButton({ pr: pr('merged'), mergeBlock: 'not_open' })).toMatchObject({
      label: 'Merged into main',
      canMerge: false,
    });
  });

  it('what a refused or failed merge says', () => {
    expect(mergeOutcomeText({ status: 'ok', data: {}, httpStatus: 200 } as never)).toBeNull();
    expect(mergeOutcomeText({ status: 'blocked', keyNeeded: { label: 'Merge into main' } } as never)).toBe(
      'Blocked: merging needs the “Merge into main” key.',
    );
    expect(mergeOutcomeText({ status: 'pending_approval', approvalNumber: 4 } as never)).toBe(
      'That needs a person to approve it first. We’ve asked.',
    );
    expect(mergeErrorText(new ApiError(409, 'conflict', 'Checks have to pass first.', {}, 'prs.merge'))).toBe(
      'Checks have to pass first.',
    );
    expect(mergeErrorText(new Error('x'))).toBe('Couldn’t merge. Try again in a moment.');
  });
});

describe('the file view (AP-664)', () => {
  it('changes, gutter and neighbours', () => {
    const lines = [
      { kind: 'context', old: 1, new: 1 },
      { kind: 'del', old: 2, new: null },
      { kind: 'add', old: null, new: 2 },
      { kind: 'context', old: 3, new: 3 },
      { kind: 'add', old: null, new: 104 },
    ] as const;
    expect(changeStarts(lines)).toEqual([1, 4]);
    expect(gutterDigits(lines)).toBe(3);
    expect(gutterDigits([])).toBe(2);
    const files = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];
    expect(neighbours(files, 'b')).toEqual({ previous: 'a', next: 'c' });
    expect(neighbours(files, 'x')).toEqual({ previous: null, next: null });
  });
});
