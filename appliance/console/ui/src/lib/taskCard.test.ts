import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { constList, taskCardSource } from './contractsSource';
import { type DeskSessionTask, TASK_STATES } from './desk';
import { DESK_WORDS } from './deskCopy';
import { formatTaskDuration, taskElapsedMs, taskResultLine, taskRow } from './taskCard';

/** A copied function's body as the page and the vendored core write it, without spaces and types. */
function body(source: string, name: string): string {
  const m = new RegExp(`export function ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  if (!m?.[1]) throw new Error(`${name} isn't there`);
  return m[1].replace(/\s+/g, '');
}

describe('the copied task card helpers (core task-card.ts, 0.116)', () => {
  it('know every state the contracts name', () => {
    expect(TASK_STATES).toEqual(constList(taskCardSource, 'TASK_CARD_STATES'));
    for (const state of TASK_STATES) expect(DESK_WORDS.tasks[state]).toBeTruthy();
  });

  it('are core’s own, line for line', () => {
    const page = readFileSync(new URL('./taskCard.ts', import.meta.url), 'utf8');
    expect(body(page, 'formatTaskDuration')).toBe(body(taskCardSource, 'formatTaskDuration'));
    expect(body(page, 'taskResultLine')).toBe(body(taskCardSource, 'taskResultLine'));
  });

  // Core's cases (task-feedback-1160.test.ts, CT-881).
  it('say how long in whole units', () => {
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

  it('take the first sentence of the result, without its full stop', () => {
    expect(taskResultLine('Updated to v2.1.3. Nothing else changed.')).toBe('Updated to v2.1.3');
    expect(taskResultLine('\nIt didn’t work: the storage is full.\nMore here.')).toBe(
      'It didn’t work: the storage is full',
    );
    expect(taskResultLine('Did it work?')).toBe('Did it work?');
    expect(taskResultLine('Still going…')).toBe('Still going…');
  });
});

const started = '2026-10-21T14:02:00Z';
const running: DeskSessionTask = {
  title: 'Installing 23 updates on Home Assistant',
  state: 'running',
  startedAt: started,
  endedAt: null,
  result: null,
};
const at = (iso: string) => Date.parse(iso);

describe('a task’s row (TF-17, CG-284)', () => {
  it('counts from the start to now while it runs, then to its end', () => {
    expect(taskElapsedMs(running, at('2026-10-21T14:02:12Z'))).toBe(12_000);
    expect(taskElapsedMs(running, at('2026-10-21T14:01:00Z'))).toBe(0);
    const ended = { ...running, state: 'ok' as const, endedAt: '2026-10-21T14:06:12Z' };
    expect(taskElapsedMs(ended, at('2026-10-21T15:00:00Z'))).toBe(252_000);
  });

  it('runs with its title, state and the time ticking', () => {
    const r = taskRow(running, at('2026-10-21T14:02:12Z'));
    expect(r).toEqual({ title: running.title, label: DESK_WORDS.tasks.running, time: '12 s', result: null });
    expect(taskRow(running, at('2026-10-21T14:03:30Z')).time).toBe('1 min');
  });

  it('settles with how it went and how long it took', () => {
    const done = taskRow(
      {
        ...running,
        state: 'ok',
        endedAt: '2026-10-21T14:06:12Z',
        result: 'Home Assistant is up to date: 23 updates installed. It needs a restart.',
      },
      at('2026-10-21T15:00:00Z'),
    );
    expect(done.label).toBe(DESK_WORDS.tasks.ok);
    expect(done.time).toBe('4 min');
    expect(done.result).toBe('Home Assistant is up to date: 23 updates installed');
    const failed = taskRow(
      { ...running, state: 'error', endedAt: '2026-10-21T14:04:00Z', result: null },
      at('2026-10-21T15:00:00Z'),
    );
    expect(failed.label).toBe(DESK_WORDS.tasks.error);
    expect(failed.result).toBeNull();
  });

  it('says where a lost one is, without a time', () => {
    const lost = taskRow(
      {
        ...running,
        state: 'lost',
        endedAt: '2026-10-22T14:02:00Z',
        result: 'Whombat lost track of this task. Home Assistant’s Tasks tab has it.',
      },
      at('2026-10-22T15:00:00Z'),
    );
    expect(lost.label).toBe(DESK_WORDS.tasks.lost);
    expect(lost.time).toBeNull();
    expect(lost.result).toContain('Tasks tab');
  });
});
