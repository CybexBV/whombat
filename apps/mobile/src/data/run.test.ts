import type { RunDetail } from '@whombat/core';
import { BASE_LOG_LINES, bootstrap, RUN_LOG_LINES, run } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { worldContext } from '../test/world';
import { cardSummary } from './messages';
import { runControlButtons, runControlRefusal, runScreen } from './run';

const conversation = bootstrap().sidebar.branchRooms.find((c) => c.id === run.conversationId);
if (!conversation) throw new Error('fixture: PR #482’s room');

const detail = (over: Partial<RunDetail> = {}): RunDetail => ({
  run,
  log: BASE_LOG_LINES,
  grants: [],
  conversation,
  ...over,
});

describe('run screen', () => {
  it('drops log lines left over from before a demo rewind, and says who paused', () => {
    const model = runScreen(
      detail({ run: { ...run, status: 'paused', logCount: 3 }, log: RUN_LOG_LINES }),
      worldContext(),
    );
    expect(model.log.map((l) => l.seq)).toEqual([0, 1, 2]);
    expect(model).toMatchObject({ label: 'RUN · PAUSED', dot: 'warn', live: true });
    expect(model.steps[0]?.marker).toBe('paused');
    const mine = runScreen(detail({ run: { ...run, askedById: 'prn_mara' } }), worldContext());
    expect(mine.askedBy).toBe(`Asked by you in ${conversation.title}`);
  });

  it('says why a live run needs a person, and nothing once it moves on (CT-197, AP-597)', () => {
    const text = 'Dusty stopped without finishing this run.';
    expect(runScreen(detail({ run: { ...run, attention: text } }), worldContext()).attention).toBe(text);
    expect(runScreen(detail({ run: { ...run, attention: null } }), worldContext()).attention).toBeNull();
    expect(runScreen(detail(), worldContext()).attention).toBeNull();
    expect(
      runScreen(detail({ run: { ...run, status: 'done', attention: text } }), worldContext()).attention,
    ).toBeNull();
  });

  it('puts the attention line on the run card in warn (CT-197, AP-597)', () => {
    const text = 'Dusty stopped without finishing this run.';
    const live = cardSummary({ kind: 'run', run: { ...run, attention: text } }, worldContext());
    expect(live).toMatchObject({ detail: `Needs attention · ${text}`, tone: 'warn' });
    const plain = cardSummary({ kind: 'run', run }, worldContext());
    expect(plain).toMatchObject({ detail: `Now: ${run.activity}`, tone: 'ok' });
  });

  it('shows a run that changed nothing as the run line, and one with changes as the card (AP-668)', () => {
    const quiet = { ...run, diff: { add: 0, del: 0, files: 0 }, prNumber: null, attention: null };
    expect(cardSummary({ kind: 'run', run: quiet }, worldContext())?.runLine).toEqual({
      lead: 'Checking',
      detail: run.activity,
      tone: 'live',
      runNumber: run.number,
      live: true,
      progress: run.progress,
      link: 'Watch ›',
      retry: false,
      agentName: 'Dusty',
    });
    expect(cardSummary({ kind: 'run', run }, worldContext())?.runLine).toBeNull();
  });

  it('opens a run line that has stopped with “Open ›”, and watches a live one (AP-699)', () => {
    const quiet = { ...run, diff: { add: 0, del: 0, files: 0 }, prNumber: null, attention: null };
    const line = (status: (typeof run)['status']) =>
      cardSummary({ kind: 'run', run: { ...quiet, status } }, worldContext())?.runLine;
    expect(line('live')?.link).toBe('Watch ›');
    for (const status of ['failed', 'done', 'taken_over', 'paused'] as const) {
      expect(line(status)).toMatchObject({ link: 'Open ›', live: false });
    }
    expect(line('failed')?.lead).toMatch(/^Run #1907 · Failed/);
  });

  it('gives the run card its progress, diff and pull request, as the web does (AP-705)', () => {
    const card = cardSummary({ kind: 'run', run }, worldContext());
    expect(card?.run).toEqual({
      runNumber: 1907,
      live: true,
      progress: 55,
      attention: false,
      diff: { add: '+214', del: '−12', files: '6 files' },
      pr: 'PR #482',
      prNumber: 482,
      retry: false,
      agentName: 'Dusty',
    });
    const needs = cardSummary({ kind: 'run', run: { ...run, attention: 'Dusty stopped.' } }, worldContext());
    expect(needs?.run?.attention).toBe(true);
    const noPr = cardSummary(
      { kind: 'run', run: { ...run, prNumber: null, status: 'done', progress: 140 } },
      worldContext(),
    );
    expect(noPr?.run).toMatchObject({ live: false, progress: 100, pr: null, prNumber: null });
    const prOnly = cardSummary(
      { kind: 'run', run: { ...run, diff: { add: 0, del: 0, files: 0 } } },
      worldContext(),
    );
    expect(prOnly?.run).toMatchObject({ diff: null, pr: 'PR #482' });
    // A run line is not a card too.
    const quiet = { ...run, diff: { add: 0, del: 0, files: 0 }, prNumber: null };
    expect(cardSummary({ kind: 'run', run: quiet }, worldContext())?.run).toBeNull();
  });

  it('offers Try again on a failed run’s line and card (AP-705)', () => {
    const quiet = { ...run, diff: { add: 0, del: 0, files: 0 }, prNumber: null, attention: null };
    const summary = (r: typeof run) => cardSummary({ kind: 'run', run: r }, worldContext());
    expect(summary({ ...quiet, status: 'failed' })?.runLine?.retry).toBe(true);
    expect(summary({ ...quiet, status: 'done' })?.runLine?.retry).toBe(false);
    expect(summary({ ...run, status: 'failed' })?.run?.retry).toBe(true);
    expect(summary({ ...run, status: 'live' })?.run?.retry).toBe(false);
    expect(summary({ ...run, status: 'failed' })?.run?.live).toBe(false);
  });
});

describe('run controls on the phone (AP-711)', () => {
  const actions = (status: RunDetail['run']['status']) =>
    runControlButtons({ ...run, status }, 'Dusty').map((b) => b.label);

  it('the web’s rules: Pause while live, Resume while paused, Take over while it holds the branch', () => {
    expect(actions('live')).toEqual(['Pause', 'Take over']);
    expect(actions('paused')).toEqual(['Resume', 'Take over']);
    expect(actions('done')).toEqual([]);
    expect(actions('taken_over')).toEqual([]);
  });

  it('Try again only on a failed run', () => {
    expect(actions('failed')).toEqual(['Try again']);
  });

  it('asks before taking over, naming the branch, as the web’s dialog', () => {
    const take = runControlButtons({ ...run, status: 'live' }, 'Dusty').find((b) => b.action === 'take_over');
    expect(take?.variant).toBe('primary');
    expect(take?.confirm).toEqual({
      title: 'Take over Dusty’s run?',
      body: `Dusty stops now and hands you ${run.branch}. The steps and log so far stay on this page, and Dusty won’t push to the branch again.`,
      cta: 'Take over',
    });
    expect(runControlButtons({ ...run, status: 'live' }, 'Dusty')[0]?.confirm).toBeNull();
  });

  it('a refusal says its own sentence', () => {
    expect(runControlRefusal({ status: 'ok', data: {}, httpStatus: 200 })).toBeNull();
    expect(
      runControlRefusal({
        status: 'blocked',
        message: 'Needs Pause runs.',
        keyNeeded: {} as never,
        eventId: 'e',
      }),
    ).toBe('Needs Pause runs.');
    expect(
      runControlRefusal({ status: 'pending_approval', approvalId: 'a', approvalNumber: 3, eventId: 'e' }),
    ).toBe('That needs a person to approve first.');
  });
});

describe('a run card opens its run and its pull request (AP-712)', () => {
  it('carries the run’s number and PR', () => {
    const card = cardSummary({ kind: 'run', run: { ...run, prNumber: 482 } } as never, worldContext());
    expect(card?.run).toMatchObject({ runNumber: run.number, prNumber: 482, pr: 'PR #482' });
  });
});
