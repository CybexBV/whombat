/**
 * A 1Password vault kept in step with the Vault (docs/decisions/onepassword-sync.md), against a real Postgres and an
 * in-memory 1Password (`testing/fake.ts`). Needs Postgres: every change a pass makes goes through the commit pipeline
 * as the person (the write lock, the Vault's own helpers, signed events), the links and state live in their tables
 * with their constraints (one link per entry and per item, cascades), and the connection, Home's Inbox and backups read
 * them back.
 */
import { api, ONEPASSWORD_WORDS } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  catalogConnections,
  events,
  vaultEntries,
  vaultOnePasswordLinks,
  vaultOnePasswordState,
} from '../../db/schema/index';
import { IDS } from '../../seed/test-world';
import type { Logger } from '../../services';
import { useTestServer } from '../../test/harness';
import { useVaultWorld } from '../testing/world';
import { onePasswordNeedsYou } from './inbox';
import { runOnePasswordPass } from './pass';
import { forgetOnePasswordBases, relinkOnePassword } from './restore';
import { onePasswordSyncFor, useOnePasswordForTests } from './sync';
import { FakeOnePassword } from './testing/fake';

const t = useTestServer({ seed: true, app: true });
const w = useVaultWorld(t);

const TOKEN = 'ops_eyJzaWduSW5BZGRyZXNzIjoibXkuMXBhc3N3b3JkLmNvbSJ9Wq7Yt2Kp9';
const READ_ONLY_TOKEN = 'ops_eyJyZWFkT25seSI6dHJ1ZX0Rk3Lm8Np2Qs4Tu6Vw';
const BURROW = 'bur_burrow-hq';

let fake: FakeOnePassword;
let vaultId = '';
let otherVaultId = '';
/** Everything the services log, to look for values. */
const logged: string[] = [];

beforeAll(() => {
  const real = t.services.log;
  const capture = (level: keyof Logger) => (obj: unknown, msg?: string) => {
    logged.push(`${msg ?? ''} ${JSON.stringify(obj)}`);
    if (level === 'error') real.error(obj, msg);
  };
  t.services.log = {
    info: capture('info'),
    warn: capture('warn'),
    error: capture('error'),
    debug: capture('debug'),
  };
});

afterAll(async () => {
  await onePasswordSyncFor(t.services).close();
});

/** A fresh 1Password and a Vault without entries or a 1Password connection. */
async function reset(): Promise<void> {
  await onePasswordSyncFor(t.services)
    .runNow()
    .catch(() => {});
  fake = new FakeOnePassword();
  vaultId = fake.addVault('Whombat');
  otherVaultId = fake.addVault('Family');
  fake.addToken(TOKEN, [vaultId]);
  fake.addToken(READ_ONLY_TOKEN, [vaultId], { readOnly: true });
  useOnePasswordForTests(t.services, fake);
  await t.services.db
    .delete(catalogConnections)
    .where(and(eq(catalogConnections.burrowId, BURROW), eq(catalogConnections.catalogId, 'onepassword')));
  await t.services.db.delete(vaultEntries).where(eq(vaultEntries.burrowId, BURROW));
}

const sync = () => onePasswordSyncFor(t.services).runNow();

async function addLogin(
  name: string,
  username: string,
  secret: string,
  url = 'https://public.example/login',
) {
  const res = await w.call(
    api.vault.create,
    {},
    { kind: 'login', name, url, auth: { type: 'form', username }, secret },
  );
  expect(res.status, res.raw).toBeLessThan(300);
  return (res.body.entry as { id: string }).id;
}

async function addToken(name: string, secret: string, url = 'https://public.example/api') {
  const res = await w.call(
    api.vault.create,
    {},
    { kind: 'http', name, url, auth: { type: 'bearer' }, secret },
  );
  expect(res.status, res.raw).toBeLessThan(300);
  return (res.body.entry as { id: string }).id;
}

