/**
 * A repository renamed on GitHub is renamed on the Whombat (docs/decisions/agent-repos.md AGR-14…AGR-17), against a real
 * database because the rename moves rows of many tables in one signed command: the poller finds the new name through
 * GitHub's redirect, the owned-repository sync matches GitHub's id, and an automation made for the old name comes out
 * equal to one made today for the new name, still published by the person who published it.
 */
import {
  type AutomationDefinition,
  type AutomationRecipeInput,
  canonicalJson,
  recipeDefinition,
  recipeInstructions,
  recipeIsCurrent,
} from '@whombat/core';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyBurrowChain } from '../audit/verify';
import {
  automations,
  automationVersions,
  catalogConnections,
  events,
  githubConnections,
  githubPollCursors,
  grants,
  repos,
} from '../db/schema/index';
import { IDS, useAutomationWorld } from '../test/automations';
import { insertConnection } from '../test/connections';
import { syncOwnedRepos } from './owned-repos';

const w = useAutomationWorld();
const OLD = 'whombat/billing';
const NEW = 'whombat/invoicing';

const fake = () => {
  const f = w.services.github.fake;
  if (!f) throw new Error('no FakeGitHub');
  return f;
};
const poll = async () => {
  const report = await w.services.github.poller.pollNow({ burrowId: w.burrowId });
  if (report.errors.length) throw new Error(report.errors.join('; '));
  return report;
};
const recipe = (repo: string): AutomationRecipeInput => {
  const when = { kind: 'github' as const, repo, events: ['issue_opened' as const] };
  return {
    when,
    job: 'assess',
    instructions: recipeInstructions('assess', when),
    conversationId: IDS.billing,
    replyOnGitHub: true,
  };
};
const live = async (id: string) => {
  const [row] = await w.services.db
    .select({ definition: automationVersions.definition, publishedById: automationVersions.publishedById })
    .from(automationVersions)
    .innerJoin(automations, eq(automations.currentVersion, automationVersions.n))
    .where(and(eq(automations.id, id), eq(automationVersions.automationId, id)));
  if (!row) throw new Error('no live version');
  return row;
};
const repoRow = async () => {
  const [row] = await w.services.db.select().from(repos).where(eq(repos.id, 'rep_billing'));
  if (!row) throw new Error('no repo');
  return row;
};

let automationId = '';
let connectionId = '';

beforeAll(async () => {
  await w.services.db
    .insert(githubConnections)
    .values({ burrowId: w.burrowId, login: fake().login, connectedById: IDS.mara })
    .onConflictDoNothing();
  automationId = await w.publish(recipeDefinition(recipe(OLD)) as AutomationDefinition, {
    grants: [{ keyId: 'pr.comment', tier: 'can', repos: [OLD, 'whombat/other'] }],
  });
  connectionId = await insertConnection(w.services, {
    catalogId: 'github_actions',
    burrowId: w.burrowId,
    fields: { repos: `${OLD}, whombat/other` },
  });
  // The baseline: the name GitHub gives is the one the Whombat has.
  await poll();
  expect((await repoRow()).fullName).toBe(OLD);
});

describe('a repository renamed on GitHub', () => {
  it('the poller follows it: the repository, its cursor, keys and connection settings take the new name', async () => {
    const before = await repoRow();
    const version = (
      await w.services.db.select().from(automations).where(eq(automations.id, automationId))
    )[0]?.currentVersion;
    fake().renameRepo(OLD, NEW);
    expect((await poll()).changes).toBe(1);

    const row = await repoRow();
    expect(row).toMatchObject({ fullName: NEW, enabled: true, source: 'github' });
    expect(row.githubRepoId).not.toBeNull();
    expect(row.position).toBe(before.position);
    const cursors = await w.services.db
      .select({ repo: githubPollCursors.repo })
      .from(githubPollCursors)
      .where(eq(githubPollCursors.burrowId, w.burrowId));
    expect(cursors.map((c) => c.repo)).toContain(NEW);
    expect(cursors.map((c) => c.repo)).not.toContain(OLD);

    const keys = await w.services.db.select().from(grants).where(sql`${grants.scope}->'repos' is not null`);
    expect(keys.flatMap((g) => g.scope?.repos ?? [])).toEqual(expect.arrayContaining([NEW, 'whombat/other']));
    expect(keys.flatMap((g) => g.scope?.repos ?? [])).not.toContain(OLD);
    const [connection] = await w.services.db
      .select({ fields: catalogConnections.fields })
      .from(catalogConnections)
      .where(eq(catalogConnections.id, connectionId));
    expect(connection?.fields.repos).toBe(`${NEW}, whombat/other`);

    // Signed by GitHub, in the log.
    const [renamed] = await w.services.db
      .select()
      .from(events)
      .where(eq(events.type, 'repo.renamed'))
      .orderBy(desc(events.seq))
      .limit(1);
    expect(renamed?.text).toContain(NEW);

    // The automation made for the old name equals one made today for the new name, published by the same person.
    const now = await live(automationId);
    const [latest] = await w.services.db.select().from(automations).where(eq(automations.id, automationId));
    expect(latest?.currentVersion).toBe((version ?? 0) + 1);
    expect(canonicalJson(now.definition)).toBe(canonicalJson(recipeDefinition(recipe(NEW))));
    expect(recipeIsCurrent(now.definition as AutomationDefinition)).toBe(true);
    expect(now.publishedById).toBe(IDS.mara);

    // Once: polling again changes nothing.
    expect((await poll()).changes).toBe(0);
    expect(
      (await w.services.db.select().from(automations).where(eq(automations.id, automationId)))[0]
        ?.currentVersion,
    ).toBe(latest?.currentVersion);
    expect(await verifyBurrowChain(w.services.db, w.burrowId)).toMatchObject({ ok: true });
  });

  it('the owned repositories’ sync matches GitHub’s id: the one it has takes the new name, not a second row', async () => {
    fake().renameRepo(NEW, 'whombat/ledger');
    const res = await syncOwnedRepos(w.services, w.burrowId, IDS.mara);
    expect(res.renamed).toEqual([{ from: NEW, to: 'whombat/ledger' }]);
    expect(res.added).not.toContain('whombat/ledger');
    const [{ n } = { n: 0 }] = await w.services.db
      .select({ n: count() })
      .from(repos)
      .where(
        and(eq(repos.burrowId, w.burrowId), eq(repos.githubRepoId, (await repoRow()).githubRepoId ?? -1)),
      );
    expect(n).toBe(1);
    expect((await repoRow()).fullName).toBe('whombat/ledger');
    expect(JSON.stringify((await live(automationId)).definition)).toContain('whombat/ledger');
    expect(JSON.stringify((await live(automationId)).definition)).not.toContain(NEW);
  });

  it('keeps the old name when the Whombat already has a repository by the new one', async () => {
    const before = await repoRow();
    fake().renameRepo('whombat/ledger', 'whombat/payroll');
    await w.services.db.insert(repos).values({
      id: 'rep_payroll',
      burrowId: w.burrowId,
      fullName: 'whombat/payroll',
      enabled: true,
      source: 'local',
    });
    await poll();
    expect((await repoRow()).fullName).toBe(before.fullName);
  });
});
