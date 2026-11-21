/**
 * Cards that settle into a line, on the phone (docs/decisions/card-settle.md AP-730…AP-733): the chat view model's
 * display switch, the settled lines and what a run did folded into it.
 */
import type { Message, MessageCard, Run } from '@whombat/core';
import { approval, dusty, mara, run } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { worldContext } from '../test/world';
import { cardSummary, chatItems, settledLine } from './messages';

const ctx = worldContext();

const changed = (o: Partial<Run> = {}): Run =>
  ({
    ...run,
    id: 'run_a',
    number: 7,
    diff: { add: 12, del: 8, files: 3 },
    prNumber: 3,
    attention: null,
    ...o,
  }) as Run;

function msg(id: string, card: MessageCard | null, authorId = dusty.id): Message {
  return {
    id,
    conversationId: 'cnv_dm-dusty',
    authorId,
    createdAt: '2026-09-23T09:00:00.000Z',
    editedAt: null,
    text: '',
    mentions: [],
    reactions: [],
    attachments: [],
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
    card,
    suggestions: [],
    more: null,
  } as Message;
}

/** A turn the agent scheduled in a run (RA-30): folded into that run (AP-732). */
const scheduled = (runId: string | null): MessageCard =>
  ({
    kind: 'schedule',
    scheduleId: 'sch_1',
    runId,
    schedule: {
      id: 'sch_1',
      agentId: dusty.id,
      prompt: 'Check that PR #4 was merged.',
      when: { kind: 'at', at: '2026-09-23T13:23:00.000Z' },
      status: 'active',
      endedReason: null,
      nextAt: '2026-09-23T13:23:00.000Z',
      endsAt: null,
      runs: 0,
      lastRunAt: null,
    },
  }) as unknown as MessageCard;

describe('a run by its state (AP-730, AP-733)', () => {
  it('is the compact live card while it works and a line with its chips once done', () => {
    const live = cardSummary({ kind: 'run', run: changed({ status: 'live', progress: 62 }) }, ctx);
    expect(live?.runLine).toBeNull();
    expect(live?.runSettled).toMatchObject({
      title: 'Run #7 · Address review on PR #482',
      now: `Now: ${run.activity}`,
      link: 'Watch ›',
      progress: 62,
      chips: { prNumber: 3, diff: '+12 −8' },
    });
    const done = cardSummary(
      {
        kind: 'run',
        run: changed({ status: 'done', finishedAt: '2026-09-23T09:28:12.000Z', summary: 'Fixed.' }),
      },
      ctx,
    );
    expect(done?.runSettled?.line).toEqual({ lead: 'Run #7 · Done in 6m 12s', detail: 'Fixed.', tone: 'ok' });
    expect(done?.runSettled?.link).toBe('Open ›');
  });

  it('keeps the run line for a run that changed nothing', () => {
    const quiet = cardSummary(
      { kind: 'run', run: changed({ diff: { add: 0, del: 0, files: 0 }, prNumber: null }) },
      ctx,
    );
    expect(quiet?.runLine).not.toBeNull();
    expect(quiet?.runSettled).toBeNull();
  });
});

describe('settled lines (AP-731)', () => {
  it('is a line only once the card is settled', () => {
    expect(settledLine({ kind: 'approval', approval }, ctx, dusty.id)).toBeNull();
    const decided = {
      ...approval,
      state: 'approved' as const,
      decidedById: mara.id,
      execution: { ...approval.execution, state: 'succeeded' as const },
    };
    expect(settledLine({ kind: 'approval', approval: decided }, ctx, dusty.id)).toEqual({
      lead: 'Approved by Mara Okafor',
      detail: decided.title,
      tone: 'ok',
    });
    expect(settledLine(scheduled('run_a'), ctx, dusty.id)?.lead).toMatch(/^Once, /);
  });
});

describe('what a run did, inside it (AP-732)', () => {
  it('folds a scheduled turn under its run and leaves its own row out', () => {
    const items = chatItems(
      [msg('m1', { kind: 'run', run: changed({ status: 'done' }) }), msg('m2', scheduled('run_a'))],
      ctx,
      { authors: true },
    );
    expect(items.map((i) => i.id)).toEqual(['m1']);
    expect(items[0]?.inside.map((s) => s.id)).toEqual(['m2']);
    expect(items[0]?.inside[0]?.card?.kind).toBe('schedule');
  });

  it('keeps a scheduled turn whose run isn’t in the list as a row of its own', () => {
    const items = chatItems(
      [msg('m1', { kind: 'run', run: changed({ status: 'done' }) }), msg('m3', scheduled('run_elsewhere'))],
      ctx,
      { authors: true },
    );
    expect(items.map((i) => [i.id, i.display])).toEqual([
      ['m1', 'line'],
      ['m3', 'line'],
    ]);
    expect(items[0]?.inside).toEqual([]);
  });

  it('gives the next visible message its author line after a folded one', () => {
    const items = chatItems(
      [
        msg('m1', { kind: 'run', run: changed({ status: 'done' }) }),
        msg('m2', scheduled('run_a')),
        { ...msg('m3', null, mara.id), text: 'Thanks' },
        { ...msg('m4', null, dusty.id), text: 'You’re welcome' },
      ],
      ctx,
      { authors: true },
    );
    expect(items.map((i) => [i.id, i.showAuthor])).toEqual([
      ['m1', true],
      ['m3', true],
      ['m4', true],
    ]);
  });
});
