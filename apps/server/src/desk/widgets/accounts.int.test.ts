/**
 * The person's accounts' widgets on a real database (desk-display-server.md DK-S250…): Postgres is the point — *Your
 * accounts* lists only the screen's person's own connections (another account's stays out, and its widget says it isn't
 * connected), and *Pull requests* and *Waiting for review* come from the GitHub mirror's tables: open ones of enabled
 * repositories, their checks summed, the reviewers asked who haven't answered.
 */
import { newId } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { accounts, connections, principals, prReviewers, pullRequests } from '../../db/schema/index';
import type { PrincipalRow } from '../../read/principals';
import { IDS } from '../../seed/test-world';
import { useTestServer } from '../../test/harness';
import { dbAccountReads } from './accounts';
import { WidgetResolver } from './resolve';
import type { ThingWidgets, WidgetCtx } from './types';

const t = useTestServer({ seed: true });
let ctx: WidgetCtx;
let mine = '';
let theirs = '';

async function connection(accountId: string, email: string, services: string[]): Promise<string> {
  const id = newId('connection');
  const now = t.services.clock();
  await t.services.db.insert(connections).values({
    id,
    accountId,
    provider: 'google',
    externalId: `sub-${email}`,
    email,
    services,
    refreshTokenEnc: 'sealed',
    grantedAt: now,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  } as never);
  return id;
}

beforeAll(async () => {
  const [mara] = await t.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
  const person = mara as PrincipalRow;
  ctx = {
    services: t.services,
    viewer: { accountId: person.accountId as string, burrowId: t.burrowId, principal: person },
    now: t.services.clock(),
    timeZone: 'Europe/Amsterdam',
    assistant: 'Dusty',
  };
  const other = newId('account');
  await t.services.db.insert(accounts).values({ id: other, email: 'someone@example.com', name: 'Someone' });
  mine = await connection(person.accountId as string, 'mara@gmail.example', ['calendar', 'mail']);
  theirs = await connection(other, 'someone@gmail.example', ['mail']);
  // Mara was asked to review the seeded pull request; a pull request of a repository not mirrored stays out.
  await t.services.db
    .insert(prReviewers)
    .values({ prId: 'pr_482', principalId: IDS.mara, state: 'pending', position: 5 });
  await t.services.db.insert(pullRequests).values({
    id: 'pr_web_9',
    burrowId: t.burrowId,
    repoId: 'rep_web',
    number: 9,
    branch: 'fix/x',
    title: 'Not mirrored',
    headSha: 'abc123',
    conversationId: IDS.pr482,
    openedAt: t.services.clock(),
  });
});

const noThings: ThingWidgets = { groups: async () => [], resolve: async () => new Map() };

describe('the person’s accounts', () => {
  it('lists the screen’s person’s own accounts and the Whombat’s GitHub, nobody else’s', async () => {
    const resolver = new WidgetResolver(t.services, () => noThings);
    const keys = (await resolver.accounts.groups(ctx)).map((g) => g.key);
    expect(keys).toContain(`account:${mine}`);
    expect(keys).not.toContain(`account:${theirs}`);
    expect(keys.at(-1)).toBe('account:github');
  });

  it('says another person’s account isn’t connected, without reading it', async () => {
    const resolver = new WidgetResolver(t.services, () => noThings);
    const got = await resolver.resolve(
      ctx,
      [{ id: 'w_theirs', type: 'panel', ref: `account:${theirs}`, opts: { panel: 'unread' } }],
      null,
      2_000,
    );
    expect(got.get('w_theirs')?.view.problem?.text).toContain('isn’t connected');
  });

  it('reads open pull requests of mirrored repositories with their checks and who’s asked to review', async () => {
    const pulls = await dbAccountReads(t.services).pulls(ctx);
    expect(pulls.map((p) => [p.repo, p.number])).toEqual([['billing', 482]]);
    expect(pulls[0]?.checks).toBe('failing');
    expect(pulls[0]?.author).toBe('Dusty');
    expect(pulls[0]?.waitingOn).toEqual([{ name: 'Mara', viewer: true }]);
    expect(await dbAccountReads(t.services).hasRepos(ctx)).toBe(true);
  });
});
