/** Names for a box's own address in the apps: the live check, its lines, renames' refusals and the 30 days after. */
import { localLinkFor } from '@whombat/protocol/session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationError } from '../session/managed-ops';
import { createHttpControl } from './control';
import { linkAccountErrorKey, linkBoxClaimUrl, linkBoxOpenUrl } from './link';
import {
  createOwnNameChecker,
  OWN_NAME_TEXT as N,
  type OwnNameCheck,
  ownAddressCloudflareLine,
  ownAddressLeavingView,
  ownAddressMovedView,
  ownAddressMoveTarget,
  ownAddressPasskeyMoved,
  ownAddressRenameErrorText,
  ownAddressToKeep,
  ownNameCandidate,
  ownNameChosen,
  ownNameLine,
  ownNameLocal,
  ownNameZoneOf,
} from './own-name';

afterEach(() => vi.useRealTimers());

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-23T12:00:00Z');
const until = new Date(NOW + 30 * DAY).toISOString();
const own = {
  host: 'home.whombat.app',
  url: 'https://home.whombat.app/',
  leaving: {
    host: 'maple-otter-river.box.whombat.app',
    url: 'https://maple-otter-river.box.whombat.app/',
    until,
  },
};

describe('a typed name', () => {
  it('is trimmed and lower case', () => {
    expect(ownNameCandidate('  Home ')).toBe('home');
  });

  it('is judged at once when its shape is wrong, it is kept back, or it is the current one', () => {
    expect(ownNameLocal('')).toEqual({ kind: 'idle' });
    expect(ownNameLocal('ab')).toMatchObject({ kind: 'done', verdict: 'invalid' });
    expect(ownNameLocal('my--box')).toMatchObject({ kind: 'done', verdict: 'invalid' });
    expect(ownNameLocal('admin')).toMatchObject({ kind: 'done', verdict: 'reserved' });
    expect(ownNameLocal('whombat-home')).toMatchObject({ kind: 'done', verdict: 'reserved' });
    expect(ownNameLocal('home', 'home')).toEqual({ kind: 'current', name: 'home' });
    // Anything else is asked.
    expect(ownNameLocal('home')).toBeNull();
    expect(ownNameLocal('my-box-2')).toBeNull();
  });

  it('says what the check found, with the host it would be', () => {
    const done = (verdict: 'free' | 'yours' | 'taken' | 'reserved' | 'invalid', host: string | null = null) =>
      ({ kind: 'done', name: 'home', verdict, host }) as OwnNameCheck;
    expect(ownNameLine({ kind: 'idle' })).toBeNull();
    expect(ownNameLine(done('free', 'home.whombat.app'))).toEqual({
      text: N.free('home.whombat.app'),
      tone: 'ok',
    });
    // No host in the answer: built with the zone the field shows.
    expect(ownNameLine(done('free'), 'box.whombat.app')?.text).toContain('home.box.whombat.app');
    expect(ownNameLine(done('yours', 'home.whombat.app'))?.tone).toBe('ok');
    expect(ownNameLine(done('taken'))).toEqual({ text: N.taken, tone: 'bad' });
    expect(ownNameLine(done('reserved'))?.text).toBe(N.reserved);
    expect(ownNameLine(done('invalid'))?.text).toBe(N.invalid);
    expect(ownNameLine({ kind: 'failed', name: 'home' })?.tone).toBe('bad');
    expect(ownNameLine({ kind: 'checking', name: 'home' })?.tone).toBe('mut');
  });

  it('is sent only once the check said it can be the box’s', () => {
    expect(ownNameChosen({ kind: 'done', name: 'home', verdict: 'free', host: null })).toBe('home');
    expect(ownNameChosen({ kind: 'done', name: 'home', verdict: 'yours', host: null })).toBe('home');
    expect(ownNameChosen({ kind: 'done', name: 'home', verdict: 'taken', host: null })).toBeNull();
    expect(ownNameChosen({ kind: 'checking', name: 'home' })).toBeNull();
    expect(ownNameChosen({ kind: 'current', name: 'home' })).toBeNull();
  });

  it('shows the zone of the host it is under', () => {
    expect(ownNameZoneOf('home.whombat.app')).toBe('whombat.app');
    expect(ownNameZoneOf('maple-otter-river.box.whombat.app')).toBe('box.whombat.app');
    expect(ownNameZoneOf(null)).toBe('whombat.app');
  });
});

