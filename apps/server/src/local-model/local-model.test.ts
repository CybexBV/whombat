/**
 * The model on the person's network, the pure parts (hermes-engine.md HE-S90…): the same-origin rule for a kept key, what
 * a save changes, the view without the key, the sealed key bound to its burrow, and how a test's two steps become its
 * result.
 */
import { describe, expect, it } from 'vitest';
import { KeyCustody } from '../keys/custody';
import { type LocalModelListing, localModelCheckOf } from './check';
import {
  keyFor,
  localModelChange,
  localModelKeyOf,
  localModelView,
  openLocalModelKey,
  sealLocalModelKey,
} from './store';

const AT = '2026-10-23T10:00:00.000Z';
const BASE = 'http://192.168.1.20:11434/v1';

describe('the key a save or a draft test uses (CT-1171)', () => {
  const saved = { baseUrl: BASE, key: 'sk-old' };

  it('a new key, none, or the saved one while the address keeps its origin', () => {
    expect(keyFor('sk-new', saved, 'http://10.0.0.9:8000/v1')).toEqual({ key: 'sk-new' });
    expect(keyFor(null, saved, BASE)).toEqual({ key: null });
    expect(keyFor(undefined, saved, 'http://192.168.1.20:11434/openai/v1')).toEqual({ key: 'sk-old' });
    expect(keyFor(undefined, null, BASE)).toEqual({ key: null });
    expect(keyFor(undefined, { baseUrl: BASE, key: null }, 'http://10.0.0.9/v1')).toEqual({ key: null });
  });

  it('never sends a saved key to another scheme, host or port', () => {
    for (const other of [
      'https://192.168.1.20:11434/v1',
      'http://192.168.1.21:11434/v1',
      'http://192.168.1.20:11435/v1',
    ])
      expect(keyFor(undefined, saved, other), other).toBe('refused');
  });
});

describe('what a save changes', () => {
  const m = { baseUrl: BASE, model: 'llama3.3', label: null, key: null };
  it('set, changed, or nothing', () => {
    expect(localModelChange(null, m)).toBe('set');
    expect(localModelChange(m, { ...m })).toBeNull();
    expect(localModelChange(m, { ...m, label: 'Llama on the NAS' })).toBe('changed');
    expect(localModelChange(m, { ...m, key: 'sk-1' })).toBe('changed');
  });
});

describe('the key at rest', () => {
  const custody = new KeyCustody(undefined);

  it('is sealed to its burrow and only says whether there is one', () => {
    const sealed = sealLocalModelKey(custody, 'brw_a', 'sk-secret');
    expect(sealed).not.toContain('sk-secret');
    expect(openLocalModelKey(custody, 'brw_a', sealed)).toBe('sk-secret');
    expect(() => openLocalModelKey(custody, 'brw_b', sealed)).toThrow();
    expect(localModelKeyOf(custody, { id: 'brw_b', localModelKeyEnc: sealed })).toBeNull();
    const view = localModelView({
      localModel: { baseUrl: BASE, model: 'llama3.3', label: null, check: null, updatedAt: AT },
      localModelKeyEnc: sealed,
    });
    expect(view).toMatchObject({ baseUrl: BASE, model: 'llama3.3', hasApiKey: true, check: null });
    expect(JSON.stringify(view)).not.toContain(sealed);
    expect(localModelView({ localModel: null, localModelKeyEnc: null })).toBeNull();
  });
});

describe('a test’s result from its two steps', () => {
  const listed: LocalModelListing = { ok: true, models: ['llama3.3', 'qwen3:32b'] };
  const failed = (reason: 'unreachable' | 'refused' | 'not_openai', blocked = false): LocalModelListing => ({
    ok: false,
    reason,
    blocked,
    detail: 'connect ECONNREFUSED',
  });
  const state = (
    model: string,
    listing: LocalModelListing,
    completion: Parameters<typeof localModelCheckOf>[2],
  ) => localModelCheckOf(model, listing, completion, AT).state;

  it('the list decides whether it answers as an OpenAI-compatible API', () => {
    expect(state('llama3.3', failed('unreachable'), null)).toBe('unreachable');
    expect(state('llama3.3', failed('refused'), null)).toBe('refused');
    expect(state('llama3.3', failed('not_openai'), null)).toBe('not_compatible');
    expect(state('llama3.3', failed('unreachable', true), null)).toBe('blocked');
  });

  it('the completion decides the rest', () => {
    expect(state('llama3.3', listed, { kind: 'answered' })).toBe('ok');
    expect(state('mistral', listed, { kind: 'answered' })).toBe('ok');
    expect(state('llama3.3', listed, { kind: 'status', status: 401, detail: null })).toBe('refused');
    expect(state('mistral', listed, { kind: 'status', status: 404, detail: 'HTTP 404' })).toBe('no_model');
    expect(state('llama3.3', listed, { kind: 'status', status: 500, detail: 'HTTP 500' })).toBe(
      'not_compatible',
    );
    // No answer in time: a model the list names is still loading.
    expect(state('llama3.3', listed, { kind: 'failed', detail: 'timeout' })).toBe('ok');
    expect(state('mistral', listed, { kind: 'failed', detail: 'timeout' })).toBe('no_model');
  });

  it('keeps the listed models and what was said, never a detail when ok', () => {
    const ok = localModelCheckOf('llama3.3', listed, { kind: 'answered' }, AT);
    expect(ok).toEqual({ state: 'ok', at: AT, models: ['llama3.3', 'qwen3:32b'], detail: null });
    const many: LocalModelListing = { ok: true, models: Array.from({ length: 60 }, (_, i) => `m${i}`) };
    expect(localModelCheckOf('m1', many, { kind: 'answered' }, AT).models).toHaveLength(40);
    const bad = localModelCheckOf(
      'x',
      listed,
      { kind: 'status', status: 500, detail: `Error: a\nb${'z'.repeat(900)}` },
      AT,
    );
    expect(bad.detail?.startsWith('a b')).toBe(true);
    expect(bad.detail?.length).toBeLessThanOrEqual(500);
  });
});
