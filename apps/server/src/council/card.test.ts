import { CouncilCard } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { CouncilMemberRow, CouncilRow, CouncilShotRow } from '../db/schema/councils';
import { councilCard, listOf, roundResult } from './card';

const at = (min: number) => new Date(Date.UTC(2026, 10, 5, 12, min));

const council = (over: Partial<CouncilRow> = {}): CouncilRow => ({
  id: 'cnl_one',
  burrowId: 'bur_1',
  conversationId: 'cnv_1',
  threadRootId: 'msg_root',
  agentId: 'prn_dusty',
  personId: 'prn_john',
  connectionId: 'con_t3',
  projectId: 'mcp:p',
  projectTitle: 'Demo',
  projectRoot: '/home/alex/demo',
  kind: 'improve',
  seats: [],
  builderSeat: 0,
  setupName: null,
  title: 'Improve the Settings page',
  question: 'Make it easier.',
  stage: 'research',
  round: 1,
  agreeRounds: 0,
  checkRounds: 0,
  roundsMax: 3,
  target: 9,
  goAllTheWay: false,
  okAt: null,
  plan: null,
  instructions: null,
  builderThreadId: null,
  builderWorktree: null,
  builderBranch: null,
  liveMessageId: 'msg_live',
  finalMessageId: null,
  uploadHash: null,
  uploadUntil: null,
  history: [],
  state: 'active',
  outcome: null,
  createdAt: at(0),
  updatedAt: at(0),
  endedAt: null,
  ...over,
});

const member = (over: Partial<CouncilMemberRow> = {}): CouncilMemberRow => ({
  id: 'cnm_1',
  councilId: 'cnl_one',
  burrowId: 'bur_1',
  role: 'member',
  stage: 'research',
  round: 1,
  position: 0,
  provider: 'claudeAgent',
  providerName: 'Claude',
  model: 'claude-opus-5-5',
  label: 'Claude Opus 5.5',
  options: [],
  threadId: 'mcp:t1',
  url: null,
  state: 'working',
  score: null,
  verdict: null,
  answer: null,
  step: null,
  dispatchId: null,
  stopPending: false,
  stopTries: 0,
  stopNextAt: null,
  startedAt: at(0),
  endedAt: null,
  deadline: at(60),
  ...over,
});

describe('the council card from its rows', () => {
  it('shows the round at work with each member’s mark and state', () => {
    const card = councilCard(
      council(),
      [
        member(),
        member({
          id: 'cnm_2',
          position: 1,
          provider: 'codex',
          providerName: 'Codex',
          label: 'GPT 6.1 Sol',
          state: 'done',
          score: 7.6,
        }),
      ],
      [],
    );
    expect(CouncilCard.safeParse(card).success).toBe(true);
    expect(card.live).toBe(true);
    expect(card.members.map((m) => [m.mark, m.state, m.score])).toEqual([
      ['claude', 'working', null],
      ['openai', 'done', 7.5],
    ]);
  });

  it('keeps the earlier rounds as scores and the builder beside the check', () => {
    const look = [member({ state: 'done', score: 6, endedAt: at(10) })];
    const card = councilCard(
      council({ stage: 'check', round: 1, history: [roundResult('research', 1, look)] }),
      [
        ...look,
        member({ id: 'cnm_b', role: 'builder', stage: 'build', round: 1, state: 'done', startedAt: at(20) }),
        member({ id: 'cnm_c', stage: 'check', round: 1, startedAt: at(40) }),
      ],
      [],
    );
    expect(card.history.map((r) => r.stage)).toEqual(['research']);
    // The lead runs the council and never sits at the table.
    expect(card.members.map((m) => m.role)).toEqual(['member']);
  });

  it('seats every member from the start, getting ready until its reviewer starts', () => {
    const seat = (label: string, provider: string) => ({
      provider,
      providerName: provider,
      model: label,
      label,
      options: [],
    });
    const seats = [
      seat('GPT 6.1 Sol', 'codex'),
      seat('Claude Fable 5.2', 'claudeAgent'),
      seat('Muse', 'muse'),
    ];
    const lead = member({ id: 'cnm_lead', role: 'builder', stage: 'build', position: 3 });
    const start = councilCard(council({ seats }), [lead], []);
    expect(CouncilCard.safeParse(start).success).toBe(true);
    expect(start.members.map((m) => [m.name, m.waiting])).toEqual([
      ['GPT 6.1 Sol', true],
      ['Claude Fable 5.2', true],
      ['Muse', true],
    ]);
    // The second seat's reviewer started: it takes its place, the others still getting ready.
    const later = councilCard(
      council({ seats }),
      [lead, member({ position: 1, label: 'Claude Fable 5.2' })],
      [],
    );
    expect(later.members.map((m) => [m.name, m.waiting ?? false])).toEqual([
      ['GPT 6.1 Sol', true],
      ['Claude Fable 5.2', false],
      ['Muse', true],
    ]);
    // Once it ended, only who took part.
    expect(councilCard(council({ seats, state: 'done' }), [lead], []).members).toEqual([]);
  });

  it('shows a screen once its picture is drawn, with notes only for its areas', () => {
    const shot: CouncilShotRow = {
      councilId: 'cnl_one',
      burrowId: 'bur_1',
      view: 'Settings · light',
      position: 0,
      beforeId: 'att_b',
      afterId: 'att_a',
      compareId: 'att_c',
      width: 1440,
      height: 1824,
      areas: [{ n: 1, x: 10, y: 10, w: 100, h: 40, where: 'top left' }],
      notes: [
        { n: 1, text: 'The buttons are taller.' },
        { n: 2, text: 'An area that is gone.' },
      ],
      updatedAt: at(50),
    };
    const card = councilCard(
      council({ state: 'done', stage: 'done', outcome: 'done', endedAt: at(55) }),
      [],
      [shot, { ...shot, view: 'Not drawn', compareId: null }],
    );
    expect(card.live).toBe(false);
    expect(card.shots).toEqual([
      expect.objectContaining({
        view: 'Settings · light',
        attachmentId: 'att_c',
        areas: 1,
        notes: [{ n: 1, text: 'The buttons are taller.' }],
      }),
    ]);
  });

  it('carries the agent’s words under the card, none until it writes some', () => {
    expect(councilCard(council(), [member()], []).note).toBeNull();
    const card = councilCard(council(), [member()], [], 'Claude gives it 7.');
    expect(CouncilCard.safeParse(card).success).toBe(true);
    expect(card.note).toBe('Claude gives it 7.');
  });

  it('lists names as a person says them', () => {
    expect(listOf(['Claude', 'GPT 6.1 Sol', 'Muse'])).toBe('Claude, GPT 6.1 Sol and Muse');
    expect(listOf(['Claude', 'Codex'])).toBe('Claude and Codex');
  });
});
