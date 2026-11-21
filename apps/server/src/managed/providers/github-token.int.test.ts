/**
 * An agent's git token on an appliance as it is configured (resourceful-agents.md RA-DS50): the appliance gives the
 * credentials root to the runner alone (appliance NX-20), so the server has no `WHOMBAT_CREDENTIALS_ROOT` and reads
 * sign-ins through the runner's sign-in bridge (SUB-56). With GitHub connected for the burrow, the agent's git token
 * is that of the person who connected it, read through the bridge. Before the fix the server's own (absent) root
 * decided, and every agent git operation on every appliance was refused with “Nobody’s GitHub sign-in is assigned to
 * this agent on this appliance.” — on John's box 18 minutes after he connected GitHub.
 */
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { githubConnections, principals } from '../../db/schema/index';
import { IDS, TEST_BURROW_ID } from '../../seed/test-world';
import type { Services } from '../../services';
import { useTestServer } from '../../test/harness';
import { managedGitToken, NO_GITHUB_CONNECTION, NO_SIGNINS_HERE } from './github';
import { providerLogins } from './service';

// The appliance's server: managed, the runner's sign-in executor (the default), no credentials root of its own.
const t = useTestServer({ seed: true });

beforeAll(async () => {
  // Dusty on Codex, on the person's own sign-in (one-person.md OP-S09).
  await t.services.db
    .update(principals)
    .set({ runtime: { provider: 'codex' } })
    .where(eq(principals.id, IDS.dusty));
  // Mara connected GitHub for the burrow (Settings → Connections → GitHub), as John did on his box.
  await t.services.db
    .insert(githubConnections)
    .values({ burrowId: TEST_BURROW_ID, login: 'acme', githubUserId: null, connectedById: IDS.mara });
});

/** The runner's side of the bridge: answers each `githubToken` request with `token`, and keeps what it was asked. */
function runnerAnswering(token: string | null) {
  const bridge = providerLogins(t.services).bridge;
  if (!bridge) throw new Error('this server reads sign-ins through the runner');
  const asked: { method: string; params: unknown }[] = [];
  const done = (async () => {
    for (;;) {
      const requests = await bridge.poll(5_000);
      for (const r of requests) {
        asked.push({ method: r.method, params: r.params });
        bridge.answer(r.id, { ok: true, result: r.method === 'githubToken' ? token : null });
      }
      if (requests.length) return;
    }
  })();
  return { asked, done };
}

describe('an agent’s git token on an appliance (RA-DS50)', () => {
  it('is the GitHub sign-in of the person who connected it, read through the runner, with no credentials root on the server', async () => {
    expect(t.services.config.WHOMBAT_CREDENTIALS_ROOT).toBeUndefined();
    const runner = runnerAnswering('gho_mara_token');
    const token = await managedGitToken(t.services, IDS.dusty, TEST_BURROW_ID);
    await runner.done;
    expect(token.token).toBe('gho_mara_token');
    expect(runner.asked).toEqual([{ method: 'githubToken', params: {} }]);
  });

  it('the agent with no AI sign-in chosen uses the connection too', async () => {
    await t.services.db
      .update(principals)
      .set({ runtime: { provider: 'codex' } })
      .where(eq(principals.id, IDS.dusty));
    const runner = runnerAnswering('gho_mara_token');
    expect((await managedGitToken(t.services, IDS.dusty, TEST_BURROW_ID)).token).toBe('gho_mara_token');
    await runner.done;
  });

  it('without a connection: nobody has connected GitHub, and where to do it', async () => {
    await t.services.db.delete(githubConnections).where(eq(githubConnections.burrowId, TEST_BURROW_ID));
    const refused = await managedGitToken(t.services, IDS.dusty, TEST_BURROW_ID).catch((e: unknown) => e);
    expect(refused).toMatchObject({
      message: NO_GITHUB_CONNECTION,
      extra: { details: { code: 'provider.owner_required' } },
    });
    expect(NO_GITHUB_CONNECTION).toContain('Settings → Connections → GitHub');
    expect(NO_GITHUB_CONNECTION).not.toMatch(/assign/i);
  });

  it('a runtime that holds no sign-ins at all says that instead', async () => {
    const local = {
      config: { WHOMBAT_SIGNIN_EXECUTOR: 'local', WHOMBAT_HOME: '/srv/whombat' },
    } as unknown as Services;
    await expect(managedGitToken(local, IDS.dusty, TEST_BURROW_ID)).rejects.toMatchObject({
      message: NO_SIGNINS_HERE,
      extra: { details: { code: 'provider.not_configured' } },
    });
  });
});
