import { describe, expect, it } from 'vitest';
import {
  AI_GATEWAY_COPY,
  formatGatewayUntil,
  GATEWAY_ALERT_KINDS,
  GATEWAY_TOOL_LABELS,
  gatewayAccountLabel,
  gatewayAccountStatusText,
  gatewayAlertText,
  gatewayKeysText,
  gatewayRefusalText,
  gatewaySwitchConfirms,
  gatewayToolsText,
  gatewayUpdatedText,
} from './gateway.js';

const AMS = 'Europe/Amsterdam';
const NY = 'America/New_York';
/** Saturday 10 October 2026, 16:00 in Amsterdam (CEST, UTC+2). */
const NOW = '2026-10-10T14:00:00.000Z';
const at = (iso: string) => new Date(iso);

describe('formatGatewayUntil (AIG-12)', () => {
  it('says today, tomorrow, the weekday within six days, else the date', () => {
    expect(formatGatewayUntil('2026-10-10T16:40:00.000Z', NOW, AMS)).toBe('today 18:40');
    expect(formatGatewayUntil('2026-10-11T07:00:00.000Z', NOW, AMS)).toBe('tomorrow 09:00');
    expect(formatGatewayUntil('2026-10-12T07:00:00.000Z', NOW, AMS)).toBe('Monday 09:00');
    expect(formatGatewayUntil('2026-10-16T07:00:00.000Z', NOW, AMS)).toBe('Friday 09:00');
    // Seven days on is the same weekday again: the date says which.
    expect(formatGatewayUntil('2026-10-17T07:00:00.000Z', NOW, AMS)).toBe('17 Oct 09:00');
    expect(formatGatewayUntil('2027-01-04T08:00:00.000Z', NOW, AMS)).toBe('4 Jan 2027 09:00');
    expect(formatGatewayUntil(at('2026-10-10T14:05:00.000Z'), at(NOW), AMS)).toBe('today 16:05');
  });

  it('counts days in the burrow’s zone, across midnight and summer time', () => {
    // 01:30 on Sunday in Amsterdam, still 19:30 on Saturday in New York.
    const late = '2026-10-10T23:30:00.000Z';
    expect(formatGatewayUntil('2026-10-11T07:00:00.000Z', late, AMS)).toBe('today 09:00');
    expect(formatGatewayUntil('2026-10-11T07:00:00.000Z', late, NY)).toBe('tomorrow 03:00');
    // Summer time ends on 25 October: 09:00 is 08:00 UTC afterwards.
    expect(formatGatewayUntil('2026-10-26T08:00:00.000Z', '2026-10-24T10:00:00.000Z', AMS)).toBe(
      'Monday 09:00',
    );
  });
});

describe('the switches and Runs on (AIG-05, AIG-06, AIG-17)', () => {
  it('names the tool and the gateway', () => {
    expect(AI_GATEWAY_COPY.switchLabel('claude', 'Fusebox')).toBe('Send Claude Code through Fusebox');
    expect(GATEWAY_TOOL_LABELS.codex).toBe('ChatGPT');
    for (const text of [
      AI_GATEWAY_COPY.switchLabel('codex', 'Fusebox'),
      AI_GATEWAY_COPY.switchHint('codex', 'Fusebox'),
      AI_GATEWAY_COPY.runsOnNote('codex', 'Fusebox'),
    ]) {
      expect(text).toContain('ChatGPT');
      expect(text).toContain('Fusebox');
      expect(text).not.toMatch(/codex/i);
    }
    expect(AI_GATEWAY_COPY.switchHint('claude', 'Fusebox')).toBe(
      'Every Claude Code turn on this Whombat goes through Fusebox, whoever asks. Off: turns use their usual sign-in again.',
    );
    expect(AI_GATEWAY_COPY.runsOnTitle('Fusebox')).toBe('Runs on Fusebox');
    const note = AI_GATEWAY_COPY.runsOnNote('claude', 'Fusebox');
    expect(note).toContain('Claude Code');
    expect(note).toContain('your own Claude or ChatGPT sign-in');
    expect(note).toContain('Settings → Connections → Fusebox');
  });

  it('asks first for Fusebox only, and says what the terms say', () => {
    expect(gatewaySwitchConfirms('fusebox')).toBe(true);
    expect(gatewaySwitchConfirms('ai_gateway')).toBe(false);
    expect(AI_GATEWAY_COPY.confirmTitle('claude', 'Fusebox')).toBe('Send Claude Code through Fusebox?');
    expect(AI_GATEWAY_COPY.confirmTitle('codex', 'Fusebox')).toContain('Send ChatGPT through Fusebox');
    expect(AI_GATEWAY_COPY.confirmBody).toBe(
      'Fusebox can share Claude and ChatGPT subscriptions between people. Anthropic’s terms say “Each end user must authenticate with their own … credentials”, and OpenAI asks people not to share a ChatGPT sign-in. Either can limit or suspend those accounts.',
    );
    expect(AI_GATEWAY_COPY.confirm('Fusebox')).toBe('Send through Fusebox');
    expect(AI_GATEWAY_COPY.cancel).toBe('Cancel');
  });

  it('signs a Keys line that says when it overrides the terms', () => {
    const base = { actor: 'John', name: 'Fusebox', kind: 'fusebox' as const };
    expect(gatewayKeysText({ ...base, provider: 'claude', on: true })).toBe(
      'John now sends every Claude Code turn through Fusebox (an override: Anthropic’s terms don’t allow sharing a subscription)',
    );
    const chatgptOn = gatewayKeysText({ ...base, provider: 'codex', on: true });
    expect(chatgptOn).toContain('every ChatGPT turn through Fusebox');
    expect(chatgptOn).toContain('OpenAI’s terms');
    expect(chatgptOn).not.toMatch(/codex/i);
    expect(gatewayKeysText({ ...base, provider: 'claude', on: false })).toBe(
      'John stopped sending Claude Code turns through Fusebox',
    );
    const generic = { actor: 'John', name: 'LiteLLM', kind: 'ai_gateway' as const };
    expect(gatewayKeysText({ ...generic, provider: 'claude', on: true })).toBe(
      'John now sends every Claude Code turn through LiteLLM',
    );
    expect(gatewayKeysText({ ...generic, provider: 'codex', on: false })).toBe(
      'John stopped sending ChatGPT turns through LiteLLM',
    );
  });
});

