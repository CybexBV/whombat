/**
 * The delegation card on the phone (delegate.md): shown whole under the agent's intro with its latest words under it,
 * its rows and buttons from the shared view (the finished ones folded, a question to the assistant by its name), each
 * task's pictures and ⋯ menu, the ticks and AIs shown before the server sends them back, the AI menu's heading and
 * models, and its ticking times.
 */
import {
  ApiError,
  DELEGATION_AI_WORDS,
  DELEGATION_WORDS,
  delegationAiDraft,
  delegationAiMenu,
  delegationCardView,
  PROBLEM_WORDS,
} from '@whombat/client';
import type { Attachment, DelegationCard, Message } from '@whombat/core';
import { DM_DUSTY_MESSAGES } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import {
  DELEGATION_AI_OPTIONS,
  DELEGATION_SHOT_ATTACHMENT,
  DELEGATION_TASKS,
  type DelegationFixtureStage,
  delegationThread,
} from '../fixtures/delegation';
import { worldContext } from '../test/world';
import {
  delegationActionProblem,
  delegationAfter,
  delegationAiHeading,
  delegationAiModelRows,
  delegationItem,
  delegationNextTick,
  delegationTaskMenu,
  EVERY_TASK,
  NO_AI_HOLDS,
  NO_PICKS,
  parseDelegationTaskPick,
  pendingPicks,
  withAiHolds,
  withPicks,
} from './delegation';
import { cardSummary, chatItems } from './messages';

const base = DM_DUSTY_MESSAGES[1] as Message;
const ctx = worldContext();
const made = ctx.now.getTime();

const cardAt = (stage: DelegationFixtureStage): DelegationCard => delegationThread(made, stage).reply.card;

function messageAt(stage: DelegationFixtureStage): Message {
  const { reply } = delegationThread(made, stage);
  return {
    ...base,
    id: 'msg_chat-delegation-card' as Message['id'],
    text: reply.text,
    card: reply.card,
    attachments: [...reply.attachments, NOTES],
  };
}

/** Another file on the same message, which its own row still shows. */
const NOTES: Attachment = {
  id: 'att_delegation-notes' as Attachment['id'],
  name: 'notes.txt',
  contentType: 'text/plain',
  size: 120,
  url: '/api/v1/burrows/burrow-hq/attachments/att_delegation-notes',
  kind: 'text',
  width: null,
  height: null,
};

const itemAt = (stage: DelegationFixtureStage) => chatItems([messageAt(stage)], ctx, { authors: true })[0];

describe('the checklist', () => {
  it('is shown whole under the agent’s intro, never as a summary card', () => {
    const item = itemAt('offer');
    expect(item?.delegation).not.toBeNull();
    expect(item?.display).toBe('full');
    expect(item?.card).toBeNull();
    expect(item?.text).toContain('T3 Code');
    expect(cardSummary(cardAt('offer'), ctx)).toBeNull();
  });

  it('has a checkbox per task, Hand over with the number ticked, and After on the task that waits', () => {
    const view = itemAt('offer')?.delegation?.view;
    expect(view?.offer).toBe(true);
    expect(view?.tasks).toHaveLength(7);
    expect(view?.tasks.every((t) => t.checkbox)).toBe(true);
    expect(view?.folded).toBeNull();
    expect(view?.picked).toBe(5);
    expect(view?.handOver).toBe(DELEGATION_WORDS.handOver(5));
    expect(view?.stage).toContain(DELEGATION_WORDS.ticked(5, 7));
    expect(view?.project).toBe('whombat-site');
    expect(delegationAfter(cardAt('offer'))).toEqual({
      [DELEGATION_TASKS.search]: DELEGATION_WORDS.after(2),
    });
    expect(itemAt('offer')?.delegation?.ticking).toBe(false);
  });

  it('shows a tick before the server sends it back, and drops it once the card says it', () => {
    const card = cardAt('offer');
    const picks = new Map([[DELEGATION_TASKS.names, true]]);
    const shown = withPicks(card, picks);
    expect(shown.tasks.filter((t) => t.picked)).toHaveLength(6);
    expect(pendingPicks(card, picks)).toBe(picks);
    const sentBack = {
      ...card,
      tasks: card.tasks.map((t) => (t.id === DELEGATION_TASKS.names ? { ...t, picked: true } : t)),
    };
    expect(pendingPicks(sentBack, picks).size).toBe(0);
    // Handed over: the checklist's ticks are gone, whatever was held.
    const working = cardAt('working');
    expect(pendingPicks(working, picks)).toBe(NO_PICKS);
    expect(withPicks(working, picks)).toBe(working);
  });
});

