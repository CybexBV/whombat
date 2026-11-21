import {
  PROMPT_MERGE_MARK,
  PROMPT_RUNS_MAX,
  PROMPT_TEXT_MAX,
  PROMPT_TITLE_MAX,
  promptTask,
  STARTER_PROMPTS,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { BRIEF_MAX } from '../domain/agent-brief';
import { PROMPT_WORDS_BEGIN, PROMPT_WORDS_END, promptBrief } from './brief';
import { promptList, withRun } from './view';

const at = new Date('2026-11-01T10:00:00Z');
const row = (over: Partial<Parameters<typeof promptList>[0][number]> = {}) => ({
  id: 'prm_x',
  starterKey: null,
  title: null,
  text: null,
  onRepository: true,
  ownIt: false,
  merge: false,
  ai: null,
  hidden: false,
  runs: [],
  position: 0,
  createdAt: at,
  updatedAt: at,
  ...over,
});

describe('the list', () => {
  it('shows the shipped prompts first, unchanged without rows, then the person’s own in order', () => {
    const list = promptList([
      row({ id: 'prm_b', title: 'B', text: 'b', position: 1 }),
      row({ id: 'prm_a', title: 'A', text: 'a', position: 0 }),
    ]);
    expect(list.map((p) => p.id)).toEqual([
      ...STARTER_PROMPTS.map((s) => `starter-${s.key}`),
      'prm_a',
      'prm_b',
    ]);
    expect(list[0]).toMatchObject({ starter: true, edited: false, text: STARTER_PROMPTS[0]?.text });
  });

  it('keeps a shipped prompt’s changes and leaves out a removed one', () => {
    const list = promptList([
      row({ id: 'prm_1', starterKey: 'audit', title: 'Look it over' }),
      row({ id: 'prm_2', starterKey: 'bugs', hidden: true }),
      // A run alone is no change.
      row({ id: 'prm_3', starterKey: 'docs', runs: [{ projectId: 'p', title: 'P', at: at.toISOString() }] }),
    ]);
    const audit = list.find((p) => p.id === 'starter-audit');
    expect(audit).toMatchObject({ title: 'Look it over', text: STARTER_PROMPTS[0]?.text, edited: true });
    expect(list.some((p) => p.id === 'starter-bugs')).toBe(false);
    expect(list.find((p) => p.id === 'starter-docs')).toMatchObject({ edited: false, updatedAt: null });
  });

  it('remembers one run per project, the latest first', () => {
    const runs = Array.from({ length: PROMPT_RUNS_MAX }, (_, i) => ({
      projectId: `p${i}`,
      title: '',
      at: '',
    }));
    const after = withRun(runs, { projectId: 'p3', title: 'Again', at: 'now' });
    expect(after).toHaveLength(PROMPT_RUNS_MAX);
    expect(after[0]?.title).toBe('Again');
    expect(after.filter((r) => r.projectId === 'p3')).toHaveLength(1);
    expect(withRun(runs, { projectId: 'new', title: '', at: '' })).toHaveLength(PROMPT_RUNS_MAX);
  });
});

describe('the agent’s brief', () => {
  const brief = (task: string, ai: Parameters<typeof promptBrief>[0]['ai'] = { kind: 'default' }) =>
    promptBrief({
      person: 'Mara',
      title: 'Find what’s broken',
      project: { id: 'proj-1', title: 'Fusebox' },
      handle: 't3',
      task,
      ai,
    });

  it('carries the words whole between the markers, with the tool, the project and the connection', () => {
    const text = 'Line one.\n\nLine “two”.';
    const b = brief(text);
    expect(b.split(`${PROMPT_WORDS_BEGIN}\n`)[1]?.split(`\n${PROMPT_WORDS_END}`)[0]).toBe(text);
    for (const fact of ['t3_thread_launch', 'connection_call', 't3', '"proj-1"', 'Fusebox', 'full-access'])
      expect(b).toContain(fact);
    expect(b).not.toContain('modelSelection {');
  });

  it('tells the agent Whombat merges, only when the prompt asks for it', () => {
    expect(brief('x')).not.toContain(PROMPT_MERGE_MARK);
    const merging = promptBrief({
      person: 'Mara',
      title: 'Find what’s broken',
      project: { id: 'proj-1', title: 'Fusebox' },
      handle: 't3',
      task: promptTask({ text: 'x', ownIt: false, merge: true }),
      ai: { kind: 'default' },
      merge: true,
    });
    expect(merging.split(PROMPT_WORDS_BEGIN)[0]).toContain(PROMPT_MERGE_MARK);
    expect(merging.split(PROMPT_WORDS_BEGIN)[1]).toContain(PROMPT_MERGE_MARK);
  });

  it('names the AI as T3 Code takes it, or says it can’t run now', () => {
    const chosen = brief('x', {
      kind: 'chosen',
      modelSelection: { instanceId: 'codex', model: 'gpt-6', options: [{ id: 'effort', value: 'high' }] },
    });
    expect(chosen).toContain('"instanceId":"codex"');
    expect(chosen).toContain('"value":"high"');
    const gone = brief('x', {
      kind: 'unavailable',
      ai: { provider: 'codex', model: 'gpt-6', effort: null, fast: null },
    });
    expect(gone).toContain('gpt-6');
    expect(gone).not.toContain('"instanceId"');
  });

  it('fits whole for the longest prompt Whombat keeps', () => {
    const task = promptTask(
      { text: 'w'.repeat(PROMPT_TEXT_MAX), ownIt: true, merge: true },
      at.toISOString(),
    );
    const b = promptBrief({
      person: 'M'.repeat(80),
      title: 'T'.repeat(PROMPT_TITLE_MAX),
      project: { id: 'i'.repeat(200), title: 'P'.repeat(200) },
      handle: 'h'.repeat(40),
      task,
      merge: true,
      ai: {
        kind: 'chosen',
        modelSelection: {
          instanceId: 'p'.repeat(40),
          model: 'm'.repeat(80),
          options: [
            { id: 'reasoningEffort', value: 'e'.repeat(20) },
            { id: 'serviceTier', value: 'priority' },
          ],
        },
      },
    });
    expect(b.length).toBeLessThanOrEqual(BRIEF_MAX);
  });
});
