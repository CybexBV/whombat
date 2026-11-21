import { describe, expect, it } from 'vitest';
import { parseState } from './api';

describe('parseState', () => {
  it('reads the console state of the spec', () => {
    const s = parseState({
      mode: 'console',
      now: '2026-09-27T12:00:00Z',
      claim: {
        state: 'claimed',
        claimUrl: 'app.whombat.com/claim',
        appUrl: 'app.whombat.com',
        burrows: { first: 'Banjo’s Burrow', more: 2 },
      },
      footer: 'Whombat appliance.',
      extra: 'ignored',
    });
    expect(s).toEqual({
      mode: 'console',
      now: '2026-09-27T12:00:00Z',
      claim: {
        state: 'claimed',
        code: '',
        claimUrl: 'app.whombat.com/claim',
        appUrl: 'app.whombat.com',
        retryAt: null,
        burrows: { first: 'Banjo’s Burrow', more: 2 },
      },
      footer: 'Whombat appliance.',
      desk: null,
    });
  });

  it('reads where the app on this network claims the box, on the claim screen only', () => {
    const inApp = (claim: Record<string, unknown>) => {
      const s = parseState({ mode: 'console', claim });
      return s && 'claim' in s ? s.claim?.inApp : null;
    };
    const lan = { code: 'KXQM', claimUrl: '', appUrl: '', inApp: '192.0.2.10' };
    expect(inApp({ state: 'claimable', ...lan })).toBe('192.0.2.10');
    expect(inApp({ state: 'claimed', ...lan })).toBeUndefined();
    expect(inApp({ state: 'claimable', inApp: 7 })).toBeUndefined();
  });

  it('reads New letters, how long letters asked for stay, and an IPv6-only network, each only where it belongs', () => {
    const of = (claim: Record<string, unknown>) => {
      const s = parseState({ mode: 'console', now: '2026-09-27T12:00:00Z', claim, footer: '' });
      return s && 'claim' in s ? s.claim : null;
    };
    const lan = { code: 'KXQM', claimUrl: '', appUrl: '', inApp: '192.0.2.10' };
    const asked = of({ state: 'claimable', ...lan, newLetters: true, lettersUntil: '2026-09-27T12:10:00Z' });
    expect(asked).toMatchObject({ newLetters: true, lettersUntil: '2026-09-27T12:10:00Z' });
    expect(of({ state: 'backoff', retryAt: '2026-09-27T12:04:00Z', newLetters: true })?.newLetters).toBe(
      true,
    );
    // Not on a box that is set up, and nothing the page can't read.
    const claimed = of({
      state: 'claimed',
      newLetters: true,
      lettersUntil: '2026-09-27T12:10:00Z',
      ipv6Only: true,
    });
    expect(claimed?.newLetters).toBeUndefined();
    expect(claimed?.lettersUntil).toBeUndefined();
    expect(claimed?.ipv6Only).toBeUndefined();
    expect(of({ state: 'claimable', ...lan, newLetters: 'yes', lettersUntil: 'soon' })).not.toHaveProperty(
      'lettersUntil',
    );
    expect(of({ state: 'backoff', lettersUntil: '2026-09-27T12:10:00Z' })?.lettersUntil).toBeUndefined();
    expect(of({ state: 'claimable', claimUrl: '', appUrl: '', ipv6Only: true })?.ipv6Only).toBe(true);
    // A box that could name none of its IPv6 addresses waits: the page is told all the same.
    expect(of({ state: 'waiting', claimUrl: '', appUrl: '', ipv6Only: true })?.ipv6Only).toBe(true);
    expect(
      of({ state: 'backoff', retryAt: '2026-09-27T12:04:00Z', ipv6Only: true })?.ipv6Only,
    ).toBeUndefined();
  });

  it('reads the claim’s other way in only beside a claim link, one at most', () => {
    const of = (claim: Record<string, unknown>) => {
      const s = parseState({ mode: 'console', now: '2026-09-27T12:00:00Z', claim, footer: '' });
      return s && 'claim' in s ? s.claim : null;
    };
    const own = { code: 'KXQM', claimUrl: 'quiet-river-otter.box.whombat.app/c/kxqmtv', appUrl: '' };
    expect(of({ state: 'claimable', ...own, fallbackInApp: '192.0.2.10' })?.fallbackInApp).toBe('192.0.2.10');
    const both = of({
      state: 'claimable',
      ...own,
      fallbackTailnet: 'whombat.tail1234.ts.net:4480',
      fallbackInApp: '192.0.2.10',
    });
    expect(both?.fallbackTailnet).toBe('whombat.tail1234.ts.net:4480');
    expect(both?.fallbackInApp).toBeUndefined();
    // No claim link on the page, a box in the wait or set up, or something that isn't an address: nothing.
    for (const claim of [
      {
        state: 'claimable',
        code: 'KXQM',
        claimUrl: '',
        appUrl: '',
        inApp: '192.0.2.10',
        fallbackInApp: '192.0.2.11',
      },
      { state: 'backoff', ...own, retryAt: '2026-09-27T12:04:00Z', fallbackInApp: '192.0.2.10' },
      { state: 'claimed', ...own, fallbackTailnet: 'whombat.tail1234.ts.net:4480' },
      { state: 'claimable', ...own, fallbackInApp: 7, fallbackTailnet: '' },
    ]) {
      expect(of(claim)?.fallbackInApp).toBeUndefined();
      expect(of(claim)?.fallbackTailnet).toBeUndefined();
    }
  });

  it('ignores what an older console server sent about a recovery key (CG-31)', () => {
    const s = parseState({ mode: 'console', screen: 'key', key: { groups: ['cbdefghi'] }, claim: null });
    expect(s).toEqual({ mode: 'console', now: '', claim: null, footer: '', desk: null });
  });

  it('drops an unknown claim state and an empty burrow name', () => {
    const a = parseState({ mode: 'console', claim: { state: 'exploded' } });
    expect(a?.mode === 'console' && a.claim).toBeNull();
    const b = parseState({
      mode: 'console',
      claim: { state: 'claimed', burrows: { first: '' } },
    });
    expect(b?.mode === 'console' && b.claim?.burrows).toBeNull();
  });

  it('reads the installer state, clamps the percentage and drops unknown checks', () => {
    const s = parseState({
      mode: 'installer',
      platform: 'self-installed',
      storage: 'host-encrypted',
      environment: 'dev',
      release: 'whombat-20261021.1',
      appUrl: 'dev.whombat.com',
      preflight: {
        status: 'done',
        checks: [
          { id: 'uefi', status: 'ok', value: 'UEFI' },
          { id: 'teleport', status: 'ok' },
        ],
        disks: [
          { path: '/dev/sda', name: 'sda', model: 'QEMU', sizeBytes: 1, eligible: true, reason: '' },
          {
            path: '/dev/sdb',
            name: 'sdb',
            model: 'Expansion HDD',
            sizeBytes: 2,
            eligible: false,
            reason: 'usb',
          },
          { path: '/dev/sdc', name: 'sdc', model: '', sizeBytes: 3, eligible: false, reason: 'haunted' },
          { name: 'x' },
        ],
      },
      install: { status: 'running', disk: '/dev/sda', step: 'copy', percent: 140, log: ['a'], error: '' },
    });
    if (s?.mode !== 'installer') throw new Error('not an installer state');
    expect(s.preflight.checks).toEqual([{ id: 'uefi', status: 'ok', value: 'UEFI' }]);
    expect(s.preflight.disks.map((d) => d.reason)).toEqual(['', 'usb', '']);
    expect(s.install.percent).toBe(100);
    expect(s.install.step).toBe('copy');
  });

  it('refuses what isn’t a state', () => {
    expect(parseState(null)).toBeNull();
    expect(parseState([])).toBeNull();
    expect(parseState({ mode: 'shell' })).toBeNull();
  });
});