describe('the AI on the checklist', () => {
  const SOL = {
    provider: 'codex',
    model: 'gpt-6.1-sol',
    label: 'GPT 6.1 Sol',
    effort: 'high',
    fast: true,
  } as const;

  it('shows each task’s chip and lets every task’s AI be chosen while the checklist waits', () => {
    const view = itemAt('offer')?.delegation?.view;
    expect(view?.aiChoosable).toBe(true);
    const ai = (id: string) => view?.tasks.find((t) => t.id === id)?.ai;
    expect(ai(DELEGATION_TASKS.group)).toContain('Claude Opus 5.5');
    expect(ai(DELEGATION_TASKS.rows)).toBeNull();
    expect(view?.aiSummary).toBeNull();
    // Handed over: nothing to choose.
    expect(itemAt('working')?.delegation?.view.aiChoosable).toBe(false);
  });

  it('shows a choice before the server sends it back, for one task or every task', () => {
    const card = cardAt('offer');
    const holds = new Map([
      [DELEGATION_TASKS.rows, SOL],
      [EVERY_TASK, SOL],
    ]);
    const view = delegationCardView(withAiHolds(card, holds), made);
    expect(view.tasks.find((t) => t.id === DELEGATION_TASKS.rows)?.ai).toContain('GPT 6.1 Sol');
    // Two of the five ticked chose their own: the line says what the others get.
    expect(view.aiShared).toBe(3);
    expect(view.aiSummary).toBe(DELEGATION_AI_WORDS.others(view.ai ?? ''));
    // Back to the default, and nothing held.
    const back = withAiHolds(card, new Map([[DELEGATION_TASKS.group, null]]));
    expect(back.tasks.find((t) => t.id === DELEGATION_TASKS.group)?.ai).toBeNull();
    expect(withAiHolds(card, NO_AI_HOLDS)).toBe(card);
    // Handed over: what was held no longer shows.
    const working = cardAt('working');
    expect(withAiHolds(working, holds)).toBe(working);
  });

  it('heads the menu with the task, or with how many tasks take every task’s AI', () => {
    const view = delegationCardView(cardAt('offer'), made);
    const task = delegationAiHeading(view, DELEGATION_TASKS.group);
    expect(task.title).toBe(DELEGATION_AI_WORDS.taskTitle(2));
    expect(task.subtitle).toContain('Group the settings');
    expect(task.first).toBe(DELEGATION_AI_WORDS.sameAsOthers);
    const every = delegationAiHeading(view, EVERY_TASK);
    expect(every.title).toBe(DELEGATION_AI_WORDS.allTitle);
    expect(every.subtitle).toBe(DELEGATION_AI_WORDS.allCount(4, 5));
    expect(every.first).toBe(DELEGATION_AI_WORDS.t3Default);
  });

  it('lists the default first, then each model with its company, the chosen one picked', () => {
    const current = cardAt('offer').tasks.find((t) => t.id === DELEGATION_TASKS.group)?.ai ?? null;
    const menu = delegationAiMenu(DELEGATION_AI_OPTIONS, delegationAiDraft(current), current);
    const rows = delegationAiModelRows(menu, DELEGATION_AI_WORDS.sameAsOthers);
    expect(rows[0]).toMatchObject({ id: null, label: DELEGATION_AI_WORDS.sameAsOthers, picked: false });
    expect(rows.map((r) => r.label)).toContain('Claude Sonnet 5.5');
    expect(rows.find((r) => r.label === 'GPT 6.1 Sol')?.description).toBe('Codex');
    expect(rows.filter((r) => r.picked).map((r) => r.id)).toEqual(['claudeAgent/claude-opus-5-5']);
    const none = delegationAiMenu(DELEGATION_AI_OPTIONS, delegationAiDraft(null), null);
    expect(delegationAiModelRows(none, DELEGATION_AI_WORDS.t3Default)[0]?.picked).toBe(true);
  });
});

