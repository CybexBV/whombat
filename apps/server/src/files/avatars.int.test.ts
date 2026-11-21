/**
 * A person's photo end to end (docs/decisions/person-avatars.md PVA-01…PVA-12, contracts CT-265): `PUT /me/avatar` sets
 * it on the person in every burrow (`avatarUrl` in bootstrap and the member list), anyone in the burrow downloads it
 * like an image attachment and nobody else can, a replaced or removed photo's row is gone, refused photos change
 * nothing, the sweep keeps a current photo, a burrow joined later gets it, and each change is a signed event.
 */
import { AVATAR_MAX_BYTES, api, buildPath, type Person } from '@whombat/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { createBurrow } from '../commands/burrows';
import { accounts, attachments, events, principals, uploadReservations } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { BURROW, makePng } from '../test/files';
import { useTestServer } from '../test/harness';
import { accountOf, sessionFor } from '../test/tokens';
import { blobKey } from './store';

const t = useTestServer({ seed: true, app: true });
const cookie: Record<string, string> = {};

beforeAll(async () => {
  cookie.mara = (await sessionFor(t.services, IDS.mara)).cookie;
});

const setAvatar = (who: string, image: string | null) =>
  t.api.inject({ method: 'PUT', url: '/api/v1/me/avatar', headers: { cookie: who }, payload: { image } });

const get = (who: string, url: string) => t.api.inject({ method: 'GET', url, headers: { cookie: who } });

async function principal(id: string) {
  const [row] = await t.services.db.select().from(principals).where(eq(principals.id, id));
  return row;
}

async function photoEvents(principalId: string) {
  return t.services.db
    .select()
    .from(events)
    .where(and(eq(events.type, 'member.updated'), eq(events.actorId, principalId)))
    .orderBy(desc(events.createdAt));
}

const maraPng = makePng(256, 256, [40, 120, 200]);

