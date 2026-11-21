import type { BackupBringBack } from '@whombat/protocol/session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import type { ControlApi } from './control';
import { passkeySetupView, readPasskeySetup, PASSKEY_SETUP_TEXT as T } from './passkey-setup';

const backup = (state: BackupBringBack['state'], setup?: BackupBringBack['setup']): BackupBringBack => ({
  state,
  setup,
  passkeys: state === 'ready' ? 1 : 0,
  lockedAt: null,
  nasCopyAt: null,
  paperAt: null,
});
const facts = { hasPasskey: true, linked: true, allLinked: true, bringBack: null };

describe('one passkey setup status', () => {
  it('asks to set up a missing key, even if someone else has already protected the backups', () => {
    const view = passkeySetupView({
      ...facts,
      hasPasskey: false,
      linked: false,
      bringBack: backup('ready', 'verified'),
    });
    expect(view).toMatchObject({ phase: 'empty', action: T.setup });
    expect(view.title).not.toContain('Touch');
  });
  it('finishes setup for an account key that is not linked locally, without offering to add one', () => {
    expect(passkeySetupView({ ...facts, linked: false })).toMatchObject({
      phase: 'incomplete',
      action: T.finish,
    });
  });
  it('finishes setup when another Whombat has not been linked', () => {
    expect(passkeySetupView({ ...facts, allLinked: false })).toMatchObject({
      phase: 'incomplete',
      action: T.finish,
    });
  });
  it.each([
    backup('ready'),
    backup('needs_passkey'),
    backup('paper_only'),
    backup('ready', 'verify'),
    backup('ready', 'saving'),
  ])('does not claim ready before backup verification: %j', (bringBack) => {
    expect(passkeySetupView({ ...facts, bringBack })).toMatchObject({
      phase: 'incomplete',
      action: T.finish,
    });
  });
  it('says all three uses are ready only with verified recovery', () => {
    expect(passkeySetupView({ ...facts, bringBack: backup('ready', 'verified') })).toMatchObject({
      phase: 'ready',
      action: null,
      meta: T.readyMeta,
    });
  });
  it('does not claim backups were checked when they have not been set up', () => {
    expect(passkeySetupView({ ...facts, bringBack: backup('none') })).toMatchObject({
      phase: 'ready',
      action: null,
      meta: T.noBackups,
    });
  });
});

// A local removal leaves the shared account credential intact. The display must never interpret it as permission
// to create another credential, or count a different person's passkey as this person's setup.
describe('account and appliance status together', () => {
  it('keeps an account passkey in Finish setup after local removal', async () => {
    const { input, local } = await statusWorld();
    local.mockResolvedValue({ passkeys: [], policy: { deviceBoundOnly: false } });
    expect(await readPasskeySetup(input)).toMatchObject({ phase: 'incomplete', action: T.finish });
  });

  it('does not count another person’s local passkey', async () => {
    const { input, local } = await statusWorld();
    input.control.passkeys = async () => [];
    local.mockResolvedValue({ passkeys: [{ accountId: 'someone-else' }] } as never);
    expect(await readPasskeySetup(input)).toMatchObject({ phase: 'empty', action: T.setup });
  });

  it('does not turn a failed account read into a missing key', async () => {
    const { input } = await statusWorld();
    input.control.passkeys = async () => {
      throw new Error('offline');
    };
    await expect(readPasskeySetup(input)).rejects.toThrow('offline');
  });
});

afterEach(() => vi.restoreAllMocks());

async function statusWorld() {
  const local = vi
    .spyOn(sessionOps, 'passkeysList')
    .mockResolvedValue({ passkeys: [], policy: { deviceBoundOnly: false } });
  vi.spyOn(sessionOps, 'backupStatus').mockResolvedValue({
    summary: { bringBack: backup('none') },
    status: null,
  } as never);
  const control = {
    session: async () => ({ orgs: [{ orgId: 'org' }] }),
    appliances: async () => [{ state: 'claimed', contentPeerId: 'home' }],
    passkeys: async () => [
      { id: 'shared', createdAt: '2026-11-05T10:00:00Z', owner: { appliances: ['home'] } },
    ],
  } as unknown as Pick<ControlApi, 'session' | 'passkeys' | 'appliances'>;
  return { local, input: { session: {} as ApplianceSession, control, appliance: 'home', me: 'me' } };
}
