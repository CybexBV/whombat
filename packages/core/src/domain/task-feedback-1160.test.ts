/**
 * Contracts 0.116.0, task feedback (Whombat task-feedback.md TF-10…TF-17; CT-880…CT-895): the `task` card and its
 * words, the `task_finished` wake, and the desk's new timing and words.
 */
import { describe, expect, it } from 'vitest';
import { DispatchContext, TASK_FINISHED_MAX, TaskFinishedContext } from '../contracts/runner.js';
import { FollowedTaskId, ID_PREFIXES, newId } from '../ids.js';
import { CARD_KINDS, MessageCard, PostableCard, StoredCard } from './cards.js';
import {
  DESK_TALK_SESSION_IDLE_S,
  DESK_TALK_WAIT_MAX_S,
  DESK_TALK_WORKING_S,
  DESK_WORDS,
  fillDeskWords,
} from './desk.js';
import { DispatchTrigger, SummaryTrigger, summaryTrigger } from './dispatch.js';
import {
  formatTaskDuration,
  TASK_CARD_STATES,
  TASK_CARD_WORDS,
  TASK_END_STATES,
  TASK_RESULT_MAX,
  TaskCard,
  taskCardActive,
  taskCardElapsedMs,
  taskCardLine,
  taskCardText,
  taskCardValid,
  taskLostText,
  taskResultLine,
} from './task-card.js';
import { DispatchSummary } from './work.js';

const started = '2026-10-21T14:02:00Z';
const running = TaskCard.parse({
  kind: 'task',
  followedTaskId: 'ftk_ha0000000001',
  serverId: 'home-assistant',
  server: 'Home Assistant',
  title: 'Installing 23 updates on Home Assistant',
  state: 'running',
  startedAt: started,
});
const done: TaskCard = {
  ...running,
  state: 'ok',
  endedAt: '2026-10-21T14:06:12Z',
  result: 'Home Assistant is up to date: 23 updates installed. It needs a restart for the new kernel.',
};

describe('the task card (CT-880)', () => {
  it('is a server-made card kind, the same shape stored, never postable', () => {
    expect(CARD_KINDS).toContain('task');
    expect(MessageCard.options).toHaveLength(CARD_KINDS.length);
    expect(MessageCard.parse(done)).toEqual(done);
    expect(StoredCard.parse(done)).toEqual(done);
    expect(PostableCard.safeParse(done).success).toBe(false);
  });

  it('starts without an end or a result', () => {
    expect(running).toMatchObject({ endedAt: null, result: null });
    expect(taskCardValid(running)).toBe(true);
    expect(taskCardValid(done)).toBe(true);
    expect(taskCardValid({ ...done, result: null })).toBe(true);
    expect(taskCardValid({ ...running, endedAt: done.endedAt })).toBe(false);
    expect(taskCardValid({ ...running, result: 'Done.' })).toBe(false);
    expect(taskCardValid({ ...done, endedAt: null })).toBe(false);
  });

  it('is about Whombat’s own followed task, not the hub’s task id', () => {
    expect(ID_PREFIXES.followedTask).toBe('ftk');
    expect(FollowedTaskId.safeParse(newId('followedTask')).success).toBe(true);
    expect(TaskCard.safeParse({ ...done, followedTaskId: 'pkg:0123456789abcdef' }).success).toBe(false);
  });

  it('keeps its words to their lengths and its states to five', () => {
    expect([...TASK_CARD_STATES]).toEqual(['running', 'ok', 'warning', 'error', 'lost']);
    expect([...TASK_END_STATES]).toEqual(TASK_CARD_STATES.filter((s) => s !== 'running'));
    expect(TaskCard.safeParse({ ...done, result: 'x'.repeat(TASK_RESULT_MAX) }).success).toBe(true);
    expect(TaskCard.safeParse({ ...done, result: 'x'.repeat(TASK_RESULT_MAX + 1) }).success).toBe(false);
    expect(TaskCard.safeParse({ ...done, result: '' }).success).toBe(false);
    expect(TaskCard.safeParse({ ...done, state: 'paused' }).success).toBe(false);
    expect(TaskCard.safeParse({ ...done, title: '' }).success).toBe(false);
  });

  it('is active while it runs', () => {
    expect(taskCardActive(running)).toBe(true);
    for (const state of TASK_END_STATES) expect(taskCardActive({ state })).toBe(false);
  });
});

