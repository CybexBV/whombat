import { describe, expect, it } from 'vitest';
import {
  PROMPT_COUNCIL_LINES,
  PROMPT_MERGE_MARK,
  PROMPT_OWN_IT_LINE,
  PROMPT_TEXT_MAX,
  PROMPT_TITLE_MAX,
  PromptId,
  promptLastRun,
  promptLine,
  promptTask,
  promptTitleFrom,
  STARTER_PROMPTS,
  starterPromptId,
  starterPromptOf,
} from './prompts.js';

describe('the shipped prompts', () => {
  it('fit the limits, have ids of their own and are found by id', () => {
    const ids = STARTER_PROMPTS.map((s) => starterPromptId(s.key));
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of STARTER_PROMPTS) {
      expect(PromptId.safeParse(starterPromptId(s.key)).success).toBe(true);
      expect(s.title.length).toBeLessThanOrEqual(PROMPT_TITLE_MAX);
      expect(s.text.length).toBeLessThanOrEqual(PROMPT_TEXT_MAX);
      expect(starterPromptOf(starterPromptId(s.key))).toBe(s);
    }
    expect(starterPromptOf('starter-nothing')).toBeNull();
    expect(starterPromptOf('prm_abcdefghijkl')).toBeNull();
  });

  it('give their open points to a council, not to the person', () => {
    const text = (key: string) => starterPromptOf(starterPromptId(key))?.text ?? '';
    for (const key of ['audit', 'simplify', 'bugs', 'docs'])
      expect(text(key)).toContain(PROMPT_COUNCIL_LINES);
    expect(PROMPT_COUNCIL_LINES).toContain('council');
    // One that waits for the person's word keeps waiting for it.
    expect(text('agent-instructions')).not.toContain(PROMPT_COUNCIL_LINES);
  });
});

describe('what a thread is given', () => {
  it('is the prompt as written, with the ownership line and the last run only when they apply', () => {
    expect(promptTask({ text: '  Do it.  ', ownIt: false })).toBe('Do it.');
    const full = promptTask({ text: 'Do it.', ownIt: true }, '2026-11-10T09:00:00.000Z');
    expect(full.startsWith('Do it.\n\n')).toBe(true);
    expect(full).toContain(PROMPT_OWN_IT_LINE);
    expect(full).toContain('2026-11-10');
    expect(full).not.toContain(PROMPT_MERGE_MARK);
  });

  it('asks the thread for a pull request Whombat merges when the switch is on', () => {
    const task = promptTask({ text: 'Do it.', ownIt: false, merge: true });
    expect(task.startsWith('Do it.\n\n')).toBe(true);
    expect(task).toContain(PROMPT_MERGE_MARK);
    expect(task).toContain('pull request');
  });

  it('finds when it last ran on a project', () => {
    const prompt = { runs: [{ projectId: 'p1', title: 'Whombat', at: '2026-11-10T09:00:00.000Z' }] };
    expect(promptLastRun(prompt, 'p1')).toBe('2026-11-10T09:00:00.000Z');
    expect(promptLastRun(prompt, 'p2')).toBeNull();
  });
});

describe('the words around a prompt', () => {
  it('names the prompt and the project in Chat', () => {
    expect(promptLine('Hunt for bugs', 'Fusebox')).toBe('Hunt for bugs · Fusebox');
    expect(promptLine('Hunt for bugs', null)).toBe('Hunt for bugs');
  });

  it('titles kept words by their first line', () => {
    expect(promptTitleFrom('Check the links.\nThen report.')).toBe('Check the links');
    const long = promptTitleFrom(`${'word '.repeat(40)}end`);
    expect(long.length).toBeLessThanOrEqual(PROMPT_TITLE_MAX);
    expect(long.endsWith('…')).toBe(true);
  });
});
