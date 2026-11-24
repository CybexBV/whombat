/**
 * `/internal/dev/onepassword` (the runner's token): the stand-in 1Password of a development box (`standin.ts`), changed
 * as a person changes their vault in 1Password's app, so the Vault's sync can be tried both ways without an account
 * (`pnpm --filter @whombat/server onepassword:dev`). Not part of the public contract; answers 404 wherever the stand-in
 * isn't on, which is always in production.
 *
 * Its body names one action: `state` (the vaults and their items), `edit` an item, `add` one, `remove` some (gone from
 * the vault, as deleting them in 1Password). An item is named by its id or its title; a vault by its id or its name.
 */
import type { OnePasswordItem } from '@whombat/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../../../lib/errors';
import { requireRunner } from '../../../runtime/routes';
import type { Services } from '../../../services';
import { onePasswordSyncFor } from '../sync';
import type { FakeOnePassword } from './fake';

export const ONEPASSWORD_DEV_PATH = '/internal/dev/onepassword';

const text = z.string().max(500);
const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('state') }),
  z.object({
    action: z.literal('edit'),
    item: z.string().min(1).max(200),
    title: z.string().min(1).max(200).optional(),
    url: text.optional(),
    username: text.optional(),
    password: text.optional(),
    credential: text.optional(),
    hostname: text.optional(),
  }),
  z.object({
    action: z.literal('add'),
    vault: z.string().min(1).max(200),
    kind: z.enum(['login', 'api']),
    title: z.string().min(1).max(200),
    url: text.optional(),
    username: text.optional(),
    password: text.optional(),
    credential: text.optional(),
    hostname: text.optional(),
  }),
  z.object({ action: z.literal('remove'), items: z.array(z.string().min(1).max(200)).min(1).max(50) }),
]);
export type StandInChange = z.infer<typeof Body>;
type Body = StandInChange;

/** An item as the developer reads it: its address, username and secret, by the built-in fields. */
function shown(item: OnePasswordItem) {
  const field = (id: string) => item.fields.find((f) => f.id === id)?.value;
  const totp = item.fields.find((f) => f.fieldType === 'Totp')?.value;
  return {
    id: item.id,
    title: item.title,
    category: item.category,
    url: item.websites[0]?.url ?? field('hostname') ?? null,
    username: field('username') ?? null,
    secret: field('password') ?? field('credential') ?? null,
    ...(totp ? { totp } : {}),
    whombatEntry: item.fields.find((f) => f.id === 'whombatentry')?.value ?? null,
    version: item.version,
    updatedAt: item.updatedAt,
  };
}

function state(fake: FakeOnePassword) {
  return {
    vaults: [...fake.vaults.values()].map((v) => ({
      id: v.id,
      title: v.title,
      contentVersion: v.contentVersion,
      items: [...v.items.values()].map(shown),
      archived: [...v.archived.values()].map((i) => ({ id: i.id, title: i.title })),
    })),
  };
}

function itemOf(fake: FakeOnePassword, ref: string): OnePasswordItem {
  for (const v of fake.vaults.values())
    for (const item of v.items.values()) if (item.id === ref || item.title === ref) return item;
  throw new ApiError('not_found', `No item “${ref}” in the stand-in 1Password.`);
}

function vaultOf(fake: FakeOnePassword, ref: string): string {
  for (const v of fake.vaults.values()) if (v.id === ref || v.title === ref) return v.id;
  throw new ApiError('not_found', `No vault “${ref}” in the stand-in 1Password.`);
}

/** Sets a built-in field's value, adding the field when the item has none. */
function setField(item: OnePasswordItem, id: string, value: string, concealed = false): void {
  const found = item.fields.find((f) => f.id === id);
  if (found) found.value = value;
  else item.fields.push({ id, title: id, fieldType: concealed ? 'Concealed' : 'Text', value });
}

/** One action on the stand-in, as the route takes it. */
export function changeStandIn(fake: FakeOnePassword, body: Body) {
  switch (body.action) {
    case 'state':
      return state(fake);
    case 'edit': {
      const item = fake.edit(itemOf(fake, body.item).id, (next) => {
        if (body.title !== undefined) next.title = body.title;
        if (body.url !== undefined)
          next.websites = body.url
            ? [
                {
                  ...(next.websites[0] ?? { label: 'website', autofillBehavior: 'AnywhereOnWebsite' }),
                  url: body.url,
                },
              ]
            : [];
        if (body.username !== undefined) setField(next, 'username', body.username);
        if (body.password !== undefined) setField(next, 'password', body.password, true);
        if (body.credential !== undefined) setField(next, 'credential', body.credential, true);
        if (body.hostname !== undefined) setField(next, 'hostname', body.hostname);
      });
      return { item: shown(item) };
    }
    case 'add': {
      const vault = vaultOf(fake, body.vault);
      const item =
        body.kind === 'login'
          ? fake.addLogin(vault, {
              title: body.title,
              url: body.url ?? null,
              ...(body.username !== undefined ? { username: body.username } : {}),
              ...(body.password !== undefined ? { password: body.password } : {}),
            })
          : fake.addApiCredential(vault, {
              title: body.title,
              ...(body.hostname !== undefined ? { hostname: body.hostname } : {}),
              ...(body.username !== undefined ? { username: body.username } : {}),
              ...(body.credential !== undefined ? { credential: body.credential } : {}),
            });
      return { item: shown(item) };
    }
    case 'remove': {
      const ids = body.items.map((ref) => itemOf(fake, ref).id);
      for (const id of ids) fake.remove(id);
      return { removed: ids };
    }
  }
}

export function registerOnePasswordStandIn(app: FastifyInstance, services: Services): void {
  app.post(ONEPASSWORD_DEV_PATH, async (req: FastifyRequest, reply: FastifyReply) => {
    const standIn = onePasswordSyncFor(services).standIn;
    if (!standIn) throw new ApiError('not_found', 'No such endpoint.');
    requireRunner(services, req);
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success)
      throw new ApiError('bad_request', 'Send {"action": "state" | "edit" | "add" | "remove", …}.');
    const answer = changeStandIn(standIn.fake, parsed.data);
    standIn.save();
    return reply.send(answer);
  });
}