describe('the tasks at work', () => {
  it('keeps what works, waits or needs a look in view and folds the merged ones, with a Stop while work goes on', () => {
    const item = itemAt('working')?.delegation;
    const view = item?.view;
    expect(view?.offer).toBe(false);
    expect(view?.stoppable).toBe(true);
    expect(view?.stage).toBe('2 of 6 merged · 2 working · 1 needs a look');
    // Not handed over: off the card. Merged: folded into one line that opens to them.
    expect(view?.tasks.map((t) => t.id)).toEqual([
      DELEGATION_TASKS.search,
      DELEGATION_TASKS.danger,
      DELEGATION_TASKS.save,
      DELEGATION_TASKS.contrast,
    ]);
    expect(view?.folded?.label).toBe(DELEGATION_WORDS.folded(2, true));
    expect(view?.folded?.tasks.map((t) => t.id)).toEqual([DELEGATION_TASKS.rows, DELEGATION_TASKS.group]);
    expect(view?.folded?.tasks.every((t) => t.done && t.pr)).toBe(true);
    const [search, danger, save, contrast] = view?.tasks ?? [];
    // Waiting for its checks holds no place: no working ring.
    expect(search).toMatchObject({ working: false, status: DELEGATION_WORDS.checks.running });
    expect(search?.elapsed).toBe('7 min');
    expect(danger).toMatchObject({ working: true, status: DELEGATION_WORDS.merge.merging });
    expect(save).toMatchObject({ attention: true, status: DELEGATION_WORDS.checks.failing });
    expect(save?.note).toBeTruthy();
    // A question the assistant answers itself is quiet, and says whom it asked.
    expect(contrast).toMatchObject({ attention: false, stoppable: true });
    const lead = ctx.people.agent?.name ?? null;
    expect(lead).toBeTruthy();
    expect(contrast?.status).toBe(DELEGATION_WORDS.pending.question(lead));
    expect(item?.lead).toBe(lead);
    expect(item?.ticking).toBe(true);
    // The agent's latest words go under the card.
    expect(item?.card.note).toBeTruthy();
  });

  it('opens a task’s pictures under its row, and leaves them out of the message’s own files', () => {
    const item = itemAt('working');
    const [picture] = item?.delegation?.pictures[DELEGATION_TASKS.search] ?? [];
    expect(picture?.attachment?.id).toBe(DELEGATION_SHOT_ATTACHMENT);
    expect(picture?.notes.map((n) => n.n)).toEqual([1, 2]);
    expect(picture?.label).toContain('Settings');
    expect(item?.delegation?.pictures[DELEGATION_TASKS.save]).toBeUndefined();
    expect(item?.attachments.map((a) => a.id)).toEqual([NOTES.id]);
  });

  it('has a ⋯ menu per row with Open in T3 Code and Stop this task, and none when both are missing', () => {
    const [, , save, contrast] = itemAt('working')?.delegation?.view.tasks ?? [];
    if (!save || !contrast) throw new Error('no rows');
    const ids = (spec: ReturnType<typeof delegationTaskMenu>) => spec?.sections.flat().map((i) => i.id);
    expect(ids(delegationTaskMenu(contrast))).toEqual(['open', 'stop']);
    expect(delegationTaskMenu(contrast)?.title).toBe(contrast.title);
    expect(delegationTaskMenu(contrast, true)?.sections[1]?.[0]?.disabled).toBe(true);
    // Done with its checks failing: nothing to stop, its thread still opens.
    expect(ids(delegationTaskMenu(save))).toEqual(['open']);
    expect(delegationTaskMenu({ ...save, url: null })).toBeNull();
    expect(parseDelegationTaskPick('stop')).toBe('stop');
    expect(parseDelegationTaskPick('delete')).toBeNull();
  });

  it('ticks every second while a working time shows seconds, then on the minute; never once it ended', () => {
    const card = cardAt('working');
    const fresh = {
      ...card,
      tasks: card.tasks.map((t) =>
        t.state === 'working' ? { ...t, since: new Date(made - 12_400).toISOString() } : t,
      ),
    };
    expect(delegationNextTick(fresh, made)).toBe(600);
    expect(delegationNextTick(card, made)).toBe(60_000);
    expect(delegationNextTick(cardAt('done'), made)).toBeNull();
  });
});

describe('the ended card', () => {
  it('says how it ended, with no buttons', () => {
    const view = itemAt('done')?.delegation?.view;
    expect(view?.ended).toBe(DELEGATION_WORDS.doneSome(1));
    expect(view?.stage).toBe(view?.ended);
    expect(view?.offer).toBe(false);
    expect(view?.stoppable).toBe(false);
    expect(view?.tasks.some((t) => t.stoppable)).toBe(false);
    expect(view?.tasks.map((t) => t.id)).toEqual([DELEGATION_TASKS.search]);
    expect(view?.tasks[0]).toMatchObject({
      // A task that didn't finish needs a look: not faded.
      attention: true,
      muted: false,
    });
    expect(view?.folded?.tasks).toHaveLength(4);
    expect(delegationItem(cardAt('done'), [], made).ticking).toBe(false);
  });
});

describe('when a press didn’t go through', () => {
  it('says a Whombat from before delegations needs an update', () => {
    const older = new ApiError(
      404,
      'unknown',
      'No operation delegations.pick',
      { error: { code: 'unknown_op', message: 'No operation delegations.pick' } },
      'delegations.pick',
    );
    expect(delegationActionProblem(older, DELEGATION_WORDS.failed.pick)).toBe(PROBLEM_WORDS.whombatUpdate);
  });

  it('keeps the server’s own words, else the card’s sentence for that press', () => {
    const ended = new ApiError(409, 'conflict', 'These were handed over already.', null, 'delegations.pick');
    expect(delegationActionProblem(ended, DELEGATION_WORDS.failed.pick)).toBe(
      'These were handed over already.',
    );
    expect(delegationActionProblem(new Error('boom'), DELEGATION_WORDS.failed.start)).toBe(
      DELEGATION_WORDS.failed.start,
    );
  });
});