describe('the card’s line and time (CT-881)', () => {
  it('says how long in whole units', () => {
    expect(formatTaskDuration(0)).toBe('0 s');
    expect(formatTaskDuration(12_400)).toBe('12 s');
    expect(formatTaskDuration(4 * 60_000 + 59_000)).toBe('4 min');
    expect(formatTaskDuration(3_600_000)).toBe('1 h');
    expect(formatTaskDuration(65 * 60_000)).toBe('1 h 5 min');
    expect(formatTaskDuration(27 * 3_600_000)).toBe('1 d 3 h');
    expect(formatTaskDuration(48 * 3_600_000)).toBe('2 d');
    expect(formatTaskDuration(-5)).toBe('0 s');
    expect(formatTaskDuration(Number.NaN)).toBe('0 s');
  });

  it('counts from the start to the end, or to now while it runs', () => {
    expect(taskCardElapsedMs(done, '2026-10-21T15:00:00Z')).toBe(252_000);
    expect(taskCardElapsedMs(running, '2026-10-21T14:02:12Z')).toBe(12_000);
    expect(taskCardElapsedMs(running, '2026-10-21T14:01:00Z')).toBe(0);
  });

  it('takes the first sentence of the result, without its full stop', () => {
    expect(taskResultLine(done.result as string)).toBe('Home Assistant is up to date: 23 updates installed');
    expect(taskResultLine('Updated to v2.1.3. Nothing else changed.')).toBe('Updated to v2.1.3');
    expect(taskResultLine('\nIt didn’t work: the storage is full.\nMore here.')).toBe(
      'It didn’t work: the storage is full',
    );
    expect(taskResultLine('Did it work?')).toBe('Did it work?');
    expect(taskResultLine('Still going…')).toBe('Still going…');
  });

  it('runs with its time, settles with how it went, and says when it was lost', () => {
    const line = taskCardLine(running, '2026-10-21T14:02:12Z');
    expect(line).toContain(running.title);
    expect(line).toContain('12 s');
    const settled = taskCardLine(done, '2026-10-21T15:00:00Z');
    expect(settled).toContain('23 updates installed');
    expect(settled).toContain(' · 4 min');
    expect(settled).not.toContain('restart');
    const failed = taskCardLine(
      { ...done, state: 'error', result: 'Backing up web on pve-02 didn’t work: the storage is full.' },
      started,
    );
    expect(failed).toContain('the storage is full · 4 min');
    const silent = taskCardLine({ ...done, state: 'warning', result: null }, started);
    expect(silent).toContain(running.title);
    expect(silent).toContain(TASK_CARD_WORDS.states.warning);
    const lost = taskCardLine({ ...done, state: 'lost', result: taskLostText('Home Assistant') }, started);
    expect(lost).toContain(running.title);
    expect(lost).toContain(TASK_CARD_WORDS.lostLine);
  });
});

describe('the card’s own words (CT-882)', () => {
  it('names every state and the server of a lost task', () => {
    for (const state of TASK_CARD_STATES) expect(TASK_CARD_WORDS.states[state]).toBeTruthy();
    expect(taskLostText('pve-02')).toContain('pve-02’s Tasks tab');
    expect(TaskCard.safeParse({ ...done, state: 'lost', result: taskLostText('pve-02') }).success).toBe(true);
  });

  it('reads as text with its state and result', () => {
    const text = taskCardText(done);
    expect(text).toMatch(/^\[task: /);
    expect(text).toContain(running.title);
    expect(text).toContain('ok');
    expect(text).toContain('23 updates installed');
    expect(taskCardText(running)).not.toContain('—');
  });
});

describe('the task_finished wake (CT-883)', () => {
  const ended: TaskFinishedContext = {
    followedTaskId: 'ftk_ha0000000001',
    serverId: 'home-assistant',
    server: 'Home Assistant',
    what: running.title,
    result: 'ok',
    words: done.result as string,
    rebootRequired: true,
    startedAt: started,
    endedAt: done.endedAt as string,
  };

  it('is a trigger clients read as notify', () => {
    expect(DispatchTrigger.options).toContain('task_finished');
    expect(SummaryTrigger.options).not.toContain('task_finished');
    expect(summaryTrigger('task_finished')).toBe('notify');
    expect(summaryTrigger('undo_requested')).toBe('mention');
    expect(summaryTrigger('notify')).toBe('notify');
    const summary = {
      id: 'dsp_1',
      agentId: 'prn_dusty',
      conversationId: 'cnv_1',
      threadRootId: 'msg_root1',
      state: 'queued',
      runId: null,
      createdAt: started,
      claimedAt: null,
      heartbeatAt: null,
      finishedAt: null,
      reason: null,
    };
    expect(DispatchSummary.safeParse({ ...summary, trigger: summaryTrigger('task_finished') }).success).toBe(
      true,
    );
    expect(DispatchSummary.safeParse({ ...summary, trigger: 'task_finished' }).success).toBe(false);
  });

  it('carries 1 to 10 ended tasks, each with its server, what, result, words and restart', () => {
    const field = DispatchContext.shape.taskFinished;
    expect(field.parse([ended])).toEqual([ended]);
    expect(field.parse(undefined)).toBeUndefined();
    expect(field.parse(null)).toBeNull();
    expect(field.safeParse([]).success).toBe(false);
    expect(field.safeParse(Array(TASK_FINISHED_MAX).fill(ended)).success).toBe(true);
    expect(field.safeParse(Array(TASK_FINISHED_MAX + 1).fill(ended)).success).toBe(false);
    expect(TaskFinishedContext.safeParse({ ...ended, result: 'running' }).success).toBe(false);
    expect(TaskFinishedContext.safeParse({ ...ended, result: 'lost', words: '' }).success).toBe(true);
    expect(TaskFinishedContext.safeParse({ ...ended, words: 'x'.repeat(TASK_RESULT_MAX + 1) }).success).toBe(
      false,
    );
    const { rebootRequired: _r, ...withoutRestart } = ended;
    expect(TaskFinishedContext.safeParse(withoutRestart).success).toBe(false);
  });
});

describe('the desk while it works (CT-890, CT-893, CT-895)', () => {
  it('waits 90 s before working and 30 minutes before slow', () => {
    expect(DESK_TALK_WORKING_S).toBe(90);
    expect(DESK_TALK_WAIT_MAX_S).toBe(1_800);
    expect(DESK_TALK_WAIT_MAX_S).toBeLessThanOrEqual(DESK_TALK_SESSION_IDLE_S);
  });

  it('says the assistant is working, a choice’s PIN line and a task’s state', () => {
    expect(fillDeskWords(DESK_WORDS.working, { assistant: 'Neo' })).toContain('Neo');
    const pin = fillDeskWords(DESK_WORDS.choiceWithPin, { choice: 'Don’t ask again on pve-02' });
    expect(pin).toContain('“Don’t ask again on pve-02”');
    expect(DESK_WORDS.notOffered).toBeTruthy();
    expect(DESK_WORDS.tasks).toEqual(TASK_CARD_WORDS.states);
  });
});
