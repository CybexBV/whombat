import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationError, sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import { pinnedRecord } from './pin';
import { recoverAppliance } from './recovery-ceremony';

const peerId = '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH';
const other = '12D3KooWNrPX9JcmH7DQVJDVr2AXRBHGLAE2Bowcs2hFgaBStMDa';
const known = pinnedRecord({ device: 'box', orgId: 'org', name: 'Home', peerId, source: 'claim' });
const close = vi.fn();
const openSession = vi.fn(async () => ({ close }) as unknown as ApplianceSession);
const input = {
  device: 'box',
  orgId: 'org',
  name: 'Home',
  directoryPeerId: peerId,
  known: null,
  namedPeerId: peerId,
  secretKeyHex: '01'.repeat(32),
  accountId: 'acc_mara',
  endpointPeerId: other,
  endpoint: { label: 'Browser', platform: 'web' as const },
  openSession,
};

afterEach(() => {
  vi.restoreAllMocks();
  close.mockClear();
  openSession.mockClear();
});

describe('recovery ceremony', () => {
  it.each([
    { known, directoryPeerId: other, namedPeerId: other, kind: 'changed' },
    { known: null, directoryPeerId: peerId, namedPeerId: other, kind: 'mismatch' },
    { known: null, directoryPeerId: peerId, namedPeerId: null, kind: 'missing' },
  ])('stops $kind before opening a session or sending a signature', async ({ kind, ...fields }) => {
    expect(await recoverAppliance({ ...input, ...fields })).toEqual({ kind });
    expect(openSession).not.toHaveBeenCalled();
  });

  it('pins a new identity only after enrollment succeeds and binds the request to this device and account', async () => {
    const enroll = vi
      .spyOn(sessionOps, 'recoveryEnroll')
      .mockResolvedValue({ accountId: 'acc_mara' } as never);
    expect(await recoverAppliance(input)).toMatchObject({
      kind: 'recovered',
      known: { peerId, pinSource: 'kit', enrolled: true, accountId: 'acc_mara' },
    });
    expect(enroll.mock.calls[0]?.[1]).toMatchObject({
      statement: { appliance: peerId, endpoint: other, accountId: 'acc_mara' },
      endpoint: input.endpoint,
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves the existing pin and closes the session on success', async () => {
    vi.spyOn(sessionOps, 'recoveryEnroll').mockResolvedValue({ accountId: 'acc_mara' } as never);
    expect(await recoverAppliance({ ...input, known, namedPeerId: null })).toEqual({
      kind: 'recovered',
      known: { ...known, enrolled: true, accountId: 'acc_mara' },
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('maps refusals and closes the session without recording a new pin', async () => {
    vi.spyOn(sessionOps, 'recoveryEnroll').mockRejectedValue(
      new OperationError('recovery.enroll', 403, 'recovery_signature_invalid', 'Invalid'),
    );
    expect(await recoverAppliance(input)).toEqual({ kind: 'error', error: 'recovery_signature_invalid' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('maps a failed connection without claiming recovery succeeded', async () => {
    expect(
      await recoverAppliance({
        ...input,
        openSession: async () => {
          throw new Error('offline');
        },
      }),
    ).toEqual({ kind: 'error', error: 'failed' });
    expect(close).not.toHaveBeenCalled();
  });
});
