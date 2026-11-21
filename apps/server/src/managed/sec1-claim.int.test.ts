/**
 * Security review part 1, claim attempts (M-3 appliance part, I-4; docs/decisions/managed-runtime.md MR-26): the
 * review's "F-claim-lockout" PoC inverted. Since contracts 0.7 (CC-07) the attempt limits count
 * `enroll.claim.begin`. Its own throwaway database: the appliance must start unclaimed.
 */
import { randomBytes } from 'node:crypto';
import { claimPakeInitiator } from '@whombat/protocol/claim';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { applianceClaimAttempts } from '../db/schema/index';
import { useManagedRuntime } from '../test/managed';
import type { TestSessionClient } from './testing';
import { CLAIM_ATTEMPTS_PER_PEER } from './trust';

const m = useManagedRuntime();
const DEVICE = 'dev-claim';

/** A begin with a well-formed share for `password` (a begin reveals nothing, so any password will do). */
function begin(c: TestSessionClient, password = 'AAAA') {
  const { share } = claimPakeInitiator(
    {
      method: 'code',
      password,
      deviceId: DEVICE,
      appliancePeerId: m.appliance.peerId,
      clientPeerId: c.identity.peerId,
      claimId: 'clm_test_0001',
    },
    (n) => new Uint8Array(randomBytes(n)),
  );
  return c.request('enroll.claim.begin', { claimId: 'clm_test_0001', method: 'code', share });
}

describe('claim attempts', () => {
  it('I-4: one key racing many begins at once gets exactly its budget evaluated', async () => {
    await m.runtime.trust.provisionClaim({ deviceId: DEVICE, secretHash: null });
    m.letters();
    const racer = await m.client();
    const answers = await Promise.all(Array.from({ length: 12 }, () => begin(racer)));
    const evaluated = answers.filter((a) => (a as { code?: string }).code !== 'rate_limited');
    expect(evaluated).toHaveLength(CLAIM_ATTEMPTS_PER_PEER);
    const rows = await m.t.services.db
      .select()
      .from(applianceClaimAttempts)
      .where(eq(applianceClaimAttempts.peerId, racer.identity.peerId));
    expect(rows).toHaveLength(CLAIM_ATTEMPTS_PER_PEER);
  });

  it('M-3: strangers with throwaway keys can’t lock the person out: the physical claim window lifts the overall limit', async () => {
    // Spend the overall budget with fresh keys (5 begins each).
    for (let k = 0; k < 6; k++) {
      const stranger = await m.client();
      await Promise.all(Array.from({ length: CLAIM_ATTEMPTS_PER_PEER }, () => begin(stranger)));
    }
    const owner = await m.client();
    const limited = await begin(owner, m.letters());
    expect(limited).toMatchObject({
      t: 'error',
      code: 'rate_limited',
      details: { code: 'claim_rate_limited' },
    });
    expect((limited as { message: string }).message).toMatch(/claim button/);
    // The person at the appliance presses the claim button (the manager opens the window): the claim goes through.
    await m.runtime.trust.setClaimWindow({ required: false, openUntil: new Date(Date.now() + 60_000) });
    const { claim } = await m.claim(owner, { deviceId: DEVICE, name: 'Olive' });
    expect(claim).toMatchObject({ t: 'result', output: { accountId: expect.any(String) } });
    // Once claimed, begins are answered without being counted.
    const before = (await m.t.services.db.select().from(applianceClaimAttempts)).length;
    expect(await begin(await m.client())).toMatchObject({
      t: 'error',
      code: 'conflict',
      details: { code: 'claim_used' },
    });
    expect((await m.t.services.db.select().from(applianceClaimAttempts)).length).toBe(before);
  });
});
