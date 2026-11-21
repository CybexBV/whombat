/**
 * An agent's model and effort on the runtime's side (Whombat model-effort.md ME-02…ME-05): the kind of turn automatic
 * effort tells apart, the effort a provider sends, Claude Code's model lists as recorded from 2.1.296 / 2.1.283 without a
 * sign-in (fixtures/) and ChatGPT's as Hermes's catalog says it (hermes-native.md HN-04), with their fast replies
 * (chat-runtime.md CR-06), listing them through the fakes (a throwaway home, nothing of the runner's environment) and
 * whether a failure is the tool refusing the turn's model.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_MODELS_MAX } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { fakeClaude } from '../claude/testing/fake-claude.mjs';
import type { TurnInput } from '../contract';
import { chatgptModelLabel, chatgptModels, chatgptModelsFrom } from '../providers/login/chatgpt';
import claude283 from './fixtures/claude-initialize-2.1.283.json' with { type: 'json' };
import claude296 from './fixtures/claude-initialize-2.1.296.json' with { type: 'json' };
import {
  claudeApiModel,
  claudeModelDescription,
  claudeModelsFrom,
  listClaudeModels,
  modelRefused,
  turnEffortKind,
  turnEffortOf,
} from './index';

const FAKE_CHATGPT = fileURLToPath(new URL('../providers/testing/fake-chatgpt-steps.mjs', import.meta.url));

describe('turnEffortKind (RA-DS57, ME-02)', () => {
  const ctx = (dispatch: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({
      dispatch: { mode: 'reply', ...dispatch },
      run: null,
      workspace: null,
      ...extra,
    }) as TurnInput['context'];

  it('code work: a run turn, an automation step that writes', () => {
    expect(turnEffortKind(ctx({ trigger: 'run_control', mode: 'run' }, { run: { id: 'run_1' } }))).toBe(
      'work',
    );
    // A Try again of a run turn is a run turn too.
    expect(turnEffortKind(ctx({ trigger: 'retry', mode: 'run' }, { run: { id: 'run_1' } }))).toBe('work');
    expect(
      turnEffortKind(ctx({ trigger: 'automation' }, { workspace: { repo: 'a/b', access: 'write' } })),
    ).toBe('work');
  });

  it('everything conversational is chat', () => {
    for (const trigger of [
      'dm',
      'mention',
      'expand',
      'search',
      'feedback',
      'notify',
      'schedule',
      'approval_granted',
      'approval_declined',
      'vault_pass',
      'retry',
      'reflect',
    ])
      expect(turnEffortKind(ctx({ trigger })), trigger).toBe('chat');
    expect(turnEffortKind(ctx({ trigger: 'search', mode: 'answer' }))).toBe('chat');
    // An automation's read-only step (an investigation, a review) talks; one with no context at all too.
    expect(
      turnEffortKind(ctx({ trigger: 'automation' }, { workspace: { repo: 'a/b', access: 'read' } })),
    ).toBe('chat');
    expect(turnEffortKind(undefined)).toBe('chat');
  });
});

describe('turnEffortOf (ME-02, ME-03)', () => {
  const input = (effort: unknown, runtime: Record<string, unknown> = {}, mode = 'reply') =>
    ({
      context: { dispatch: { mode, trigger: 'dm' }, agent: { runtime: { provider: 'claude', ...runtime } } },
      ...(effort === undefined ? {} : { effort }),
    }) as unknown as TurnInput;

  it('automatic is medium for conversation and high for code work, for every tool', () => {
    expect(turnEffortOf(input(undefined))).toBe('medium');
    expect(turnEffortOf(input(undefined, {}, 'run'))).toBe('high');
  });

  it('the agent’s own level applies to every turn, conversations too', () => {
    expect(turnEffortOf(input(undefined, { effort: 'low' }, 'run'))).toBe('low');
    expect(turnEffortOf(input(undefined, { effort: 'max' }))).toBe('max');
  });

  it('the runner’s effort wins (kept within the model’s); null sends none', () => {
    expect(turnEffortOf(input('xhigh', { effort: 'ultra' }))).toBe('xhigh');
    expect(turnEffortOf(input(null, { effort: 'high' }))).toBeNull();
  });
});

describe('claudeModelsFrom (ME-04)', () => {
  it('Claude Code 2.1.296: default left out, its model marked, prices gone, efforts least first', () => {
    expect(claudeModelsFrom(claude296.models)).toEqual([
      {
        id: 'opus',
        label: 'Opus',
        description: 'Opus 5.5 · Best for everyday, complex tasks',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        isDefault: true,
        // `supportsFastMode`: offered, off unless a turn asks (CR-06).
        fast: 'off',
      },
      {
        id: 'fable',
        label: 'Fable',
        // Fable 5.2 came after this version: the `fable` entry means it.
        description: 'Fable 5.2 · Most capable for your hardest and longest-running tasks',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        isDefault: false,
      },
      {
        id: 'sonnet',
        label: 'Sonnet',
        description: 'Sonnet 5.5 · Efficient for routine tasks',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        isDefault: false,
      },
      {
        id: 'haiku',
        label: 'Haiku',
        description: 'Haiku 5.5 · Fastest for quick answers',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        isDefault: false,
      },
    ]);
  });

  it('Claude Code 2.1.283: a full model id, and a model that takes no effort', () => {
    const models = claudeModelsFrom(claude283.models);
    expect(models?.map((m) => m.id)).toEqual(['opus', 'claude-fable-5-2', 'sonnet', 'haiku']);
    expect(models?.find((m) => m.id === 'haiku')).toMatchObject({ efforts: [], isDefault: false });
    expect(models?.filter((m) => m.isDefault).map((m) => m.id)).toEqual(['opus']);
    // Only Opus (and the default it is) has fast replies.
    expect(models?.filter((m) => m.fast).map((m) => [m.id, m.fast])).toEqual([['opus', 'off']]);
  });

  it('a model released after the tool takes the place of the one it follows', () => {
    const fable51 = {
      displayName: 'Fable',
      description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok',
      supportedEffortLevels: ['low', 'high', 'max'],
    };
    const alias = claudeModelsFrom([{ value: 'fable', resolvedModel: 'claude-fable-5-1', ...fable51 }]);
    expect(alias).toEqual([
      expect.objectContaining({ id: 'fable', label: 'Fable', efforts: ['low', 'high', 'max'] }),
    ]);
    expect(alias?.[0]?.description).toContain('Fable 5.2');
    // Hermes's own loop (a key, the AI gateway) then names the newer model's API id.
    expect(claudeApiModel('fable')).toBe('claude-fable-5-2');

    const full = claudeModelsFrom([
      { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', ...fable51 },
    ]);
    expect(full?.map((m) => m.id)).toEqual(['claude-fable-5-2[1m]']);
    expect(claudeApiModel('claude-fable-5-2[1m]')).toBe('claude-fable-5-2');

    // Once the tool lists it itself, its list stands as it is.
    const listed = claudeModelsFrom([
      { value: 'claude-fable-5-2[1m]', resolvedModel: 'claude-fable-5-2', displayName: 'Fable' },
      { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', ...fable51 },
    ]);
    expect(listed?.map((m) => m.id)).toEqual(['claude-fable-5-2[1m]', 'claude-fable-5-1[1m]']);
    expect(listed?.[1]?.description).toContain('Fable 5.1');
  });

  it('fast replies only where the tool says the model supports them (CR-06)', () => {
    const models = claudeModelsFrom([
      { value: 'default', resolvedModel: 'x-1' },
      { value: 'a', resolvedModel: 'x-1', supportsFastMode: true },
      { value: 'b', resolvedModel: 'x-2', supportsFastMode: false },
      { value: 'c', resolvedModel: 'x-3', supportsFastMode: 'yes' },
    ]);
    expect(models?.map((m) => m.fast ?? null)).toEqual(['off', null, null]);
    expect(models?.[1]).not.toHaveProperty('fast');
  });

  it('keeps only what Whombat can use', () => {
    expect(
      claudeModelsFrom([
        { value: 'default', resolvedModel: 'x-1' },
        {
          value: 'a',
          resolvedModel: 'x-1',
          displayName: 'A',
          supportedEffortLevels: ['turbo', 'high', 'low'],
        },
        {
          value: 'b',
          resolvedModel: 'x-1',
          displayName: 'B',
          supportsEffort: false,
          supportedEffortLevels: ['low'],
        },
        { value: 'a', displayName: 'Again' },
        { value: '', displayName: 'Nameless' },
        { value: 'x'.repeat(121) },
        'not a model',
      ]),
    ).toEqual([
      { id: 'a', label: 'A', description: null, efforts: ['low', 'high'], isDefault: true },
      { id: 'b', label: 'B', description: null, efforts: [], isDefault: false },
    ]);
    // No `default` entry: none is the default.
    expect(claudeModelsFrom([{ value: 'opus', displayName: 'Opus' }])?.[0]?.isDefault).toBe(false);
    expect(claudeModelsFrom(undefined)).toBeNull();
    expect(claudeModelsFrom([])).toBeNull();
  });

  it('descriptions lose their prices, never their words', () => {
    expect(claudeModelDescription('Use the default model (currently Opus 5.5) · $4/$20 per Mtok')).toBe(
      'Use the default model (currently Opus 5.5)',
    );
    expect(claudeModelDescription('$1/$5 per Mtok')).toBeNull();
    expect(claudeModelDescription('x'.repeat(300))).toHaveLength(200);
  });
});

describe('ChatGPT’s models from Hermes’s catalog (ME-04, HN-04)', () => {
  it('every model with its own efforts, the default marked, fast replies where Hermes offers them', () => {
    const models = chatgptModelsFrom({
      models: [
        {
          id: 'gpt-6-sol',
          efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
          isDefault: true,
          fast: true,
        },
        { id: 'gpt-5.3-codex-spark', efforts: ['low', 'high'], isDefault: false, fast: false },
        { id: 'gpt-5.5', efforts: ['low', 'medium'], isDefault: true, fast: true },
      ],
    });
    expect(models?.map((m) => m.id)).toEqual(['gpt-6-sol', 'gpt-5.3-codex-spark', 'gpt-5.5']);
    expect(models?.filter((m) => m.isDefault).map((m) => m.id)).toEqual(['gpt-6-sol']);
    expect(models?.[0]?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(models?.[0]?.fast).toBe('off');
    expect(models?.[1]).not.toHaveProperty('fast');
    expect(models?.[1]?.label).toBe('GPT-5.3 Codex Spark');
  });

  it('names read as ChatGPT says them', () => {
    expect(chatgptModelLabel('gpt-6-sol')).toBe('GPT-6 Sol');
    expect(chatgptModelLabel('gpt-5.5')).toBe('GPT-5.5');
    expect(chatgptModelLabel('gpt-5.4-mini')).toBe('GPT-5.4 Mini');
  });

  it('a list cut at the contract’s maximum; none is no list', () => {
    const many = Array.from({ length: PROVIDER_MODELS_MAX + 5 }, (_, i) => ({ id: `gpt-${i}`, efforts: [] }));
    expect(chatgptModelsFrom({ models: many })).toHaveLength(PROVIDER_MODELS_MAX);
    expect(chatgptModelsFrom({ models: [] })).toBeNull();
    expect(chatgptModelsFrom({})).toBeNull();
  });
});

describe('modelRefused (ME-05)', () => {
  it('the tools refusing a model', () => {
    // Claude Code 2.1.296 (2026-10-10): its own code, and its words.
    expect(
      modelRefused(
        {
          message:
            "There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it. (HTTP 404)",
          code: 'model_not_found',
        },
        'claude-nonexistent-9',
      ),
    ).toBe(true);
    expect(
      modelRefused(
        {
          message:
            "There's an issue with the selected model (claude-opus-5-5). It may not exist or you may not have access to it.",
        },
        'opus',
      ),
    ).toBe(true);
    // The Messages API's own 404.
    expect(
      modelRefused(
        {
          message:
            'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-x"}}',
        },
        'claude-x',
      ),
    ).toBe(true);
    // Codex 0.162.1 with a ChatGPT sign-in, and the Responses API with a key.
    expect(
      modelRefused(
        {
          message:
            '{"detail":"The \'gpt-nonexistent-9\' model is not supported when using Codex with a ChatGPT account."}',
          code: 'other',
        },
        'gpt-nonexistent-9',
      ),
    ).toBe(true);
    expect(
      modelRefused(
        { message: 'The model `gpt-x` does not exist or you do not have access to it.', code: 'badRequest' },
        'gpt-x',
      ),
    ).toBe(true);
    // An AI gateway that doesn't serve it.
    expect(modelRefused({ message: 'Model "fable" is not available through this gateway.' }, 'fable')).toBe(
      true,
    );
    expect(modelRefused({ message: 'Invalid model.' }, 'sonnet')).toBe(true);
  });

  it('anything else fails as before', () => {
    const not = (message: string, code?: string) =>
      expect(modelRefused({ message, ...(code ? { code } : {}) }, 'opus'), message).toBe(false);
    not('Invalid API key · Fix external API key (HTTP 401)', 'authentication_failed');
    not('Your account does not have access to Claude. Please login again or contact your administrator.');
    not("You've hit your session limit · resets 3pm (UTC) (HTTP 429)", 'rate_limit');
    not('API Error: 529 Overloaded. This is a server-side issue, usually temporary.', 'server_error');
    not('API Error: 400 messages: bad shape', 'invalid_request');
    not('Credit balance is too low', 'billing_error');
    not('The model opus has reached its context window limit.');
    not('Codex app-server exited unexpectedly (1): file not found');
    not('Codex turn ended as failed.');
    // A refusal, but of something else.
    not('The tool `deploy` is not available here.');
    // No model of its own: the default was what ran.
    expect(modelRefused({ message: 'Invalid model.', code: 'model_not_found' }, undefined)).toBe(false);
  });
});

describe('listing a tool’s models (ME-04)', () => {
  const runnerEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    HOME: '/home/operator',
    ANTHROPIC_API_KEY: 'sk-ant-not-for-this',
    OPENAI_API_KEY: 'sk-not-for-this',
    CLAUDE_CONFIG_DIR: '/home/operator/.claude',
    CODEX_HOME: '/home/operator/.codex',
    WHOMBAT_RUNNER_TOKEN: 'runner-secret',
  };
  const readLog = (path: string) =>
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it('Claude Code: one initialize in a throwaway config dir, nothing of the runner’s environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-models-'));
    const record = join(dir, 'record.jsonl');
    const models = await listClaudeModels(fakeClaude({ record, models: claude296.models }), {
      env: runnerEnv,
      tmpRoot: dir,
    });
    expect(models?.map((m) => m.id)).toEqual(['opus', 'fable', 'sonnet', 'haiku']);
    const entries = readLog(record);
    const start = entries.find((e) => e.kind === 'start') as { argv: string[]; env: Record<string, string> };
    expect(start.argv).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources=',
    ]);
    expect(Object.keys(start.env).sort()).toEqual(
      [
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
        'CLAUDE_CONFIG_DIR',
        'DISABLE_AUTOUPDATER',
        'HOME',
        'LANG',
        'PATH',
        'TMPDIR',
      ].sort(),
    );
    expect(start.env.CLAUDE_CONFIG_DIR).toBe(start.env.HOME);
    expect(start.env.HOME?.startsWith(dir)).toBe(true);
    // Its home is gone with it.
    expect(existsSync(start.env.HOME ?? '')).toBe(false);
    expect(entries.find((e) => e.kind === 'initialize')).toMatchObject({
      request: { subtype: 'initialize' },
    });
  });

  it('no list when the tool isn’t there, refuses, or doesn’t answer in time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-models-'));
    expect(await listClaudeModels(join(dir, 'no-such-claude'), { tmpRoot: dir })).toBeNull();
    const refusing = fakeClaude({ record: join(dir, 'r.jsonl'), initializeError: 'No.' });
    expect(await listClaudeModels(refusing, { tmpRoot: dir })).toBeNull();
    const silent = join(dir, 'silent.mjs');
    writeFileSync(silent, 'setInterval(() => {}, 1000);\n');
    const startedAt = Date.now();
    expect(await listClaudeModels(silent, { tmpRoot: dir, timeoutMs: 300 })).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it('ChatGPT: Hermes’s models step in a throwaway Hermes home, nothing of the runner’s environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-models-'));
    const models = await chatgptModels(
      { command: [process.execPath, FAKE_CHATGPT], hostEnv: runnerEnv },
      dir,
    );
    expect(models?.find((m) => m.isDefault)?.id).toBe('gpt-6-sol');
    // The throwaway home is gone with the step.
    expect(readdirSync(dir)).toEqual([]);
    expect(await chatgptModels({ command: ['/nonexistent/python'] }, dir)).toBeNull();
  });
});
