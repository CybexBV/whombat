import { describe, expect, it } from 'vitest';
import {
  approvalKey,
  asksKey,
  endedKey,
  fitAnswer,
  ITEMS_PAGE,
  ITEMS_PAGES,
  joinPages,
  lastAnswerItemOf,
  lastAnswerOf,
  launchTitle,
  needsOf,
  pageOf,
  readFrom,
  readThread,
  seenOfCall,
  settlesWhenTold,
  threadStateOf,
  waitOf,
} from './threads';

const RUN = 'run:thread:mcp%3Athread-7:ordinal:1';

/** A `t3_thread_read` answer in T3 Code 0.1.3's shape (shortened). */
function read(over: Record<string, unknown> = {}, items: Record<string, unknown>[] = []) {
  return {
    thread: {
      threadId: 'mcp:thread-7',
      title: 'Fix the login bug',
      status: 'running',
      latestRunId: RUN,
      activeRunId: RUN,
      runCount: 1,
      itemCount: 6,
      pendingRequestCount: 0,
      ...over,
    },
    recentRuns: [{ runId: RUN, status: 'running', startedAt: '2026-11-01T10:00:00.000Z' }],
    items,
  };
}

describe('reading what a thread did since the last read', () => {
  /** A T3 Code thread of `count` items that pages as T3 Code does; every read it answered is kept. */
  function timeline(count: number) {
    const reads: Record<string, unknown>[] = [];
    const read = async (args: Record<string, unknown>) => {
      reads.push(args);
      const after = typeof args.afterPosition === 'number' ? args.afterPosition : -1;
      const limit = Number(args.limit);
      const rest = Array.from({ length: count }, (_, position) => ({
        position,
        itemId: `item-${position}`,
        type: 'reasoning',
        status: 'completed',
      })).filter((i) => i.position > after);
      const items = rest.slice(0, limit);
      return {
        thread: { threadId: 'mcp:thread-7', status: 'running', itemCount: count },
        recentRuns: [],
        items,
        nextPosition: items.at(-1)?.position ?? null,
        hasMore: rest.length > items.length,
      };
    };
    return { read, reads };
  }
  const positions = (body: Record<string, unknown>) =>
    (body.items as { position: number }[]).map((i) => i.position);

  it('starts a few items before the last read’s end, or where it stopped when more came', () => {
    // A new watch reads from the start; a job's first read from the latest items known.
    expect(readFrom(null, 0)).toBeNull();
    expect(readFrom(null, 30)).toBe(25);
    // Read to its end last time: the latest few again, so a running item's end and a waiting request are seen.
    expect(readFrom(29, 30)).toBe(25);
    // More came than a pass read: on from where it stopped.
    expect(readFrom(120, 400)).toBe(120);
    expect(readFrom(2, 3)).toBeNull();
  });

  it('reads every new item, page after page, and the state from the same read', async () => {
    const t = timeline(130);
    const got = await readThread(t.read, 'mcp:thread-7', 9, 10);
    expect(positions(got.body)).toEqual(Array.from({ length: 124 }, (_, i) => i + 6));
    expect(got.readTo).toBe(129);
    expect(got.latest).toBe(got.body);
    expect(got.backlog).toBe(false);
    expect(t.reads.map((r) => r.afterPosition)).toEqual([5, 5 + ITEMS_PAGE, 5 + 2 * ITEMS_PAGE]);
    expect(t.reads.every((r) => r.view === 'activity' && r.threadId === 'mcp:thread-7')).toBe(true);
  });

  it('reads at most a few pages a pass, the rest next pass, and the state from its latest items', async () => {
    const t = timeline(1000);
    const got = await readThread(t.read, 'mcp:thread-7', 99, 100);
    expect(t.reads).toHaveLength(ITEMS_PAGES + 1);
    expect(got.readTo).toBe(95 + ITEMS_PAGE * ITEMS_PAGES);
    expect(positions(got.body).at(-1)).toBe(got.readTo);
    expect(positions(got.latest as Record<string, unknown>)).toEqual([996, 997, 998, 999]);
    // Its track isn't whole yet: the job's end waits for the next pass.
    expect(got.backlog).toBe(true);
    // The next pass goes on after it.
    const next = timeline(1000);
    await readThread(next.read, 'mcp:thread-7', got.readTo, 1000);
    expect(next.reads[0]?.afterPosition).toBe(got.readTo);
  });

  it('starts a job on a long thread at its latest items', async () => {
    const t = timeline(600);
    const got = await readThread(t.read, 'mcp:thread-7', null, 0);
    expect(positions(got.body)).toEqual([596, 597, 598, 599]);
    expect(got.readTo).toBe(599);
  });

  it('keeps each item once when pages overlap', () => {
    const page = (from: number, to: number) => ({
      thread: { threadId: 'mcp:thread-7', itemCount: to + 1 },
      items: Array.from({ length: to - from + 1 }, (_, i) => ({ position: from + i })),
    });
    expect(positions(joinPages([page(0, 3), page(2, 5)]))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pageOf({ items: [{ position: 7 }], hasMore: true }, 7)).toEqual({ next: 7, more: false });
  });
});