describe('the checker', () => {
  it('asks after a pause, only for the name still typed, and drops a late answer', async () => {
    vi.useFakeTimers();
    const answers: Record<string, (v: { verdict: 'free' | 'taken'; host?: string }) => void> = {};
    const ask = vi.fn(
      (name: string) =>
        new Promise<{ verdict: 'free' | 'taken'; host?: string }>((resolve) => {
          answers[name] = resolve;
        }),
    );
    const seen: OwnNameCheck[] = [];
    const checker = createOwnNameChecker({ ask, onChange: (c) => seen.push(c), delayMs: 300 });
    checker.type('ho');
    checker.type('hom');
    checker.type('home');
    expect(seen.at(-1)).toEqual({ kind: 'checking', name: 'home' });
    await vi.advanceTimersByTimeAsync(300);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith('home');
    // A new name while the answer is on its way: the old answer doesn't count.
    checker.type('homes');
    answers.home?.({ verdict: 'free', host: 'home.whombat.app' });
    await vi.advanceTimersByTimeAsync(300);
    answers.homes?.({ verdict: 'taken' });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toEqual({ kind: 'done', name: 'homes', verdict: 'taken', host: null });
    expect(seen.some((c) => c.kind === 'done' && c.name === 'home')).toBe(false);
  });

  it('answers what it knows without asking, and says when the check failed', async () => {
    vi.useFakeTimers();
    const ask = vi.fn(async () => {
      throw new Error('offline');
    });
    const seen: OwnNameCheck[] = [];
    const checker = createOwnNameChecker({ ask, onChange: (c) => seen.push(c), current: 'home' });
    checker.type('box');
    checker.type('home');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ask).not.toHaveBeenCalled();
    expect(seen).toEqual([
      { kind: 'done', name: 'box', verdict: 'reserved', host: null },
      { kind: 'current', name: 'home' },
    ]);
    checker.type('cottage');
    await vi.advanceTimersByTimeAsync(300);
    expect(seen.at(-1)).toEqual({ kind: 'failed', name: 'cottage' });
    // Gone: nothing more is heard.
    checker.type('garden');
    checker.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe('a refused rename', () => {
  const refused = (code: string, sessionCode = 'conflict') =>
    new OperationError('ownAddress.rename', 409, sessionCode, 'refused', { code });
  it('says why in plain words', () => {
    expect(ownAddressRenameErrorText(refused('rename_limit', 'rate_limited'))).toBe(N.errors.rename_limit);
    expect(ownAddressRenameErrorText(refused('label_taken'))).toBe(N.errors.label_taken);
    expect(ownAddressRenameErrorText(refused('link_off', 'not_allowed'))).toBe(N.errors.link_off);
    expect(ownAddressRenameErrorText(new OperationError('ownAddress.rename', 404, 'unknown_op', 'no'))).toBe(
      N.errors.own_address_unavailable,
    );
    expect(ownAddressRenameErrorText(refused('something_new'))).toBe(N.errors.failed);
    expect(ownAddressRenameErrorText(new Error('boom'))).toBe(N.errors.failed);
  });
});

describe('the 30 days after a change', () => {
  it('shows the old address with the day it stops', () => {
    const v = ownAddressLeavingView(own, NOW, 'UTC');
    expect(v?.host).toBe(own.leaving.host);
    expect(v?.line).toBe(N.leaving('23 December'));
    expect(ownAddressLeavingView(own, NOW + 31 * DAY)).toBeNull();
    expect(ownAddressLeavingView({}, NOW)).toBeNull();
  });

  it('puts the moved banner only on the page at the old address', () => {
    expect(ownAddressMovedView(own, own.leaving.host, NOW, 'UTC')).toEqual({
      host: 'home.whombat.app',
      url: 'https://home.whombat.app/',
      text: N.moved('home.whombat.app', '23 December'),
    });
    expect(ownAddressMovedView(own, 'home.whombat.app', NOW)).toBeNull();
    expect(ownAddressMovedView(own, null, NOW)).toBeNull();
    expect(ownAddressMovedView(own, own.leaving.host, NOW + 31 * DAY)).toBeNull();
  });

  it('goes to the new address with the box’s device link, which opens there', () => {
    const link = localLinkFor({
      kind: 'device',
      appliance: '12D3KooWQ3BpNQUAmF3wTbNsGDk2RJhC9k1H7rpu97Vb2Q6hRfmQ',
      secret: 'A'.repeat(32),
      routes: [],
      own: own.url,
    });
    expect(ownAddressMoveTarget(link, own)).toBe(link);
    expect(new URL(ownAddressMoveTarget(link, own)).host).toBe('home.whombat.app');
    // A link for another address, or none: the new address itself.
    expect(ownAddressMoveTarget(null, own)).toBe(own.url);
    expect(ownAddressMoveTarget(link, { url: 'https://other.whombat.app/' })).toBe(
      'https://other.whombat.app/',
    );
  });

  it('asks for a passkey for the new address while the person’s are all for the old one', () => {
    expect(ownAddressPasskeyMoved(own, [{ rpId: own.leaving.host }])).toBe(true);
    expect(ownAddressPasskeyMoved(own, [{ rpId: own.leaving.host }, { rpId: own.host }])).toBe(false);
    expect(ownAddressPasskeyMoved(own, [])).toBe(false);
    expect(ownAddressPasskeyMoved({ host: own.host }, [{ rpId: own.leaving.host }])).toBe(false);
  });
});

describe('Cloudflare’s certificates for *.whombat.app', () => {
  it('are named under an address right under whombat.app until they end', () => {
    expect(ownAddressCloudflareLine('home.whombat.app', NOW)).toBe(N.cloudflare);
    expect(ownAddressCloudflareLine('home.whombat.app', Date.parse('2027-02-17T00:00:00Z'))).toBeNull();
    // They don't cover a name under box.whombat.app or dev.whombat.app.
    expect(ownAddressCloudflareLine('maple-otter-river.box.whombat.app', NOW)).toBeNull();
    expect(ownAddressCloudflareLine('home.dev.whombat.app', NOW)).toBeNull();
  });
});

describe('the phone’s copy of the address', () => {
  it('follows the box’s current host, and only when it changed', () => {
    expect(ownAddressToKeep('https://maple-otter-river.box.whombat.app/', own)).toBe(
      'https://home.whombat.app/',
    );
    expect(ownAddressToKeep('https://home.whombat.app/', own)).toBeNull();
    expect(ownAddressToKeep(undefined, own)).toBe('https://home.whombat.app/');
    // No own address in the answer (an older app's view, Link off): the phone keeps what it has.
    expect(ownAddressToKeep('https://home.whombat.app/', null)).toBeNull();
    expect(ownAddressToKeep(null, { host: 'evil.example.com', url: 'https://evil.example.com/' })).toBeNull();
  });
});

describe('the account site with own names', () => {
  it('opens and claims a Whombat at its new host, a leaving one included', () => {
    const box = {
      host: 'home.whombat.app',
      state: 'on' as const,
      claimUrl: 'https://home.whombat.app/c/pqrtvw',
    };
    expect(linkBoxOpenUrl(box)).toBe('https://home.whombat.app/');
    expect(linkBoxClaimUrl(box)).toBe('https://home.whombat.app/c/pqrtvw');
    // A claim link at another host (the old one) isn't followed.
    expect(
      linkBoxClaimUrl({ ...box, claimUrl: 'https://maple-otter-river.box.whombat.app/c/pqrtvw' }),
    ).toBeNull();
  });

  it('sends a chosen name with the confirm, checks names, and names a taken one', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      if (url.endsWith('/link/name'))
        return new Response(
          JSON.stringify({ name: body.name, verdict: 'free', host: `${body.name}.whombat.app` }),
        );
      return new Response(
        JSON.stringify({ error: { code: 'conflict', message: 'taken', details: { code: 'label_taken' } } }),
        { status: 409 },
      );
    });
    const tokens = { get: async () => 'token', set: async () => {}, remove: async () => {} };
    const control = createHttpControl('https://api.example.com', { tokens, fetch });
    expect(await control.linkNameCheck?.('home')).toEqual({
      name: 'home',
      verdict: 'free',
      host: 'home.whombat.app',
    });
    const refused = await control.linkConfirm?.('KXQM-TRVW', undefined, 'home').catch((e: unknown) => e);
    expect(linkAccountErrorKey(refused)).toBe('label_taken');
    expect(calls.at(-1)?.body).toEqual({ code: 'KXQM-TRVW', label: 'home' });
    // Without a chosen name the body has none (an older control refuses the member).
    await control.linkConfirm?.('KXQM-TRVW').catch(() => {});
    expect(calls.at(-1)?.body).toEqual({ code: 'KXQM-TRVW' });
  });
});
