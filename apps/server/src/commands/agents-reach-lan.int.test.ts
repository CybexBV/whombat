/**
 * “Agents may reach your local network” (docs/decisions/resourceful-agents.md RA-41, RA-DC17; RA-DS41): `burrows.setAgentsReachLan`
 * for the person, `Burrow.agentsReachLan` (on by default), one signed `burrow.agents_lan_changed` (Keys) per change, and
 * `DispatchCommandsContext.lan` following it.
 */
import { api, buildPath } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { commandsContextFor } from '../agent-commands/context';
import { burrows, dispatches, events } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { agentTokenFor, sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, app: true });
const b = { burrow: 'burrow-hq' };

async function call(who: string, method: 'GET' | 'PUT', path: string, payload?: object) {
  const { cookie } = await sessionFor(t.services, who);
  const res = await t.api.inject({
    method,
    url: `/api/v1${path}`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

/** The `lan` of Dusty's commands turn now. */
async function lanNow(): Promise<boolean | undefined> {
  const { dispatchId } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, IDS.billing);
  const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
  if (!row) throw new Error('no dispatch');
  return (await commandsContextFor(t.services, { system: null }, row))?.lan;
}

describe('Agents may reach your local network (RA-41)', () => {
  it('is on by default, for the burrow and in a commands turn', async () => {
    const got = await call(IDS.mara, 'GET', buildPath(api.burrows.get.path, b));
    expect(got.body.burrow).toMatchObject({ agentsReachLan: true });
    const [row] = await t.services.db.select().from(burrows).where(eq(burrows.id, t.burrowId));
    expect(row?.agentsReachLan).toBeNull();
    expect(await lanNow()).toBe(true);
  });

  it('the person switches it, signed under Keys; the same answer twice signs nothing', async () => {
    const path = buildPath(api.burrows.setAgentsReachLan.path, b);
    const off = await call(IDS.mara, 'PUT', path, { agentsReachLan: false });
    expect(off.status).toBe(200);
    expect(off.body.burrow).toMatchObject({ agentsReachLan: false });
    expect(off.body.eventId).toEqual(expect.any(String));
    const [signed] = await t.services.db
      .select()
      .from(events)
      .where(and(eq(events.burrowId, t.burrowId), eq(events.type, 'burrow.agents_lan_changed')));
    expect(signed).toMatchObject({
      kind: 'Keys',
      actorId: IDS.mara,
      text: 'Closed the local network to agents (home networks only)',
      payload: { agentsReachLan: false },
    });
    expect(await lanNow()).toBe(false);

    const again = await call(IDS.mara, 'PUT', path, { agentsReachLan: false });
    expect(again.body).toMatchObject({ eventId: null, burrow: { agentsReachLan: false } });

    const on = await call(IDS.mara, 'PUT', path, { agentsReachLan: true });
    expect(on.body.burrow).toMatchObject({ agentsReachLan: true });
    expect(await lanNow()).toBe(true);
    const texts = (
      await t.services.db
        .select({ text: events.text })
        .from(events)
        .where(and(eq(events.burrowId, t.burrowId), eq(events.type, 'burrow.agents_lan_changed')))
    ).map((e) => e.text);
    expect(texts).toEqual([
      'Closed the local network to agents (home networks only)',
      'Let agents reach the local network',
    ]);
  });
});
