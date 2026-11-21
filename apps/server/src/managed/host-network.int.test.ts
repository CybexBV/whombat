/**
 * Wi-Fi changes in the appliance's audit chain (hardware-support-server.md HD-S06): why this file needs Postgres — each
 * change the manager took is one signed `network.wifi_joined` / `network.wifi_forgotten` in `appliance_events`, linked
 * into the chain, the person's account and device as actor (none from the box's screen), and never the passphrase. A
 * change the manager refused writes nothing.
 */
import { asc, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { applianceEvents } from '../db/schema/index';
import { useManagedRuntime } from '../test/managed';
import { verifyApplianceChain } from './audit';
import { FakeHost } from './fake-host';

const m = useManagedRuntime();
const PASSPHRASE = 'correct-horse-42';

async function networkEvents() {
  return m.t.services.db
    .select()
    .from(applianceEvents)
    .where(inArray(applianceEvents.type, ['network.wifi_joined', 'network.wifi_forgotten']))
    .orderBy(asc(applianceEvents.seq));
}

describe('Wi-Fi changes in the audit chain (HD-S06)', () => {
  it('records a join by the person and a forget from the screen, signed and chained, without the passphrase', async () => {
    let now = Date.parse('2026-10-20T12:00:00.000Z');
    m.manager.host = new FakeHost(() => now, { applyMs: 10, confirmMs: 10, keepMs: 1_000 });
    const network = m.runtime.network;
    const joined = await network.join(
      { ssid: 'Home', passphrase: PASSPHRASE },
      { via: 'app', accountId: 'acc_owner', endpointId: 'ep_owner' },
    );
    now += 100;
    // Refused by the manager (not saved): nothing written.
    await expect(network.forget({ ssid: 'Nowhere' }, { via: 'screen' })).rejects.toMatchObject({
      code: 'not_saved',
    });
    const forgot = await network.forget({ ssid: 'Office' }, { via: 'screen' });

    const rows = await networkEvents();
    expect(rows.map((r) => [r.type, r.actorAccountId, r.endpointId])).toEqual([
      ['network.wifi_joined', 'acc_owner', 'ep_owner'],
      ['network.wifi_forgotten', null, null],
    ]);
    expect(rows.map((r) => r.payload)).toEqual([
      { ssid: 'Home', via: 'app', changeId: joined.id },
      { ssid: 'Office', via: 'screen', changeId: forgot.id },
    ]);
    expect(JSON.stringify(rows)).not.toContain(PASSPHRASE);
    expect(await verifyApplianceChain(m.t.services.db)).toMatchObject({ ok: true });
  });
});