describe('PUT /me/avatar', () => {
  it('refuses callers without a session, and photos that aren’t a small JPEG, PNG or WebP', async () => {
    const anonymous = await t.api.inject({
      method: 'PUT',
      url: '/api/v1/me/avatar',
      payload: { image: null },
    });
    expect(anonymous.statusCode).toBe(401);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const refused = await setAvatar(cookie.mara as string, svg.toString('base64'));
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatchObject({
      code: 'bad_request',
      message: 'Choose a JPEG, PNG or WebP photo.',
      details: { reason: 'type' },
    });
    const garbage = await setAvatar(
      cookie.mara as string,
      Buffer.from('not a photo at all').toString('base64'),
    );
    expect(garbage.json().error.details).toEqual({ reason: 'type' });
    expect((await setAvatar(cookie.mara as string, 'not base64!')).statusCode).toBe(400);
    // Just over the limit decoded (the contract's length cap lets this through), and far over (the cap refuses).
    const big = Buffer.concat([makePng(64, 64), Buffer.alloc(AVATAR_MAX_BYTES)]).subarray(
      0,
      AVATAR_MAX_BYTES + 1,
    );
    const tooBig = await setAvatar(cookie.mara as string, big.toString('base64'));
    expect(tooBig.json().error).toMatchObject({ details: { reason: 'too_big' } });
    expect((await setAvatar(cookie.mara as string, 'A'.repeat(60_000))).statusCode).toBe(400);
    const small = await setAvatar(cookie.mara as string, makePng(16, 16).toString('base64'));
    expect(small.json().error).toMatchObject({
      message: 'That photo is too small. Choose one at least 32 × 32 pixels.',
      details: { reason: 'too_small' },
    });
    const row = await principal(IDS.mara);
    expect(row?.avatarAttachmentId).toBeNull();
    expect(await photoEvents(IDS.mara)).toHaveLength(0);
  });

  let url = '';

  it('sets the photo on the person: the response, bootstrap and the member list carry its URL', async () => {
    const res = await setAvatar(cookie.mara as string, maraPng.toString('base64'));
    expect(res.statusCode).toBe(200);
    const [person] = res.json().people as Person[];
    url = person?.avatarUrl ?? '';
    expect(url).toMatch(/^\/api\/v1\/burrows\/burrow-hq\/attachments\/att_/);
    const boot = await get(
      cookie.mara as string,
      `${api.conversations.bootstrap.base}${buildPath(api.conversations.bootstrap.path, { burrow: BURROW })}`,
    );
    const mara = (boot.json().principals as Person[]).find((p) => p.id === IDS.mara);
    expect(mara?.avatarUrl).toBe(url);
    expect(boot.json().me.avatarUrl).toBe(url);
    const [row] = await t.services.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, url.split('/').pop() as string));
    expect(row).toMatchObject({
      conversationId: null,
      messageId: null,
      state: 'ready',
      kind: 'image',
      name: 'photo.png',
      contentType: 'image/png',
      width: 256,
      height: 256,
      uploadedById: IDS.mara,
    });
  });

  it('signs the change with ids and the hash, never the bytes', async () => {
    const [event] = await photoEvents(IDS.mara);
    expect(event?.text).toBe('Changed their photo');
    const payload = event?.payload as { avatar: { attachmentId: string; sha256: string } };
    expect(payload.avatar.attachmentId).toBe(url.split('/').pop());
    expect(payload.avatar.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(event?.payload)).not.toContain(maraPng.toString('base64').slice(0, 40));
  });

  it('downloads like an image attachment, and nobody can discard it as an upload', async () => {
    const dl = await get(cookie.mara as string, url);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('image/png');
    expect(dl.rawPayload.equals(maraPng)).toBe(true);
    const discard = await t.api.inject({
      method: 'DELETE',
      url: `${api.uploads.discard.base}${buildPath(api.uploads.discard.path, {
        burrow: BURROW,
        attachmentId: url.split('/').pop() as string,
      })}`,
      headers: { cookie: cookie.mara as string },
    });
    expect(discard.statusCode).toBe(404);
    expect((await get(cookie.mara as string, url)).statusCode).toBe(200);
  });

  it('the same photo again changes nothing and signs nothing', async () => {
    const before = (await photoEvents(IDS.mara)).length;
    const res = await setAvatar(cookie.mara as string, maraPng.toString('base64'));
    expect(res.statusCode).toBe(200);
    expect(res.json().people[0].avatarUrl).toBe(url);
    expect(await photoEvents(IDS.mara)).toHaveLength(before);
  });

  it('the sweep keeps a current photo however old it is', async () => {
    const id = url.split('/').pop() as string;
    await t.services.db
      .update(attachments)
      .set({ createdAt: new Date(Date.now() - 90 * 86_400_000) })
      .where(eq(attachments.id, id));
    await t.services.files.sweep();
    const [row] = await t.services.db.select().from(attachments).where(eq(attachments.id, id));
    expect(row?.state).toBe('ready');
    expect((await get(cookie.mara as string, url)).statusCode).toBe(200);
  });

  let moss = { burrowId: '', mara: '' };

  it('a burrow made later gets the account’s photo', async () => {
    const created = await createBurrow(t.services, await accountOf(t.services, IDS.mara), 'Moss Co', {
      besideOwn: true,
    });
    moss = { burrowId: created.burrowId, mara: created.principalId };
    const row = await principal(moss.mara);
    expect(row?.avatarUrl).toMatch(/^\/api\/v1\/burrows\/moss-co\/attachments\/att_/);
    expect(row?.avatarUrl).not.toBe(url);
    const mossMara = (await sessionFor(t.services, moss.mara)).cookie;
    const dl = await get(mossMara, row?.avatarUrl as string);
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(maraPng)).toBe(true);
    // And another.
    const fern = await createBurrow(t.services, await accountOf(t.services, IDS.mara), 'Fern Ltd', {
      besideOwn: true,
    });
    expect((await principal(fern.principalId))?.avatarUrl).toMatch(
      /^\/api\/v1\/burrows\/fern-ltd\/attachments\//,
    );
  });

  it('a new photo replaces the old one everywhere: new URLs, the old rows and bytes gone', async () => {
    const oldIds = [
      (await principal(IDS.mara))?.avatarAttachmentId,
      (await principal(moss.mara))?.avatarAttachmentId,
    ];
    const oldKey = blobKey(
      ((await t.services.db.select().from(accounts).where(eq(accounts.email, 'mara@burrowhq.example')))[0]
        ?.avatar?.sha256 ?? '') as string,
    );
    const next = makePng(200, 200, [10, 200, 90]);
    const res = await setAvatar(cookie.mara as string, next.toString('base64'));
    expect(res.statusCode).toBe(200);
    const people = res.json().people as Person[];
    expect(people).toHaveLength(3);
    for (const p of people) expect(p.avatarUrl).toMatch(/\/attachments\/att_/);
    const hq = people.find((p) => p.id === IDS.mara);
    expect(hq?.avatarUrl).not.toBe(url);
    const left = await t.services.db
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        sql`${attachments.id} in (${sql.join(
          oldIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    expect(left).toEqual([]);
    expect((await get(cookie.mara as string, url)).statusCode).toBe(404);
    const dl = await get(cookie.mara as string, hq?.avatarUrl as string);
    expect(dl.rawPayload.equals(next)).toBe(true);
    expect(await t.services.files.store.size(oldKey)).toBeNull();
    url = hq?.avatarUrl as string;
  });

  it('null removes it everywhere: initials again, rows gone, signed', async () => {
    const res = await setAvatar(cookie.mara as string, null);
    expect(res.statusCode).toBe(200);
    for (const p of res.json().people as Person[]) expect(p.avatarUrl).toBeNull();
    expect((await get(cookie.mara as string, url)).statusCode).toBe(404);
    const [event] = await photoEvents(IDS.mara);
    expect(event?.text).toBe('Removed their photo');
    expect(event?.payload).toMatchObject({ avatar: null, previousAttachmentId: url.split('/').pop() });
    const rows = await t.services.db
      .select({ id: attachments.id })
      .from(attachments)
      .where(and(eq(attachments.uploadedById, IDS.mara), sql`${attachments.conversationId} is null`));
    expect(rows).toEqual([]);
    const [account] = await t.services.db
      .select()
      .from(accounts)
      .where(eq(accounts.email, 'mara@burrowhq.example'));
    expect(account?.avatar).toBeNull();
  });

  it('at most ten changes an hour', async () => {
    const account = await accountOf(t.services, IDS.mara);
    // Test setup only: the changes above don't count against this hour.
    await t.services.db.delete(uploadReservations).where(eq(uploadReservations.rateKey, `avatar:${account}`));
    const photos = [makePng(64, 64, [1, 2, 3]), makePng(64, 64, [3, 2, 1])];
    for (let i = 0; i < 10; i++)
      expect(
        (await setAvatar(cookie.mara as string, (photos[i % 2] as Buffer).toString('base64'))).statusCode,
      ).toBe(200);
    const limited = await setAvatar(cookie.mara as string, null);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');
    // The same photo again is no change, so it isn't counted.
    expect(
      (await setAvatar(cookie.mara as string, (photos[1] as Buffer).toString('base64'))).statusCode,
    ).toBe(200);
    const counted = await t.services.db
      .select()
      .from(uploadReservations)
      .where(eq(uploadReservations.rateKey, `avatar:${account}`));
    expect(counted).toHaveLength(10);
  });
});
