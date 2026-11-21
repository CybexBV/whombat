import { describe, expect, it } from 'vitest';
import type { CouncilMemberRow } from '../db/schema/councils';
import { childrenOf, childState, historyOf, placeChild, standingOf } from './lead';
import { T3_COUNCIL } from './members';

const SEATS = [
  { provider: 'codex', providerName: 'Codex', model: 'gpt-6.1-sol', label: 'GPT 6.1 Sol', options: [] },
  {
    provider: 'claudeAgent',
    providerName: 'Claude',
    model: 'claude-fable-5-2',
    label: 'Claude Fable 5.2',
    options: [],
  },
  {
    provider: 'muse',
    providerName: 'Muse Code',
    model: 'muse-wonder-full-1.0',
    label: 'Muse Wonder Full 1.0',
    options: [],
  },
];

const LEAD = 'thread:project:p1:lead';
const listed = (over: Record<string, unknown>) => ({
  threadId: 'c1',
  title: 'Council · GPT 6.1 Sol · look 1',
  status: 'running',
  providerInstanceId: 'codex',
  model: 'gpt-6.1-sol',
  itemCount: 3,
  createdAt: '2026-11-13T10:00:00.000Z',
  updatedAt: '2026-11-13T10:01:00.000Z',
  parentThreadId: LEAD,
  relationshipToParent: 'subagent',
  ...over,
});

let n = 0;
function row(over: Partial<CouncilMemberRow>): CouncilMemberRow {
  n += 1;
  return {
    id: `m${n}`,
    role: 'member',
    stage: 'research',
    round: 1,
    position: 0,
    model: 'gpt-6.1-sol',
    state: 'done',
    score: null,
    verdict: null,
    startedAt: new Date(Date.UTC(2026, 10, 13, 10, 0, n)),
    label: 'GPT 6.1 Sol',
    provider: 'codex',
    providerName: 'Codex',
    ...over,
  } as CouncilMemberRow;
}

describe('the lead thread’s children', () => {
  it('are its subagent threads only, oldest first', () => {
    const body = {
      threads: [
        listed({ threadId: 'late', createdAt: '2026-11-13T10:05:00.000Z' }),
        listed({ threadId: 'other', parentThreadId: 'thread:project:p1:someone-else' }),
        listed({ threadId: 'own', relationshipToParent: null }),
        listed({ threadId: 'early' }),
      ],
    };
    expect(childrenOf(body, LEAD).map((c) => c.threadId)).toEqual(['early', 'late']);
    expect(childrenOf({}, LEAD)).toEqual([]);
  });

  it('leave out a subagent of the lead’s own AI program, which rests forever', () => {
    const body = { threads: [listed({ threadId: 'native', creationSource: 'provider', status: 'idle' })] };
    expect(childrenOf(body, LEAD)).toEqual([]);
    expect(childrenOf({ threads: [listed({ threadId: 'task', creationSource: 'mcp' })] }, LEAD)).toHaveLength(
      1,
    );
  });

  it('leave out a helper the lead started for its own work', () => {
    const body = {
      threads: [
        listed({ threadId: 'helper', title: 'Make the buttons taller' }),
        listed({ threadId: 'named', title: 'Council · GPT 6.1 Sol · check 1' }),
        listed({ threadId: 'loose', title: 'Design review (Muse)' }),
      ],
    };
    expect(
      childrenOf(body, LEAD)
        .map((c) => c.threadId)
        .sort(),
    ).toEqual(['loose', 'named']);
  });

  it('end as T3 Code says their status', () => {
    expect(childState('completed')).toBe('done');
    expect(childState('failed')).toBe('failed');
    expect(childState('cancelled')).toBe('stopped');
    for (const status of ['running', 'queued', 'preparing', 'waiting', 'idle'])
      expect(childState(status)).toBe('working');
  });
});

