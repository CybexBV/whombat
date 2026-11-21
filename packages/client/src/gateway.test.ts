import type { BurrowAiGateway, GatewayAccountUsage, GatewayPool } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  aiGatewayOf,
  GATEWAY_TEXT,
  gatewayAccountGroups,
  gatewayAccountStatus,
  gatewayCarries,
  gatewayConfirm,
  gatewayPoolLine,
  gatewayProviderLine,
  gatewayRowLine,
  gatewayRunsOn,
  gatewaySavedText,
  gatewaySwitches,
  gatewayUsedBy,
} from './gateway';

/** 11:22 in Amsterdam on Wednesday 23 September 2026. */
const NOW = new Date('2026-09-23T09:22:00Z');
const TZ = 'Europe/Amsterdam';

const fusebox = (over: Partial<BurrowAiGateway> = {}): BurrowAiGateway => ({
  connectionId: 'con_fb',
  name: 'Fusebox',
  kind: 'fusebox',
  claude: true,
  codex: false,
  ...over,
});

const account = (over: Partial<GatewayAccountUsage>): GatewayAccountUsage => ({
  key: 'a',
  label: 'work@lumio.example.org',
  provider: 'claude',
  plan: 'max',
  status: 'ok',
  until: null,
  windows: [],
  ...over,
});

const pool = (over: Partial<GatewayPool> = {}): GatewayPool => ({
  connectionId: 'con_fb',
  name: 'Fusebox',
  kind: 'fusebox',
  claude: true,
  codex: false,
  reachable: true,
  observedAt: '2026-09-23T09:21:00Z',
  error: null,
  accounts: [],
  ...over,
});

