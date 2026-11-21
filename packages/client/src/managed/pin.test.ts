/**
 * The identity pin (MA-24, AP-63…AP-69): the registry never lets anything but a claim change a pin, the directory is
 * only compared with it, and links and kits name the identity a device may pin — tested as a directory that lies.
 */
import { describe, expect, it } from 'vitest';
import { parseApplianceLinkPath } from './links';
import {
  addDeviceAppLink,
  addDeviceLink,
  isPeerId,
  openDecision,
  parseAddDeviceLink,
  pinnedRecord,
  trustDecision,
} from './pin';
import { kitChecksum, kitText, newRecoveryKit, readKitFile } from './recovery';
import { createRegistry, type KnownAppliance, PinConflictError } from './registry';
import { parseSetupLink } from './setup-link';

/** The real Whombat, and what a lying directory (or a relay it points at) would name instead. */
const REAL = '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH';
const FAKE = '12D3KooWNrPX9JcmH7DQVJDVr2AXRBHGLAE2Bowcs2hFgaBStMDa';
const SECRET = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const ui = ['https://app.whombat.com'];

function memory() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const record = (over: Partial<KnownAppliance> = {}): KnownAppliance => ({
  device: 'dev_1',
  orgId: 'org_1',
  name: 'Studio',
  peerId: REAL,
  pinSource: 'claim',
  enrolled: true,
  kitPending: false,
  ...over,
});

describe('the registry keeps pins (AP-63)', () => {
  it('refuses to change a pinned identity, and keeps where the pin came from', () => {
    const registry = createRegistry('acc_1', memory());
    registry.put(record({ pinSource: 'add-link', enrolled: false }));
    expect(() => registry.put(record({ peerId: FAKE }))).toThrow(PinConflictError);
    expect(registry.get('dev_1')?.peerId).toBe(REAL);
    // Updating anything else is fine; the source stays the one that pinned it.
    registry.put(record({ enrolled: true, name: 'Renamed', pinSource: 'claim' }));
    expect(registry.get('dev_1')).toMatchObject({ enrolled: true, name: 'Renamed', pinSource: 'add-link' });
  });

  it('lets only a claim replace a pin (a reset Whombat claimed again)', () => {
    const registry = createRegistry('acc_1', memory());
    registry.put(record({ pinSource: 'kit' }));
    registry.put(record({ peerId: FAKE, pinSource: 'claim', kitPending: true }), { replacePin: true });
    expect(registry.get('dev_1')).toMatchObject({ peerId: FAKE, pinSource: 'claim', kitPending: true });
  });

  it('reads records from before AP-63 as legacy pins and keeps them', () => {
    const storage = memory();
    const { pinSource: _, ...old } = record();
    storage.setItem('whombat:appliances:acc_1', JSON.stringify({ appliances: [old], last: 'dev_1' }));
    const registry = createRegistry('acc_1', storage);
    expect(registry.get('dev_1')).toMatchObject({ peerId: REAL, pinSource: 'legacy' });
    expect(() => registry.put({ ...record(), peerId: FAKE })).toThrow(PinConflictError);
    registry.put({ ...record(), enrolled: false });
    expect(registry.get('dev_1')).toMatchObject({ pinSource: 'legacy', enrolled: false });
  });

  it('forgets a Whombat on this device (the way out of a hard stop)', () => {
    const registry = createRegistry('acc_1', memory());
    registry.put(record());
    registry.setLastUsed('dev_1');
    registry.remove('dev_1');
    expect(registry.get('dev_1')).toBeUndefined();
    expect(registry.lastUsed()).toBeNull();
  });
});

