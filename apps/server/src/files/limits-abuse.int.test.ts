/**
 * Upload limits under abuse (security review of docs/decisions/bp-attachments.md BP-A04, BP-A15): discarding an
 * upload does not give its place in the hourly rate back, and concurrent reserves cannot go past the burrow's
 * quota together.
 */
import { api, buildPath } from '@whombat/core';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { attachments, uploadReservations } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { BURROW, reserve } from '../test/files';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { reserveUpload } from './commands';

const t = useTestServer({
  seed: true,
  app: true,
  env: {
    WHOMBAT_UPLOAD_RATE_PER_HOUR: '3',
    WHOMBAT_BURROW_QUOTA_BYTES: String(1024 * 1024),
    WHOMBAT_UPLOAD_MAX_BYTES: String(1024 * 1024),
  },
});
let mara: Record<string, string> = {};

beforeAll(async () => {
  mara = { cookie: (await sessionFor(t.services, IDS.mara)).cookie };
});

async function discard(who: Record<string, string>, attachmentId: string) {
  return t.api.inject({
    method: 'DELETE',
    url: `${api.uploads.discard.base}${buildPath(api.uploads.discard.path, { burrow: BURROW, attachmentId })}`,
    headers: who,
  });
}

describe('upload limits under abuse', () => {
  it('reserving and discarding still counts toward the hourly rate', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await reserve(t.api, mara, { conversationId: IDS.general, name: `${i}.txt`, size: 10 });
      expect(res.statusCode).toBe(201);
      expect((await discard(mara, res.json().attachment.id)).statusCode).toBe(200);
    }
    const [{ n } = { n: 0 }] = await t.services.db
      .select({ n: sql<number>`count(*)::int` })
      .from(attachments)
      .where(sql`${attachments.uploadedById} = ${IDS.mara}`);
    expect(n).toBe(0);
    const res = await reserve(t.api, mara, { conversationId: IDS.general, name: '3.txt', size: 10 });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
  });

  it('concurrent reserves cannot go past the quota together', async () => {
    // Test setup only: Mara's reserves above are out of the hour.
    await t.services.db.update(uploadReservations).set({ createdAt: new Date(Date.now() - 2 * 3_600_000) });
    const size = 300 * 1024;
    const byMara = (i: number) =>
      reserve(t.api, mara, { conversationId: IDS.general, name: `big-${i}.bin`, size }).then(
        (r) => r.statusCode,
      );
    const byDusty = (i: number) =>
      t.services.pipeline
        .commit(
          reserveUpload,
          { conversationId: IDS.general, name: `big-${i}.bin`, size },
          { burrowId: t.burrowId, actorId: IDS.dusty },
        )
        .then(
          () => 201,
          (err: { status?: number }) => err.status ?? 500,
        );
    const results = await Promise.all([byMara(0), byDusty(1), byMara(2), byDusty(3), byMara(4)]);
    const codes = results.sort();
    // 3 × 300 KB fit in 1 MB; a fourth would not.
    expect(codes).toEqual([201, 201, 201, 413, 413]);
    const [{ bytes } = { bytes: 0 }] = await t.services.db
      .select({ bytes: sql<number>`coalesce(sum(${attachments.size}), 0)::int` })
      .from(attachments);
    expect(bytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it('the sweep prunes reservation records once they are out of the rate window', async () => {
    await t.services.db.update(uploadReservations).set({ createdAt: new Date(Date.now() - 3 * 3_600_000) });
    await t.services.files.sweep();
    const [{ n } = { n: 0 }] = await t.services.db
      .select({ n: sql<number>`count(*)::int` })
      .from(uploadReservations);
    expect(n).toBe(0);
  });
});