async function connect(entries: 'put' | 'keep' = 'put', token = TOKEN) {
  const res = await w.call(
    api.connections.create,
    {},
    { catalogId: 'onepassword', signIn: 'token', secret: token, fields: { vault: vaultId, entries } },
  );
  expect(res.status, res.raw).toBeLessThan(300);
  const id = (res.body.connection as { id: string }).id;
  // The pass the connection asked for at once, and one more of our own.
  await sync();
  return id;
}

async function entry(id: string) {
  const [row] = await t.services.db.select().from(vaultEntries).where(eq(vaultEntries.id, id));
  return row;
}

async function entryByName(name: string) {
  const [row] = await t.services.db
    .select()
    .from(vaultEntries)
    .where(and(eq(vaultEntries.burrowId, BURROW), eq(vaultEntries.name, name)));
  return row;
}

async function links(connectionId: string) {
  return t.services.db
    .select()
    .from(vaultOnePasswordLinks)
    .where(eq(vaultOnePasswordLinks.connectionId, connectionId));
}

async function linkOf(entryId: string) {
  const [row] = await t.services.db
    .select()
    .from(vaultOnePasswordLinks)
    .where(eq(vaultOnePasswordLinks.entryId, entryId));
  return row;
}

async function state(connectionId: string) {
  const [row] = await t.services.db
    .select()
    .from(vaultOnePasswordState)
    .where(eq(vaultOnePasswordState.connectionId, connectionId));
  return row;
}

async function secretOf(entryId: string) {
  const res = await w.call(api.vault.get, { entryId });
  return res.body.entry as { source?: { state: string; problem?: string }; name: string; agentOn: boolean };
}

async function page(connectionId: string) {
  const res = await w.call(api.connections.onePassword, { connectionId });
  expect(res.status, res.raw).toBe(200);
  return res.body as Record<string, unknown> & {
    kept: number;
    pending: number;
    localOnly: number;
    notInVault: { title: string; reason: string }[];
    removals: { token: string; entries: { entryId: string }[] } | null;
    outcome: string | null;
  };
}