const waiting = (type: string, text: string) => ({
  type,
  status: 'waiting',
  text,
  updatedAt: '2026-11-01T10:01:00.000Z',
});

describe('what a thread needs', () => {
  it('nothing while it works, its questions when one waits, its end once a run ended', () => {
    const at = (over: Record<string, unknown>, items: Record<string, unknown>[] = []) => {
      const s = threadStateOf(read(over, items));
      if (!s) throw new Error('unread');
      return needsOf(s);
    };
    expect(at({})).toEqual({ kind: 'nothing' });
    // T3 Code's `waiting` is a finished turn whose after-work still runs.
    expect(at({ status: 'waiting' })).toEqual({ kind: 'nothing' });
    expect(at({ pendingRequestCount: 1 }, [waiting('user_input_request', 'Which colour?')])).toEqual({
      kind: 'pending',
    });
    expect(at({ status: 'completed', activeRunId: null })).toEqual({ kind: 'ended', runId: RUN });
    expect(at({ status: 'failed' })).toEqual({ kind: 'ended', runId: RUN });
    const made = threadStateOf({
      ...read({ status: 'idle', runCount: 0, latestRunId: null }),
      recentRuns: [],
    });
    expect(made && needsOf(made)).toEqual({ kind: 'no_work' });
    // Idle after a run: that run ended.
    expect(at({ status: 'idle' })).toEqual({ kind: 'ended', runId: RUN });
    expect(threadStateOf({ thread: { status: 'running' } })).toBeNull();
  });

  it('keys each thing once: a run’s end, a set of questions in any order, a permission request', () => {
    expect(endedKey(RUN)).toBe(`done:${RUN}`);
    const long = (n: number) => `request-${n}-${'x'.repeat(400)}`;
    expect(asksKey([long(1), long(2)])).toBe(asksKey([long(2), long(1)]));
    expect(asksKey([long(1)])).not.toBe(asksKey([long(2)]));
    expect(asksKey([long(1)]).length).toBeLessThan(40);
    expect(approvalKey(RUN, 1)).not.toBe(approvalKey(RUN, 2));
  });

  it('reads the last answer, cut to what a turn reads', () => {
    expect(
      lastAnswerOf({
        items: [
          { type: 'user_message', text: 'Fix it.' },
          { type: 'assistant_message', text: 'Looking.' },
          { type: 'assistant_message', text: ' Fixed: the cookie expired early. ' },
        ],
      }),
    ).toBe('Fixed: the cookie expired early.');
    expect(lastAnswerOf({ items: [{ type: 'user_message', text: 'Fix it.' }] })).toBeNull();
    expect(lastAnswerOf({ items: [{ type: 'assistant_message', text: 'y'.repeat(5000) }] })?.length).toBe(
      4000,
    );
  });

  it('keeps the start and the end of a long answer, where its fixed lines are', () => {
    const long = `${'Looked at the cards.\n'.repeat(800)}Item 2: not done, no room left.\nChecks: passing\nScore: 8/10`;
    const cut = fitAnswer(long, 4000);
    expect(cut.length).toBeLessThanOrEqual(4000);
    expect(cut.startsWith('Looked at the cards.')).toBe(true);
    expect(cut).toContain('\n…\n');
    expect(cut.endsWith('Item 2: not done, no room left.\nChecks: passing\nScore: 8/10')).toBe(true);
    // The end starts at a whole line.
    expect(cut.split('\n…\n')[1]?.startsWith('Looked at the cards.')).toBe(true);
    expect(fitAnswer('Short.', 4000)).toBe('Short.');
  });

  it('says where a cut-off answer goes on', () => {
    expect(
      lastAnswerItemOf({
        items: [
          { type: 'assistant_message', itemId: 'i-1', text: 'Looking.' },
          { type: 'assistant_message', itemId: 'i-2', text: 'Done', textTruncated: true, nextTextOffset: 4 },
          { type: 'assistant_message', itemId: 'i-3', text: '  ' },
        ],
      }),
    ).toEqual({ itemId: 'i-2', text: 'Done', more: 4 });
    expect(
      lastAnswerItemOf({ items: [{ type: 'assistant_message', itemId: 'i', text: 'All of it.' }] }),
    ).toEqual({
      itemId: 'i',
      text: 'All of it.',
      more: null,
    });
  });

  it('reads a wait: timed out, or the run with the final answer', () => {
    expect(waitOf({ threadId: 't', runId: RUN, status: 'completed', timedOut: false })).toEqual({
      timedOut: false,
      runId: RUN,
      status: 'completed',
    });
    expect(waitOf({ runId: RUN, status: 'completed', timedOut: false, resultRun: 'run-2' }).runId).toBe(
      'run-2',
    );
    expect(
      waitOf({ runId: RUN, status: 'completed', timedOut: false, resultRun: { runId: 'run-3' } }).runId,
    ).toBe('run-3');
    expect(waitOf({ runId: RUN, status: 'running', timedOut: true }).timedOut).toBe(true);
  });
});

