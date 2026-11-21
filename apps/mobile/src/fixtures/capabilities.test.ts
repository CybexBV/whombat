import { enabledSkillsOf } from '@whombat/client/query';
import { skillLibraryEndpoints as L } from '@whombat/client/skill-library';
import { api } from '@whombat/core';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { beforeEach, describe, expect, it } from 'vitest';
import { vaultAgentRows, vaultEntryRows, vaultEntryScreen } from '../data/vault';
import { demoClient } from '../demo/session';
import { createClock } from '../lib/time';
import { minutesAfterSeed, worldContext } from '../test/world';
import { createFixtureServer } from './fixture-server';

const burrow = 'burrow-hq';

function setup() {
  const server = createFixtureServer({
    inner: createFixtureFetch(),
    now: createClock(minutesAfterSeed(0), Date.now()),
    setTimer: () => undefined,
  });
  // The client checks every answer against the contract, so the layer's data is valid contract data.
  const client = demoClient(server.fetch);
  return { client };
}

async function ok<T>(p: Promise<{ status: string; data?: T }>): Promise<T> {
  const r = await p;
  if (r.status !== 'ok' || r.data === undefined) throw new Error(r.status);
  return r.data;
}

describe('the agent’s capabilities in the demo world (AP-238)', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('has one skill library, the agent’s, with no agent in the address (OA-18, AP-4967)', async () => {
    const library = await ok(s.client.request(L.library, { params: { burrow } }));
    expect(library.agentName).toBe('Neo');
    expect(library.items.length).toBeGreaterThan(0);
    const name = library.items.find((i) => i.status === 'on')?.name ?? '';
    const off = await ok(s.client.request(L.switch, { params: { burrow }, body: { name, on: false } }));
    expect(off.item?.status).toBe('off');
    const after = await ok(s.client.request(L.library, { params: { burrow } }));
    expect(enabledSkillsOf(after).some((skill) => skill.name === name)).toBe(false);
  });

  it('keeps a website login in Mara’s Vault, on and off for the agent (CT-125, AP-4992)', async () => {
    const ctx = worldContext();
    const list = await ok(s.client.request(api.vault.list, { params: { burrow } }));
    // The agent holds every entry but an old secret (VS-01, VS-02; AP-4035).
    expect(vaultEntryRows(list.entries, ctx.now, ctx.timeZone, 'Neo').map((r) => r.name)).toContain(
      'Shop admin',
    );
    expect(vaultAgentRows(list.entries).map((r) => r.entryId)).toContain('vlt_shop');
    const got = await ok(s.client.request(api.vault.get, { params: { burrow, entryId: 'vlt_shop' } }));
    expect(vaultEntryScreen(got.entry, ctx).connection).toMatchObject({ canCheck: false });
    expect(got.entry.agentOn).toBe(true);
    const taken = await ok(s.client.request(api.vault.takeKey, { params: { burrow, entryId: 'vlt_shop' } }));
    expect([taken.entry.agentOn, taken.entry.key]).toEqual([false, null]);
    const given = await ok(
      s.client.request(api.vault.giveKey, { params: { burrow, entryId: 'vlt_shop' }, body: {} }),
    );
    expect(given.entry.agentOn).toBe(true);
  });
});
