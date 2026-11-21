/**
 * (e) Revocation (assignment §14.6, MA-04 §6): a second endpoint of the owner (paired with a code) is revoked
 * from the owner's endpoint: its live session gets the `revoked` notice (clear cached content) and closes, it
 * cannot reconnect, and the appliance reports the revocation to control through the manager (metadata only).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { sleep } from '../src/lib/proc.ts';
import {
  type ApplianceSession,
  openSession,
  sessionOps,
  whenOpen,
  whenState,
} from '../src/scenario-kit/app-client.ts';
import { devices } from '../src/scenario-kit/cloud.ts';
import { note } from '../src/scenario-kit/report.ts';
import { ensureSlice, ownerSession, pairSecondEndpoint, type SliceState } from '../src/scenario-kit/slice.ts';
import { collect, ensureWorkspace } from '../src/scenario-kit/work.ts';
import { env, persona, ticketSource } from '../src/scenario-kit/world.ts';

let slice: SliceState;
let owner: ApplianceSession;

beforeAll(async () => {
  slice = await ensureSlice();
  owner = (await ownerSession(slice)).session;
});

describe('e revocation', () => {
  it('revoking an endpoint closes its live session with a cache-clear notice; it cannot come back', async (ctx) => {
    const w = await ensureWorkspace(owner, `Revoke ${Date.now().toString(36)}`);
    const second = await pairSecondEndpoint(slice, owner, 'Harness laptop');
    expect(second.endpointId).toBeTruthy();
    const p = await persona(slice.owner.email.split('@')[0] ?? '', slice.owner.name);
    const s = openSession({
      tickets: ticketSource(p, slice.deviceId),
      identity: second.identity,
      appliance: { peerId: slice.peerId },
      channel: 'app',
    });
    const notices: { kind: string }[] = [];
    s.onNotice((n) => notices.push(n));
    const info = await whenOpen(s);
    expect(info.account?.id).toBe(slice.owner.accountId);
    const events = collect(s, [`burrow:${w.burrowId}`, `conv:${w.conversationId}`]);
    const t0 = Date.now();
    const revoked = await sessionOps.endpointsRevoke(owner, second.endpointId);
    const closed = await whenState(s, (x) => x.status === 'closed', 15_000);
    const closeMs = Date.now() - t0;
    note(ctx, 'revoked', { revoked, closed, closeMs, notices, authzGeneration: info.authzGeneration });
    expect(closed.status === 'closed' && closed.reason).toBe('revoked');
    expect(notices.some((n) => n.kind === 'revoked')).toBe(true);
    events.close();

    // It cannot reconnect with that key.
    const again = openSession({
      tickets: ticketSource(p, slice.deviceId),
      identity: second.identity,
      appliance: { peerId: slice.peerId },
      channel: 'app',
    });
    again.connect();
    const st = await whenState(again, (x) => x.status === 'closed', 15_000);
    note(ctx, 'reconnect after revocation', { state: st });
    expect(st.status === 'closed' && ['revoked', 'not_enrolled']).toContain(
      st.status === 'closed' ? st.reason : '',
    );

    // The owner's endpoint is unaffected.
    const list = await sessionOps.endpointsList(owner);
    const row = list.endpoints.find((x) => x.endpointId === second.endpointId) as
      | { revokedAt: string | null; revocation: string }
      | undefined;
    expect(row?.revokedAt).toBeTruthy();

    // A box claimed on its own page tells control nothing about its person's devices: the box
    // refusing the key is the whole revocation, so it is `applied` at once and control's directory lists none.
    let applied = false;
    let dir: unknown = null;
    for (let i = 0; i < 40 && !applied; i++) {
      const rows = (await sessionOps.endpointsList(owner)).endpoints;
      applied = rows.some((x) => x.endpointId === second.endpointId && x.revocation === 'applied');
      if (!applied) await sleep(500);
    }
    const d = await devices(env().control?.url ?? '', p.session.token, p.org);
    dir = d.devices.find((x) => x.device === slice.deviceId)?.revocations;
    note(ctx, 'revocation', { directory: dir, applied });
    expect(dir).toEqual([]);
    const status = (await sessionOps.applianceStatus(owner)) as {
      revocationsPending: number;
      revocationsApplied: number;
    };
    expect(status.revocationsPending).toBe(0);
    expect(status.revocationsApplied).toBeGreaterThan(0);
    expect(applied).toBe(true);
  });
});
