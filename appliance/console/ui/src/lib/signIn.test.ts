import { describe, expect, it } from 'vitest';
import { type ClaimState, parseState } from './api';
import { minutesLeft } from './console';
import { consoleFileSource, screenSignInSource } from './contractsSource';
import {
  groupLetters,
  liveSignIn,
  parseSignIn,
  SIGN_IN_AHEAD_MAX_MS,
  SIGN_IN_LETTERS_RE,
  SIGN_IN_TEXT_MAX,
  signInTitleSize,
} from './signIn';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const SIGN_IN = { code: 'KXQMTR', name: 'John Doe', device: 'Pixel 9', expiresAt: '2026-10-20T12:04:30Z' };

const claimed = (signIn: unknown): ClaimState | null => {
  const s = parseState({
    mode: 'console',
    now: '2026-10-20T12:00:00Z',
    claim: { state: 'claimed', claimUrl: 'app.whombat.com/claim', appUrl: 'app.whombat.com', signIn },
  });
  return s?.mode === 'console' ? s.claim : null;
};

describe('parseState’s sign-in (CG-150)', () => {
  it('reads it on a claimed box', () => {
    expect(claimed(SIGN_IN)?.signIn).toEqual(SIGN_IN);
  });

  it('leaves it out when there is none, so an older server’s state reads as before', () => {
    expect(claimed(undefined)).not.toHaveProperty('signIn');
  });

  it('never reads it outside claimed', () => {
    const s = parseState({ mode: 'console', claim: { state: 'claimable', code: 'KXQM', signIn: SIGN_IN } });
    expect(s?.mode === 'console' && s.claim).not.toHaveProperty('signIn');
  });

  it.each([
    ['five letters', { code: 'KXQMT' }],
    ['lower case', { code: 'kxqmtr' }],
    ['outside the alphabet', { code: 'KXQMTI' }],
    ['grouped', { code: 'KXQ MTR' }],
    ['no name', { name: '' }],
    ['a name of controls only', { name: '‮​' }],
    ['no device', { device: undefined }],
    ['a device that isn’t text', { device: 9 }],
    ['an unreadable time', { expiresAt: 'soon' }],
  ])('drops one with %s', (_, patch) => {
    expect(parseSignIn({ ...SIGN_IN, ...patch })).toBeNull();
    expect(claimed({ ...SIGN_IN, ...patch })).not.toHaveProperty('signIn');
  });

  it('keeps names one bounded line of text', () => {
    const s = parseSignIn({ ...SIGN_IN, name: ' Zoë  Ångström‍ ', device: 'x'.repeat(80) });
    expect(s?.name).toBe('Zoë Ångström');
    expect(s?.device).toHaveLength(64);
  });
});

describe('liveSignIn', () => {
  const claim = claimed(SIGN_IN);

  it('shows it until its time is up, by Whombat’s clock', () => {
    expect(liveSignIn(claim, NOW)?.code).toBe('KXQMTR');
    expect(liveSignIn(claim, NOW + 269_999)).not.toBeNull();
    expect(liveSignIn(claim, NOW + 270_000)).toBeNull();
    expect(liveSignIn(claim, NOW + 3_600_000)).toBeNull();
  });

  it('doesn’t show one that claims to last too long', () => {
    expect(liveSignIn(claim, NOW + 270_000 - SIGN_IN_AHEAD_MAX_MS)).not.toBeNull();
    expect(liveSignIn(claim, NOW + 270_000 - SIGN_IN_AHEAD_MAX_MS - 1)).toBeNull();
  });

  it('shows nothing without a claimed box', () => {
    expect(liveSignIn(null, NOW)).toBeNull();
    expect(liveSignIn(claim && { ...claim, state: 'starting' }, NOW)).toBeNull();
  });
});

describe('the panel’s words', () => {
  it('groups the letters three and three', () => {
    expect(groupLetters('KXQMTR')).toBe('KXQ MTR');
  });

  it('counts whole minutes, rounded up, “in 1 min” under a minute', () => {
    const at = SIGN_IN.expiresAt;
    expect(minutesLeft(at, NOW)).toBe(5);
    expect(minutesLeft(at, NOW + 29_000)).toBe(5);
    expect(minutesLeft(at, NOW + 30_000)).toBe(4);
    expect(minutesLeft(at, NOW + 211_000)).toBe(1);
    expect(minutesLeft(at, NOW + 269_000)).toBe(1);
  });

  it('makes a long name’s title smaller', () => {
    expect(signInTitleSize('John')).toBeGreaterThan(signInTitleSize('Johanna Wilhelmina van der Berg'));
    expect(signInTitleSize('Johanna Wilhelmina van der Berg')).toBeGreaterThan(
      signInTitleSize('johanna.wilhelmina.vanderberg@example.com'),
    );
  });
});

// The page's copy of the shapes (CG-103) against the pinned contracts (0.106.0, CT-620, CT-626).
describe('the contracts', () => {
  it('have the same sign-in members, letters and lengths', () => {
    const shape =
      /export const ConsoleSignIn = z\.object\(\{([\s\S]*?)\}\);/.exec(consoleFileSource)?.[1] ?? '';
    expect([...shape.matchAll(/^\s*(\w+):/gm)].map((m) => m[1])).toEqual(
      Object.keys(parseSignIn(SIGN_IN) ?? {}),
    );
    expect(consoleFileSource).toContain('signIn: ConsoleSignIn.optional()');
    expect(consoleFileSource).toContain(`CONSOLE_DISPLAY_TEXT_MAX = ${SIGN_IN_TEXT_MAX};`);
    expect(screenSignInSource).toContain(
      `ScreenSignInLetters = z.string().regex(/${SIGN_IN_LETTERS_RE.source}/)`,
    );
    // formatScreenSignInLetters' example: `KXQMTR` → `KXQ MTR`.
    expect(screenSignInSource).toContain(`\`KXQMTR\` → \`${groupLetters('KXQMTR')}\``);
  });
});
