import type { CouncilCard, CouncilCardMember } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { attachmentsBesideCard, wordsUnderCard } from './cardDisplay';
import {
  COUNCIL_WORDS,
  councilCardView,
  councilElderPose,
  councilScoreTable,
  councilScoreText,
  councilStageLine,
} from './council';

const NOW = Date.parse('2026-11-05T12:10:00Z');

const member = (over: Partial<CouncilCardMember> = {}): CouncilCardMember => ({
  id: 'cnm_1',
  name: 'Claude Opus 5.5',
  provider: 'Claude',
  mark: 'claude',
  role: 'member',
  state: 'working',
  score: null,
  verdict: null,
  since: '2026-11-05T12:00:00Z',
  endedAt: null,
  step: null,
  url: null,
  ...over,
});

const card = (over: Partial<CouncilCard> = {}): CouncilCard => ({
  kind: 'council',
  councilId: 'cnl_1',
  what: 'improve',
  title: 'Improve the Settings page',
  stage: 'research',
  round: 1,
  roundsMax: 3,
  target: 9,
  live: true,
  members: [
    member(),
    member({ id: 'cnm_2', name: 'GPT 6.1 Sol', provider: 'Codex', mark: 'openai', state: 'done', score: 8 }),
    member({ id: 'cnm_3', name: 'Muse Wonder', provider: 'Muse Code', mark: null, state: 'no_answer' }),
  ],
  history: [],
  plan: null,
  shots: [],
  outcome: null,
  startedAt: '2026-11-05T12:00:00Z',
  endedAt: null,
  ...over,
});

