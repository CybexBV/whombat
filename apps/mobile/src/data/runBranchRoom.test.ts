import { describe, expect, it } from 'vitest';
import { runBranchRoom } from './run';

const a = { id: 'cnv_a', prNumber: 42, branch: 'feat/a', repo: 'acme/web' };
const b = { id: 'cnv_b', prNumber: 42, branch: 'feat/b', repo: 'acme/api' };
const other = { id: 'cnv_c', prNumber: 7, branch: 'fix/c', repo: 'acme/web' };

describe('a run’s branch room', () => {
  it('is its own pull request’s when two repositories share the number', () => {
    expect(runBranchRoom([a, b], { prNumber: 42, branch: 'feat/b', conversationId: 'cnv_chat' })).toBe(b);
    expect(runBranchRoom([a, b], { prNumber: 42, branch: 'feat/x', conversationId: 'cnv_b' })).toBe(b);
  });

  it('is none when the number alone can’t tell them apart', () => {
    expect(runBranchRoom([a, b], { prNumber: 42, branch: 'feat/x', conversationId: 'cnv_chat' })).toBeNull();
  });

  it('is the only room with that number, and none without a pull request', () => {
    expect(runBranchRoom([a, other], { prNumber: 42, branch: 'feat/x', conversationId: 'cnv_chat' })).toBe(a);
    expect(
      runBranchRoom([a, other], { prNumber: null, branch: 'feat/a', conversationId: 'cnv_a' }),
    ).toBeNull();
  });
});
