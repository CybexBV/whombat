import { describe, expect, it } from 'vitest';
import { createRegistry, forgetEnrollments, type KnownAppliance, PinConflictError } from './registry';

const PEER = `12D3KooW${'A'.repeat(44)}`;
const OTHER = `12D3KooW${'B'.repeat(44)}`;
const known: KnownAppliance = {
  device: 'dev_1',
  orgId: 'org_1',
  name: 'Burrow HQ',
  peerId: PEER,
  pinSource: 'claim',
  enrolled: true,
  kitPending: true,
};

/** A `Storage` in memory whose methods can be made to throw (full, disabled, blocked). */
function fakeStorage() {
  const data = new Map<string, string>();
  const fail = { get: false, set: false, remove: false };
  return {
    data,
    fail,
    getItem(k: string) {
      if (fail.get) throw new Error('SecurityError: storage is disabled');
      return data.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      if (fail.set)
        throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
      data.set(k, v);
    },
    removeItem(k: string) {
      if (fail.remove) throw new Error('SecurityError: storage is disabled');
      data.delete(k);
    },
  };
}

describe('the appliance registry when storage fails (AP-594)', () => {
  it('stores and reads as before, and says it is saved', () => {
    const s = fakeStorage();
    const r = createRegistry('acc_1', s);
    r.put(known);
    r.setLastUsed('dev_1');
    expect(createRegistry('acc_1', s).get('dev_1')).toEqual(known);
    expect(r.saved()).toBe(true);
  });

  it('a write that fails never throws; this page keeps it, and says it isn’t saved', () => {
    const s = fakeStorage();
    const r = createRegistry('acc_1', s);
    s.fail.set = true;
    expect(() => r.put(known)).not.toThrow();
    expect(() => r.setLastUsed('dev_1')).not.toThrow();
    expect(r.get('dev_1')).toEqual(known);
    expect(r.lastUsed()).toBe('dev_1');
    expect(r.saved()).toBe(false);
    // Nothing pretends it's stored.
    expect(s.data.size).toBe(0);
    // The page's other registry objects (a remount) see the same.
    expect(createRegistry('acc_1', s).get('dev_1')).toEqual(known);
    expect(createRegistry('acc_1', s).saved()).toBe(false);
    // Another account's registry isn't touched.
    expect(createRegistry('acc_2', s).list()).toEqual([]);
    expect(createRegistry('acc_2', s).saved()).toBe(true);
  });

  it('the pin rules hold for what this page keeps', () => {
    const s = fakeStorage();
    const r = createRegistry('acc_1', s);
    s.fail.set = true;
    r.put(known);
    expect(() => r.put({ ...known, peerId: OTHER })).toThrow(PinConflictError);
    forgetEnrollments(r);
    expect(r.get('dev_1')?.enrolled).toBe(false);
  });

  it('once a write succeeds again, everything this page kept is stored', () => {
    const s = fakeStorage();
    const r = createRegistry('acc_1', s);
    s.fail.set = true;
    r.put(known);
    s.fail.set = false;
    r.setLastUsed('dev_1');
    expect(r.saved()).toBe(true);
    expect(JSON.parse(s.data.get('whombat:appliances:acc_1') ?? '{}')).toEqual({
      appliances: [known],
      last: 'dev_1',
    });
  });

  it('a clear that can’t remove still forgets everything for this page', () => {
    const s = fakeStorage();
    const r = createRegistry('acc_1', s);
    r.put(known);
    s.fail.remove = true;
    expect(() => r.clear()).not.toThrow();
    expect(r.list()).toEqual([]);
    expect(r.saved()).toBe(false);
  });

  it('storage that can’t be reached or read: an empty registry kept for this page, never a throw', () => {
    const unreachable = () => {
      throw new Error('SecurityError: The operation is insecure.');
    };
    const r = createRegistry('acc_1', unreachable);
    expect(r.list()).toEqual([]);
    expect(() => r.put(known)).not.toThrow();
    expect(r.get('dev_1')).toEqual(known);
    expect(r.saved()).toBe(false);
    const s = fakeStorage();
    s.fail.get = true;
    expect(createRegistry('acc_1', s).list()).toEqual([]);
  });

  describe('two tabs on one storage that fails and recovers', () => {
    /** Another tab's view of the same storage: its own page state, the same data. */
    const tab = (s: ReturnType<typeof fakeStorage>) => ({
      getItem: (k: string) => s.getItem(k),
      setItem: (k: string, v: string) => s.setItem(k, v),
      removeItem: (k: string) => s.removeItem(k),
    });
    const at = (device: string, peerId = PEER, pinSource: KnownAppliance['pinSource'] = 'add-link') => ({
      ...known,
      device,
      peerId,
      pinSource,
    });
    const storedDevices = (s: ReturnType<typeof fakeStorage>) =>
      (
        JSON.parse(s.data.get('whombat:appliances:acc_1') ?? '{"appliances":[]}') as {
          appliances: KnownAppliance[];
        }
      ).appliances.map((a) => `${a.device}:${a.peerId === PEER ? 'P' : 'O'}`);

    it('a later write merges this page’s changes into what storage holds now, never over it', () => {
      const s = fakeStorage();
      const a = createRegistry('acc_1', tab(s));
      const b = createRegistry('acc_1', tab(s));
      s.fail.set = true;
      a.put(at('dev_1'));
      s.fail.set = false;
      b.put(at('dev_2'));
      // This page sees the other tab's Whombat too.
      expect(a.get('dev_2')).toBeDefined();
      a.setLastUsed('dev_1');
      expect(a.saved()).toBe(true);
      expect(storedDevices(s).sort()).toEqual(['dev_1:P', 'dev_2:P']);
      expect(b.lastUsed()).toBe('dev_1');
    });

    it('a pin another tab stored wins over this page’s link, unless a claim replaces it', () => {
      const s = fakeStorage();
      const a = createRegistry('acc_1', tab(s));
      const b = createRegistry('acc_1', tab(s));
      s.fail.set = true;
      a.setLastUsed(null);
      s.fail.set = false;
      b.put(at('dev_3', PEER));
      expect(() => a.put(at('dev_3', OTHER))).toThrow(PinConflictError);
      expect(a.get('dev_3')?.peerId).toBe(PEER);
      // Only a claim may replace a pin (AP-63).
      a.put(at('dev_3', OTHER, 'claim'), { replacePin: true });
      expect(a.get('dev_3')?.peerId).toBe(OTHER);
    });

    it('a pin stored after this page’s unsaved link wins, then and when this page writes again', () => {
      const s = fakeStorage();
      const a = createRegistry('acc_1', tab(s));
      const b = createRegistry('acc_1', tab(s));
      s.fail.set = true;
      a.put(at('dev_4', OTHER));
      s.fail.set = false;
      b.put(at('dev_4', PEER));
      expect(a.get('dev_4')?.peerId).toBe(PEER);
      a.setLastUsed('dev_4');
      expect(storedDevices(s)).toEqual(['dev_4:P']);
    });

    it('a write while storage can’t be read keeps this page’s changes instead of replacing what it couldn’t see', () => {
      const s = fakeStorage();
      const a = createRegistry('acc_1', tab(s));
      const b = createRegistry('acc_1', tab(s));
      b.put(at('dev_2'));
      s.fail.get = true;
      a.put(at('dev_1'));
      expect(a.saved()).toBe(false);
      s.fail.get = false;
      expect(storedDevices(s)).toEqual(['dev_2:P']);
      a.setLastUsed('dev_1');
      expect(storedDevices(s).sort()).toEqual(['dev_1:P', 'dev_2:P']);
    });

    it('forgets stay forgotten: another tab’s, and this page’s own made while storage failed', () => {
      const s = fakeStorage();
      const a = createRegistry('acc_1', tab(s));
      const b = createRegistry('acc_1', tab(s));
      a.put(at('dev_1'));
      a.put(at('dev_2'));
      s.fail.set = true;
      a.remove('dev_1');
      expect(a.get('dev_1')).toBeUndefined();
      expect(a.saved()).toBe(false);
      s.fail.set = false;
      b.remove('dev_2');
      a.setLastUsed(null);
      expect(a.saved()).toBe(true);
      expect(storedDevices(s)).toEqual([]);
      expect(b.list()).toEqual([]);
    });
  });
});