describe('connecting and removing (AIG-01, AIG-02, AIG-03)', () => {
  it('says what to do', () => {
    expect(AI_GATEWAY_COPY.exists('Fusebox')).toBe(
      'This Whombat already sends its AI through Fusebox. Remove that connection first.',
    );
    expect(AI_GATEWAY_COPY.tooOld).toBe(
      'This Fusebox is too old to add a client key for Whombat. Update Fusebox and connect again.',
    );
    expect(AI_GATEWAY_COPY.removeByHand('Fusebox', 'Whombat · Lumio BV')).toBe(
      'Fusebox didn’t answer, so remove the client “Whombat · Lumio BV” there yourself.',
    );
  });
});

describe('the pool on Settings → AI → Usage (AIG-13)', () => {
  const status = (s: Parameters<typeof gatewayAccountStatusText>[0]['status'], until: string | null) =>
    gatewayAccountStatusText({ status: s, until, name: 'Fusebox', now: NOW, timeZone: AMS });

  it('gives each account a status line, none when it is fine', () => {
    expect(status('ok', null)).toBeNull();
    expect(status('used_up', '2026-10-12T07:00:00.000Z')).toBe('Used up until Monday 09:00');
    expect(status('used_up', '2026-10-10T16:40:00.000Z')).toBe('Used up until today 18:40');
    expect(status('used_up', null)).toBe('Used up');
    expect(status('rate_limited', '2026-10-10T14:05:00.000Z')).toBe('Busy until 16:05');
    expect(status('rate_limited', '2026-10-11T07:00:00.000Z')).toBe('Busy until tomorrow 09:00');
    expect(status('rate_limited', null)).toBe('Busy');
    expect(status('signin_expired', null)).toBe('Sign-in expired');
    expect(status('off', null)).toBe('Off in Fusebox');
  });

  it('labels accounts for members and says how fresh the pool is', () => {
    expect(gatewayAccountLabel('claude', 1)).toBe('Claude account 1');
    expect(gatewayAccountLabel('codex', 2)).toBe('ChatGPT account 2');
    expect(AI_GATEWAY_COPY.groups).toEqual({ claude: 'Claude', codex: 'ChatGPT' });
    const updated = (reachable: boolean, observedAt: string | null) =>
      gatewayUpdatedText({ name: 'Fusebox', reachable, observedAt, now: NOW, timeZone: AMS });
    expect(updated(true, '2026-10-10T13:59:00.000Z')).toBe('Updated 1 min ago');
    expect(updated(true, '2026-10-10T13:59:40.000Z')).toBe('Updated just now');
    expect(updated(false, '2026-10-10T13:50:00.000Z')).toBe('Fusebox isn’t answering');
    expect(updated(true, null)).toBe('Not read yet');
    expect(AI_GATEWAY_COPY.answering('LiteLLM')).toBe('LiteLLM is answering');
    expect(AI_GATEWAY_COPY.toolOn('claude', 'Fusebox')).toBe('Claude Code turns go through Fusebox');
    expect(AI_GATEWAY_COPY.toolOff('codex', 'Fusebox')).toBe('ChatGPT turns don’t go through Fusebox');
  });
});

