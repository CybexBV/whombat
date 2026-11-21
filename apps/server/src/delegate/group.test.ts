import { describe, expect, it } from 'vitest';
import { groupMembers, leadsWith, togetherWith } from './group';

const task = (
  id: string,
  position: number,
  afterId: string | null = null,
  fields: Partial<Parameters<typeof togetherWith>[0]> = {},
) => ({ id, position, afterId, state: 'queued', ...fields });

describe('tasks done in one thread', () => {
  it('keeps dependencies in order when the card was reordered', () => {
    const a = task('a', 0);
    const tasks = [a, task('c', 1, 'b'), task('b', 2, 'a')];
    expect(togetherWith(a, tasks).map((t) => t.id)).toEqual(['b', 'c']);
  });

  it('keeps siblings in card order, each before its own children', () => {
    const a = task('a', 0);
    const tasks = [a, task('b1', 3, 'a'), task('c', 1, 'b1'), task('b2', 2, 'a')];
    expect(togetherWith(a, tasks).map((t) => t.id)).toEqual(['b2', 'b1', 'c']);
  });

  it('leaves an incompatible model and everything depending on it for another thread', () => {
    const a = task('a', 0, null, { provider: 'claudeAgent', model: 'opus' });
    const tasks = [
      a,
      task('b', 1, 'a', { provider: 'codex', model: 'sol' }),
      task('c', 2, 'b', { provider: 'claudeAgent', model: 'opus' }),
    ];
    expect(togetherWith(a, tasks)).toEqual([]);
  });

  it('uses the checklist defaults when matching an explicit choice', () => {
    const defaults = {
      aiProvider: 'codex',
      aiModel: 'sol',
      aiOptions: [{ id: 'reasoningEffort', value: 'high' }],
    };
    const a = task('a', 0);
    const b = task('b', 1, 'a', {
      provider: 'codex',
      model: 'sol',
      options: [{ id: 'reasoningEffort', value: 'high' }],
    });
    expect(togetherWith(a, [a, b], defaults)).toEqual([b]);
    expect(togetherWith(a, [a, b])).toEqual([]);
  });

  it('preserves provider, effort and fast-tier choices even for the same model', () => {
    const own = {
      provider: 'codex',
      model: 'sol',
      options: [
        { id: 'reasoningEffort', value: 'high' },
        { id: 'serviceTier', value: 'priority' },
      ],
    };
    const a = task('a', 0, null, own);
    const tasks = [
      a,
      task('provider', 1, 'a', { ...own, provider: 'another-codex' }),
      task('effort', 2, 'a', { ...own, options: [{ id: 'reasoningEffort', value: 'low' }] }),
      task('tier', 3, 'a', { ...own, options: [{ id: 'reasoningEffort', value: 'high' }] }),
      task('same', 4, 'a', { ...own, options: [...own.options].reverse() }),
    ];
    expect(togetherWith(a, tasks).map((t) => t.id)).toEqual(['same']);
  });

  it('does not confuse boolean options with text or inherit options into an explicit choice', () => {
    const a = task('a', 0, null, { provider: 'claudeAgent', model: 'opus', options: [] });
    const b = task('b', 1, 'a', { provider: 'claudeAgent', model: 'opus', options: null });
    expect(
      togetherWith(a, [a, b], {
        aiProvider: 'codex',
        aiModel: 'sol',
        aiOptions: [{ id: 'fastMode', value: true }],
      }),
    ).toEqual([b]);
    const boolean = task('boolean', 2, 'a', {
      provider: 'claudeAgent',
      model: 'opus',
      options: [{ id: 'fastMode', value: true }],
    });
    const text = task('text', 3, 'boolean', {
      provider: 'claudeAgent',
      model: 'opus',
      options: [{ id: 'fastMode', value: 'true' }],
    });
    expect(togetherWith(boolean, [boolean, text])).toEqual([]);
  });

  it('keeps work for an existing thread, final checks and ended tasks out of a new group', () => {
    const a = task('a', 0);
    const tasks = [
      a,
      task('send', 1, 'a', { sendPending: 'More work' }),
      task('final', 2, 'a', { kind: 'final' }),
      task('done', 3, 'a', { state: 'done' }),
      task('unrelated', 4),
    ];
    expect(togetherWith(a, tasks)).toEqual([]);
  });

  it('keeps a requested open pull request separate from automatic merging', () => {
    const a = task('a', 0);
    const b = task('b', 1, 'a', { mergeState: 'kept' });
    const c = task('c', 2, 'b', { mergeState: 'kept' });
    expect(togetherWith(a, [a, b, c])).toEqual([]);
    expect(togetherWith(b, [a, b, c])).toEqual([c]);
  });
});