describe('linking (OPW-01, OPW-02)', () => {
  beforeAll(reset);

  it('signs in through the worker and offers the token’s vaults; one vault is taken, several are asked', async () => {
    const two = 'ops_two-vaults-token-0123456789abcdefABCDEF';
    fake.addToken(two, [vaultId, otherVaultId]);
    const asked = await w.call(
      api.connections.create,
      {},
      { catalogId: 'onepassword', signIn: 'token', secret: two, fields: {} },
    );
    expect(asked.status).toBe(409);
    expect(asked.body).toMatchObject({ error: { details: { code: 'field_choice_needed', field: 'vault' } } });
    const options = (asked.body.error as { details: { options: { value: string; label: string }[] } }).details
      .options;
    expect(options.map((o) => o.label).sort()).toEqual(['Family', 'Whombat']);
    const refused = await w.call(
      api.connections.create,
      {},
      {
        catalogId: 'onepassword',
        signIn: 'token',
        secret: 'ops_not-a-token-anyone-made-0000000',
        fields: {},
      },
    );
    expect(refused.status).toBe(409);
    expect(fake.count('check')).toBe(2);
  });

  it('keeps the entries only in Whombat when asked, and brings the vault’s items in', async () => {
    const own = await addLogin('Bank', 'mara', 'hunter2-bank');
    fake.addLogin(vaultId, {
      title: 'Mail',
      url: 'https://public.example/mail',
      username: 'mara',
      password: 'mail-pass-1',
    });
    const connectionId = await connect('keep');
    expect((await linkOf(own))?.state).toBe('local_only');
    expect(fake.count('create')).toBe(0);
    const mail = await entryByName('Mail');
    expect(mail).toBeDefined();
    // Switched on for the assistant at once (OPW-25).
    expect(mail?.agentOnAt).not.toBeNull();
    expect((await secretOf(own)).source).toBeUndefined();
    expect((await secretOf(mail?.id as string)).source).toMatchObject({
      kind: 'onepassword',
      state: 'synced',
    });
    const view = await page(connectionId);
    expect(view).toMatchObject({
      vaultTitle: 'Whombat',
      kept: 1,
      pending: 0,
      localOnly: 1,
      outcome: 'ok',
      // The apps read again while it is true: it ends with the pass.
      syncing: false,
    });
    // Its row: the vault as its place, and set to manage it (never “Look only”).
    const list = await w.call(api.connections.list, {});
    const row = (list.body.connections as { id: string; detail: string | null; access: string }[]).find(
      (c) => c.id === connectionId,
    );
    expect(row).toMatchObject({ detail: 'Whombat', access: 'manage' });
  });

  it('refuses a second 1Password connection', async () => {
    const again = await w.call(
      api.connections.create,
      {},
      { catalogId: 'onepassword', signIn: 'token', secret: TOKEN, fields: { vault: vaultId } },
    );
    expect(again.status).toBe(409);
  });

  it('disconnecting keeps the entries by default and changes nothing in 1Password', async () => {
    const [conn] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(and(eq(catalogConnections.burrowId, BURROW), eq(catalogConnections.catalogId, 'onepassword')));
    const before = fake.calls.length;
    const res = await w.call(api.connections.disconnect, { connectionId: conn?.id as string });
    expect(res.status, res.raw).toBe(200);
    expect(await entryByName('Mail')).toBeDefined();
    expect(await entryByName('Bank')).toBeDefined();
    expect(fake.calls.length).toBe(before);
  });

  it('linking the vault again pairs what is already there instead of making it twice', async () => {
    await connect('put');
    await sync();
    expect(fake.items(vaultId).filter((i) => i.title === 'Mail')).toHaveLength(1);
    expect(fake.items(vaultId).filter((i) => i.title === 'Bank')).toHaveLength(1);
    const mails = await t.services.db
      .select()
      .from(vaultEntries)
      .where(and(eq(vaultEntries.burrowId, BURROW), eq(vaultEntries.name, 'Mail')));
    expect(mails).toHaveLength(1);
    expect((await linkOf(mails[0]?.id as string))?.state).toBe('synced');
    expect((await linkOf(mails[0]?.id as string))?.base).not.toBeNull();
  });
});

