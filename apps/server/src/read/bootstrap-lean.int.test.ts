/**
 * Bootstrap reads only what it shows (docs/decisions/server-efficiency.md SV-06): member counts without every member
 * row, branch-room dots without files, commits or diffs — the same numbers the full reads gave — and no “needs you”
 * count (`work.needsYou` has it, counted in SQL).
 */
import { type Bootstrap, canDecide, prStatus } from '@whombat/core';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { approvals, pullRequests } from '../db/schema/index';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { engineActor, loadPrincipalRow } from './principals';
import { decidablePendingCount, loadPullRequests, toApproval } from './work';

const t = useTestServer({ seed: true, app: true });
const PEOPLE = [IDS.mara] as const;

async function bootstrapOf(principalId: string): Promise<Bootstrap> {
  const { cookie } = await sessionFor(t.services, principalId);
  const res = await t.api.inject({
    method: 'GET',
    url: '/api/v1/burrows/burrow-hq/bootstrap',
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as Bootstrap;
}

beforeAll(async () => {
  // Pending approvals of every shape `canDecide` tells apart, copies of the seeded one with other conditions.
  const person = (extra: Record<string, unknown>) => ({
    id: 'person',
    met: false,
    kind: 'person_approves',
    label: 'A person says yes',
    ...extra,
  });
  const variants: [string, unknown[]][] = [
    ['apr_private_mara', [person({ approverIds: [IDS.mara], private: true })]],
    ['apr_named_mara', [person({ approverIds: [IDS.mara] })]],
    ['apr_anyone', []],
  ];
  let n = 900;
  for (const [id, conditions] of variants) {
    n++;
    await t.services.db.execute(sql`
      insert into approvals
      select (jsonb_populate_record(null::approvals, to_jsonb(a) || jsonb_build_object(
        'id', ${id}::text, 'number', ${n}::int, 'conditions', ${JSON.stringify(conditions)}::jsonb))).*
      from approvals a where a.id = 'apr_staging-482'`);
  }
  // One decided: never counted.
  await t.services.db.execute(sql`
    insert into approvals
    select (jsonb_populate_record(null::approvals, to_jsonb(a) || jsonb_build_object(
      'id', 'apr_done', 'number', 999, 'state', 'approved'))).*
    from approvals a where a.id = 'apr_staging-482'`);
});

describe('bootstrap reads only what it shows (SV-06)', () => {
  it('counts the approvals the person and the agent may decide in SQL exactly as canDecide does', async () => {
    const pending = await t.services.db.select().from(approvals).where(eq(approvals.state, 'pending'));
    expect(pending.length).toBeGreaterThanOrEqual(4);
    for (const id of [...PEOPLE, IDS.dusty]) {
      const viewer = await loadPrincipalRow(t.services.db, id);
      if (!viewer) throw new Error(id);
      const decider = engineActor(viewer);
      const expected = pending.filter((a) => canDecide(toApproval(a), decider) === null).length;
      expect({ id, n: await decidablePendingCount(t.services.db, TEST_BURROW_ID, viewer) }).toEqual({
        id,
        n: expected,
      });
    }
    // Mara, the one person (one-person.md OP-01), decides every pending one.
    const mara = await loadPrincipalRow(t.services.db, IDS.mara);
    if (!mara) throw new Error('mara');
    expect(await decidablePendingCount(t.services.db, TEST_BURROW_ID, mara)).toBe(pending.length);
  });

  it('shows the same branch-room dots as the full reads, and counts nothing for needs-you', async () => {
    const boot = await bootstrapOf(IDS.mara);
    // No channels and no conversations between people (one-agent.md OA-04): Mara's Chat and the PR rooms she is in.
    const all = [...boot.sidebar.dms, ...boot.sidebar.branchRooms];
    expect(all.length).toBeGreaterThanOrEqual(2);

    const rows = await t.services.db.select().from(pullRequests);
    const full = await loadPullRequests(t.services.db, rows);
    expect(boot.sidebar.branchRooms.length).toBeGreaterThan(0);
    for (const room of boot.sidebar.branchRooms) {
      const pr = full.find((p) => p.conversationId === room.id);
      expect(room.prStatus).toBe(pr ? prStatus(pr) : 'in_review');
      // A room without its pull request (the test world's old channels, OA-S28) still has a number to show.
      if (pr) expect(room.prNumber).toBe(pr.number);
    }
    // `work.needsYou` counts what needs the person; the bootstrap's field no screen shows is always 0.
    expect(boot.sidebar.counts.needsYou).toBe(0);
  });
});
