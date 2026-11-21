/** This Whombat on the phone in parts (this-whombat-sections-android.md AP-1241…AP-1244, AP-1249, AP-1254). */
import { PASSKEY_SETUP_TEXT, passkeySetupView, whombatOverview } from '@whombat/client/managed';
import type { ApplianceStatus } from '@whombat/client/session';
import { describe, expect, it } from 'vitest';
import {
  actionStep,
  diagnosticScopeLine,
  glanceLabel,
  glanceRows,
  needsRows,
  type OverviewFacts,
  overviewInput,
  partStep,
} from './thisWhombat';

const status = (over: Partial<ApplianceStatus> = {}): ApplianceStatus =>
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
    appliance: { runtimeVersion: '2026.9.2' },
    licence: null,
    ...over,
  }) as unknown as ApplianceStatus;

const facts = (over: Partial<OverviewFacts> = {}): OverviewFacts => ({
  status: status(),
  endpoints: [{ revocation: 'none' }, { revocation: 'pending' }, { revocation: 'none' }],
  passkeys: passkeySetupView({ hasPasskey: false, linked: false, allLinked: false, bringBack: null }),
  app: '0.74.0',
  timeZone: 'UTC',
  ...over,
});

describe('the Overview’s input on the phone (AP-1241)', () => {
  it('devices not removed, your passkeys, no Agents’ access', () => {
    const input = overviewInput(facts());
    expect(input.devices).toBe(2);
    expect(input.passkeys?.phase).toBe('empty');

    expect(input.access).toBeNull();
    expect(input.versions).toEqual({ app: '0.74.0', runtime: '2026.9.2' });
  });

  it('what couldn’t be read, or isn’t offered here, is left out', () => {
    const input = overviewInput(facts({ endpoints: null, passkeys: null }));
    expect(input.devices).toBeNull();
    expect(input.passkeys).toBeNull();
  });
});

describe('NEEDS YOU on the phone (AP-1242, AP-1243)', () => {
  it('each row has its button and the step that fixes it', () => {
    const rows = needsRows(whombatOverview(overviewInput(facts())));
    expect(rows.map((r) => [r.title, r.button, r.step])).toEqual([
      ['Backups aren’t set up', 'Set up backups', { to: 'WhombatBackups', params: { setUp: true } }],
      [PASSKEY_SETUP_TEXT.empty, PASSKEY_SETUP_TEXT.setup, { to: 'passkey' }],
    ]);
  });

  it('the recovery kit is saved from here; failing backups and the devices open their part', () => {
    expect(actionStep('saveKit')).toEqual({ to: 'kit' });
    expect(actionStep('setUpPasskey')).toEqual({ to: 'passkey' });
    expect(actionStep('openBackups')).toEqual({ to: 'WhombatBackups' });
    expect(actionStep('openDevices')).toEqual({ to: 'Devices' });
  });
});

describe('AT A GLANCE on the phone (AP-1244)', () => {
  it('rows link to their part, read as their title and line', () => {
    const rows = glanceRows(
      whombatOverview(
        overviewInput(
          facts({
            status: status({
              backup: {
                state: 'protected',
                lastSuccessAt: new Date().toISOString(),
                lastFailure: null,
              } as never,
            }),
          }),
        ),
      ),
    );
    expect(rows.map((r) => [r.key, r.step.to, r.label])).toEqual([
      ['update', 'WhombatAbout', 'Up to date, Software 2026.9.2'],
      ['backups', 'WhombatBackups', 'Backed up, Last backup just now'],
      ['kit', 'WhombatBackups', 'Recovery kit saved, Keep it somewhere safe and offline.'],
      ['devices', 'Devices', '2 devices'],
    ]);
  });

  it('every part stays one tap away: a row named after a part nothing links to', () => {
    const rows = glanceRows(
      whombatOverview(
        overviewInput(
          facts({
            status: status({ recovery: { kitVerified: false, rotationPending: false } as never }),
            endpoints: null,
          }),
        ),
      ),
    );
    // No kit is a quiet glance row since BX-01, so it links Backups itself; Devices has nothing.
    expect(rows.filter((r) => r.key.startsWith('part:')).map((r) => [r.title, r.dot, r.step])).toEqual([
      ['Devices', null, { to: 'Devices' }],
    ]);
    expect(rows.find((r) => r.key === 'kit')?.step).toEqual({ to: 'WhombatBackups' });
  });

  it('without an update row the version links to About; Agents’ access never shows on the phone', () => {
    const o = whombatOverview({
      ...overviewInput(facts({ status: status({ update: null }) })),
      access: { lan: 'open' },
    });
    const rows = glanceRows(o);
    expect(rows.find((r) => r.key === 'version')).toMatchObject({
      title: 'Version',
      meta: 'App 0.74.0 · Whombat 2026.9.2',
      step: { to: 'WhombatAbout' },
    });
    expect(rows.some((r) => r.key === 'access')).toBe(false);
  });

  it('a part’s screen, and a row’s label without a line', () => {
    expect(partStep('about')).toEqual({ to: 'WhombatAbout' });
    expect(glanceLabel('Backups', null)).toBe('Backups');
  });
});

describe('diagnostics in plain words (AP-1249)', () => {
  it('the app’s line for a scope it knows, the contract’s for a newer one', () => {
    expect(diagnosticScopeLine('connectivity', 'relay connects')).toBe(
      'How well this Whombat stayed connected over the last 7 days.',
    );
    expect(diagnosticScopeLine('newScope', 'What the contract says.')).toBe('What the contract says.');
  });
});