describe('pushing and pulling (OPW-20…OPW-23)', () => {
  let connectionId = '';
  let bank = '';
  let api1 = '';

  beforeAll(async () => {
    await reset();
    bank = await addLogin('Bank', 'mara', 'hunter2-bank');
    api1 = await addToken('Weather API', 'weather-key-1');
    connectionId = await connect('put');
  });

  it('puts the entries already there into the vault, each with its marker', async () => {
    const items = fake.items(vaultId);
    expect(items).toHaveLength(2);
    const login = items.find((i) => i.category === 'Login');
    expect(login?.fields.find((f) => f.id === 'whombatentry')?.value).toBe(bank);
    expect(login?.fields.find((f) => f.id === 'password')?.value).toBe('hunter2-bank');
    const cred = items.find((i) => i.category === 'ApiCredentials');
    expect(cred?.fields.find((f) => f.id === 'credential')?.value).toBe('weather-key-1');
    expect((await linkOf(bank))?.state).toBe('synced');
    expect((await page(connectionId)).kept).toBe(2);
  });

  it('a pass with nothing changed reads only the vault’s version', async () => {
    fake.calls = [];
    await sync();
    expect(fake.calls).toEqual(['overview']);
  });

  it('pulls a password changed in 1Password', async () => {
    const itemId = (await linkOf(bank))?.itemId as string;
    fake.edit(itemId, (i) => {
      const f = i.fields.find((x) => x.id === 'password');
      if (f) f.value = 'changed-in-1password';
    });
    await sync();
    const row = await entry(bank);
    expect(t.services.custody.open(`vault:${bank}:secret`, row?.sealed as string)).toBe(
      'changed-in-1password',
    );
    // Its own change didn't come back as one from Whombat.
    fake.calls = [];
    await sync();
    expect(fake.count('put')).toBe(0);
  });

  it('pushes a password changed in Whombat, keeping what only 1Password holds', async () => {
    const itemId = (await linkOf(bank))?.itemId as string;
    fake.edit(itemId, (i) => {
      i.fields.push({ id: 'pin', title: 'PIN', sectionId: 'extra', fieldType: 'Concealed', value: '4321' });
      i.sections.push({ id: 'extra', title: 'Extra' });
      i.notes = 'Recovery codes: 9999';
    });
    await sync();
    const res = await w.call(api.vault.setSecret, { entryId: bank }, { value: 'changed-in-whombat' });
    expect(res.status, res.raw).toBeLessThan(300);
    await sync();
    expect(fake.field(itemId, 'password')).toBe('changed-in-whombat');
    expect(fake.field(itemId, 'pin')).toBe('4321');
    expect(fake.item(itemId)?.notes).toBe('Recovery codes: 9999');
  });

  it('when both changed differently, Whombat’s version wins', async () => {
    const itemId = (await linkOf(api1))?.itemId as string;
    fake.edit(itemId, (i) => {
      const f = i.fields.find((x) => x.id === 'credential');
      if (f) f.value = 'from-1password';
    });
    await w.call(api.vault.setSecret, { entryId: api1 }, { value: 'from-whombat' });
    await sync();
    expect(fake.field(itemId, 'credential')).toBe('from-whombat');
    const row = await entry(api1);
    expect(t.services.custody.open(`vault:${api1}:secret`, row?.sealed as string)).toBe('from-whombat');
  });

  it('a put refused for a stale version reads the item again and tries once more', async () => {
    const itemId = (await linkOf(bank))?.itemId as string;
    await w.call(api.vault.setSecret, { entryId: bank }, { value: 'second-whombat-change' });
    fake.failNext.set('put', ['failed']);
    fake.calls = [];
    await sync();
    expect(fake.count('put')).toBe(2);
    expect(fake.field(itemId, 'password')).toBe('second-whombat-change');
  });

  it('a new item becomes an entry; one that doesn’t fit is listed with why', async () => {
    fake.addApiCredential(vaultId, {
      title: 'Billing',
      hostname: 'public.example',
      credential: 'billing-key',
    });
    fake.addLogin(vaultId, { title: 'No site', username: 'mara', password: 'x-pass-1' });
    fake.addOther(vaultId, 'Server key', 'SshKey');
    fake.addOther(vaultId, 'Passport', 'Document');
    fake.addLogin(vaultId, {
      title: 'Metadata',
      url: 'https://meta.home.test/',
      username: 'mara',
      password: 'meta-pass-1',
    });
    await sync();
    const billing = await entryByName('Billing');
    expect(billing?.kind).toBe('http');
    expect(billing?.url).toBe('https://public.example');
    expect(billing?.auth).toEqual({ type: 'bearer' });
    const view = await page(connectionId);
    const why = Object.fromEntries(view.notInVault.map((n) => [n.title, n.reason]));
    expect(why).toEqual({
      'No site': 'no_website',
      'Server key': 'ssh_key',
      Passport: 'other_kind',
      Metadata: 'unreachable',
    });
    // Read once: unchanged, they aren't read again.
    fake.calls = [];
    fake.edit(fake.items(vaultId)[0]?.id as string, () => {});
    await sync();
    expect(fake.count('get')).toBe(1);
  });

  it('an entry removed in Whombat is archived in 1Password, never deleted', async () => {
    const extra = await addLogin('Shop', 'mara', 'shop-pass-1');
    await sync();
    const itemId = (await linkOf(extra))?.itemId as string;
    expect(fake.item(itemId)).toBeDefined();
    const res = await w.call(api.vault.remove, { entryId: extra });
    expect(res.status, res.raw).toBeLessThan(300);
    await sync();
    expect(fake.isArchived(itemId)).toBe(true);
    const left = await links(connectionId);
    expect(left.some((l) => l.itemId === itemId)).toBe(false);
  });

  it('an item gone from the vault removes its entry when the guard allows', async () => {
    // Four pairs kept in step now (Bank, Weather API, Billing and a fifth): one gone is a quarter or less.
    await addLogin('Fifth', 'mara', 'fifth-pass-1');
    await sync();
    const billing = await entryByName('Billing');
    const itemId = (await linkOf(billing?.id as string))?.itemId as string;
    fake.remove(itemId);
    await sync();
    expect(await entryByName('Billing')).toBeUndefined();
  });

  it('signs every change as the person with the source onepassword, and never a name, value or the token', async () => {
    const rows = await t.services.db.select().from(events).where(eq(events.burrowId, BURROW));
    const sourced = rows.filter(
      (e) => (e.payload as Record<string, unknown> | null)?.source === 'onepassword',
    );
    expect(sourced.length).toBeGreaterThan(0);
    expect(sourced.every((e) => e.actorId === IDS.mara)).toBe(true);
    const text = JSON.stringify(rows);
    for (const value of [TOKEN, 'changed-in-1password', 'from-1password', 'billing-key', 'Recovery codes'])
      expect(text).not.toContain(value);
    expect(logged.join('\n')).not.toContain(TOKEN);
    const list = await w.call(api.connections.list, {});
    expect(list.raw).not.toContain(TOKEN);
    expect(JSON.stringify(await page(connectionId))).not.toContain(TOKEN);
  });
});

