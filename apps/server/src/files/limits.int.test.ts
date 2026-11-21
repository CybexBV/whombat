/** Upload limits (docs/decisions/bp-attachments.md BP-A04): per-account rate and per-burrow storage quota. */
import { beforeAll, describe, expect, it } from 'vitest';
import { uploadReservations } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { reserve } from '../test/files';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';

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
let maraPhone: Record<string, string> = {};

beforeAll(async () => {
  mara = { cookie: (await sessionFor(t.services, IDS.mara)).cookie };
  maraPhone = { authorization: (await sessionFor(t.services, IDS.mara)).bearer };
});

describe('upload limits', () => {
  it('an account gets a limited number of uploads an hour, on every device', async () => {
    for (let i = 0; i < 2; i++)
      expect(
        (await reserve(t.api, mara, { conversationId: IDS.general, name: `${i}.txt`, size: 10 })).statusCode,
      ).toBe(201);
    expect(
      (await reserve(t.api, maraPhone, { conversationId: IDS.general, name: '2.txt', size: 10 })).statusCode,
    ).toBe(201);
    const res = await reserve(t.api, mara, { conversationId: IDS.general, name: '3.txt', size: 10 });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatchObject({
      code: 'rate_limited',
      message: 'You’ve uploaded a lot of files in the last hour. Try again in a few minutes.',
    });
  });

  it('a burrow cannot store more than its quota', async () => {
    // Test setup only: Mara's reserves above are out of the hour.
    await t.services.db.update(uploadReservations).set({ createdAt: new Date(Date.now() - 2 * 3_600_000) });
    expect(
      (await reserve(t.api, mara, { conversationId: IDS.general, name: 'a.bin', size: 600 * 1024 }))
        .statusCode,
    ).toBe(201);
    const res = await reserve(t.api, mara, { conversationId: IDS.general, name: 'b.bin', size: 600 * 1024 });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatchObject({
      code: 'too_large',
      message: 'This Whombat has used all of its 1 MB for files. Ask whoever runs this Whombat to raise it.',
      details: { reason: 'quota', limit: 1024 * 1024 },
    });
  });
});