describe('opening a Whombat the directory lists (AP-64)', () => {
  it('goes on only when the pin and the directory agree', () => {
    expect(openDecision(record(), REAL)).toMatchObject({ kind: 'proceed' });
  });
  it('a directory that names another identity is a hard stop, never an update', () => {
    expect(openDecision(record(), FAKE)).toMatchObject({ kind: 'changed', directory: FAKE });
    expect(openDecision(record({ pinSource: 'legacy' }), FAKE)).toMatchObject({ kind: 'changed' });
  });
  it('without a pin, nothing connects: set up this device', () => {
    expect(openDecision(undefined, REAL)).toEqual({ kind: 'unpinned' });
    expect(openDecision(null, FAKE)).toEqual({ kind: 'unpinned' });
  });
});

describe('links and kits that name the identity (AP-65…AP-67)', () => {
  it('pin what the link names when the directory agrees', () => {
    expect(trustDecision({ pinned: null, named: REAL, directory: REAL })).toEqual({
      kind: 'pin',
      peerId: REAL,
      isNew: true,
    });
    expect(trustDecision({ pinned: REAL, named: REAL, directory: REAL })).toEqual({
      kind: 'pin',
      peerId: REAL,
      isNew: false,
    });
  });
  it('stop before any secret when the directory names another identity than the link', () => {
    expect(trustDecision({ pinned: null, named: REAL, directory: FAKE })).toEqual({
      kind: 'mismatch',
      named: REAL,
      directory: FAKE,
    });
  });
  it('stop when this device’s pin differs from the directory, whatever the link says', () => {
    expect(trustDecision({ pinned: REAL, named: FAKE, directory: FAKE })).toMatchObject({ kind: 'changed' });
    expect(trustDecision({ pinned: REAL, named: null, directory: FAKE })).toMatchObject({ kind: 'changed' });
  });
  it('an old kit or key names nothing: only a device that already pinned it can go on', () => {
    expect(trustDecision({ pinned: null, named: null, directory: REAL })).toEqual({ kind: 'missing' });
    expect(trustDecision({ pinned: REAL, named: null, directory: REAL })).toMatchObject({
      kind: 'pin',
      isNew: false,
    });
  });
  it('a new pin makes a record that isn’t let in yet', () => {
    expect(
      pinnedRecord({ device: 'dev_1', orgId: 'org_1', name: null, peerId: REAL, source: 'add-link' }),
    ).toEqual({
      device: 'dev_1',
      orgId: 'org_1',
      name: null,
      peerId: REAL,
      pinSource: 'add-link',
      enrolled: false,
      kitPending: false,
    });
  });
});

describe('the add-a-device link (AP-66)', () => {
  it('names the Whombat and its identity, and is a journey, not a burrow path', () => {
    const link = addDeviceLink('https://app.whombat.com/', 'dev_1', REAL);
    expect(link).toBe(`https://app.whombat.com/appliances/dev_1/add#p=${REAL}`);
    expect(parseAddDeviceLink(link, ui)).toEqual({ device: 'dev_1', peerId: REAL });
    expect(parseAddDeviceLink(addDeviceAppLink('dev_1', REAL), ui)).toEqual({
      device: 'dev_1',
      peerId: REAL,
    });
    expect(parseApplianceLinkPath('/appliances/dev_1/add')).toBeNull();
    expect(parseApplianceLinkPath('/appliances/dev_1/setup')).toBeNull();
    expect(parseApplianceLinkPath('/appliances/dev_1/identity-changed')).toBeNull();
  });
  it('refuses a link without an identity, a malformed one and another host', () => {
    expect(parseAddDeviceLink('https://app.whombat.com/appliances/dev_1/add', ui)).toBeNull();
    expect(parseAddDeviceLink('https://app.whombat.com/appliances/dev_1/add#p=', ui)).toBeNull();
    expect(parseAddDeviceLink('https://app.whombat.com/appliances/dev_1/add#p=12D3KooWshort', ui)).toBeNull();
    expect(parseAddDeviceLink(`https://evil.example/appliances/dev_1/add#p=${REAL}`, ui)).toBeNull();
    expect(parseAddDeviceLink(`https://app.whombat.com/appliances/dev_1/join#p=${REAL}`, ui)).toBeNull();
    expect(isPeerId(REAL)).toBe(true);
    expect(isPeerId('12D3KooW')).toBe(false);
  });
});