describe('the AI gateway in the app (AIG-01…AIG-17; AP-1117…AP-1124)', () => {
  it('reads the burrow’s gateway', () => {
    const burrow = { aiGateway: fusebox() };
    expect(aiGatewayOf(burrow)).toEqual(fusebox());
    expect(aiGatewayOf({ aiGateway: null })).toBeNull();
    expect(aiGatewayOf({})).toBeNull();
  });

  it('says “Runs on Fusebox” for an agent whose tool is switched on, and nothing otherwise (AIG-17)', () => {
    const burrow = { aiGateway: fusebox() };
    const on = gatewayRunsOn(burrow, 'claude');
    expect(on?.title).toBe('Runs on Fusebox');
    expect(on?.note).toContain('Settings → Connections → Fusebox');
    expect(gatewayRunsOn(burrow, 'codex')).toBeNull();
    expect(gatewayRunsOn(burrow, 'local')).toBeNull();
  });

  it('knows when the gateway carries a tool the runner has, signed in or not (AIG-16, AP-1126)', () => {
    const burrow = { aiGateway: fusebox() };
    expect(gatewayCarries(burrow, [{ provider: 'claude', state: 'logged_out' }])).toBe(true);
    expect(gatewayCarries(burrow, [{ provider: 'claude', state: 'ready' }])).toBe(true);
    expect(gatewayCarries(burrow, [{ provider: 'claude', state: 'missing' }])).toBe(false);
    expect(gatewayCarries(burrow, [{ provider: 'codex', state: 'ready' }])).toBe(false);
    expect(gatewayCarries({ aiGateway: null }, [{ provider: 'claude', state: 'ready' }])).toBe(false);
  });

  it('names the switches in the gateway’s name, Claude Code first (AIG-05)', () => {
    expect(gatewaySwitches('Fusebox')).toEqual([
      {
        provider: 'claude',
        label: 'Send Claude Code through Fusebox',
        hint: expect.stringMatching(/^Every Claude Code turn .*Fusebox.* Off: /),
      },
      {
        provider: 'codex',
        label: 'Send ChatGPT through Fusebox',
        hint: expect.stringMatching(/^Every ChatGPT turn .*Fusebox.* Off: /),
      },
    ]);
  });

  it('asks before a Fusebox switch goes on, with the terms; never for off or another gateway (AIG-06)', () => {
    expect(gatewayConfirm('fusebox', 'codex', 'Fusebox', true)).toEqual({
      title: 'Send ChatGPT through Fusebox?',
      body: 'Fusebox can share Claude and ChatGPT subscriptions between people. Anthropic’s terms say “Each end user must authenticate with their own … credentials”, and OpenAI asks people not to share a ChatGPT sign-in. Either can limit or suspend those accounts.',
      confirm: 'Send through Fusebox',
      cancel: 'Cancel',
    });
    expect(gatewayConfirm('fusebox', 'claude', 'Fusebox', false)).toBeNull();
    expect(gatewayConfirm('ai_gateway', 'claude', 'LiteLLM', true)).toBeNull();
  });

  it('says what changed, which tools use it, and on its row (AP-1117)', () => {
    expect(gatewaySavedText('claude', 'Fusebox', true)).toBe('Claude Code turns now go through Fusebox.');
    expect(gatewaySavedText('codex', 'Fusebox', false)).toBe('ChatGPT runs on its own sign-in again.');
    expect(gatewayUsedBy(fusebox({ codex: true }))).toEqual({
      title: 'Used by Claude Code and ChatGPT',
      text: 'Claude Code and ChatGPT turns go through it.',
    });
    expect(gatewayUsedBy(fusebox())).toEqual({
      title: 'Used by Claude Code',
      text: 'Claude Code turns go through it. ChatGPT turns run on your own sign-in.',
    });
    expect(gatewayUsedBy(fusebox({ claude: false }))).toEqual({
      title: GATEWAY_TEXT.unused,
      text: GATEWAY_TEXT.unusedText,
    });
    expect(gatewayUsedBy(null).title).toBe('Not switched on yet');
    expect(gatewayRowLine(fusebox())).toBe('Claude Code turns go through it');
    expect(gatewayRowLine(fusebox({ codex: true }))).toBe('Claude Code and ChatGPT turns go through it');
    expect(gatewayRowLine(null)).toBe('Not switched on');
  });

  it('says how fresh the pool is, or that it isn’t answering (AIG-11, AIG-13)', () => {
    expect(gatewayPoolLine(pool(), NOW, TZ)).toEqual({ tone: 'ok', text: 'Updated 1 min ago' });
    expect(gatewayPoolLine(pool({ reachable: false }), NOW, TZ)).toEqual({
      tone: 'warn',
      text: 'Fusebox isn’t answering',
    });
    expect(gatewayPoolLine(pool({ observedAt: null }), NOW, TZ)).toEqual({
      tone: 'mut',
      text: 'Not read yet',
    });
    expect(gatewayProviderLine('claude', pool())).toBe('Claude Code turns go through Fusebox');
    expect(gatewayProviderLine('codex', pool())).toBe('ChatGPT turns don’t go through Fusebox');
  });

  it('says an account’s state in the burrow’s clock, nothing when it is fine (AIG-13)', () => {
    const p = pool();
    expect(gatewayAccountStatus(account({}), p, NOW, TZ)).toBeNull();
    expect(
      gatewayAccountStatus(account({ status: 'used_up', until: '2026-09-28T07:00:00Z' }), p, NOW, TZ),
    ).toEqual({ tone: 'warn', text: 'Used up until Monday 09:00' });
    expect(
      gatewayAccountStatus(account({ status: 'rate_limited', until: '2026-09-23T12:05:00Z' }), p, NOW, TZ),
    ).toEqual({ tone: 'warn', text: 'Busy until 14:05' });
    // Out of credit: no time, since Fusebox's next try brings no room by itself.
    expect(
      gatewayAccountStatus(
        account({ status: 'used_up', until: '2026-09-23T12:05:00Z', outOfCredit: true }),
        p,
        NOW,
        TZ,
      ),
    ).toEqual({ tone: 'warn', text: 'Out of API credit' });
    expect(gatewayAccountStatus(account({ status: 'signin_expired' }), p, NOW, TZ)).toEqual({
      tone: 'warn',
      text: 'Sign-in expired',
    });
    expect(gatewayAccountStatus(account({ status: 'off' }), p, NOW, TZ)).toEqual({
      tone: 'mut',
      text: 'Off in Fusebox',
    });
  });

  it('groups the accounts Claude first, each in Fusebox’s order, without empty groups', () => {
    const accounts = [
      account({ key: 'c1', provider: 'codex' }),
      account({ key: 'a1' }),
      account({ key: 'a2' }),
    ];
    expect(gatewayAccountGroups({ accounts }).map((g) => [g.provider, g.accounts.map((a) => a.key)])).toEqual(
      [
        ['claude', ['a1', 'a2']],
        ['codex', ['c1']],
      ],
    );
    expect(gatewayAccountGroups({ accounts: [account({ key: 'a1' })] }).map((g) => g.provider)).toEqual([
      'claude',
    ]);
  });
});