describe('the guard (OPW-24)', () => {
  let connectionId = '';
  const names = ['A', 'B', 'C', 'D', 'E', 'F'];

  beforeAll(async () => {
    await reset();
    for (const n of names) await addLogin(`Login ${n}`, 'mara', `pass-${n}-123`);
    connectionId = await connect('put');
  });

  it('pauses when more than three items are gone, and asks in the Inbox', async () => {
    const all = fake.items(vaultId);
    for (const item of all.slice(0, 4)) fake.remove(item.id);
    await sync();
    for (const n of names) expect(await entryByName(`Login ${n}`)).toBeDefined();
    const view = await page(connectionId);
    expect(view.outcome).toBe('paused');
    expect(view.removals?.entries).toHaveLength(4);
    const items = await onePasswordNeedsYou({
      db: t.services.db,
      burrowId: BURROW,
      personId: IDS.mara,
      now: new Date(),
      services: t.services,
    });
    const card = items.find((i) => i.id.endsWith(':removals'));
    expect(card?.title).toBe('1Password says 4 items are gone');
    expect(card?.actions.map((a) => [a.kind, a.removals?.answer])).toEqual([
      ['onepassword_removals', 'remove'],
      ['onepassword_removals', 'keep'],
    ]);
    const home = await w.call(api.home.overview, {});
    expect(home.status, home.raw).toBe(200);
    const listed = (home.body.needsYou as { id: string; ref: unknown }[]).find((i) => i.id === card?.id);
    expect(listed?.ref).toEqual({ kind: 'connection', id: connectionId });
    expect((home.body.summary as { needsYou: number }).needsYou).toBeGreaterThan(0);
    const head = await w.call(api.things.page, { thing: `connection:${connectionId}` });
    expect(head.body).toMatchObject({ status: 'warn', badge: '1Password says 4 items are gone' });
    // The same set the next pass: the same token.
    const token = view.removals?.token;
    await sync();
    expect((await page(connectionId)).removals?.token).toBe(token);
  });

  it('refuses an answer to a set the person didn’t see', async () => {
    const res = await w.call(
      api.connections.onePasswordRemovals,
      { connectionId },
      { answer: 'remove', token: 'not-the-token' },
    );
    expect(res.status).toBe(409);
  });

  it('“Keep them here” keeps them only in Whombat, never pushed back', async () => {
    const view = await page(connectionId);
    const kept = view.removals?.entries.slice(0) ?? [];
    const res = await w.call(
      api.connections.onePasswordRemovals,
      { connectionId },
      { answer: 'keep', token: view.removals?.token },
    );
    expect(res.status, res.raw).toBe(200);
    expect((res.body as { removals: unknown }).removals).toBeNull();
    for (const k of kept) expect((await linkOf(k.entryId))?.state).toBe('local_only');
    fake.calls = [];
    await sync();
    expect(fake.count('create')).toBe(0);
    expect((await page(connectionId)).outcome).toBe('ok');
  });

  it('“Remove them here too” removes them through the Vault', async () => {
    // Two pairs left: one gone is more than a quarter of them.
    const left = fake.items(vaultId);
    expect(left).toHaveLength(2);
    fake.remove(left[0]?.id as string);
    await sync();
    const view = await page(connectionId);
    expect(view.removals?.entries).toHaveLength(1);
    const gone = view.removals?.entries[0]?.entryId as string;
    const res = await w.call(
      api.connections.onePasswordRemovals,
      { connectionId },
      { answer: 'remove', token: view.removals?.token },
    );
    expect(res.status, res.raw).toBe(200);
    expect(await entry(gone)).toBeUndefined();
  });

  it('an error while reading pauses removals', async () => {
    const left = fake.items(vaultId);
    fake.edit(left[0]?.id as string, () => {});
    // Nothing gone: no question, whatever the error.
    fake.failNext.set('get', ['failed']);
    await sync();
    expect((await page(connectionId)).removals).toBeNull();
  });
});

