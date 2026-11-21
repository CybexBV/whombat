/**
 * The turn's logins against a real Postgres (docs/decisions/hermes-engine.md HE-42, HE-S141; contracts CT-1230,
 * CT-1231): `DispatchContext.logins` lists the person's logins switched on for an agent that may browse, without a
 * secret; `runner.loginSecret` gives one of them to the runner holding the turn, and nothing to anyone else or to an
 * outsiders' turn (one-person.md OP-17); each turn's use is one line in the Vault's RECENT USE.
 */
import { DispatchLoginSecret } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { liveDispatch, RUNNER, runnerCall } from '../agent-commands/testing';
import { vaultUses } from '../db/schema/index';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { setGrant } from '../test/approvals';
import { useTestServer } from '../test/harness';
import { createVaultEntry, giveVaultKey, takeVaultKey } from '../vault/commands';

const t = useTestServer({ seed: true, app: true });

const PASSWORD = 'gh-pass-Lq7Tz2Vw9Xc4';
let github = '';
let bank = '';

async function ok<R>(res: { status: string; result?: R }): Promise<R> {
  expect(res.status).toBe('ok');
  return res.result as R;
}

const secretOf = (dispatchId: string, entryId: string, attempt = 1) =>
  runnerCall(
    t,
    'POST',
    '/dispatches/:dispatchId/logins/:entryId',
    { dispatchId, entryId },
    { runnerId: RUNNER, attempt },
  );

beforeAll(async () => {
  await setGrant(t.services, IDS.dusty, 'browser.use', 'can');
  const login = (person: string, name: string, url: string, username: string) =>
    t.commit(person, createVaultEntry, {
      kind: 'login',
      name,
      url,
      auth: { type: 'form', username },
      secret: PASSWORD,
    });
  github = (await ok(await login(IDS.mara, 'GitHub', 'https://github.com/login', 'mara@example.com')))
    .entryId;
  bank = (await ok(await login(IDS.mara, 'Bank', 'https://bank.example.com/signin', 'mara'))).entryId;
  await ok(await t.commit(IDS.mara, giveVaultKey, { entryId: github }));
  // The Bank's key, which came with the entry, switched off.
  await ok(await t.commit(IDS.mara, takeVaultKey, { entryId: bank }));
});

describe('a turn’s logins (HE-S141)', () => {
  it('the turn lists the person’s logins switched on, never a secret, and only with the browser', async () => {
    const d = await liveDispatch(t, { person: IDS.mara });
    const ctx = await buildDispatchContext(t.services, d);
    expect(ctx.browser).toEqual({ sites: null });
    expect(ctx.logins).toEqual([
      {
        entryId: github,
        name: 'GitHub',
        origin: 'https://github.com',
        username: 'mara@example.com',
        otp: false,
      },
    ]);
    expect(JSON.stringify(ctx)).not.toContain(PASSWORD);
    // Without “Use a web browser”: no browser, no logins.
    await setGrant(t.services, IDS.dusty, 'browser.use', 'cannot');
    const off = await buildDispatchContext(t.services, await liveDispatch(t, { person: IDS.mara }));
    expect(off.browser ?? null).toBeNull();
    expect(off.logins).toEqual([]);
    await setGrant(t.services, IDS.dusty, 'browser.use', 'can');
  });

  it('gives the runner holding the turn one login of the turn’s, once in RECENT USE however often', async () => {
    const d = await liveDispatch(t, { person: IDS.mara });
    for (let i = 0; i < 2; i++) {
      const res = await secretOf(d.id, github);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(DispatchLoginSecret.parse(res.body)).toEqual({ password: PASSWORD, otp: null });
    }
    const uses = await t.services.db
      .select()
      .from(vaultUses)
      .where(and(eq(vaultUses.dispatchId, d.id), eq(vaultUses.entryId, github)));
    expect(uses.map((u) => u.outcome)).toEqual(['done']);
  });

  it('never a login switched off, an outsiders’ turn’s, or a runner that lost the lease', async () => {
    const d = await liveDispatch(t, { person: IDS.mara });
    expect((await secretOf(d.id, bank)).status).toBe(404);
    const outsiders = await liveDispatch(t, { person: null });
    expect((await secretOf(outsiders.id, github)).status).toBe(404);
    expect((await secretOf(d.id, github, 2)).status).toBe(409);
  });
});
