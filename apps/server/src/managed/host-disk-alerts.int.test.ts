/**
 * The person's disk alerts (docs/decisions/box-status.md BS-09, BS-D02): the runtime reads the data disk from the
 * manager (range `hour` from now: just the disks) and tells the person in their Chat with the agent at
 * 85 % and at 95 %, once per level — a level re-arms 5 points below it — and the level it kept survives a restart.
 * An account in two burrows hears it once; a manager that doesn't answer changes nothing.
 */
import { formatUsagePct, hostDiskAlertText } from '@whombat/core';
import { and, asc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { burrows, messages, principals } from '../db/schema/index';
import { personalPlace } from '../guides/place';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { extraBurrow, useManagedRuntime } from '../test/managed';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { HostDiskAlerts, largestPart } from './host-disk-alerts';
import { sampleHostMetrics } from './testing';

const m = useManagedRuntime({ seed: true });
const GB = 1_000_000_000;
let maras: PersonalSetup;
let elsewhere = '';

/** The manager reports a 100 GB data disk with `pct` percent of it used (as `df` counts it). */
function diskAt(pct: number) {
  m.manager.onHostMetrics = async () => ({
    v: 1,
    metrics: sampleHostMetrics(
      { points: 0 },
      {
        usedBytes: pct * GB,
        freeBytes: (100 - pct) * GB,
        parts: [
          { key: 'containers', bytes: 22_900_000_000 },
          { key: 'work', bytes: 12_000_000_000 },
          { key: 'database', bytes: 2_000_000_000 },
        ],
      },
    ),
  });
}

/** What the assistant said about the disk in its DM (its greeting aside). */
async function said(dm: PersonalSetup): Promise<string[]> {
  const rows = await m.t.services.db
    .select({ text: messages.text })
    .from(messages)
    .where(and(eq(messages.conversationId, dm.dmId), eq(messages.authorId, dm.agentId)))
    .orderBy(asc(messages.createdAt));
  return rows.map((r) => r.text).filter((text) => text.includes('disk'));
}

async function kept(burrowId = TEST_BURROW_ID): Promise<number | undefined> {
  const [row] = await m.t.services.db
    .select({ level: burrows.hostDiskAlert })
    .from(burrows)
    .where(eq(burrows.id, burrowId));
  return row?.level;
}

beforeAll(async () => {
  maras = await addPersonalAgent(m.t.services, TEST_BURROW_ID, IDS.mara, { services: null });
  // Mara owns a second burrow on this box, with an assistant of her own there too.
  const [mara] = await m.t.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
  const second = await extraBurrow(m.t.services, mara?.accountId as string, 'Disk Elsewhere');
  elsewhere = second.burrowId;
  await addPersonalAgent(m.t.services, elsewhere, second.principalId, { services: null }).catch(() => null);
  if (!(await personalPlace(m.t.services.db, elsewhere, second.principalId)))
    throw new Error('Mara has no assistant in her second burrow');
});

describe('disk alerts to the person (BS-09)', () => {
  it('reads just the disks: range hour from now', async () => {
    diskAt(40);
    const before = m.manager.hostMetricsRequests.length;
    const from = m.t.services.clock().getTime();
    expect(await m.runtime.diskAlerts.check()).toEqual({ usedPct: 40, posted: 0 });
    const asked = m.manager.hostMetricsRequests.slice(before);
    expect(asked).toEqual([{ v: 1, range: 'hour', since: expect.any(String), timeZone: 'UTC' }]);
    const since = Date.parse(asked[0]?.since ?? '');
    expect(since).toBeGreaterThanOrEqual(from);
    expect(since).toBeLessThanOrEqual(m.t.services.clock().getTime());
    expect(await kept()).toBe(0);
  });

  it('tells the person at 85 %, in plain words, once — even across a restart', async () => {
    diskAt(86);
    // Mara owns both burrows: she hears it once, in the older one.
    expect(await m.runtime.diskAlerts.check()).toEqual({ usedPct: 86, posted: 1 });
    const text = hostDiskAlertText({
      level: 85,
      usedPct: 86,
      freeBytes: 14 * GB,
      biggest: { key: 'containers', bytes: 22_900_000_000 },
    });
    expect(await said(maras)).toEqual([text]);
    for (const fact of ['86\u00a0%', '14\u00a0GB', '22.9\u00a0GB']) expect(text).toContain(fact);
    expect(await kept()).toBe(85);
    expect(await kept(elsewhere)).toBe(85);

    // Still full: nothing new. A restarted runtime reads the level it kept.
    diskAt(87);
    expect(await m.runtime.diskAlerts.check()).toEqual({ usedPct: 87, posted: 0 });
    const restarted = new HostDiskAlerts(m.t.services, m.runtime.host);
    expect(await restarted.check()).toEqual({ usedPct: 87, posted: 0 });
    expect(await said(maras)).toEqual([text]);
  });

  it('re-arms a level only 5 points below it, and says the 95 % one too', async () => {
    diskAt(81);
    await m.runtime.diskAlerts.check();
    diskAt(86);
    expect(await m.runtime.diskAlerts.check()).toMatchObject({ posted: 0 });
    expect(await kept()).toBe(85);

    diskAt(96);
    expect(await m.runtime.diskAlerts.check()).toMatchObject({ posted: 1 });
    expect((await said(maras)).at(-1)).toBe(
      hostDiskAlertText({
        level: 95,
        usedPct: 96,
        freeBytes: 4 * GB,
        biggest: { key: 'containers', bytes: 22_900_000_000 },
      }),
    );
    expect(await kept()).toBe(95);

    diskAt(79);
    await m.runtime.diskAlerts.check();
    expect(await kept()).toBe(0);
    diskAt(85);
    expect(await m.runtime.diskAlerts.check()).toMatchObject({ posted: 1 });
    expect((await said(maras)).at(-1)).toContain(`${formatUsagePct(85)} full`);
  });

  it('changes nothing when the manager doesn’t answer or the Whombat is paused', async () => {
    const level = await kept();
    m.manager.onHostMetrics = null;
    expect(await m.runtime.diskAlerts.check()).toBeNull();
    diskAt(10);
    m.t.services.maintenance.drain('test', m.t.services.clock());
    try {
      expect(await m.runtime.diskAlerts.check()).toBeNull();
    } finally {
      m.t.services.maintenance.resume();
    }
    expect(await kept()).toBe(level);
  });

  it('names what takes the most space only when the parts are known', () => {
    expect(largestPart(null)).toBeNull();
    expect(largestPart([])).toBeNull();
    expect(
      largestPart([
        { key: 'whombat', bytes: 3 },
        { key: 'work', bytes: 9 },
        { key: 'database', bytes: 0 },
      ]),
    ).toEqual({ key: 'work', bytes: 9 });
  });
});