describe('when things go wrong', () => {
  let connectionId = '';

  beforeAll(async () => {
    await reset();
    await addLogin('Bank', 'mara', 'hunter2-bank');
    connectionId = await connect('put');
  });

  it('a create whose answer was lost is found by its marker, not made twice', async () => {
    const shop = await addLogin('Shop', 'mara', 'shop-pass-1');
    fake.loseCreates = 1;
    await sync();
    expect((await linkOf(shop))?.state).toBe('creating');
    expect((await secretOf(shop)).source?.state).toBe('pending');
    await sync();
    expect((await linkOf(shop))?.state).toBe('synced');
    expect(fake.items(vaultId).filter((i) => i.title === 'Shop')).toHaveLength(1);
  });

  it('1Password’s limit makes the passes wait, kept with the state', async () => {
    fake.failNext.set('overview', ['limit']);
    await sync();
    const s = await state(connectionId);
    expect(s?.outcome).toBe('waiting');
    expect(s?.limitHits).toBe(1);
    const wait = (s?.nextTryAt?.getTime() ?? 0) - Date.now();
    expect(wait).toBeGreaterThan(13 * 60_000);
    expect(wait).toBeLessThanOrEqual(15 * 60_000);
    fake.calls = [];
    const outcome = await runOnePasswordPass(t.services, connectionId, { api: fake });
    expect(outcome).toEqual({ ran: false, why: 'waiting' });
    expect(fake.calls).toEqual([]);
    const items = await onePasswordNeedsYou({
      db: t.services.db,
      burrowId: BURROW,
      personId: IDS.mara,
      now: new Date(),
    });
    // Its check starts off (OPW-51): nothing in the Inbox.
    expect(items.some((i) => i.id.endsWith(':limit'))).toBe(false);
    await t.services.db
      .update(vaultOnePasswordState)
      .set({ nextTryAt: new Date(Date.now() - 1000) })
      .where(eq(vaultOnePasswordState.connectionId, connectionId));
    await sync();
    expect((await state(connectionId))?.outcome).toBe('ok');
    expect((await state(connectionId))?.limitHits).toBe(0);
  });

  it('a pass that can’t reach 1Password says so, in the Inbox too', async () => {
    fake.failNext.set('overview', ['network']);
    await sync();
    expect((await page(connectionId)).problem).toBe(ONEPASSWORD_WORDS.unreachable);
    const head = await w.call(api.things.page, { thing: `connection:${connectionId}` });
    expect(head.status, head.raw).toBe(200);
    expect(head.body).toMatchObject({ status: 'bad', problem: ONEPASSWORD_WORDS.unreachable });
    const items = await onePasswordNeedsYou({
      db: t.services.db,
      burrowId: BURROW,
      personId: IDS.mara,
      now: new Date(),
    });
    expect(items.map((i) => i.title)).toContain('Whombat can’t reach 1Password');
    await sync();
    expect((await page(connectionId)).outcome).toBe('ok');
  });

  it('an item that stops fitting leaves its entry as it was, with the reason', async () => {
    const bank = (await entryByName('Bank'))?.id as string;
    const itemId = (await linkOf(bank))?.itemId as string;
    fake.edit(itemId, (i) => {
      i.websites = [];
    });
    await sync();
    expect((await entry(bank))?.url).toBe('https://public.example/login');
    const link = await linkOf(bank);
    expect(link?.problem).toBe('1Password’s item has no website now');
    expect(link?.base).not.toBeNull();
    expect((await secretOf(bank)).source).toMatchObject({ state: 'problem' });
    fake.edit(itemId, (i) => {
      i.websites = [
        { url: 'https://public.example/login', label: 'website', autofillBehavior: 'AnywhereOnWebsite' },
      ];
    });
    await sync();
    expect((await linkOf(bank))?.problem).toBeNull();
  });

  it('an entry that stops fitting stops following; its item stays', async () => {
    const api1 = await addToken('Header API', 'header-key-1');
    await sync();
    const itemId = (await linkOf(api1))?.itemId as string;
    const res = await w.call(
      api.vault.update,
      { entryId: api1 },
      { auth: { type: 'header', name: 'X-Key' } },
    );
    expect(res.status, res.raw).toBeLessThan(300);
    await sync();
    const link = await linkOf(api1);
    expect(link?.state).toBe('local_only');
    expect(link?.problem).toBe('No longer kept in step: 1Password has no place for this sign-in.');
    expect((await secretOf(api1)).source).toMatchObject({ state: 'problem', problem: link?.problem });
    const listed = await w.call(api.vault.list, {});
    expect(
      (listed.body.entries as { id: string; source?: { state: string } }[]).find((e) => e.id === api1)?.source
        ?.state,
    ).toBe('problem');
    expect(fake.item(itemId)).toBeDefined();
    expect(fake.isArchived(itemId)).toBe(false);
  });

  it('a token that can only read is found at the first push; pulling goes on', async () => {
    await t.services.db
      .update(catalogConnections)
      .set({
        secretEnc: t.services.custody.seal(`catalog_connection:${connectionId}:secret`, READ_ONLY_TOKEN),
      })
      .where(eq(catalogConnections.id, connectionId));
    const later = await addLogin('Later', 'mara', 'later-pass-1');
    fake.addLogin(vaultId, {
      title: 'Pulled',
      url: 'https://public.example/p',
      username: 'mara',
      password: 'pulled-1',
    });
    await sync();
    const view = await page(connectionId);
    expect(view.readOnly).toBe(true);
    expect(await entryByName('Pulled')).toBeDefined();
    expect((await secretOf(later)).source).toMatchObject({
      state: 'problem',
      problem: ONEPASSWORD_WORDS.readOnly,
    });
    await t.services.db
      .update(catalogConnections)
      .set({ secretEnc: t.services.custody.seal(`catalog_connection:${connectionId}:secret`, TOKEN) })
      .where(eq(catalogConnections.id, connectionId));
    await sync();
    expect((await page(connectionId)).readOnly).toBe(false);
    expect((await linkOf(later))?.state).toBe('synced');
  });

  it('no pass runs while the Whombat is read-only or paused for maintenance', async () => {
    const services = t.services as { schemaAccess: 'read-write' | 'read-only' };
    services.schemaAccess = 'read-only';
    fake.calls = [];
    try {
      await sync();
    } finally {
      services.schemaAccess = 'read-write';
    }
    t.services.maintenance.quarantined = true;
    try {
      await sync();
    } finally {
      t.services.maintenance.quarantined = false;
    }
    expect(fake.calls).toEqual([]);
    const res = await w.call(api.connections.onePasswordSync, { connectionId }, {});
    expect(res.status, res.raw).toBe(200);
    expect((res.body as { syncing: boolean }).syncing).toBe(true);
  });
});

