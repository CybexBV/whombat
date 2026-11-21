/**
 * ChatGPT is what people sign in to and pick (2.1, CT-1450…CT-1452; Whombat hermes-native.md HN-02…HN-04): the
 * provider id stays `codex` everywhere on the wire, and every word people or agents read names it “ChatGPT”.
 */
import { describe, expect, it } from 'vitest';
import { ALL_ENDPOINTS } from '../contracts/index.js';
import { CATALOG } from '../domain/connections-catalog.js';
import { GATEWAY_PROVIDERS } from '../domain/gateway.js';
import { LIVE_PROVIDERS, PROVIDER_LABELS } from '../domain/providers.js';
import { UsageProvider } from '../domain/usage.js';
import { CHAT_PROVIDER_LABELS } from './chat-runtime.js';
import { GATEWAY_ACCOUNT_PROVIDER_LABELS, GATEWAY_TOOL_LABELS } from './gateway.js';
import { turnFailureText } from './turns.js';
import { USAGE_PROVIDER_LABELS, usageSummaryText } from './usage.js';

describe('ChatGPT’s name (CT-1450)', () => {
  it('keeps the id `codex` and names it ChatGPT in every label', () => {
    expect(LIVE_PROVIDERS).toContain('codex');
    expect(GATEWAY_PROVIDERS).toContain('codex');
    expect(UsageProvider.options).toContain('codex');
    for (const labels of [
      PROVIDER_LABELS,
      CHAT_PROVIDER_LABELS,
      USAGE_PROVIDER_LABELS,
      GATEWAY_TOOL_LABELS,
      GATEWAY_ACCOUNT_PROVIDER_LABELS,
    ])
      expect(labels.codex).toBe('ChatGPT');
    // Claude keeps its names.
    expect(PROVIDER_LABELS.claude).toBe('Claude Code');
    expect(GATEWAY_TOOL_LABELS.claude).toBe('Claude Code');
    expect(USAGE_PROVIDER_LABELS.claude).toBe('Claude');
  });

  it('says ChatGPT when a turn fails or a subscription is summed up', () => {
    for (const code of ['signin', 'usage_limit', 'provider'] as const) {
      const text = turnFailureText(code, { provider: 'codex' });
      expect(text, code).toContain('ChatGPT');
      expect(text, code).not.toMatch(/codex/i);
    }
    const summary = usageSummaryText(
      { provider: 'codex', kind: 'subscription', windows: [], connected: false },
      '2026-10-25T12:00:00.000Z',
    );
    expect(summary.startsWith('ChatGPT')).toBe(true);
  });

  it('never says Codex in an endpoint’s summary or a catalog entry’s words', () => {
    for (const e of ALL_ENDPOINTS) expect(e.summary, e.id).not.toMatch(/\bCodex\b/);
    for (const entry of CATALOG) {
      const words = [
        entry.description,
        entry.tagline ?? '',
        entry.guide,
        ...entry.fields.map((f) => f.help),
        ...entry.signIn.map((s) => ('secretHelp' in s ? s.secretHelp : '')),
      ];
      for (const text of words) expect(text, entry.id).not.toMatch(/\bCodex\b/);
    }
  });
});