describe('the console alert (contracts 4.3, CG-400)', () => {
  it('passes a known alert on, in any claim state', () => {
    const s = parseState({
      mode: 'console',
      claim: { state: 'claimable', code: 'KXQM', claimUrl: 'x/claim', appUrl: 'x' },
      alert: { kind: 'own_address_foreign', since: '2026-11-18T11:00:00Z' },
    });
    expect(s?.mode === 'console' && s.alert).toEqual({
      kind: 'own_address_foreign',
      since: '2026-11-18T11:00:00Z',
    });
  });

  it('leaves out an alert it has no words for, or none at all', () => {
    for (const alert of [
      { kind: 'something_new', since: '2026-11-18T11:00:00Z' },
      { kind: 'own_address_foreign' },
      'own_address_foreign',
      null,
      undefined,
    ]) {
      const s = parseState({ mode: 'console', claim: null, alert });
      expect(s && 'alert' in s).toBe(false);
    }
  });
});

describe('the start problem (CG-409)', () => {
  const claim = (state: string, start: unknown) =>
    parseState({ mode: 'console', claim: { state, claimUrl: '', appUrl: '', start } });

  it('passes a known problem on while starting', () => {
    const s = claim('starting', { problem: 'release-missing', release: 'whombat-20261120.15' });
    expect(s?.mode === 'console' && s.claim?.start).toEqual({
      problem: 'release-missing',
      release: 'whombat-20261120.15',
    });
    const o = claim('starting', { problem: 'offline' });
    expect(o?.mode === 'console' && o.claim?.start).toEqual({ problem: 'offline', release: '' });
  });

  it('leaves it out on any other screen, or when it has no words for it', () => {
    for (const [state, start] of [
      ['waiting', { problem: 'offline' }],
      ['claimed', { problem: 'failed' }],
      ['starting', { problem: 'melted' }],
      ['starting', 'offline'],
      ['starting', null],
    ] as const) {
      const s = claim(state, start);
      expect(s?.mode === 'console' && s.claim !== null && 'start' in s.claim).toBe(false);
    }
  });
});
