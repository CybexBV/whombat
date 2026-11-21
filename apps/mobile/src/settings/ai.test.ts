import type { ClientStatus, ProviderSignIn, SubscriptionUsage } from '@whombat/core/domain';
import { NBSP } from '@whombat/core/text';
import { describe, expect, it } from 'vitest';
import { AI_TEXT, aiProviderCards, meterLabel, planText, shownWindows } from './ai';

const NOW = Date.parse('2026-09-23T09:22:00.000Z');
const TZ = 'Europe/Amsterdam';

const signIn = (over: Partial<ProviderSignIn> = {}): ProviderSignIn => ({
  provider: 'claude',
  authMode: 'subscription_cli',
  createdAt: '2026-08-24T07:00:00.000Z',
  expiresAt: null,
  verified: 'valid',
  login: null,
  state: 'ready',
  explanation: null,
  ...over,
});

const client = (provider: 'claude' | 'codex', version: string | null): ClientStatus =>
  ({
    provider,
    installed: version ? { version, installedAt: null, source: 'whombat' } : null,
    latest: null,
    state: version ? 'installed' : 'not_installed',
    progress: null,
    error: null,
  }) as ClientStatus;

const usage = (over: Partial<SubscriptionUsage> = {}): SubscriptionUsage => ({
  provider: 'claude',
  kind: 'subscription',
  connected: true,
  plan: 'max',
  windows: [
    { kind: 'five_hour', label: '5-hour', usedPct: 62, resetsAt: '2026-09-23T11:32:00.000Z', status: 'ok' },
    { kind: 'seven_day', label: '7-day', usedPct: 41, resetsAt: null, status: 'ok' },
    { kind: 'seven_day_opus', label: '7-day Opus', usedPct: 18, resetsAt: null, status: 'ok' },
  ],
  observedAt: '2026-09-23T09:18:00.000Z',
  source: 'probe',
  error: null,
  ...over,
});

describe('Settings → AI: a card per provider (less-is-more.md AP-1814)', () => {
  it('puts the sign-in, the plan and the 5-hour and 7-day meters together; the rest under Details', () => {
    const [claude, chatgpt] = aiProviderCards({
      signIns: [signIn()],
      clients: [client('claude', '2.1.40')],
      usage: [usage()],
      now: NOW,
      timeZone: TZ,
    });
    expect(claude).toMatchObject({
      name: 'Claude Code',
      tone: 'ok',
      status: 'Signed in · Max plan',
      signIn: false,
      trouble: false,
      note: null,
    });
    // A healthy 7-day Opus stays out; nothing says “resets” while all is well.
    expect(claude?.meters.map((m) => [m.label, m.pctText, m.word, m.resets])).toEqual([
      ['5-hour', `62${NBSP}%`, null, null],
      ['7-day', `41${NBSP}%`, null, null],
    ]);
    expect(claude?.details).toEqual([
      'Signed in with your Claude subscription',
      'Claude Code 2.1.40 on this Whombat',
      'Usage as of 11:18',
    ]);
    expect(chatgpt).toMatchObject({
      provider: 'codex',
      name: 'ChatGPT',
      tone: 'mut',
      status: 'Not signed in',
      signIn: true,
      meters: [],
    });
  });

  it('shows ChatGPT whether or not a Codex client is listed, with no client line (AP-5618)', () => {
    const signedIn = signIn({ provider: 'codex', authMode: 'chatgpt' });
    for (const clients of [
      [client('claude', '2.1.40')],
      [client('claude', '2.1.40'), client('codex', null)],
    ]) {
      const cards = aiProviderCards({ signIns: [signedIn], clients, usage: [], now: NOW, timeZone: TZ });
      expect(cards.map((c) => c.provider)).toEqual(['claude', 'codex']);
      const chatgpt = cards[1];
      expect(chatgpt?.details).toEqual(['Signed in with your ChatGPT plan']);
      expect(chatgpt?.details.join(' ')).not.toMatch(/installed|on this Whombat|Codex/);
    }
    // An older Whombat's Codex client says nothing either.
    const [, older] = aiProviderCards({
      signIns: [signedIn],
      clients: [client('claude', '2.1.40'), client('codex', '0.63.0')],
      usage: [],
      now: NOW,
      timeZone: TZ,
    });
    expect(older?.details.join(' ')).not.toMatch(/0\.63\.0|Codex/);
  });

  it('shows a window that runs high, with its word and when it resets', () => {
    const high = usage({
      windows: [
        {
          kind: 'five_hour',
          label: '5-hour',
          usedPct: 96,
          resetsAt: '2026-09-23T11:32:00.000Z',
          status: 'warning',
        },
        { kind: 'seven_day_opus', label: '7-day Opus', usedPct: 85, resetsAt: null, status: 'ok' },
      ],
    });
    const [claude] = aiProviderCards({
      signIns: [signIn()],
      clients: undefined,
      usage: [high],
      now: NOW,
      timeZone: TZ,
    });
    expect(claude?.meters.map((m) => [m.label, m.word, m.tone])).toEqual([
      ['5-hour', 'Near the limit', 'bad'],
      ['7-day Opus', 'High', 'warn'],
    ]);
    expect(claude?.meters[0]?.resets).toBe('resets in 2 h 10 min');
    expect(meterLabel(claude?.meters[0] ?? ({} as never))).toBe(
      `5-hour, 96${NBSP}% used, Near the limit, resets in 2 h 10 min`,
    );
    expect(claude?.label).toContain(`5-hour 96${NBSP}%, Near the limit`);
  });

  it('opens Details by itself and offers to sign in again when a sign-in stopped working (AP-1753)', () => {
    const [claude] = aiProviderCards({
      signIns: [signIn({ state: 'auth_expired', explanation: 'Sign in to Claude Code again.' })],
      clients: undefined,
      usage: [usage()],
      now: NOW,
      timeZone: TZ,
    });
    expect(claude).toMatchObject({
      tone: 'bad',
      status: 'Sign-in expired',
      trouble: true,
      signIn: true,
      note: 'Sign in to Claude Code again.',
      meters: [],
    });
  });

  it('says “Pay as you go” for an API key instead of meters, and leaves out Claude Code while it isn’t installed', () => {
    const cards = aiProviderCards({
      signIns: [signIn({ provider: 'codex', authMode: 'api_key' })],
      clients: [client('claude', null)],
      usage: [usage({ provider: 'codex', kind: 'api_key', plan: null, windows: [] })],
      now: NOW,
      timeZone: TZ,
    });
    expect(cards.map((c) => c.name)).toEqual(['ChatGPT']);
    expect(cards[0]).toMatchObject({
      status: 'Signed in · API key',
      note: 'Pay as you go — see Spend',
      meters: [],
    });
  });

  it('words the plan and the help sentence', () => {
    expect(planText({ kind: 'subscription', plan: 'max_5x' })).toBe('Max 5x plan');
    expect(planText({ kind: 'subscription', plan: null })).toBe('Subscription');
    expect(planText({ kind: 'api_key', plan: 'pro' })).toBe('API key');
    expect(AI_TEXT.help('Neo')).toContain('Neo');
    expect(AI_TEXT.help('Neo')).toContain('Claude and ChatGPT sign-ins');
    expect(shownWindows([])).toEqual([]);
  });
});
