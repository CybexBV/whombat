/**
 * The appliance licence since Whombat Link (docs/decisions/whombat-link.md LNK-04): inert on every box, against a real
 * database and the real admin socket. The manager's push (`POST /licence`) is still verified and kept, so a rollback to
 * the release before finds its token, but the runtime computes, shows and enforces no state: `licence.status` answers
 * none, `licence.refresh` has nothing to renew, and a lapsed token stops nothing. The licence's own state machine and its
 * enforcement were retired with the behaviour (LNK-53); phase 2 deletes the module.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LICENCE_GRACE_S, type LicenceClaims } from '@whombat/protocol/licence';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applianceEvents, applianceState } from '../db/schema/managed';
import { IDS } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import { AdminSocket } from './admin-socket';
import type { RequestAnswer } from './dispatcher';
import { RequestControl } from './dispatcher';
import { signTestLicence, testIdentity, testLicenceClaims } from './testing';
import type { SessionPrincipal } from './trust';

const dir = mkdtempSync(join(tmpdir(), 'wb-licence-'));
const adminPath = join(dir, 'admin.sock');
const m = useManagedRuntime({ seed: true });
const DEVICE = 'dev-licence-01';
const DAY = 86_400;
let admin: AdminSocket;
let mara: SessionPrincipal;
let requestNo = 0;

const now = () => Math.floor(Date.now() / 1000);
const isoAt = (s: number) => new Date(s * 1000).toISOString();

beforeAll(async () => {
  admin = new AdminSocket({ runtime: m.runtime, endpoint: null });
  await admin.listen(adminPath);
  const maraId = await m.enroll(IDS.mara);
  mara = await m.runtime.trust.identify(maraId.peerId, maraId.publicKey);
  await m.runtime.trust.provisionClaim({ deviceId: DEVICE, secretHash: null });
  const client = await m.client(testIdentity());
  await m.claim(client, { deviceId: DEVICE, name: 'Olga', email: 'olga@example.com' });
});

afterAll(async () => {
  await admin.close();
  rmSync(dir, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in this test.
function call(path: string, body: unknown): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: adminPath, path, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString() || '{}'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const push = (token: string | null, highWater = now()) =>
  call('/licence', { v: 1, token, highWater: isoAt(highWater) });

async function op(principal: SessionPrincipal, name: string, input: unknown = {}): Promise<RequestAnswer> {
  let answer: RequestAnswer | null = null;
  await m.runtime.dispatcher.handle(
    principal,
    { id: `req-licence-${++requestNo}`, op: name, input },
    { accepted: () => {}, result: (a) => (answer = a) },
    new RequestControl(null),
  );
  return answer as unknown as RequestAnswer;
}

describe('the licence is inert (LNK-04)', () => {
  it('a claimed box has no licence state: nothing shown, nothing enforced', async () => {
    expect(m.t.services.licence.status).toBeNull();
    expect(m.t.services.licence.lapsed).toBe(false);
    expect(await op(mara, 'licence.status')).toMatchObject({ type: 'result', output: { licence: null } });
    const status = await op(mara, 'appliance.status');
    expect(status).toMatchObject({ type: 'result', output: { licence: null } });
  });

  it('a token the manager still pushes is verified and kept, and answers no state', async () => {
    const claims: LicenceClaims = testLicenceClaims(DEVICE, { iat: now() - 10 });
    const token = signTestLicence(claims);
    expect(await push(token, claims.iat)).toEqual({ status: 200, body: { v: 1, licence: null } });
    const [row] = await m.t.services.db.select().from(applianceState).where(eq(applianceState.id, 1));
    expect(row?.licenceToken).toBe(token);
    // Still checked: a token for another box is refused as before.
    expect(await push(signTestLicence(testLicenceClaims('dev-someone-else', { iat: now() })))).toMatchObject({
      status: 400,
      body: { error: { message: expect.stringMatching(/wrong_device/) } },
    });
  });

  it('a lapsed token stops nothing: no state, no lapse, nothing refused', async () => {
    const long = now() - 2 * LICENCE_GRACE_S - 10 * DAY;
    const lapsed = testLicenceClaims(DEVICE, { iat: now(), nbf: long, exp: long + DAY });
    await push(signTestLicence(lapsed), now());
    expect(m.t.services.licence.status).toBeNull();
    expect(m.t.services.licence.lapsed).toBe(false);
    m.t.services.licence.assertNotLapsed();
    await m.t.services.licence.assertCanAdd('connectors', async () => 1_000);
  });

  it('licence.refresh has nothing to renew and asks the manager nothing', async () => {
    const before = m.manager.renewals;
    expect(await op(mara, 'licence.refresh')).toMatchObject({ type: 'error', code: 'not_allowed' });
    expect(m.manager.renewals).toBe(before);
  });

  it('records no licence state change', async () => {
    const rows = await m.t.services.db
      .select({ payload: applianceEvents.payload })
      .from(applianceEvents)
      .where(eq(applianceEvents.type, 'licence.state_changed'));
    expect(rows).toEqual([]);
  });
});
