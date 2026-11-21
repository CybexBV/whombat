/**
 * The person's prompts on the phone (prompts-phone.md): what `/` offers, the picker's states, the Settings line, the
 * editor's draft and what Save sends, the AI line, when bringing Whombat's prompts back shows.
 */
import { PROMPT_WORDS } from '@whombat/client';
import {
  PROMPT_TEXT_MAX,
  PROMPT_TITLE_MAX,
  type Prompt,
  STARTER_PROMPTS,
  starterPromptId,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { COUNCIL_PROVIDER_OPTIONS } from '../fixtures/councilSetups';
import {
  canRestorePrompts,
  promptAiFromMenu,
  promptAiLine,
  promptCanSave,
  promptChoice,
  promptDraftBody,
  promptDraftFor,
  promptListLine,
  promptPickerView,
  slashQuery,
  slashRows,
} from './prompts';

const now = new Date(2026, 10, 12, 15, 0);
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

function prompt(over: Partial<Prompt> = {}): Prompt {
  return {
    id: 'prm_one',
    title: 'Find what’s broken',
    text: 'Read this entire project.\nThen fix it.',
    onRepository: true,
    ownIt: false,
    merge: false,
    ai: null,
    starter: false,
    edited: false,
    runs: [],
    updatedAt: null,
    ...over,
  };
}

const starters = (): Prompt[] =>
  STARTER_PROMPTS.map((s) =>
    prompt({ id: starterPromptId(s.key), title: s.title, text: s.text, starter: true }),
  );

describe('/ in the composer', () => {
  it('reads a / and one word, nothing else', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/te')).toBe('te');
    expect(slashQuery('/skill do it')).toBeNull();
    expect(slashQuery('hi /te')).toBeNull();
    expect(slashQuery('/te\n')).toBeNull();
  });

  it('offers the prompts that match, with their first line', () => {
    const rows = slashRows(starters(), '/pru');
    expect(rows?.map((r) => r.title)).toEqual(['Prune the tests']);
    expect(rows?.[0]?.preview).not.toContain('\n');
    expect(slashRows(starters(), '/zzz')).toBeNull();
    expect(slashRows(starters(), 'hello')).toBeNull();
    expect(slashRows([], '/')).toBeNull();
  });

  it('puts words in the draft or asks which repository', () => {
    expect(promptChoice({ onRepository: false })).toBe('draft');
    expect(promptChoice({ onRepository: true })).toBe('repository');
  });
});

describe('which repository', () => {
  const projects = [
    { id: 'a', title: 'Whombat', folder: null },
    { id: 'b', title: 'Fusebox', folder: '~/Code/fusebox' },
  ];
  const ran = prompt({ runs: [{ projectId: 'a', title: 'Whombat', at: daysAgo(3) }] });

  it('asks T3 Code first, then lists the ones it ran on first', () => {
    expect(promptPickerView(ran, undefined, false, '', now).kind).toBe('loading');
    const view = promptPickerView(ran, { projects, t3: 'ready' }, false, '', now);
    expect(view.kind === 'rows' && view.rows.map((r) => [r.id, r.ran])).toEqual([
      ['a', 'Ran 3 days ago'],
      ['b', null],
    ]);
  });

  it('says when there are none, none by that name, or why T3 Code has none', () => {
    expect(promptPickerView(ran, { projects: [], t3: 'ready' }, false, '', now)).toEqual({
      kind: 'empty',
      text: PROMPT_WORDS.pickEmpty,
    });
    expect(promptPickerView(ran, { projects, t3: 'ready' }, false, 'zz', now)).toMatchObject({
      text: PROMPT_WORDS.pickNone,
    });
    expect(promptPickerView(ran, { projects: null, t3: 'not_connected' }, false, '', now)).toEqual({
      kind: 't3',
      text: PROMPT_WORDS.t3.not_connected,
    });
    expect(promptPickerView(ran, undefined, true, '', now)).toMatchObject({ kind: 't3' });
  });
});

describe('Settings → You → Prompts', () => {
  it('shows the first line and the latest run', () => {
    const line = promptListLine(
      prompt({
        runs: [
          { projectId: 'b', title: 'Fusebox', at: daysAgo(3) },
          { projectId: 'a', title: 'Whombat', at: daysAgo(9) },
        ],
      }),
      now,
    );
    expect(line.preview).toBe('Read this entire project.');
    expect(line.ran).toBe('Ran 3 days ago · Fusebox');
    expect(promptListLine(prompt(), now).ran).toBeNull();
  });

  it('offers Whombat’s prompts back when one is gone or changed', () => {
    expect(canRestorePrompts(starters())).toBe(false);
    expect(canRestorePrompts(starters().slice(1))).toBe(true);
    expect(canRestorePrompts(starters().map((p, i) => (i === 2 ? { ...p, edited: true } : p)))).toBe(true);
  });
});

describe('the editor', () => {
  it('opens on a prompt, on a message’s words, or empty', () => {
    expect(promptDraftFor(prompt({ ownIt: true }))).toMatchObject({
      title: 'Find what’s broken',
      ownIt: true,
    });
    const fromMessage = promptDraftFor(null, '  Check the backups.\nAll of them. ');
    expect(fromMessage).toMatchObject({
      title: 'Check the backups',
      text: 'Check the backups.\nAll of them.',
    });
    expect(fromMessage.onRepository).toBe(false);
    expect(promptDraftFor(null).onRepository).toBe(true);
  });

  it('saves only a title and words that fit, once something changed', () => {
    const original = promptDraftFor(prompt());
    expect(promptCanSave(original, original)).toBe(false);
    expect(promptCanSave({ ...original, title: 'Audit' }, original)).toBe(true);
    expect(promptCanSave({ ...original, title: ' ' }, null)).toBe(false);
    expect(promptCanSave({ ...original, title: 'x'.repeat(PROMPT_TITLE_MAX + 1) }, null)).toBe(false);
    expect(promptCanSave({ ...original, text: 'x'.repeat(PROMPT_TEXT_MAX + 1) }, null)).toBe(false);
    expect(promptCanSave(promptDraftFor(null, 'Hello'), null)).toBe(true);
  });

  it('sends the ownership switch, the merge and the AI only for a repository', () => {
    const ai = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', fast: null };
    const draft = { title: ' T ', text: ' Words ', onRepository: false, ownIt: true, merge: true, ai };
    expect(promptDraftBody(draft)).toEqual({
      title: 'T',
      text: 'Words',
      onRepository: false,
      ownIt: false,
      merge: false,
      ai: null,
    });
    expect(promptDraftBody({ ...draft, onRepository: true })).toMatchObject({ ownIt: true, merge: true, ai });
  });

  it('names the AI as T3 Code does, or its default', () => {
    expect(promptAiLine(null, COUNCIL_PROVIDER_OPTIONS)).toBe(PROMPT_WORDS.aiDefault);
    const line = promptAiLine(
      { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'xhigh', fast: null },
      COUNCIL_PROVIDER_OPTIONS,
    );
    expect(line).toContain('Claude Opus 5.5');
    expect(promptAiLine({ provider: 'x', model: 'gone-1', effort: null, fast: null }, null)).toBe('gone-1');
    expect(
      promptAiFromMenu(
        { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', fast: null },
        COUNCIL_PROVIDER_OPTIONS,
      ),
    ).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    expect(promptAiFromMenu({ provider: null, model: null, effort: null, fast: null }, [])).toBeNull();
  });
});
