/**
 * (b3) Recovery-kit enrollment (MA-04 §5c, MA-19a, contracts CT-45): a statement signed by the saved recovery key
 * lets a new endpoint in, and only into the account of the person who set the kit up, and only with a confirmed kit.
 * - The person's new device enrolls through `recovery.enroll` and gets the person's app channel.
 * - A statement for any other account id is refused (`recovery_not_kit_owner`) and enrolls nothing.
 * - An unconfirmed kit: the only moment a claimed appliance has one is inside the claim ceremony, between
 *   `recovery.kit.register` and `recovery.kit.confirm`, so the claim (scenario a, or the first claim of this
 *   environment) tries `recovery.enroll` there and records the answer; this test asserts it
 *   (`recovery_kit_unverified`).
 */
import { newId } from '@whombat/core/ids';
import { beforeAll, describe, expect, it } from 'vitest';
import { type ApplianceSession, newEndpointIdentity, sessionOps } from '../src/scenario-kit/app-client.ts';
import { note } from '../src/scenario-kit/report.ts';
import {
  ensureSlice,
  ownerSession,
  recoveryEnrollInput,
  type SliceState,
} from '../src/scenario-kit/slice.ts';
import { refused, sessionFor } from '../src/scenario-kit/trust.ts';
import { type Persona, persona } from '../src/scenario-kit/world.ts';

let slice: SliceState;
let owner: ApplianceSession;
let p: Persona;

beforeAll(async () => {
  slice = await ensureSlice();
  owner = (await ownerSession(slice)).session;
  p = await persona(slice.owner.email.split('@')[0] ?? '', slice.owner.name);
});

describe('b3 recovery-kit enrollment', () => {
  it('the person’s new device enrolls with the recovery kit and gets the person’s app channel', async (ctx) => {
    const identity = await newEndpointIdentity();
    const { session: enroll, info } = await sessionFor(slice, p, identity, 'enroll');
    expect(info.channel).toBe('enroll');
    const enrolled = (await sessionOps.recoveryEnroll(
      enroll,
      recoveryEnrollInput({
        appliance: slice.peerId,
        endpoint: identity.peerId,
        accountId: slice.owner.accountId,
        recoverySecretKey: slice.recovery.secretKey,
        label: 'Harness (recovered)',
      }),
    )) as { accountId: string; endpoint?: { endpointId: string } };
    enroll.close('closed');
    note(ctx, 'recovery.enroll', { enrolled });
    expect(enrolled.accountId).toBe(slice.owner.accountId);
    const app = await sessionFor(slice, p, identity, 'app');
    expect(app.info.channel).toBe('app');
    expect(app.info.account?.id).toBe(slice.owner.accountId);
    const list = await sessionOps.endpointsList(owner);
    const row = (list.endpoints as { endpointId: string; label: string; enrolledVia?: string }[]).find(
      (x) => x.endpointId === app.info.endpointId,
    );
    note(ctx, 'recovered endpoint', { row });
    expect(row?.label).toBe('Harness (recovered)');
    app.session.close('closed');
  });

  it('a statement for another account id is refused: recovery_not_kit_owner', async (ctx) => {
    const other = newId('account');
    const identity = await newEndpointIdentity();
    const { session: enroll } = await sessionFor(slice, p, identity, 'enroll');
    const r = await refused(
      sessionOps.recoveryEnroll(
        enroll,
        recoveryEnrollInput({
          appliance: slice.peerId,
          endpoint: identity.peerId,
          accountId: other,
          recoverySecretKey: slice.recovery.secretKey,
          label: 'Harness (another account)',
        }),
      ),
      'recovery into another account',
    );
    enroll.close('closed');
    const list = await sessionOps.endpointsList(owner);
    const labels = (list.endpoints as { label: string }[]).map((x) => x.label);
    note(ctx, 'refused', { accountId: other, refusal: r });
    expect(r.appCode).toBe('recovery_not_kit_owner');
    expect(labels).not.toContain('Harness (another account)');
  });

  it('an unconfirmed kit cannot enroll devices: recovery_kit_unverified (probed inside the claim ceremony)', async (ctx) => {
    const probe = slice.probes?.unconfirmedKit;
    if (!probe) {
      note(ctx, 'not probed: this appliance was claimed without the probe (reuse a fresh environment)', {});
      ctx.skip();
      return;
    }
    note(ctx, 'recovery.enroll between kit register and confirm', { probe });
    expect(probe.outcome).toBe('refused');
    expect(probe.outcome === 'refused' ? probe.appCode : null).toBe('recovery_kit_unverified');
  });
});
