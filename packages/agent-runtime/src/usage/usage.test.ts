import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fakeClaude } from '../claude/testing/fake-claude.mjs';
import { chatgptUsageFrom } from '../providers/login/chatgpt';
import {
  claudeRateLimitObservation,
  mergeObservation,
  parseClaudeGetUsage,
  runUsageProbe,
  statusOf,
  type UsageObservation,
} from './index';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = (name: string) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
const AT = '2026-09-29T19:36:00.000Z';

describe('Claude Code get_usage', () => {
  it('reads a Max login: plan, the named windows and a model’s own window, nothing else', () => {
    const usage = parseClaudeGetUsage(fixture('claude-get-usage-max.json'), AT);
    expect(usage).toEqual({
      provider: 'claude',
      kind: 'subscription',
      plan: 'max',
      observedAt: AT,
      error: null,
      windows: [
        { kind: 'five_hour', label: '5-hour', usedPct: 0, resetsAt: null, status: 'ok', windowMinutes: 300 },
        {
          kind: 'seven_day',
          label: '7-day',
          usedPct: 77,
          resetsAt: '2026-10-02T15:00:00.368Z',
          status: 'ok',
          windowMinutes: 10080,
        },
        {
          kind: 'other',
          label: 'Fable 7-day',
          usedPct: 11,
          resetsAt: '2026-10-02T15:00:00.368Z',
          status: 'ok',
          windowMinutes: 10080,
        },
      ],
    });
  });

  it('an API key or a cloud provider: no plan limits, no windows', () => {
    // What 2.1.283 answered with an API key (recorded from the binary, offline).
    const usage = parseClaudeGetUsage(
      {
        session: { total_cost_usd: 0 },
        subscription_type: null,
        rate_limits_available: false,
        rate_limits: null,
        behaviors: null,
      },
      AT,
    );
    expect(usage).toMatchObject({ kind: 'api_key', plan: null, windows: [], error: null });
  });

  it('a plan whose limits weren’t reported is an error, not a key', () => {
    expect(
      parseClaudeGetUsage({ subscription_type: 'pro', rate_limits_available: true, rate_limits: null }, AT),
    ).toMatchObject({
      kind: 'subscription',
      plan: 'pro',
      windows: [],
      error: expect.stringMatching(/limits/),
    });
  });

  it('forgives odd values: utilization over 100 or missing, a bad date', () => {
    const usage = parseClaudeGetUsage(
      {
        subscription_type: 'pro',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 104.6, resets_at: 'soon' },
          seven_day_opus: { utilization: null, resets_at: null },
          model_scoped: [{ utilization: 5 }, 'x'],
        },
      },
      AT,
    );
    expect(usage.windows).toEqual([
      {
        kind: 'five_hour',
        label: '5-hour',
        usedPct: 100,
        resetsAt: null,
        status: 'limited',
        windowMinutes: 300,
      },
      {
        kind: 'seven_day_opus',
        label: '7-day Opus',
        usedPct: null,
        resetsAt: null,
        status: 'ok',
        windowMinutes: 10080,
      },
    ]);
  });
});

describe('Claude Code rate_limit_event', () => {
  it('reads the limiting window (utilization 0–1) and a warning', () => {
    expect(
      claudeRateLimitObservation(
        { status: 'allowed_warning', resetsAt: 4102444800, rateLimitType: 'five_hour', utilization: 0.853 },
        AT,
      ),
    ).toEqual({
      provider: 'claude',
      kind: 'subscription',
      plan: null,
      observedAt: AT,
      error: null,
      windows: [
        {
          kind: 'five_hour',
          label: '5-hour',
          usedPct: 85.3,
          resetsAt: '2100-01-01T00:00:00.000Z',
          status: 'warning',
          windowMinutes: 300,
        },
      ],
    });
  });

  it('rejected is the limit hit, even without a utilization', () => {
    const usage = claudeRateLimitObservation(
      { status: 'rejected', resetsAt: 4102444800, rateLimitType: 'seven_day_opus' },
      AT,
    );
    expect(usage?.windows).toEqual([
      expect.objectContaining({ kind: 'seven_day_opus', usedPct: 100, status: 'limited' }),
    ]);
  });

  it('reads both unified windows when the CLI sends them', () => {
    const usage = claudeRateLimitObservation(
      {
        status: 'allowed',
        unifiedWindows: {
          five_hour: { utilization: 0.12, resetsAt: 4102444800 },
          seven_day: { utilization: 0.951, resetsAt: 4102790400 },
        },
      },
      AT,
    );
    expect(usage?.windows.map((w) => [w.kind, w.usedPct, w.status])).toEqual([
      ['five_hour', 12, 'ok'],
      ['seven_day', 95.1, 'warning'],
    ]);
  });

  it('says nothing when no window is named (an overage event, an older CLI)', () => {
    expect(claudeRateLimitObservation({ status: 'allowed', rateLimitType: 'overage' }, AT)).toBeNull();
    expect(claudeRateLimitObservation({ status: 'allowed' }, AT)).toBeNull();
    expect(claudeRateLimitObservation(null, AT)).toBeNull();
  });
});

