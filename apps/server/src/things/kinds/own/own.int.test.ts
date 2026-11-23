/**
 * The kinds drawn from Whombat's own records read the right rows on a real database: a report tracker's open reports,
 * fixes on their way and those out to customers; an AI gateway's turns through it, finished and going now, and its
 * switches. Their pages' layout and words are unit-tested in `own.test.ts`.
 */

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  burrows,
  catalogConnections,
  dispatches,
  trackerFixes,
  trackerItems,
} from '../../../db/schema/index';
import { IDS } from '../../../seed/test-world';
import { insertConnection } from '../../../test/connections';
import { useTestServer } from '../../../test/harness';
import { turnsLoad } from './gateway';
import { trackerLoad } from './tracker';

const t = useTestServer({ seed: true });
const DAY = 86_400_000;

describe('kinds from Whombat’s own records', () => {
  it('reads a tracker’s reports and fixes', async () => {
    const s = t.services;
    const connectionId = await insertConnection(s, {
      catalogId: 'tracker',
      burrowId: t.burrowId,
      secret: 'k',
      fields: { url: 'https://desk.example.com' },
    });
    const now = s.clock();
    const [row] = await s.db.select().from(catalogConnections).where(eq(catalogConnections.id, connectionId));
    const item = (n: number, status: string, days: number, seen: string | null = null) => ({
      burrowId: t.burrowId,
      connectionId,
      externalId: `r${n}`,
      number: n,
      kind: n % 2 ? 'bug' : 'feature',
      title: `Report ${n}`,
      organization: 'Arnica',
      status,
      seenStatus: seen,
      reportedAt: new Date(now.getTime() - days * DAY),
      mirroredAt: now,
    });
    await s.db.insert(trackerItems).values([
      { ...item(1, 'new', 1), id: `trp_${connectionId}_1` },
      { ...item(2, 'new', 2, 'closed'), id: `trp_${connectionId}_2` },
      { ...item(3, 'new', 60), id: `trp_${connectionId}_3` },
      { ...item(4, 'closed', 60), id: `trp_${connectionId}_4` },
    ]);
    const fix = (n: number, state: 'open' | 'live' | 'closed', productionAt: Date | null) => ({
      id: `tfx_${connectionId}_${n}`,
      burrowId: t.burrowId,
      connectionId,
      reportId: `r${n}`,
      number: n,
      repo: 'example/app',
      prNumber: n,
      kind: 'bug',
      state,
      productionAt,
      createdAt: now,
      updatedAt: now,
    });
    await s.db
      .insert(trackerFixes)
      .values([fix(1, 'open', null), fix(2, 'live', now), fix(3, 'closed', null)]);

    const snap = await trackerLoad(s, row as NonNullable<typeof row>, now);
    expect(snap.listened).toBe(true);
    // The old closed one is left out; the old open one stays.
    expect(snap.reports.map((r) => [r.number, r.status])).toEqual([
      [3, 'new'],
      [2, 'closed'],
      [1, 'new'],
    ]);
    expect(snap.fixes.map((f) => [f.number, f.state, f.title])).toEqual([[1, 'open', 'Report 1']]);
    expect(snap.fixedMonth).toBe(1);
  });

  it('reads the turns that went through the gateway and its switches', async () => {
    const s = t.services;
    const connectionId = await insertConnection(s, {
      catalogId: 'ai_gateway',
      burrowId: t.burrowId,
      secret: 'k',
      fields: { url: 'https://llm.example.com' },
    });
    const now = s.clock();
    // Connected two days ago: turns before that weren't through it.
    await s.db
      .update(catalogConnections)
      .set({ createdAt: new Date(now.getTime() - 2 * DAY) })
      .where(eq(catalogConnections.id, connectionId));
    const [row] = await s.db.select().from(catalogConnections).where(eq(catalogConnections.id, connectionId));
    await s.db
      .update(burrows)
      .set({ aiGateway: { connectionId, claude: true, codex: false } })
      .where(eq(burrows.id, t.burrowId));
    const turn = (
      n: number,
      state: 'done' | 'failed' | 'running',
      provider: 'claude' | null,
      finished: Date | null,
    ) => ({
      id: `dsp_gw_${connectionId}_${n}`,
      burrowId: t.burrowId,
      agentId: IDS.dusty,
      trigger: 'dm' as const,
      conversationId: IDS.general,
      state,
      gatewayProvider: provider,
      createdAt: now,
      finishedAt: finished,
    });
    await s.db.insert(dispatches).values([
      turn(1, 'done', 'claude', new Date(now.getTime() - 3_600_000)),
      turn(2, 'failed', 'claude', new Date(now.getTime() - 7_200_000)),
      turn(3, 'done', null, new Date(now.getTime() - 3_600_000)),
      // Before it was connected.
      turn(5, 'done', 'claude', new Date(now.getTime() - 3 * DAY)),
      turn(4, 'running', 'claude', null),
    ]);
    const got = await turnsLoad(s, row as NonNullable<typeof row>, now);
    expect(got.switches).toEqual({ claude: true, codex: false });
    expect(got.turns.map((x) => x.failed).sort()).toEqual([false, true]);
    expect(got.running).toBe(1);
  });
});
