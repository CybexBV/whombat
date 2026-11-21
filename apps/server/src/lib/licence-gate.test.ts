/** The licence gate (LC-10, MR-58): what a state refuses, the codes and LC-14's copy. */
import type { LicenceStatusResult } from '@whombat/protocol/licence';
import { LicenceLimitDetails } from '@whombat/protocol/session';
import { describe, expect, it, vi } from 'vitest';
import { LICENCE_LAPSED_MESSAGE, LicenceGate, licenceLapsed, licenceLimit } from './maintenance';

const status = (
  state: LicenceStatusResult['state'],
  limits: LicenceStatusResult['limits'] = { devices: 1, connectors: 3 },
): LicenceStatusResult => ({
  state,
  reason: state === 'lapsed' ? 'expired' : state === 'grace' ? 'not_renewed' : 'active',
  plan: 'team',
  limits,
  renewedAt: 1,
  expiresAt: 2,
  graceEndsAt: 3,
  effectiveAt: 1,
});

describe('LicenceGate', () => {
  it('enforces nothing without a state (self-hosted, unclaimed)', async () => {
    const gate = new LicenceGate();
    expect(gate.status).toBeNull();
    expect(gate.lapsed).toBe(false);
    gate.assertNotLapsed();
    const count = vi.fn(async () => 1_000);
    await gate.assertCanAdd('connectors', count);
    expect(count).not.toHaveBeenCalled();
    gate.enforce(() => null);
    gate.assertNotLapsed();
  });

  it('is inert in every state since Whombat Link (whombat-link.md LNK-04): nothing refused, the state still readable', async () => {
    for (const state of ['licensed', 'grace', 'lapsed'] as const) {
      const gate = new LicenceGate();
      gate.enforce(() => status(state));
      expect(gate.status?.state).toBe(state);
      expect(gate.lapsed).toBe(false);
      gate.assertNotLapsed();
      // At and past the plan's limit, and even lapsed: adding goes on, without counting.
      const count = vi.fn(async () => 99);
      await gate.assertCanAdd('connectors', count);
      expect(count).not.toHaveBeenCalled();
    }
  });

  it('keeps the refusals’ codes and words for a rollback’s sake (CT-77)', () => {
    expect(licenceLapsed().toBody().error).toEqual({
      code: 'not_allowed',
      message: LICENCE_LAPSED_MESSAGE,
      details: { code: 'licence.lapsed' },
    });
    const full = licenceLimit('connectors', 3);
    expect(full.toBody().error).toMatchObject({
      code: 'not_allowed',
      details: { code: 'licence.limit', limit: 'connectors', allowed: 3 },
    });
    expect(LicenceLimitDetails.parse(full.toBody().error.details)).toBeTruthy();
  });
});
