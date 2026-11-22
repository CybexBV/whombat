import type { LocalModelView } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_MODEL_FIELDS,
  localModelCheckLine,
  localModelDraft,
  localModelKeyChoice,
  localModelOf,
  localModelProblems,
  localModelRow,
  localModelSaved,
  localModelSetBody,
  localModelTestBody,
} from './localModel';

const saved = (over: Partial<LocalModelView> = {}): LocalModelView => ({
  baseUrl: 'http://192.168.1.20:11434/v1',
  model: 'llama3.3:70b',
  label: 'Llama on the NAS',
  hasApiKey: true,
  check: null,
  updatedAt: '2026-10-23T09:00:00.000Z',
  ...over,
});

describe('a model on your network (HE-32, CT-1170…CT-1175)', () => {
  it('reads the burrow’s', () => {
    expect(localModelOf({ localModel: saved() })?.model).toBe('llama3.3:70b');
    expect(localModelOf({})).toBeNull();
  });

  it('starts the form from the saved model, never with its key', () => {
    expect(localModelDraft(saved())).toEqual({
      baseUrl: 'http://192.168.1.20:11434/v1',
      model: 'llama3.3:70b',
      label: 'Llama on the NAS',
      apiKey: '',
    });
    expect(localModelDraft(null)).toEqual({ baseUrl: '', model: '', label: '', apiKey: '' });
  });

  it('says per field what stops it, in the contracts’ words for the address', () => {
    expect(Object.keys(localModelProblems(localModelDraft(null)))).toEqual(['baseUrl', 'model']);
    const problems = (baseUrl: string) =>
      localModelProblems({ ...localModelDraft(saved()), baseUrl }).baseUrl;
    expect(problems('http://192.168.1.20:11434/v1')).toBeUndefined();
    expect(problems('https://llm.tailnet.ts.net/v1')).toBeUndefined();
    expect(problems('http://127.0.0.1:11434/v1')).toContain('192.168.1.20');
    expect(problems('http://8.8.8.8/v1')).toContain('https://');
    expect(problems('ftp://nas/v1')).toContain('http://');
    expect(localModelProblems({ ...localModelDraft(saved()), label: 'x'.repeat(61) }).label).toBeTruthy();
  });

  it('keeps a saved key on the same server, drops it for another, sends a typed one', () => {
    const view = saved();
    const draft = localModelDraft(view);
    expect(localModelKeyChoice(draft, view)).toBe('keep');
    expect(localModelSetBody(draft, view)).toEqual({
      baseUrl: view.baseUrl,
      model: view.model,
      label: 'Llama on the NAS',
    });
    const moved = { ...draft, baseUrl: 'http://192.168.1.30:1234/v1' };
    expect(localModelKeyChoice(moved, view)).toBe('drop');
    expect(localModelSetBody(moved, view).apiKey).toBeNull();
    expect(localModelSetBody({ ...draft, apiKey: ' sk-local ', label: ' ' }, view)).toMatchObject({
      apiKey: 'sk-local',
      label: null,
    });
    expect(localModelKeyChoice(draft, saved({ hasApiKey: false }))).toBe('none');
    expect('apiKey' in localModelSetBody(draft, null)).toBe(false);
  });

  it('checks the saved model again while the form holds it, else tries the draft', () => {
    const view = saved();
    expect(localModelTestBody(localModelDraft(view), view)).toEqual({});
    expect(localModelTestBody({ ...localModelDraft(view), label: 'Other name' }, view)).toEqual({});
    expect(localModelTestBody({ ...localModelDraft(view), model: 'qwen3:32b' }, view)).toEqual({
      draft: { baseUrl: view.baseUrl, model: 'qwen3:32b' },
    });
    expect(localModelTestBody({ ...localModelDraft(view), apiKey: 'sk-new' }, view).draft?.apiKey).toBe(
      'sk-new',
    );
  });

  it('says what a test found with its tone', () => {
    expect(localModelCheckLine(null, 'llama3.3:70b')).toEqual({ text: 'Not tested yet.', tone: 'mut' });
    expect(localModelCheckLine({ state: 'ok' }, 'llama3.3:70b').tone).toBe('ok');
    expect(localModelCheckLine({ state: 'unreachable' }, 'llama3.3:70b').tone).toBe('warn');
    const missing = localModelCheckLine({ state: 'no_model' }, 'llama3.3:70b');
    expect(missing.tone).toBe('bad');
    expect(missing.text).toContain('llama3.3:70b');
  });

  it('names the row by its name, the model beside the address when the name hides it', () => {
    expect(localModelRow(saved())).toEqual({
      name: 'Llama on the NAS',
      meta: 'llama3.3:70b · http://192.168.1.20:11434/v1',
    });
    expect(localModelRow(saved({ label: null }))).toEqual({
      name: 'llama3.3:70b',
      meta: 'http://192.168.1.20:11434/v1',
    });
    expect(LOCAL_MODEL_FIELDS.map((f) => f.field)).toEqual(['baseUrl', 'model', 'label', 'apiKey']);
  });

  it('confirms a custom AI model save against what the box returned', () => {
    const view = saved();
    const req = localModelSetBody(localModelDraft(view), view);
    expect(localModelSaved(req, view)).toBe(true);
    expect(localModelSaved(req, null)).toBe(false);
    expect(localModelSaved(req, saved({ model: 'other' }))).toBe(false);
    expect(localModelSaved(req, saved({ baseUrl: 'https://other.example/v1' }))).toBe(false);
    expect(localModelSaved(req, saved({ label: null }))).toBe(false);
    expect(localModelSaved({ ...req, apiKey: 'sk-new' }, saved({ hasApiKey: false }))).toBe(false);
    expect(localModelSaved({ ...req, apiKey: null }, saved({ hasApiKey: true }))).toBe(false);
    expect(localModelSaved({ ...req, apiKey: null }, saved({ hasApiKey: false }))).toBe(true);
  });
});
