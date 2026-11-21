/**
 * The scripted Hermes runs turns without anyone's sign-in only where the server allows it (hermes-engine.md HE-46):
 * the claim of a runner whose last heartbeat says its Hermes is scripted carries no credential when
 * `WHOMBAT_ALLOW_SCRIPTED` is on, and the same claim of a real Hermes (or with the flag off) carries the agent's
 * sign-in as always. Needs Postgres: the claim reads the queued dispatch and the agent's stored sign-in source.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runnerApi } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { dispatches, principals } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';

const t = useTestServer({
  seed: true,
  app: true,
  env: {
    WHOMBAT_ALLOW_SCRIPTED: '1',
    // The suite's sign-ins, read in this process (no runner relays them).
    WHOMBAT_CREDENTIALS_ROOT: mkdtempSync(join(tmpdir(), 'wb-scripted-')),
    WHOMBAT_SIGNIN_EXECUTOR: 'local',
  },
});
const AUTH = { authorization: 'Bearer dev-runner-token' };

const post = (url: string, payload: object) => t.api.inject({ method: 'POST', url, headers: AUTH, payload });

/** A heartbeat that says which Hermes the runner has. */
async function beat(runnerId: string, version: string) {
  const res = await post('/internal/runner/heartbeat', {
    runnerId,
    active: [],
    status: {
      hermes: { ready: true, version, problem: null, detail: null },
      providers: [],
      checkedAt: new Date().toISOString(),
    },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** A queued turn of Dusty's, claimed by `runnerId`: the credential the claim hands out. */
async function claimedCredential(runnerId: string) {
  const sent = await t.commit(IDS.mara, sendMessage, { conversationId: IDS.billing, text: '@Dusty hello' });
  if (sent.status !== 'ok') throw new Error('send failed');
  const res = await post('/internal/runner/claim', { runnerId, providers: ['claude'], waitMs: 0 });
  expect(res.statusCode, res.body).toBe(200);
  const ctx = runnerApi.claim.response.parse(res.json()).dispatch;
  if (!ctx) throw new Error('nothing to claim');
  await post(`/internal/runner/dispatches/${ctx.dispatch.id}/complete`, {
    outcome: 'done',
    runnerId,
    attempt: ctx.dispatch.attempts,
  });
  return ctx.credential ?? null;
}

beforeAll(async () => {
  // Dusty on Claude: every claim of its turns names the person's sign-in (one-person.md OP-S09).
  await t.services.db
    .update(principals)
    .set({
      runtime: { provider: 'claude' },
    })
    .where(eq(principals.id, IDS.dusty));
});

afterEach(async () => {
  t.services.config.WHOMBAT_ALLOW_SCRIPTED = true;
  await t.services.db.update(dispatches).set({ state: 'done' }).where(eq(dispatches.agentId, IDS.dusty));
});

describe('a scripted Hermes and the sign-in (HE-46)', () => {
  it('runs without one where the server allows it', async () => {
    await beat('rnr_scripted', '0.22.5 (scripted)');
    expect(t.services.runtime.scriptedRunner('rnr_scripted')).toBe(true);
    expect(await claimedCredential('rnr_scripted')).toBeNull();
  });

  it('gets the sign-in as always when the server doesn’t allow it', async () => {
    t.services.config.WHOMBAT_ALLOW_SCRIPTED = false;
    await beat('rnr_scripted-off', '0.22.5 (scripted)');
    expect(t.services.runtime.scriptedRunner('rnr_scripted-off')).toBe(false);
    expect(await claimedCredential('rnr_scripted-off')).toMatchObject({ provider: 'claude' });
  });

  it('never treats a real Hermes so', async () => {
    await beat('rnr_real', '0.22.5');
    expect(t.services.runtime.scriptedRunner('rnr_real')).toBe(false);
    expect(await claimedCredential('rnr_real')).toMatchObject({
      provider: 'claude',
    });
  });
});