describe('a turn that can’t go through (AIG-12)', () => {
  const refusal = (code: Parameters<typeof gatewayRefusalText>[0]['code'], until?: string | null) =>
    gatewayRefusalText({ code, name: 'Fusebox', provider: 'claude', until, now: NOW, timeZone: AMS });

  it('says why it didn’t start and who can change it', () => {
    expect(refusal('gateway.missing')).toBe(
      'Fusebox isn’t set up any more, so I couldn’t start. You can connect it again under Settings → Connections.',
    );
    // Only said when none of the person's own sign-ins could take the turn: it says where to add one.
    expect(refusal('gateway.unreachable')).toContain('Fusebox isn’t answering');
    expect(refusal('gateway.unreachable')).toContain('Settings → AI sign-in');
    expect(refusal('gateway.used_up', '2026-10-12T07:00:00.000Z')).toBe(
      'Fusebox has no Claude Code room left until Monday 09:00, so I couldn’t start.',
    );
    expect(refusal('gateway.used_up', '2026-10-10T16:40:00.000Z')).toBe(
      'Fusebox has no Claude Code room left until today 18:40, so I couldn’t start.',
    );
    expect(refusal('gateway.used_up', null)).toBe(
      'Fusebox has no Claude Code room left, so I couldn’t start.',
    );
    expect(
      gatewayRefusalText({
        code: 'gateway.used_up',
        name: 'Fusebox',
        provider: 'codex',
        until: '2026-10-11T07:00:00.000Z',
        now: NOW,
        timeZone: AMS,
      }),
    ).toBe('Fusebox has no ChatGPT room left until tomorrow 09:00, so I couldn’t start.');
  });
});

describe('the owners’ alerts (AIG-14)', () => {
  const ctx = { name: 'Fusebox', now: NOW, timeZone: AMS };

  it('says each fault and its end in a sentence or two', () => {
    expect(GATEWAY_ALERT_KINDS).toEqual(['used_up', 'back', 'signin_expired', 'unreachable', 'reachable']);
    expect(
      gatewayAlertText({ ...ctx, kind: 'used_up', provider: 'claude', until: '2026-10-12T07:00:00.000Z' }),
    ).toBe(
      'Fusebox has no Claude Code room left until Monday 09:00. Claude Code turns won’t start until then.',
    );
    const usedUp = gatewayAlertText({ ...ctx, kind: 'used_up', provider: 'codex', until: null });
    expect(usedUp).toContain('no ChatGPT room left');
    expect(usedUp).not.toMatch(/codex/i);
    expect(gatewayAlertText({ ...ctx, kind: 'back', provider: 'claude' })).toBe(
      'Fusebox has room for Claude Code again.',
    );
    expect(
      gatewayAlertText({ ...ctx, kind: 'signin_expired', provider: 'claude', account: 'work@example.com' }),
    ).toBe('Fusebox’s Claude sign-in for work@example.com has expired. Sign in again in Fusebox.');
    expect(
      gatewayAlertText({ ...ctx, kind: 'signin_expired', provider: 'codex', account: 'ops@example.com' }),
    ).toBe('Fusebox’s ChatGPT sign-in for ops@example.com has expired. Sign in again in Fusebox.');
    expect(gatewayAlertText({ ...ctx, kind: 'reachable' })).toBe('Whombat reaches Fusebox again.');
  });

  it('names the tools switched on when it can’t reach the gateway and nothing takes their turns', () => {
    const none = gatewayAlertText({ ...ctx, kind: 'unreachable', providers: ['claude'], fallback: [] });
    expect(none).toContain('Claude Code turns won’t start');
    expect(none).toContain('Settings → AI sign-in');
    expect(gatewayAlertText({ ...ctx, kind: 'unreachable', providers: ['codex', 'claude'] })).toContain(
      'Claude Code and ChatGPT turns won’t start',
    );
    expect(gatewayToolsText(['codex'])).toBe('ChatGPT');
    expect(gatewayToolsText([])).toBe('Claude Code and ChatGPT');
  });

  it('names the person’s own sign-ins that take the turns while it doesn’t answer', () => {
    const claude = gatewayAlertText({
      ...ctx,
      kind: 'unreachable',
      providers: ['claude'],
      fallback: ['claude'],
    });
    expect(claude).toContain('your own Claude sign-in');
    expect(claude).not.toContain('won’t start');
    const both = gatewayAlertText({
      ...ctx,
      kind: 'unreachable',
      providers: ['claude', 'codex'],
      fallback: ['codex', 'claude'],
    });
    expect(both).toContain('your own Claude and ChatGPT sign-ins');
  });

  it('writes no straight apostrophes or quotes', () => {
    const texts = [
      AI_GATEWAY_COPY.confirmBody,
      AI_GATEWAY_COPY.tooOld,
      AI_GATEWAY_COPY.exists('Fusebox'),
      AI_GATEWAY_COPY.removeByHand('Fusebox', 'Whombat · Lumio BV'),
      AI_GATEWAY_COPY.switchHint('codex', 'Fusebox'),
      AI_GATEWAY_COPY.toolOff('claude', 'Fusebox'),
      refusalAll(),
      gatewayAlertText({ ...ctx, kind: 'unreachable', providers: ['claude'] }),
      gatewayAlertText({ ...ctx, kind: 'unreachable', providers: ['claude'], fallback: ['claude'] }),
      AI_GATEWAY_COPY.runsOnNote('claude', 'Fusebox'),
    ];
    for (const t of texts) expect(t).not.toMatch(/['"]/);
  });
});

function refusalAll(): string {
  return (['gateway.missing', 'gateway.unreachable', 'gateway.used_up'] as const)
    .map((code) =>
      gatewayRefusalText({ code, name: 'Fusebox', provider: 'claude', until: null, now: NOW, timeZone: AMS }),
    )
    .join(' ');
}
