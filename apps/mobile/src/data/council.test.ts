/**
 * The council card on the phone (council.md): shown whole under the agent's words, its
 * members' rows with their answers and buttons from the shared view, the plan folded, a builder's row of an older
 * Whombat, and the final card's scores and pictures — whose attachments the message's own row leaves out.
 */
import { ApiError, COUNCIL_WORDS, PROBLEM_WORDS } from '@whombat/client';
import type { Attachment, CouncilCard, Message } from '@whombat/core';
import { DM_DUSTY_MESSAGES } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { COUNCIL_ROOTS, COUNCIL_SHOT_ATTACHMENT, councilThreads } from '../fixtures/council';
import { worldContext } from '../test/world';
import { councilActionProblem, councilItem, councilNextTick } from './council';
import { cardSummary, chatItems } from './messages';

const base = DM_DUSTY_MESSAGES[1] as Message;
const ctx = worldContext();
const made = ctx.now.getTime();
const threads = councilThreads(made);

/** The council message of a fixture thread, as the server sends it. */
function councilMessage(rootId: string): Message {
  const reply = threads.find((t) => t.id === rootId)?.replies.find((r) => r[3]);
  if (!reply?.[3]) throw new Error(`no council in ${rootId}`);
  const [, , text, extra] = reply;
  return {
    ...base,
    id: `msg_${rootId.slice(4)}-card` as Message['id'],
    text,
    card: extra.card,
    attachments: [...(extra.attachments ?? []), NOTES],
  };
}

/** Another file on the same message, which its own row still shows. */
const NOTES: Attachment = {
  id: 'att_council-notes' as Attachment['id'],
  name: 'notes.txt',
  contentType: 'text/plain',
  size: 120,
  url: '/api/v1/burrows/burrow-hq/attachments/att_council-notes',
  kind: 'text',
  width: null,
  height: null,
};

const itemOf = (rootId: string) => chatItems([councilMessage(rootId)], ctx, { authors: true })[0];

describe('a council at work (CNL-40)', () => {
  it('is shown whole, under what the agent asked and over its latest thoughts, never as a summary card', () => {
    const item = itemOf(COUNCIL_ROOTS.review);
    expect(item?.council).not.toBeNull();
    expect(item?.display).toBe('full');
    expect(item?.card).toBeNull();
    expect(item?.text).toContain('asked Claude, ChatGPT and Muse');
    expect(item?.council?.card.note).toContain('Waiting for Claude');
    expect(cardSummary(councilMessage(COUNCIL_ROOTS.review).card ?? null, ctx)).toBeNull();
  });

  it('has a row per member: one working with its time, one with its score, one muted', () => {
    const view = itemOf(COUNCIL_ROOTS.review)?.council?.view;
    expect(view?.heading).toContain('Review the NAS backup plan');
    expect(view?.stage).toBe(COUNCIL_WORDS.firstRound.review);
    // Only answers count: Muse didn't answer.
    expect(view?.progress).toContain('1 of 3');
    const [claude, gpt, muse] = view?.members ?? [];
    expect(claude).toMatchObject({ working: true, mark: 'claude', status: COUNCIL_WORDS.states.working });
    expect(claude?.elapsed).toBe('22 min');
    expect(gpt).toMatchObject({ working: false, mark: 'openai', score: '8/10' });
    expect(muse).toMatchObject({ muted: true, mark: null, letter: 'M' });
    expect(view?.stoppable).toBe(true);
    expect(itemOf(COUNCIL_ROOTS.review)?.council).toMatchObject({ ticking: true, plan: null, pictures: [] });
  });

  it('opens an answer on its member’s row once it is in, with its T3 Code thread when the card has only its start', () => {
    const [claude, gpt, muse] = itemOf(COUNCIL_ROOTS.review)?.council?.view.members ?? [];
    // Still working, or never answered: nothing to read.
    expect(claude?.answer).toBeNull();
    expect(muse?.answer).toBeNull();
    expect(gpt?.answer).toContain('8/10');
    expect(gpt).toMatchObject({ cut: true });
    expect(gpt?.url).toBeTruthy();
    const short = itemOf(COUNCIL_ROOTS.build)?.council?.view.members ?? [];
    expect(short.every((m) => m.answer && !m.cut)).toBe(true);
  });

  it('waits for its checklist’s Hand over: no go-ahead of its own, the plan folded', () => {
    const council = itemOf(COUNCIL_ROOTS.build)?.council;
    expect(council?.card.stage).toBe('approve');
    expect(council?.view.stage).toBe(COUNCIL_WORDS.stages.approve);
    expect(council?.plan).toContain('**Group the settings**');
    expect(council?.view.earlier).toHaveLength(2);
    expect(council?.view.stoppable).toBe(true);
    expect(council?.ticking).toBe(false);
  });

  it('still draws the builder with its step on a council of an older Whombat', () => {
    const message = councilMessage(COUNCIL_ROOTS.build);
    if (message.card?.kind !== 'council') throw new Error('no card');
    const lead = message.card.members[0];
    if (!lead) throw new Error('no member');
    const older: CouncilCard = {
      ...message.card,
      members: [
        {
          ...lead,
          role: 'builder',
          state: 'working',
          verdict: null,
          answer: null,
          since: new Date(made - 14 * 60_000).toISOString(),
          endedAt: null,
          step: 'Changing BackupsPage.tsx',
        },
      ],
    };
    const [builder] = councilItem(older, [], made).view.members;
    expect(builder).toMatchObject({ builder: true, working: true, answer: null });
    expect(builder?.step).toContain('BackupsPage.tsx');
    expect(builder?.label).toContain(COUNCIL_WORDS.builder);
  });

  it('ticks every second while a working time shows seconds, then on the minute; never once nobody works', () => {
    const card = councilMessage(COUNCIL_ROOTS.review).card;
    if (card?.kind !== 'council') throw new Error('no card');
    const fresh = {
      ...card,
      members: card.members.map((m) => ({ ...m, since: new Date(made - 12_400).toISOString() })),
    };
    expect(councilNextTick(fresh, made)).toBe(600);
    expect(councilNextTick(card, made)).toBe(60_000);
    const done = { ...card, members: card.members.filter((m) => m.state !== 'working') };
    expect(councilNextTick(done, made)).toBeNull();
  });
});