describe('the recovery kit names the identity (kit version 2, AP-65)', () => {
  const kit = newRecoveryKit({ applianceName: 'Studio', device: 'dev_7KQ2M4XD', appliancePeerId: REAL });

  it('writes the identity inside the checksummed text and reads it back', () => {
    const text = kitText(kit, null, 'acc_mara');
    expect(text).toContain(`Appliance identity: ${REAL}`);
    expect(text).toContain('Kit version: 3');
    expect(text).toMatch(/\nChecksum: [0-9a-f]{16}\n$/);
    expect(readKitFile(text)).toEqual({
      ok: true,
      kit: {
        secretKeyHex: kit.secretKeyHex,
        device: 'dev_7KQ2M4XD',
        accountId: 'acc_mara',
        appliancePeerId: REAL,
        version: 3,
      },
    });
    // Windows line ends and trailing spaces still read.
    expect(readKitFile(text.replace(/\n/g, '  \r\n'))).toMatchObject({ ok: true });
  });

  it('a changed identity, key or line is caught by the checksum', () => {
    const text = kitText(kit, null, 'acc_mara');
    expect(readKitFile(text.replace(REAL, FAKE))).toEqual({ ok: false, reason: 'damaged' });
    expect(readKitFile(text.replace('Whombat: Studio', 'Whombat: Other'))).toEqual({
      ok: false,
      reason: 'damaged',
    });
    // An identity line added to a kit without its checksum doesn't count either.
    const noChecksum = text.replace(/Checksum: .*\n$/, '');
    expect(readKitFile(noChecksum)).toEqual({ ok: false, reason: 'damaged' });
    // Recomputing the checksum over a malformed identity still isn't a kit that names one.
    const lines = text.replace(REAL, '12D3KooWnope').split('\n');
    const at = lines.findIndex((l) => l.startsWith('Checksum: '));
    lines[at] = `Checksum: ${kitChecksum(lines.slice(0, at))}`;
    expect(readKitFile(lines.join('\n'))).toEqual({ ok: false, reason: 'damaged' });
  });

  it('reads a version 1 kit (no identity) as such', () => {
    const v1 = [
      'WHOMBAT RECOVERY KIT',
      '',
      'Whombat: Studio',
      'Appliance: dev_7KQ2M4XD',
      'Owner account: acc_mara',
      'Made: 2026-09-20',
      '',
      'Recovery key:',
      kit.recoveryKey,
      '',
    ].join('\n');
    expect(readKitFile(v1)).toEqual({
      ok: true,
      kit: {
        secretKeyHex: kit.secretKeyHex,
        device: 'dev_7KQ2M4XD',
        accountId: 'acc_mara',
        appliancePeerId: null,
        version: 1,
      },
    });
    expect(readKitFile('hello')).toEqual({ ok: false, reason: 'not_a_kit' });
  });
});

describe('a pasted link that sets up this device', () => {
  it('is an add-a-device link; anything else isn’t', () => {
    expect(parseSetupLink(addDeviceLink(ui[0] as string, 'dev_1', REAL), ui)).toEqual({
      kind: 'add',
      device: 'dev_1',
      peerId: REAL,
    });
    expect(
      parseSetupLink(`https://app.whombat.com/appliances/dev_1/get-back-in#p=${REAL}&s=${SECRET}`, ui),
    ).toBeNull();
    expect(
      parseSetupLink(`https://app.whombat.com/appliances/dev_1/join#s=${SECRET}&p=${REAL}`, ui),
    ).toBeNull();
    expect(parseSetupLink('https://app.whombat.com/appliances/dev_1/burrow-hq', ui)).toBeNull();
    expect(parseSetupLink(`https://app.whombat.com/claim#v=1&d=dev_1&p=${REAL}&s=${SECRET}`, ui)).toBeNull();
  });
});
