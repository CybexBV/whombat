import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAIM_CARD_HELD_MS,
  forgetHeld,
  forgetHeldFor,
  heldRecords,
  LINK_HELD_MS,
  SIGNUP_CODE_HELD_MS,
} from './held';

const T0 = Date.UTC(2026, 8, 30, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PEER = `12D3KooW${'A'.repeat(44)}`;
const CLAIM_SECRET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const KEYS = {
  addDevice: 'whombat:add-device-link',
  claimCard: 'whombat:claim-card',
  signupCode: 'whombat:signup-code',
} as const;

/** The records on a clock the test moves. */
function at(start = T0) {
  const clock = { now: start };
  return { clock, records: heldRecords({ now: () => clock.now }) };
}
const put = (key: string, v: unknown) => localStorage.setItem(key, JSON.stringify(v));
const stored = (key: string) =>
  JSON.parse(localStorage.getItem(key) ?? 'null') as Record<string, unknown> | null;

/** One valid value per record, and the lifetime it gets (AP-591). */
const CASES = [
  { name: 'addDevice', value: { device: 'dev_1', peerId: PEER }, ttl: LINK_HELD_MS },
  { name: 'claimCard', value: { device: 'dev_1', secret: CLAIM_SECRET }, ttl: CLAIM_CARD_HELD_MS },
  { name: 'signupCode', value: { code: '7KQ2-M4XD' }, ttl: SIGNUP_CODE_HELD_MS },
] as const;

describe('the held links (AP-591)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('last 7 days (add a device) and an hour (a card, an invite code); nothing else is held (AP-5674)', () => {
    expect([LINK_HELD_MS, CLAIM_CARD_HELD_MS, SIGNUP_CODE_HELD_MS]).toEqual([7 * DAY, HOUR, HOUR]);
    expect(Object.keys(heldRecords()).sort()).toEqual(['addDevice', 'claimCard', 'signupCode']);
  });

  for (const c of CASES) {
    describe(c.name, () => {
      const key = KEYS[c.name];
      // biome-ignore lint/suspicious/noExplicitAny: each case's record has its own value type.
      const recordOf = (records: ReturnType<typeof heldRecords>) => records[c.name] as any;

      it('is held with an absolute expiry and resumed until just before it, then removed', () => {
        const { clock, records } = at();
        expect(recordOf(records).hold(c.value)).toBe(true);
        expect(stored(key)).toEqual({ v: 1, heldAt: T0, expiresAt: T0 + c.ttl, value: c.value });
        clock.now = T0 + c.ttl - 1;
        expect(recordOf(records).read()).toEqual(c.value);
        clock.now = T0 + c.ttl;
        expect(recordOf(records).read()).toBeNull();
        expect(localStorage.getItem(key)).toBeNull();
      });

      it('a record from before AP-590 works until its original expiry, and is never extended', () => {
        const { clock, records } = at();
        put(key, { ...c.value, at: T0 - c.ttl / 2 });
        expect(recordOf(records).read()).toEqual(c.value);
        expect(stored(key)).toEqual({
          v: 1,
          heldAt: T0 - c.ttl / 2,
          expiresAt: T0 + c.ttl / 2,
          value: c.value,
        });
        clock.now = T0 + c.ttl / 2;
        expect(recordOf(records).read()).toBeNull();
        expect(localStorage.getItem(key)).toBeNull();
      });

      it('an expired, future-dated or unreadable one is ignored and removed', () => {
        const { records } = at();
        for (const bad of [
          { ...c.value, at: T0 - c.ttl },
          { ...c.value, at: T0 + DAY },
          { ...c.value, at: 'now' },
          { v: 1, heldAt: T0 + DAY, expiresAt: T0 + DAY + c.ttl, value: c.value },
          { v: 1, heldAt: T0 - c.ttl, expiresAt: T0, value: c.value },
          { v: 1, heldAt: T0, expiresAt: null, value: c.value },
          { v: 1, heldAt: T0, expiresAt: T0 + c.ttl, value: {} },
        ]) {
          put(key, bad);
          expect(recordOf(records).read(), JSON.stringify(bad)).toBeNull();
          expect(localStorage.getItem(key)).toBeNull();
        }
        localStorage.setItem(key, '{"device":');
        expect(recordOf(records).read()).toBeNull();
        expect(localStorage.getItem(key)).toBeNull();
      });
    });
  }

  it('values the link parsers wouldn’t give are dropped', () => {
    const { records } = at();
    const bad: [keyof typeof KEYS, unknown][] = [
      ['addDevice', { device: '', peerId: PEER }],
      ['addDevice', { device: 'dev_1', peerId: 'not-a-peer-id' }],
      ['claimCard', { device: 'dev 1', secret: CLAIM_SECRET }],
      ['claimCard', { device: 'dev_1', secret: 'not a claim secret' }],
      ['signupCode', { code: 42 }],
      ['signupCode', { code: 'x'.repeat(65) }],
    ];
    for (const [name, value] of bad) {
      put(KEYS[name], { v: 1, heldAt: T0, expiresAt: T0 + HOUR, value });
      expect(records[name].read(), `${name} ${JSON.stringify(value)}`).toBeNull();
      expect(localStorage.getItem(KEYS[name])).toBeNull();
    }
  });

  it('the legacy shapes of every held link still read', () => {
    const { records } = at();
    put(KEYS.addDevice, { device: 'dev_1', peerId: PEER, at: T0 - HOUR });
    put(KEYS.claimCard, { device: 'dev_1', secret: CLAIM_SECRET, at: T0 - HOUR / 2 });
    put(KEYS.signupCode, { code: '7KQ2-M4XD', at: T0 - HOUR / 2 });
    expect(records.addDevice.read()).toEqual({ device: 'dev_1', peerId: PEER });
    expect(records.claimCard.read()).toEqual({ device: 'dev_1', secret: CLAIM_SECRET });
    expect(records.signupCode.read()).toEqual({ code: '7KQ2-M4XD' });
    // The code's hour from before AP-590 (AP-161) is kept, not the seven days of the older links.
    put(KEYS.signupCode, { code: '7KQ2-M4XD', at: T0 - HOUR });
    expect(records.signupCode.read()).toBeNull();
  });

  it('a new link starts a new hold', () => {
    const { clock, records } = at();
    records.addDevice.hold({ device: 'dev_1', peerId: PEER });
    clock.now = T0 + 6 * DAY;
    records.addDevice.hold({ device: 'dev_2', peerId: PEER });
    expect(records.addDevice.entry()).toMatchObject({ heldAt: T0 + 6 * DAY, expiresAt: T0 + 13 * DAY });
  });

  it('sign-out and account deletion forget every held link, card and code, and nothing else', () => {
    const { records } = at();
    for (const c of CASES) (records[c.name] as { hold(v: unknown): boolean }).hold(c.value);
    localStorage.setItem('whombat:appliances:acc_mara', '{"appliances":[]}');
    localStorage.setItem('whombat-theme', 'dark');
    forgetHeld(records);
    for (const key of Object.values(KEYS)) expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem('whombat:appliances:acc_mara')).toBe('{"appliances":[]}');
    expect(localStorage.getItem('whombat-theme')).toBe('dark');
  });

  it('forgetting a Whombat forgets only the links that name it', () => {
    const { records } = at();
    for (const c of CASES) (records[c.name] as { hold(v: unknown): boolean }).hold(c.value);
    forgetHeldFor('dev_2', records);
    for (const key of Object.values(KEYS)) expect(localStorage.getItem(key)).not.toBeNull();
    forgetHeldFor('dev_1', records);
    expect(records.addDevice.read()).toBeNull();
    // Not about a Whombat this browser knows: kept.
    expect(records.claimCard.read()).not.toBeNull();
    expect(records.signupCode.read()).not.toBeNull();
  });

  describe('when the browser’s storage throws', () => {
    it('storage that can’t be reached at all (a sandboxed frame): nothing is held, nothing crashes', () => {
      vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      });
      const records = heldRecords();
      expect(records.addDevice.hold({ device: 'dev_1', peerId: PEER })).toBe(false);
      expect(records.addDevice.read()).toBeNull();
      expect(() => forgetHeld(records)).not.toThrow();
      expect(() => forgetHeldFor('dev_1', records)).not.toThrow();
    });

    it('a full storage: a new link isn’t held, and the older one doesn’t stand in for it', () => {
      const { records } = at();
      records.signupCode.hold({ code: 'OLDR-CODE' });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      });
      expect(records.signupCode.hold({ code: 'NEWR-CODE' })).toBe(false);
      expect(records.signupCode.read()).toBeNull();
      expect(localStorage.getItem(KEYS.signupCode)).toBeNull();
    });

    it('a used link that can’t be removed is never read again on this page', () => {
      const { records } = at();
      records.addDevice.hold({ device: 'dev_1', peerId: PEER });
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      });
      expect(() => records.addDevice.clear()).not.toThrow();
      expect(localStorage.getItem(KEYS.addDevice)).not.toBeNull();
      expect(records.addDevice.read()).toBeNull();
      // Nor through the page's other record objects.
      expect(heldRecords({ now: () => T0 }).addDevice.read()).toBeNull();
    });
  });
});