describe('the final council card (CNL-42)', () => {
  it('has every round’s scores, how it ended, and the plan folded', () => {
    const council = itemOf(COUNCIL_ROOTS.final)?.council;
    expect(council?.view.ended).toBe(COUNCIL_WORDS.stages.done);
    expect(council?.view.stoppable).toBe(false);
    expect(council?.view.table.columns).toHaveLength(4);
    expect(council?.view.table.rows.map((r) => r.mark)).toEqual(['claude', 'openai', null]);
    expect(council?.plan).toBeTruthy();
    expect(council?.ticking).toBe(false);
  });

  it('shows each changed screen with its picture and notes, and the message’s row leaves that picture out', () => {
    const item = itemOf(COUNCIL_ROOTS.final);
    const [picture] = item?.council?.pictures ?? [];
    expect(picture?.attachment?.id).toBe(COUNCIL_SHOT_ATTACHMENT);
    expect(picture?.aspect).toBeCloseTo(1440 / 1800);
    expect(picture?.notes.map((n) => n.n)).toEqual([1, 2, 3]);
    expect(picture?.label).toContain('Login');
    expect(item?.attachments.map((a) => a.id)).toEqual([NOTES.id]);
  });

  it('draws a picture without its file as a space, not a broken image', () => {
    const message = councilMessage(COUNCIL_ROOTS.final);
    if (message.card?.kind !== 'council') throw new Error('no card');
    const [picture] = councilItem(message.card, [], made).pictures;
    expect(picture?.attachment).toBeNull();
  });
});

describe('when Stop didn’t go through', () => {
  it('says a Whombat from before the council needs an update', () => {
    const older = new ApiError(
      404,
      'unknown',
      'No operation councils.stop',
      {
        error: { code: 'unknown_op', message: 'No operation councils.stop' },
      },
      'councils.stop',
    );
    expect(councilActionProblem(older)).toBe(PROBLEM_WORDS.whombatUpdate);
  });

  it('keeps the server’s own words for a refusal', () => {
    const ended = new ApiError(409, 'conflict', 'This council has ended.', null, 'councils.stop');
    expect(councilActionProblem(ended)).toBe('This council has ended.');
  });
});