describe('ChatGPT’s usage as Hermes reads it (HN-03)', () => {
  it('300 minutes is the 5-hour window, 10 080 the 7-day one; the plan as ChatGPT says it', () => {
    const usage = chatgptUsageFrom(
      {
        plan: 'plus',
        windows: [
          { usedPercent: 83, windowMinutes: 300, resetsAt: '2100-01-01T00:00:00Z' },
          { usedPercent: 41, windowMinutes: 10_080, resetsAt: '2100-01-05T00:00:00Z' },
        ],
        limited: false,
      },
      AT,
    );
    expect(usage).toEqual({
      provider: 'codex',
      kind: 'subscription',
      plan: 'plus',
      observedAt: AT,
      error: null,
      windows: [
        {
          kind: 'five_hour',
          label: '5-hour',
          usedPct: 83,
          resetsAt: '2100-01-01T00:00:00.000Z',
          status: 'warning',
          windowMinutes: 300,
        },
        {
          kind: 'seven_day',
          label: '7-day',
          usedPct: 41,
          resetsAt: '2100-01-05T00:00:00.000Z',
          status: 'ok',
          windowMinutes: 10080,
        },
      ],
    });
  });

  it('another length is `other`, labelled by it; a reached limit is `limited`; nothing is an error', () => {
    const usage = chatgptUsageFrom(
      { plan: null, windows: [{ usedPercent: 100, windowMinutes: 60, resetsAt: null }], limited: true },
      AT,
    );
    expect(usage).toMatchObject({
      plan: null,
      windows: [{ kind: 'other', label: '1-hour', usedPct: 100, status: 'limited', windowMinutes: 60 }],
    });
    expect(chatgptUsageFrom({ windows: [] }, AT)).toMatchObject({ windows: [], error: expect.any(String) });
  });
});

describe('merging readings', () => {
  const probe: UsageObservation = {
    provider: 'claude',
    kind: 'subscription',
    plan: 'max',
    observedAt: AT,
    error: null,
    windows: [
      { kind: 'five_hour', label: '5-hour', usedPct: 10, resetsAt: null, status: 'ok', windowMinutes: 300 },
      { kind: 'seven_day', label: '7-day', usedPct: 70, resetsAt: null, status: 'ok', windowMinutes: 10080 },
    ],
  };

  it('a turn’s reading replaces the windows it names and keeps the plan and the rest', () => {
    const turn = claudeRateLimitObservation(
      { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9 },
      '2026-09-29T20:00:00.000Z',
    ) as UsageObservation;
    const merged = mergeObservation(probe, turn);
    expect(merged.plan).toBe('max');
    expect(merged.observedAt).toBe('2026-09-29T20:00:00.000Z');
    expect(merged.windows.map((w) => [w.kind, w.usedPct])).toEqual([
      ['five_hour', 90],
      ['seven_day', 70],
    ]);
  });

  it('an API-key reading replaces everything', () => {
    expect(mergeObservation(probe, { ...probe, kind: 'api_key', plan: null, windows: [] }).windows).toEqual(
      [],
    );
  });

  it('statuses: 80 % warns, 100 % or a refusal is limited', () => {
    expect([statusOf(79), statusOf(80), statusOf(99), statusOf(100), statusOf(12, 'limited')]).toEqual([
      'ok',
      'warning',
      'warning',
      'limited',
      'limited',
    ]);
  });
});

describe('the probe through the CLIs', () => {
  const home = () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'wb-usage-'));
    const work = join(dir, 'work');
    mkdirSync(work);
    return { dir, work };
  };

  it('Claude: get_usage alone (no user message), with the home’s config dir and nothing of the host', async () => {
    const { dir, work } = home();
    const record = join(dir, 'record.jsonl');
    const command = fakeClaude({ record, usage: fixture('claude-get-usage-max.json') });
    const usage = await runUsageProbe({
      provider: 'claude',
      home: dir,
      authMode: 'subscription_cli',
      command,
      cwd: work,
      hostEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-ant-host', LANG: 'C.UTF-8' },
      now: () => new Date(AT),
    });
    expect(usage).toMatchObject({ kind: 'subscription', plan: 'max', error: null });
    const lines = readFileSync(record, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const start = lines.find((l) => l.kind === 'start');
    expect(start.env.CLAUDE_CONFIG_DIR).toBe(join(dir, 'config'));
    expect(start.env.HOME).toBe(work);
    expect(start.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(start.env.DISABLE_AUTOUPDATER).toBe('1');
    expect(start.argv).toContain('--setting-sources=');
    expect(start.argv).toContain('--strict-mcp-config');
    expect(JSON.parse(start.argv[start.argv.indexOf('--settings') + 1])).toEqual({
      disableAllHooks: true,
      env: { DISABLE_UPDATES: '1' },
    });
    expect(lines.filter((l) => l.kind === 'get_usage').map((l) => l.request)).toEqual([
      { subtype: 'get_usage', skip_behaviors: true },
    ]);
    // Never a model turn.
    expect(lines.some((l) => l.kind === 'user' || l.kind === 'initialize')).toBe(false);
    expect(lines.at(-1)?.kind).toBe('stdin-closed');
  });

  it('Claude: an older CLI without get_usage is a reading with the error, not a failure', async () => {
    const { dir, work } = home();
    const command = fakeClaude({ record: join(dir, 'r.jsonl') });
    const usage = await runUsageProbe({
      provider: 'claude',
      home: dir,
      authMode: 'subscription_cli',
      command,
      cwd: work,
    });
    expect(usage).toMatchObject({
      kind: 'subscription',
      windows: [],
      error: 'Unsupported control request subtype: get_usage',
    });
  });

  it('an API key is never probed', async () => {
    const usage = await runUsageProbe({
      provider: 'claude',
      home: '/nonexistent',
      authMode: 'api_key',
      command: '/nonexistent/claude',
      cwd: '/nonexistent',
    });
    expect(usage).toMatchObject({ kind: 'api_key', windows: [] });
  });
});
