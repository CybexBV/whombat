import { type Prompt, STARTER_PROMPTS } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { COUNCIL_PROVIDER_OPTIONS } from '../../app/councilSetupFixtures';
import type { SkillCommand } from '../messaging/model';
import {
  promptAiLine,
  promptDraftOf,
  promptRunLine,
  promptSaveBody,
  promptsMissing,
  restoreOffered,
  slashOptions,
} from './promptsModel';

const prompt = (title: string, extra: Partial<Prompt> = {}): Prompt => ({
  id: `prm_${title.toLowerCase().replace(/[^a-z]/g, '')}xxxxxx`.slice(0, 16),
  title,
  text: `${title} words`,
  onRepository: true,
  ownIt: false,
  merge: false,
  ai: null,
  starter: false,
  edited: false,
  runs: [],
  updatedAt: null,
  ...extra,
});

const skill = (name: string): SkillCommand => ({
  name,
  description: `${name} skill`,
  agentId: 'prn_agent',
  agentName: 'Neo',
  insert: `/${name} `,
});

describe('the `/` list with prompts and skills', () => {
  const prompts = [prompt('Find what’s broken'), prompt('Prune the tests')];
  const skills = [skill('pdf'), skill('test-runner')];

  it('lists every prompt above every skill for a bare `/`', () => {
    expect(slashOptions(prompts, skills, '').map((o) => o.kind)).toEqual([
      'prompt',
      'prompt',
      'skill',
      'skill',
    ]);
  });

  it('matches a word of a prompt’s title and the start of a skill’s name', () => {
    const found = slashOptions(prompts, skills, 'te');
    expect(found.map((o) => (o.kind === 'prompt' ? o.prompt.title : o.skill.name))).toEqual([
      'Prune the tests',
      'test-runner',
    ]);
    expect(slashOptions(prompts, skills, 'zzz')).toEqual([]);
  });
});

describe('a prompt in Settings', () => {
  const now = new Date('2026-11-12T12:00:00Z');

  it('names its latest run and where', () => {
    const ran = prompt('Find what’s broken', {
      runs: [
        { projectId: 'p1', title: 'Fusebox', at: '2026-11-09T10:00:00Z' },
        { projectId: 'p2', title: 'Acme Desk', at: '2026-11-01T10:00:00Z' },
      ],
    });
    const line = promptRunLine(ran, now);
    expect(line).toContain('3 days ago');
    expect(line).toContain('Fusebox');
    expect(line).not.toContain('Acme Desk');
    expect(promptRunLine(prompt('Never'), now)).toBeNull();
  });

  it('offers to bring back Whombat’s prompts only when one is missing or changed', () => {
    const all = STARTER_PROMPTS.map((s) => prompt(s.title, { starter: true }));
    expect(restoreOffered(all)).toBe(false);
    expect(restoreOffered([...all, prompt('Mine')])).toBe(false);
    expect(restoreOffered(all.slice(1))).toBe(true);
    expect(restoreOffered(all.map((p, i) => (i === 2 ? { ...p, edited: true } : p)))).toBe(true);
  });
});

describe('the editor’s draft', () => {
  it('takes a message’s words, its title from the first line', () => {
    const draft = promptDraftOf(null, '  Check the backups.\nAll of them.  ');
    expect(draft.title).toBe('Check the backups');
    expect(draft.text).toBe('Check the backups.\nAll of them.');
    expect(draft.onRepository).toBe(false);
    expect(promptDraftOf(null).onRepository).toBe(true);
  });

  it('sends ownership, the merge and the AI only for a repository, and refuses empty fields', () => {
    const ai = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', fast: null };
    const draft = { title: ' T ', text: ' words ', onRepository: false, ownIt: true, merge: true, ai };
    expect(promptSaveBody(draft)).toEqual({
      body: { title: 'T', text: 'words', onRepository: false, ownIt: false, merge: false, ai: null },
    });
    expect(promptSaveBody({ ...draft, onRepository: true })).toMatchObject({
      body: { ownIt: true, merge: true, ai },
    });
    expect(promptSaveBody({ ...draft, title: ' ' })).toEqual({ problem: 'title' });
    expect(promptSaveBody({ ...draft, text: '' })).toEqual({ problem: 'text' });
  });

  it('names the chosen AI as T3 Code does, and nothing for its default', () => {
    const line = promptAiLine(
      { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', fast: true },
      COUNCIL_PROVIDER_OPTIONS,
    );
    expect(line).toContain('GPT 6.1 Sol');
    expect(line).toContain('Fast');
    expect(promptAiLine({ provider: 'x', model: 'm-1', effort: null, fast: null }, null)).toBe('m-1');
    expect(promptAiLine(null, COUNCIL_PROVIDER_OPTIONS)).toBeNull();
  });
});

describe('a Whombat without prompts', () => {
  it('reads `unknown_op` and a missing route as no prompts, other failures as errors', () => {
    expect(promptsMissing({ code: 'unknown_op', status: 404 })).toBe(true);
    expect(promptsMissing({ status: 501 })).toBe(true);
    expect(promptsMissing({ status: 500, code: 'internal' })).toBe(false);
    expect(promptsMissing(null)).toBe(false);
  });
});
