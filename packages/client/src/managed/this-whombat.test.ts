/** This Whombat's parts and the Overview's lists (this-whombat-sections.md AP-1221…AP-1226, AP-1234). */
import { describe, expect, it } from 'vitest';
import type { LicenceView } from '../session/managed-ops';
import { PASSKEY_SETUP_TEXT, passkeySetupView } from './passkey-setup';
import { MANAGED_TEXT } from './status-copy';
import {
  THIS_WHOMBAT_TEXT,
  type WhombatOverviewInput,
  whombatOverview,
  whombatPart,
  whombatParts,
} from './this-whombat';

const licence: LicenceView = {
  state: 'licensed',
  reason: 'active',
  plan: 'whombat',
  limits: { devices: 3, connectors: 3 },
  renewedAt: '2026-09-25T10:00:00.000Z',
  expiresAt: '2026-10-24T10:00:00.000Z',
  graceEndsAt: '2026-11-08T10:00:00.000Z',
  effectiveAt: '2026-09-26T10:00:00.000Z',
  usage: { connectors: 0 },
  checkedAt: '2026-09-26T10:00:00.000Z',
};

type Status = NonNullable<WhombatOverviewInput['status']>;
const status = (over: Partial<Status> = {}): Status =>
  ({
    backup: { state: 'unprotected', lastSuccessAt: null, lastFailure: null },
    recovery: { kitVerified: true, rotationPending: false },
    update: {
      state: 'Healthy',
      current: '2026.9.2',
      candidate: null,
      lastCheckedAt: null,
      deferredReason: null,
      failure: null,
    },
    licence,
    ...over,
  }) as Status;

const input = (over: Partial<WhombatOverviewInput> = {}): WhombatOverviewInput => ({
  status: status(),
  devices: 1,
  passkeys: passkeySetupView({ hasPasskey: false, linked: false, allLinked: false, bringBack: null }),
  access: { lan: 1 },
  agent: 'Dusty',
  timeZone: 'UTC',
  ...over,
});

describe('the parts (AP-1221, AP-1222)', () => {
  it('a managed Whombat has all five, in order', () => {
    expect(whombatParts({ managed: true, backupFile: false })).toEqual([
      'overview',
      'backups',
      'devices',
      'access',
      'about',
    ]);
  });

  it('elsewhere Backups only with the backup file, never Devices', () => {
    expect(whombatParts({ managed: false, backupFile: true })).toEqual([
      'overview',
      'backups',
      'access',
      'about',
    ]);
    expect(whombatParts({ managed: false, backupFile: false })).toEqual(['overview', 'access', 'about']);
  });

  it('`section=` is a part, else the Overview', () => {
    expect(whombatPart('devices')).toBe('devices');
    expect(whombatPart('nope')).toBe('overview');
    expect(whombatPart(undefined)).toBe('overview');
    expect(THIS_WHOMBAT_TEXT.parts.devices).toBe('Devices');
  });
});