describe('council card words', () => {
  it('says what the council does by stage and kind', () => {
    expect(councilStageLine(card())).toBe('Looking at it');
    expect(councilStageLine(card({ what: 'research' }))).toBe('Researching');
    expect(councilStageLine(card({ stage: 'agree', round: 2 }))).toBe('Agreeing on the plan · round 2 of 3');
    expect(councilStageLine(card({ stage: 'check' }))).toContain('aiming for 9/10');
    expect(councilStageLine(card({ stage: 'build', round: 2 }))).toContain('T3 Code');
  });

  it('draws each member with its mark, its state and how long it worked', () => {
    const view = councilCardView(card(), NOW);
    const [claude, codex, muse] = view.members;
    expect(claude).toMatchObject({ working: true, mark: 'claude', status: 'Working', elapsed: '10 min' });
    expect(codex).toMatchObject({ working: false, score: '8/10', status: '8/10' });
    expect(muse).toMatchObject({ muted: true, letter: 'M', mark: null, status: 'Didn’t answer' });
    // Only answers count: Muse didn't answer.
    expect(view.progress).toBe('1 of 3 answered');
    expect(view.stoppable).toBe(true);
  });

  it('seats each member’s elder by how it is doing', () => {
    const [claude, codex, muse] = councilCardView(card(), NOW).members;
    expect([claude?.pose, codex?.pose, muse?.pose]).toEqual(['thinking', 'answered', 'resting']);
    expect(councilElderPose({ state: 'done', verdict: 'agree' })).toBe('agrees');
    expect(councilElderPose({ state: 'done', verdict: 'changes' })).toBe('doubts');
    for (const state of ['failed', 'stopped', 'no_answer'] as const)
      expect(councilElderPose({ state, verdict: null })).toBe('resting');
  });

  it('opens a member’s answer on its row once it answered, and says when T3 Code has the rest', () => {
    const base = card();
    const members = base.members.map((m, i) =>
      i === 1 ? { ...m, answer: 'The buttons are cramped.' } : i === 0 ? { ...m, answer: 'x' } : m,
    );
    const view = councilCardView({ ...base, members }, NOW);
    expect(view.members[1]).toMatchObject({ answer: 'The buttons are cramped.', cut: false });
    // Still at work: nothing to read yet.
    expect(view.members[0]?.answer).toBeNull();
    const long = councilCardView(
      { ...base, members: members.map((m, i) => (i === 1 ? { ...m, answer: 'a'.repeat(6000) } : m)) },
      NOW,
    );
    expect(long.members[1]?.cut).toBe(true);
  });

  it('keeps a score table of every round', () => {
    const table = councilScoreTable([
      {
        stage: 'research',
        round: 1,
        members: [
          {
            name: 'Claude Opus 5.5',
            mark: 'claude',
            provider: 'Claude',
            state: 'done',
            score: 6,
            verdict: null,
          },
          {
            name: 'GPT 6.1 Sol',
            mark: 'openai',
            provider: 'Codex',
            state: 'done',
            score: 7.5,
            verdict: null,
          },
        ],
      },
      {
        stage: 'check',
        round: 1,
        members: [
          {
            name: 'Claude Opus 5.5',
            mark: 'claude',
            provider: 'Claude',
            state: 'done',
            score: 9,
            verdict: 'agree',
          },
          {
            name: 'GPT 6.1 Sol',
            mark: 'openai',
            provider: 'Codex',
            state: 'no_answer',
            score: null,
            verdict: null,
          },
        ],
      },
    ]);
    expect(table.columns).toEqual(['Look 1', 'Check 1']);
    // A review's round is called a review, a research's agreement “Agree”.
    expect(councilScoreTable([{ stage: 'research', round: 1, members: [] }], 'review').columns).toEqual([]);
    const reviewed = councilScoreTable(
      [
        {
          stage: 'research',
          round: 1,
          members: [{ name: 'A', mark: null, provider: 'P', state: 'done', score: 8, verdict: null }],
        },
      ],
      'review',
    );
    expect(reviewed.columns).toEqual(['Review 1']);
    expect(table.rows.map((r) => r.cells)).toEqual([
      ['6/10', '9/10'],
      ['7.5/10', 'Didn’t answer'],
    ]);
  });

  it('formats halves', () => {
    expect(councilScoreText(7)).toBe('7/10');
    expect(councilScoreText(8.5)).toBe('8.5/10');
  });

  it('leaves the card’s own pictures out of the message’s files', () => {
    const files = [{ id: 'att_shot' }, { id: 'att_log' }];
    const shot = {
      view: 'Settings · light',
      attachmentId: 'att_shot',
      width: 1440,
      height: 1800,
      areas: 1,
      notes: [{ n: 1, text: 'The buttons are taller.' }],
    };
    expect(attachmentsBesideCard(files, card({ live: false, shots: [shot] })).map((a) => a.id)).toEqual([
      'att_log',
    ]);
    expect(attachmentsBesideCard(files, card())).toBe(files);
    expect(attachmentsBesideCard(files, null)).toBe(files);
  });

  it('shows the agent’s latest words under a council’s card, and nothing under other cards', () => {
    expect(wordsUnderCard(card({ note: 'Waiting for Claude.' }))).toBe('Waiting for Claude.');
    expect(wordsUnderCard(card({ note: null }))).toBeNull();
    expect(wordsUnderCard(card({ note: undefined }))).toBeNull();
    expect(wordsUnderCard(null)).toBeNull();
    // A finished card's own status is its head's already; a live one's still shows.
    expect(wordsUnderCard(card({ live: false, note: 'The council finished.' }))).toBeNull();
    expect(wordsUnderCard(card({ live: true, note: 'The council finished.' }))).toBe('The council finished.');
  });
});

describe('the card’s controls', () => {
  it('asks before Stop, with Stop and Keep going', () => {
    expect(COUNCIL_WORDS.stopAsk.title).toContain('Stop');
    expect(COUNCIL_WORDS.stopAsk.keep).toBeTruthy();
    expect(COUNCIL_WORDS.readAnswer).not.toBe(COUNCIL_WORDS.hideAnswer);
  });
});