describe('one thread leading the list', () => {
  it('leads every compatible task from the default branch too, not only the ones after it', () => {
    const a = task('a', 0);
    const tasks = [a, task('b', 1), task('c', 2, 'b'), task('d', 3, 'a'), task('e', 4, 'gone')];
    // e builds on a task outside the group (its own branch), so it waits for that one.
    expect(leadsWith(a, tasks).map((t) => t.id)).toEqual(['b', 'c', 'd']);
  });

  it('puts what a task builds on before it, even from later on the card', () => {
    const a = task('a', 0);
    const tasks = [a, task('c', 1, 'b'), task('b', 2), task('b1', 3, 'c')];
    expect(leadsWith(a, tasks).map((t) => t.id)).toEqual(['b', 'c', 'b1']);
  });

  it('leaves another AI, kept-open work and what builds on them for their own thread', () => {
    const a = task('a', 0);
    const tasks = [
      a,
      task('sol', 1, null, { provider: 'codex', model: 'sol' }),
      task('onSol', 2, 'sol'),
      task('kept', 3, null, { mergeState: 'kept' }),
      task('same', 4),
    ];
    expect(leadsWith(a, tasks).map((t) => t.id)).toEqual(['same']);
    expect(leadsWith(tasks[1] as (typeof tasks)[number], tasks)).toEqual([]);
  });

  it('keeps work for an existing thread, final checks, ended and unticked tasks out', () => {
    const a = task('a', 0);
    const tasks = [
      a,
      task('send', 1, null, { sendPending: 'More work' }),
      task('final', 2, null, { kind: 'final' }),
      task('done', 3, null, { state: 'done' }),
      task('unticked', 4, null, { picked: false }),
    ];
    expect(leadsWith(a, tasks)).toEqual([]);
  });
});

describe('members of a claimed task group', () => {
  it('finds every member before its thread exists', () => {
    const a = { id: 'a', groupId: 'group-a', threadId: null };
    const b = { id: 'b', groupId: 'group-a', threadId: null };
    const c = { id: 'c', groupId: 'group-c', threadId: null };
    expect(groupMembers(b, [a, b, c])).toEqual([a, b]);
  });

  it('falls back to a shared thread for older groups, never to a missing thread', () => {
    const a = { id: 'a', groupId: null, threadId: 'thread-a' };
    const b = { id: 'b', groupId: null, threadId: 'thread-a' };
    const c = { id: 'c', groupId: null, threadId: null };
    const d = { id: 'd', groupId: null, threadId: null };
    expect(groupMembers(b, [a, b, c, d])).toEqual([a, b]);
    expect(groupMembers(c, [a, b, c, d])).toEqual([c]);
  });

  it('does not pull a previous run into a new group because a thread id was retained', () => {
    const a = { id: 'a', groupId: 'new', threadId: 'old-thread' };
    const b = { id: 'b', groupId: 'old', threadId: 'old-thread' };
    const c = { id: 'c', groupId: null, threadId: 'old-thread' };
    expect(groupMembers(a, [a, b, c])).toEqual([a]);
  });
});