describe('backups (OPW-42)', () => {
  let connectionId = '';
  let bank = '';

  beforeAll(async () => {
    await reset();
    bank = await addLogin('Bank', 'mara', 'hunter2-bank');
    connectionId = await connect('put');
  });

  it('a restored entry relinked without a base takes 1Password’s newer version', async () => {
    const itemId = (await linkOf(bank))?.itemId as string;
    fake.edit(itemId, (i) => {
      const f = i.fields.find((x) => x.id === 'password');
      if (f) f.value = 'newer-in-1password';
    });
    // The backup's older password comes back over the entry, which is paired with its item again without a base.
    await t.services.db
      .update(vaultEntries)
      .set({
        sealed: t.services.custody.seal(`vault:${bank}:secret`, 'old-from-backup'),
        updatedAt: new Date(),
      })
      .where(eq(vaultEntries.id, bank));
    await relinkOnePassword(t.services.db, BURROW, bank, itemId);
    expect((await linkOf(bank))?.base).toBeNull();
    await sync();
    const row = await entry(bank);
    expect(t.services.custody.open(`vault:${bank}:secret`, row?.sealed as string)).toBe('newer-in-1password');
    expect(fake.field(itemId, 'password')).toBe('newer-in-1password');
    expect((await linkOf(bank))?.base).not.toBeNull();
  });

  it('a whole-box restore forgets every base: 1Password wins at the next pass', async () => {
    const itemId = (await linkOf(bank))?.itemId as string;
    // The restored database's entry is older than the item.
    await t.services.db
      .update(vaultEntries)
      .set({ sealed: t.services.custody.seal(`vault:${bank}:secret`, 'older-restored') })
      .where(eq(vaultEntries.id, bank));
    await forgetOnePasswordBases(t.services);
    await sync();
    const row = await entry(bank);
    expect(t.services.custody.open(`vault:${bank}:secret`, row?.sealed as string)).toBe('newer-in-1password');
    expect(fake.field(itemId, 'password')).toBe('newer-in-1password');
  });

  it('a restored pair whose item is gone becomes a Whombat entry like any other', async () => {
    const lone = await addLogin('Lone', 'mara', 'lone-pass-1');
    await t.services.db.delete(vaultOnePasswordLinks).where(eq(vaultOnePasswordLinks.entryId, lone));
    await relinkOnePassword(t.services.db, BURROW, lone, 'gonegonegonegonegonegone01');
    await sync();
    // Not removed: put in as a new item instead.
    expect(await entry(lone)).toBeDefined();
    await sync();
    expect((await linkOf(lone))?.state).toBe('synced');
    expect((await linkOf(lone))?.itemId).not.toBe('gonegonegonegonegonegone01');
  });

  it('disconnecting with “Remove them too” removes the entries kept in step', async () => {
    const res = await w.call(api.connections.disconnect, { connectionId }, undefined, 'mara', {
      vaultEntries: 'remove',
    });
    expect(res.status, res.raw).toBe(200);
    expect(await entry(bank)).toBeUndefined();
    expect(fake.items(vaultId).length).toBeGreaterThan(0);
  });
});