describe('what the agent’s own calls mean', () => {
  it('hands a thread work when it starts it, messages it or answers it; ends the watch when it stops it', () => {
    expect(
      seenOfCall(
        't3_thread_launch',
        { projectId: 'p', title: 'Fix it' },
        {
          threadId: 'mcp:thread-7',
          link: '[Fix the login bug](t3-thread://v1/mcp:thread-7)',
          status: 'preparing',
        },
      ),
    ).toEqual({ how: 'arm', threadId: 'mcp:thread-7', title: 'Fix the login bug' });
    expect(seenOfCall('t3_thread_launch', { title: 'Fix it' }, { threadId: 'mcp:thread-7' })).toMatchObject({
      title: 'Fix it',
    });
    expect(
      seenOfCall('t3_thread_send', { threadId: 'mcp:thread-7', message: 'Also…' }, { ok: true }),
    ).toEqual({
      how: 'arm',
      threadId: 'mcp:thread-7',
      title: null,
    });
    expect(
      seenOfCall(
        't3_pending_request',
        { action: 'respond', threadId: 'mcp:thread-7', requestId: 'r', answers: {} },
        { sequence: 7 },
      ),
    ).toMatchObject({ how: 'arm' });
    expect(seenOfCall('t3_thread_interrupt', { threadId: 'mcp:thread-7' }, {})).toEqual({
      how: 'stop',
      threadId: 'mcp:thread-7',
    });
  });

  it('counts as seen what a wait, a read or a list of questions showed it', () => {
    expect(
      seenOfCall(
        't3_thread_wait',
        { threadId: 'mcp:thread-7' },
        { runId: RUN, status: 'completed', timedOut: false },
      ),
    ).toEqual({ how: 'seen', threadId: 'mcp:thread-7', key: endedKey(RUN) });
    expect(
      seenOfCall(
        't3_thread_wait',
        { threadId: 'mcp:thread-7' },
        { runId: RUN, status: 'running', timedOut: true },
      ),
    ).toBeNull();
    expect(seenOfCall('t3_thread_read', {}, read({ status: 'completed' }))).toEqual({
      how: 'seen',
      threadId: 'mcp:thread-7',
      key: endedKey(RUN),
    });
    expect(
      seenOfCall(
        't3_thread_read',
        {},
        read({ pendingRequestCount: 1 }, [waiting('approval_request', 'Write a.txt')]),
      ),
    ).toEqual({ how: 'seen', threadId: 'mcp:thread-7', key: approvalKey(RUN, 1) });
    // A question's key needs its ids: a read alone doesn't see it.
    expect(
      seenOfCall(
        't3_thread_read',
        {},
        read({ pendingRequestCount: 1 }, [waiting('user_input_request', 'Which?')]),
      ),
    ).toBeNull();
    expect(
      seenOfCall(
        't3_pending_request',
        { action: 'list', threadId: 'mcp:thread-7' },
        { requestIds: ['a', 'b'] },
      ),
    ).toEqual({ how: 'seen', threadId: 'mcp:thread-7', key: asksKey(['b', 'a']) });
    expect(
      seenOfCall('t3_pending_request', { action: 'list', threadId: 'mcp:thread-7' }, { requestIds: [] }),
    ).toBeNull();
    expect(seenOfCall('t3_project_list', {}, { projects: [] })).toBeNull();
  });
});

describe('a thread the agent starts', () => {
  it('carries its name first, once', () => {
    expect(launchTitle('Dusty', 'Fix the login bug')).toBe('Dusty - Fix the login bug');
    expect(launchTitle('Dusty', '  Dusty: Fix the login bug ')).toBe('Dusty - Fix the login bug');
    expect(launchTitle('Dusty', 'dusty – Fix it')).toBe('Dusty - Fix it');
    expect(launchTitle('Dusty', 'Dusty - Fix it')).toBe('Dusty - Fix it');
    expect(launchTitle('Dusty', 'Dustbin cleanup')).toBe('Dusty - Dustbin cleanup');
    expect(launchTitle('Dusty', ' ')).toBe(' ');
  });

  it('is settled when its work completed, never when it failed or was stopped', () => {
    expect(settlesWhenTold('completed')).toBe(true);
    expect(settlesWhenTold('idle')).toBe(true);
    expect(settlesWhenTold('failed')).toBe(false);
    expect(settlesWhenTold('interrupted')).toBe(false);
    expect(settlesWhenTold(null)).toBe(false);
  });
});
