/**
 * A server task's card on the phone (contracts 0.116, CT-880; docs/decisions/task-feedback.md AP-4305): the live card
 * while it runs, one line once it ended that opens the runtime's full words and the server, and the words the runtime
 * writes for an older app folded into the card.
 */
import { type Message, TASK_CARD_WORDS, type TaskCard, taskCardLine } from '@whombat/core';
import { DM_DUSTY_MESSAGES } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { worldContext } from '../test/world';
import { cardSummary, chatItems, settledLine } from './messages';

const base = DM_DUSTY_MESSAGES[1] as Message;
const STARTED = '2026-10-21T10:00:00.000Z';

function task(over: Partial<TaskCard> = {}): TaskCard {
  return {
    kind: 'task',
    followedTaskId: 'ftk_ha0updates01' as TaskCard['followedTaskId'],
    serverId: 'home-assistant',
    server: 'Home Assistant',
    title: 'Installing 23 updates on Home Assistant',
    state: 'running',
    startedAt: STARTED,
    endedAt: null,
    result: null,
    ...over,
  };
}

const ended = (over: Partial<TaskCard> = {}) =>
  task({
    state: 'ok',
    endedAt: '2026-10-21T10:04:12.000Z',
    result: 'Home Assistant is up to date: 23 updates installed. It needs a restart to finish.',
    ...over,
  });

const msg = (id: string, card: TaskCard): Message => ({
  ...base,
  id: id as Message['id'],
  card,
  text: taskCardLine({ ...card, state: 'running', endedAt: null, result: null }, STARTED),
});

describe('a server task on the phone (AP-4305)', () => {
  it('is the live card while it runs, with the server it opens and no line', () => {
    const ctx = worldContext();
    const [item] = chatItems([msg('msg_t1', task())], ctx, { authors: true });
    expect(item?.display).toBe('live');
    expect(item?.line).toBeNull();
    expect(item?.text).toBe('');
    expect(item?.card?.task).toMatchObject({
      serverId: 'home-assistant',
      server: 'Home Assistant',
      running: true,
      state: TASK_CARD_WORDS.states.running,
      startedAt: STARTED,
    });
    expect(item?.card?.task?.label).toContain('Home Assistant');
  });

  it('settles into one line with how it went and how long it took', () => {
    const ctx = worldContext();
    const [item] = chatItems([msg('msg_t2', ended())], ctx, { authors: true });
    expect(item?.display).toBe('line');
    expect(item?.line?.tone).toBe('ok');
    expect(item?.line?.lead).toContain('23 updates installed');
    expect(item?.line?.detail).toBe('4 min');
    expect(item?.text).toBe('');
  });

  it('opens to the full words, the server and the time, in the state’s tone', () => {
    const ctx = worldContext();
    const done = cardSummary(ended(), ctx);
    expect(done?.detail).toContain('It needs a restart to finish.');
    expect(done?.meta).toContain('Home Assistant');
    expect(done?.meta).toContain('4 min');
    expect(done?.label).toContain(TASK_CARD_WORDS.states.ok.toUpperCase());
    expect(done?.tone).toBe('ok');
    expect(cardSummary(ended({ state: 'warning' }), ctx)?.tone).toBe('warn');
    expect(cardSummary(ended({ state: 'error' }), ctx)?.tone).toBe('bad');
    expect(
      cardSummary(ended({ state: 'lost', result: 'Whombat lost track of this task.' }), ctx)?.tone,
    ).toBeNull();
  });

  it('says a lost task without a time', () => {
    const ctx = worldContext();
    const line = settledLine(
      ended({ state: 'lost', result: 'Whombat lost track of this task.' }),
      ctx,
      base.authorId,
    );
    expect(line).toMatchObject({ detail: TASK_CARD_WORDS.lostLine, tone: 'mut' });
  });
});