describe('placing a reviewer', () => {
  const council = { seats: SEATS, kind: 'improve' as const, stage: 'research' as const };
  const [child] = childrenOf({ threads: [listed({})] }, LEAD);
  if (!child) throw new Error('no child');

  it('takes its seat from its model and its round from its title', () => {
    expect(
      placeChild(council, [], {
        ...child,
        title: 'Council · Claude Fable 5.2 · plan 2',
        provider: 'claudeAgent',
        model: 'claude-fable-5-2',
      }),
    ).toMatchObject({
      stage: 'agree',
      round: 2,
      position: 1,
      label: 'Claude Fable 5.2',
    });
  });

  it('takes the seat its title names when T3 Code says another model', () => {
    expect(
      placeChild(council, [], {
        ...child,
        title: 'Council · Muse Wonder Full 1.0 · look 1',
        provider: 'muse',
        model: 'default',
      }),
    ).toMatchObject({
      position: 2,
      model: 'muse-wonder-full-1.0',
    });
  });

  it('counts rounds itself when the title says nothing: a look first, then the plan, then checks once it builds', () => {
    const untitled = { ...child, title: 'Review' };
    expect(placeChild(council, [], untitled)).toMatchObject({ stage: 'research', round: 1, position: 0 });
    const looked = [row({ stage: 'research', round: 1 })];
    expect(placeChild(council, looked, untitled)).toMatchObject({ stage: 'agree', round: 1 });
    expect(
      placeChild({ ...council, stage: 'build' }, [...looked, row({ stage: 'agree', round: 1 })], untitled),
    ).toMatchObject({ stage: 'check', round: 1 });
  });

  it('seats two reviewers on one model on the two seats that run it', () => {
    const twice = {
      ...council,
      seats: [
        { ...SEATS[0], label: 'GPT 6.1 Sol (high)' },
        { ...SEATS[0], label: 'GPT 6.1 Sol (xhigh)' },
        SEATS[1],
      ] as typeof SEATS,
    };
    // By the seat its title names, else the one still free in its round, else the one with fewer rows.
    expect(
      placeChild(twice, [], { ...child, title: 'Council · GPT 6.1 Sol (xhigh) · look 1' }).position,
    ).toBe(1);
    const taken = [row({ position: 0, stage: 'research', round: 1 })];
    expect(placeChild(twice, taken, { ...child, title: 'Council · Sol · look 1' }).position).toBe(1);
    expect(placeChild(twice, taken, { ...child, title: 'Review' })).toMatchObject({
      position: 1,
      stage: 'research',
    });
  });

  it('gives a model on no seat a place after the seats, and the same one each round', () => {
    const stray = { ...child, title: 'Council · Extra · look 1', provider: 'grok', model: 'grok-build' };
    const first = placeChild(council, [], stray);
    expect(first).toMatchObject({ position: 3, label: 'Extra', providerName: 'grok' });
    const known = [row({ position: 3, model: 'grok-build' })];
    expect(placeChild(council, known, { ...stray, title: 'Council · Extra · plan 1' }).position).toBe(3);
  });

  it('in T3 Code’s own council, sits a new model on its company’s empty seat', () => {
    const t3 = { ...council, setupName: T3_COUNCIL };
    const astra = {
      ...child,
      title: 'Council · GPT 6 Astra · look 1',
      provider: 'codex',
      model: 'gpt-6-astra',
    };
    expect(placeChild(t3, [], astra)).toMatchObject({
      position: 0,
      model: 'gpt-6-astra',
      label: 'GPT 6 Astra',
      stage: 'research',
      round: 1,
    });
    // Once that seat has a reviewer, another model of the company sits after the seats.
    const sat = [row({ position: 0, model: 'gpt-6.1-sol' })];
    expect(placeChild(t3, sat, astra).position).toBe(3);
    // A council with the person's own seats keeps them.
    expect(placeChild(council, [], astra).position).toBe(3);
  });
});

describe('where a council is', () => {
  const council = {
    kind: 'improve' as const,
    stage: 'research' as const,
    round: 1,
    okAt: new Date(),
    roundsMax: 3,
    target: 9,
  };
  const lead = (state: CouncilMemberRow['state']) =>
    row({ role: 'builder', stage: 'build', state, position: 3 });

  it('is the round at work', () => {
    const members = [row({}), row({ stage: 'agree', state: 'working', position: 1 }), lead('working')];
    expect(standingOf(council, members)).toMatchObject({
      stage: 'agree',
      round: 1,
      agreeRounds: 1,
      checkRounds: 0,
    });
  });

  it('builds once the plan is agreed and the person said go', () => {
    const agreed = [row({}), row({ stage: 'agree', verdict: 'agree' }), lead('working')];
    expect(standingOf(council, agreed).stage).toBe('build');
    // Without the go-ahead it doesn't build, whatever the reviewers said.
    expect(standingOf({ ...council, okAt: null }, agreed).stage).toBe('agree');
    // Changes wanted: the lead is on the plan again.
    expect(
      standingOf(council, [row({}), row({ stage: 'agree', verdict: 'changes' }), lead('working')]).stage,
    ).toBe('agree');
  });

  it('fixes after a check below the target, and stays on a check that reached it', () => {
    const below = [row({ stage: 'check', score: 7, verdict: 'changes' }), lead('working')];
    expect(standingOf(council, below)).toMatchObject({ stage: 'build', round: 2, checkRounds: 1 });
    const reached = [row({ stage: 'check', score: 9, verdict: 'agree' }), lead('working')];
    expect(standingOf(council, reached).stage).toBe('check');
  });

  it('takes a round nobody answered as no agreement, and a check without a score as not reached', () => {
    const none = [row({}), row({ stage: 'agree', state: 'failed' }), lead('working')];
    expect(standingOf(council, none).stage).toBe('agree');
    const unscored = [row({ stage: 'check', score: null, verdict: null }), lead('working')];
    expect(standingOf(council, unscored).stage).toBe('build');
  });

  it('keeps waiting for the go-ahead, and keeps building, with no reviewer at work', () => {
    const members = [row({ stage: 'agree', verdict: 'agree' }), lead('done')];
    expect(standingOf({ ...council, stage: 'approve' }, members).stage).toBe('approve');
    expect(standingOf({ ...council, stage: 'build' }, members).stage).toBe('build');
  });

  it('keeps every round that is in, oldest first', () => {
    const members = [
      row({ stage: 'research', score: 6 }),
      row({ stage: 'research', score: 7, position: 1 }),
      row({ stage: 'agree', verdict: 'agree' }),
      row({ stage: 'check', state: 'working' }),
      lead('working'),
    ];
    const history = historyOf(members);
    expect(history.map((r) => [r.stage, r.round, r.members.length])).toEqual([
      ['research', 1, 2],
      ['agree', 1, 1],
    ]);
    expect(history[0]?.members.map((m) => m.score)).toEqual([6, 7]);
  });
});
