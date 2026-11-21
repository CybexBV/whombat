/** Finding the reviewer's own verdict of a T3 Code fix (report-trackers.md TA-57). */
import { describe, expect, it } from 'vitest';
import { modelKnown, newestReviewOf, type ReviewerVerdict, reviewBinds, reviewTitleOf } from './reviewer';

describe('the reviewer of a T3 Code fix', () => {
  it('is looked for by the title the recipe gives it, rendered for the run', () => {
    expect(reviewTitleOf({ trigger: { connection: 'Acme production', number: 23 } })).toBe(
      'Review Acme production #23:',
    );
    expect(reviewTitleOf({ trigger: { kind: 'manual' } })).toBeNull();
  });

  it('is the newest review one of the run’s own threads handed out', () => {
    const own = new Set(['mcp:fix']);
    const title = 'Review Acme production #23:';
    const listed = {
      threads: [
        {
          threadId: 'r1',
          parentThreadId: 'mcp:fix',
          relationshipToParent: 'subagent',
          title: `${title} a`,
          createdAt: '2026-11-09T13:30:00Z',
          itemCount: 40,
        },
        {
          threadId: 'r2',
          parentThreadId: 'mcp:fix',
          relationshipToParent: 'subagent',
          title: `${title} a`,
          createdAt: '2026-11-09T14:13:00Z',
          itemCount: 66,
        },
        {
          threadId: 'other',
          parentThreadId: 'mcp:else',
          relationshipToParent: 'subagent',
          title: `${title} a`,
          createdAt: '2026-11-09T15:00:00Z',
        },
        {
          threadId: 'not-a-review',
          parentThreadId: 'mcp:fix',
          relationshipToParent: 'subagent',
          title: 'Something else',
          createdAt: '2026-11-09T16:00:00Z',
        },
      ],
    };
    expect(newestReviewOf(listed, own, title)).toMatchObject({
      threadId: 'r2',
      items: 66,
      parentThreadId: 'mcp:fix',
    });
    expect(newestReviewOf({ threads: [] }, own, title)).toBeNull();
    expect(newestReviewOf('nonsense', own, title)).toBeNull();
  });

  it('binds the commit the reviewer named, or a head committed before the review began, by another model', () => {
    const head = { sha: '8c94527fb1c624336cfabe7ba406560bcd0493b6', committedAt: '2026-11-09T12:30:00Z' };
    const review: ReviewerVerdict = {
      verdict: 'approve',
      commit: null,
      startedAt: '2026-11-09T12:35:05Z',
      model: 'gpt-6.1-sol',
      fixerModel: 'claude-opus-5-5',
      provider: 'codex',
      fixerProvider: 'claudeAgent',
    };
    expect(reviewBinds({ ...review, commit: '8c94527' }, head)).toEqual({ ok: true });
    // Which provider reviewed it unknown: no approval, unless the automation chose this reviewer.
    expect(reviewBinds({ ...review, commit: '8c94527', provider: null }, head)).toMatchObject({ ok: false });
    expect(reviewBinds({ ...review, commit: '8c94527', fixerProvider: null }, head)).toMatchObject({
      ok: false,
    });
    expect(reviewBinds({ ...review, commit: '8c94527', provider: null }, head, 'gpt-6.1-sol')).toEqual({
      ok: true,
    });
    expect(reviewBinds({ ...review, commit: '1209c71' }, head)).toMatchObject({ ok: false });
    // Naming none: the head must be older than the review.
    expect(reviewBinds(review, head)).toEqual({ ok: true });
    expect(reviewBinds(review, { ...head, committedAt: '2026-11-09T13:00:00Z' })).toMatchObject({
      ok: false,
    });
    expect(reviewBinds(review, { ...head, committedAt: null })).toMatchObject({ ok: false });
    // Which model reviewed it unknown, or only “default”: no approval.
    expect(reviewBinds({ ...review, commit: '8c94527', fixerModel: 'default' }, head)).toMatchObject({
      ok: false,
    });
    expect(reviewBinds({ ...review, commit: '8c94527', model: null }, head)).toMatchObject({ ok: false });
    expect(reviewBinds({ ...review, commit: '8c94527', fixerModel: null }, head)).toMatchObject({
      ok: false,
    });
    // Another model of the fixer's provider: only when the automation chose that reviewer.
    const sameProvider = {
      ...review,
      commit: '8c94527',
      provider: 'claudeAgent',
      fixerProvider: 'claudeAgent',
      model: 'claude-sonnet-5-5',
    };
    expect(reviewBinds(sameProvider, head)).toMatchObject({ ok: false });
    expect(reviewBinds(sameProvider, head, 'claude-sonnet-5-5')).toEqual({ ok: true });
    expect(
      reviewBinds({ ...review, commit: '8c94527', provider: 'codex', fixerProvider: 'claudeAgent' }, head),
    ).toEqual({ ok: true });
    // Reviewed by the fixer's own model: no approval.
    expect(reviewBinds({ ...review, commit: '8c94527', model: 'claude-opus-5-5' }, head)).toMatchObject({
      ok: false,
    });
  });

  it('holds after the fixes of what one review found, on the branch it read, whatever its verdict', () => {
    const reviewed = '1209c71aa0be1d6a4fc2b67c9a3b5a7f0e6d2c11';
    const head = {
      sha: '8c94527fb1c624336cfabe7ba406560bcd0493b6',
      committedAt: '2026-11-09T13:00:00Z',
      commits: [reviewed, '8c94527fb1c624336cfabe7ba406560bcd0493b6'],
    };
    const review: ReviewerVerdict = {
      verdict: 'changes_needed',
      commit: '1209c71',
      startedAt: '2026-11-09T12:35:05Z',
      model: 'gpt-6.1-sol',
      fixerModel: 'claude-opus-5-5',
      provider: 'codex',
      fixerProvider: 'claudeAgent',
    };
    expect(reviewBinds(review, head)).toEqual({ ok: true });
    expect(reviewBinds({ ...review, verdict: 'approve' }, head)).toEqual({ ok: true });
    // A commit that isn't on the branch: it read something else.
    expect(reviewBinds({ ...review, commit: 'deadbee' }, head)).toMatchObject({ ok: false });
    // Naming none while the branch moved after it began: which commit it read can't be told.
    expect(reviewBinds({ ...review, commit: null }, head)).toMatchObject({ ok: false });
    // Still another model's.
    expect(reviewBinds({ ...review, model: 'claude-opus-5-5' }, head)).toMatchObject({ ok: false });
  });

  it('knows a model only by its name, never “default” or nothing', () => {
    expect(modelKnown('gpt-6.1-sol')).toBe(true);
    expect(modelKnown('default')).toBe(false);
    expect(modelKnown('Default')).toBe(false);
    expect(modelKnown(null)).toBe(false);
  });
});