describe('the Overview (AP-1223…AP-1226)', () => {
  it('the mockup: backups and a passkey need you; the rest is at a glance', () => {
    const o = whombatOverview(input());
    expect(o.needsYou.map((i) => [i.key, i.action])).toEqual([
      ['backups', 'setUpBackups'],
      ['passkey', 'setUpPasskey'],
    ]);
    expect(o.glance.map((i) => i.key)).toEqual(['update', 'plan', 'kit', 'devices', 'access']);
    // The row that opens About is named after it; how the updates stand is its line.
    expect(o.glance[0]).toMatchObject({ part: 'about', title: 'About' });
    expect(o.glance[0]?.meta).toMatch(/^Up to date · /);
    expect(o.glance.find((i) => i.key === 'plan')?.meta).toContain('Connectors 0 of 3');
    expect(o.glance.find((i) => i.key === 'devices')?.meta).toBeUndefined();
    expect(o.badges).toEqual({ backups: 1, devices: 1 });
  });

  it('failing backups come first, with the last one and why; a missing kit is quiet (BX-01)', () => {
    const o = whombatOverview(
      input({
        status: status({
          backup: {
            state: 'failing',
            lastSuccessAt: null,
            lastFailure: { reason: 'The backup destination didn’t answer.' },
          } as never,
          recovery: { kitVerified: false, rotationPending: false } as never,
        }),
        passkeys: passkeySetupView({ hasPasskey: true, linked: true, allLinked: true, bringBack: null }),
      }),
    );
    expect(o.needsYou.map((i) => [i.dot, i.key, i.action])).toEqual([['bad', 'backups', 'openBackups']]);
    // Not a warning any more: a quiet glance row that opens Backups, where the person finds “Make a kit”.
    expect(o.glance.find((i) => i.key === 'kit')).toMatchObject({
      dot: 'mut',
      part: 'backups',
      title: MANAGED_TEXT.kitMissing,
    });
    expect(o.glance.find((i) => i.key === 'kit')?.action).toBeUndefined();
    expect(o.needsYou[0]?.meta).toBe('No backup has finished yet · The backup destination didn’t answer.');
  });

  it('protected backups are a glance row; nothing needs you, no badges', () => {
    const o = whombatOverview(
      input({
        status: status({ backup: { state: 'protected', lastSuccessAt: new Date().toISOString() } as never }),
        passkeys: passkeySetupView({ hasPasskey: true, linked: true, allLinked: true, bringBack: null }),
      }),
    );
    expect(o.needsYou).toEqual([]);
    expect(o.badges).toEqual({});
    expect(o.glance.find((i) => i.key === 'backups')).toMatchObject({
      dot: 'ok',
      title: 'Backed up',
      meta: 'Last backup just now',
    });
    expect(o.glance.find((i) => i.key === 'passkey')).toMatchObject({
      part: 'devices',
      dot: 'ok',
      title: PASSKEY_SETUP_TEXT.ready,
    });
  });

  it('a passkey of your own is said at a glance, with the backups’ key once it holds it', () => {
    const ready = {
      state: 'ready' as const,
      setup: 'verified' as const,
      passkeys: 1,
      lockedAt: null,
      nasCopyAt: null,
      paperAt: null,
    };
    const o = whombatOverview(
      input({
        status: status({
          backup: { state: 'protected', lastSuccessAt: null, bringBack: ready } as never,
        }),
        passkeys: passkeySetupView({ hasPasskey: true, linked: true, allLinked: true, bringBack: ready }),
      }),
    );
    expect(o.needsYou.map((i) => i.key)).toEqual([]);
    expect(o.glance.map((i) => i.key)).toEqual(['update', 'plan', 'backups', 'passkey', 'devices', 'access']);
    expect(o.glance.find((i) => i.key === 'passkey')).toMatchObject({
      title: PASSKEY_SETUP_TEXT.ready,
      meta: PASSKEY_SETUP_TEXT.readyMeta,
    });
  });

  it('no passkey and backups waiting: one setup action, never a touch of a missing key', () => {
    const o = whombatOverview(
      input({
        status: status({
          backup: {
            state: 'protected',
            lastSuccessAt: null,
            bringBack: {
              state: 'needs_passkey',
              passkeys: 0,
              lockedAt: null,
              nasCopyAt: null,
              paperAt: null,
            },
          } as never,
        }),
      }),
    );
    expect(o.needsYou).toHaveLength(1);
    expect(o.needsYou[0]).toMatchObject({
      key: 'passkey',
      action: 'setUpPasskey',
      actionLabel: PASSKEY_SETUP_TEXT.setup,
    });
    expect(o.badges).toEqual({ devices: 1 });
  });

  it('incomplete passkey setup appears once, with no ready claim at a glance', () => {
    const waiting = {
      state: 'needs_passkey' as const,
      passkeys: 0,
      lockedAt: null,
      nasCopyAt: null,
      paperAt: null,
    };
    const o = whombatOverview(
      input({
        status: status({
          backup: { state: 'protected', lastSuccessAt: null, bringBack: waiting } as never,
        }),
        passkeys: passkeySetupView({ hasPasskey: true, linked: true, allLinked: true, bringBack: waiting }),
      }),
    );
    expect(o.needsYou.map((i) => [i.key, i.action])).toEqual([['passkey', 'setUpPasskey']]);
    expect(o.glance.find((i) => i.key === 'passkey')).toBeUndefined();
    expect(o.needsYou[0]?.actionLabel).toBe(PASSKEY_SETUP_TEXT.finish);
  });
});

describe('a Whombat that isn’t managed', () => {
  it('the agent’s access and the version, no box rows', () => {
    const o = whombatOverview({
      status: null,
      devices: null,
      passkeys: null,
      access: { lan: 'open' },
      versions: { app: '0.74.0', runtime: '2026.10.11' },
      agent: 'Dusty',
    });
    expect(o.needsYou).toEqual([]);
    expect(o.glance.map((i) => [i.part, i.title, i.meta])).toEqual([
      ['access', 'Dusty may reach your local network', undefined],
      ['about', 'About', 'App 0.74.0 · Whombat 2026.10.11'],
    ]);
  });

  it('a closed network says so', () => {
    const o = whombatOverview({
      status: null,
      devices: null,
      passkeys: null,
      access: { lan: 0 },
      agent: 'Dusty',
    });
    expect(o.glance).toEqual([
      { key: 'access', part: 'access', dot: 'ok', title: 'Your local network is closed to Dusty' },
    ]);
  });
});
