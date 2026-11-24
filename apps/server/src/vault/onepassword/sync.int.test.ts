/**
 * A 1Password vault kept in step with the Vault (docs/decisions/onepassword-sync.md), against a real Postgres and an
 * in-memory 1Password (`testing/fake.ts`). Needs Postgres: every change a pass makes goes through the commit pipeline
 * as the person (the write lock, the Vault's own helpers, signed events), the links and state live in their tables
 * with their constraints (one link per entry and per item, cascades), and the connection, Home's Inbox and backups read
 * them back.
 */
import { api, ONEPASSWORD_TAB, ONEPASSWORD_WORDS } from '@whombat/core';
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
import { recordVaultUse } from '../uses';
import { applyOnePasswordOps } from './commands';
import { onePasswordNeedsYou } from './inbox';
import { ONEPASSWORD_PASS_WORDS, runOnePasswordPass } from './pass';
import { forgetOnePasswordBase, forgetOnePasswordBases, relinkOnePassword } from './restore';
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
  return res.body.entry as {
    source?: { state: string; problem?: string; paired?: boolean };
    name: string;
    agentOn: boolean;
  };
}

async function page(connectionId: string) {
  const res = await w.call(api.connections.onePassword, { connectionId });
  expect(res.status, res.raw).toBe(200);
  return res.body as Record<string, unknown> & {
    kept: number;
    pending: number;
    localOnly: number;
    notInVault: { title: string; reason: string }[];
    removals: { token: string; entries: { entryId: string; name: string }[] } | null;
    outcome: string | null;
  };
}

describe('linking', () => {
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
    // Switched on for the assistant at once.
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

  it('linking the vault again pairs what is already there instead of making it twice, and Whombat wins', async () => {
    const bank = (await entryByName('Bank'))?.id as string;
    const mailItem = fake.items(vaultId).find((i) => i.title === 'Mail')?.id as string;
    // While unlinked: Bank's password changed here, Mail's in 1Password.
    await w.call(api.vault.setSecret, { entryId: bank }, { value: 'bank-changed-here' });
    setPassword(mailItem, 'mail-changed-in-1password');
    // One pass pairs Mail with its item (it signs in as the entry does) and decides the pair at once: Whombat's values
    // go to 1Password, which keeps the old ones in the item's history. Bank, kept only here before, is put in.
    await connect('put');
    const bankItem = fake.items(vaultId).find((i) => i.title === 'Bank')?.id as string;
    expect(fake.field(bankItem, 'password')).toBe('bank-changed-here');
    expect(fake.field(mailItem, 'password')).toBe('mail-pass-1');
    expect(await passwordOf(bank)).toBe('bank-changed-here');
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

describe('pushing and pulling', () => {
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

describe('the guard', () => {
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
    // Neither answer is the recommended one: both alike, as on the page.
    expect(card?.actions.map((a) => [a.kind, a.removals?.answer, a.style])).toEqual([
      ['onepassword_removals', 'remove', 'secondary'],
      ['onepassword_removals', 'keep', 'secondary'],
    ]);
    // It names the entries: three, then how many more.
    const held = view.removals?.entries.map((e) => e.name) ?? [];
    for (const name of held.slice(0, 3)) expect(card?.body).toContain(name);
    expect(card?.body).not.toContain(held[3] as string);
    expect(card?.body).toContain('and 1 more');
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
    // Its check starts off: nothing in the Inbox.
    expect(items.some((i) => i.id.endsWith(':limit'))).toBe(false);
    await t.services.db
      .update(vaultOnePasswordState)
      .set({ nextTryAt: new Date(Date.now() - 1000) })
      .where(eq(vaultOnePasswordState.connectionId, connectionId));
    await sync();
    expect((await state(connectionId))?.outcome).toBe('ok');
    expect((await state(connectionId))?.limitHits).toBe(0);
  });

  it('passes that can’t reach 1Password say so, in the Inbox too, from the second in a row', async () => {
    fake.failNext.set('overview', ['network']);
    await sync();
    expect((await page(connectionId)).problem).toBe(ONEPASSWORD_WORDS.unreachable);
    // One alone is usually a blip: no red head, no card yet, and the tab's line isn't red either. But the head never
    // says the vault is kept in step after a pass that failed.
    expect((await page(connectionId)).failing).toBe(false);
    const calm = await w.call(api.things.page, { thing: `connection:${connectionId}` });
    expect((calm.body as { status: string }).status).not.toBe('bad');
    expect((calm.body as { badge?: string }).badge).not.toBe('Kept in step');
    const first = await onePasswordNeedsYou({
      db: t.services.db,
      burrowId: BURROW,
      personId: IDS.mara,
      now: new Date(),
    });
    expect(first.some((i) => i.id.endsWith(':failing'))).toBe(false);
    fake.failNext.set('overview', ['network']);
    await sync();
    const head = await w.call(api.things.page, { thing: `connection:${connectionId}` });
    expect(head.status, head.raw).toBe(200);
    expect(head.body).toMatchObject({
      status: 'bad',
      badge: 'Whombat can’t reach 1Password',
      problem: ONEPASSWORD_WORDS.unreachable,
    });
    // It opens on its own tab, which the apps draw; the vault is in the facts, never an address to run on.
    const shown = head.body as { tabs: { key: string; panels: unknown[] }[]; address?: string };
    expect(shown.tabs.map((t) => t.key).slice(0, 2)).toEqual([ONEPASSWORD_TAB, 'overview']);
    expect(shown.tabs[0]?.panels).toEqual([]);
    expect(shown.address).toBeUndefined();
    const items = await onePasswordNeedsYou({
      db: t.services.db,
      burrowId: BURROW,
      personId: IDS.mara,
      now: new Date(),
    });
    expect(items.map((i) => i.title)).toContain('Whombat can’t reach 1Password');
    expect((await page(connectionId)).failing).toBe(true);
    // The person's to mend: it opens 1Password and asks the assistant nothing.
    const failing = items.find((i) => i.id.endsWith(':failing'));
    expect(failing?.nature).toBe('you');
    expect(failing?.actions.map((a) => a.kind)).toEqual(['open']);
    await sync();
    expect((await page(connectionId)).outcome).toBe('ok');
    expect((await page(connectionId)).failing).toBe(false);
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
    // While it can only read, a change here asks 1Password nothing; the regular pass still tries once.
    await w.call(api.vault.setSecret, { entryId: later }, { value: 'later-pass-2' });
    fake.calls = [];
    await onePasswordSyncFor(t.services).runNow('change');
    expect(fake.calls).toEqual([]);
    await sync();
    expect(fake.count('create')).toBe(1);
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

describe('backups', () => {
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
    // A change 1Password refused before the backup isn't what is waiting now.
    await t.services.db
      .update(vaultOnePasswordLinks)
      .set({ refused: (await linkOf(bank))?.base ?? null })
      .where(eq(vaultOnePasswordLinks.entryId, bank));
    await relinkOnePassword(t.services.db, BURROW, bank, itemId);
    expect((await linkOf(bank))?.base).toBeNull();
    expect((await linkOf(bank))?.refused).toBeNull();
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
    // The backup held a question for the person: it isn't one any more.
    await t.services.db
      .update(vaultOnePasswordState)
      .set({
        outcome: 'paused',
        removals: {
          token: 'old-set',
          since: new Date().toISOString(),
          entries: [{ entryId: bank, name: 'Bank' }],
        },
      })
      .where(eq(vaultOnePasswordState.connectionId, connectionId));
    await forgetOnePasswordBases(t.services);
    expect(await state(connectionId)).toMatchObject({ removals: null, outcome: null });
    await sync();
    const row = await entry(bank);
    expect(t.services.custody.open(`vault:${bank}:secret`, row?.sealed as string)).toBe('newer-in-1password');
    expect(fake.field(itemId, 'password')).toBe('newer-in-1password');
  });

  it('a file restored over a paired entry gives 1Password’s value back at the next pass', async () => {
    const itemId = await itemOf(bank);
    setPassword(itemId, 'newest-in-1password');
    // The file's older password replaces the entry's, and the file named no item.
    await t.services.db
      .update(vaultEntries)
      .set({
        sealed: t.services.custody.seal(`vault:${bank}:secret`, 'from-the-file'),
        updatedAt: new Date(),
      })
      .where(eq(vaultEntries.id, bank));
    await forgetOnePasswordBase(t.services.db, bank);
    await sync();
    expect(await passwordOf(bank)).toBe('newest-in-1password');
    expect(fake.field(itemId, 'password')).toBe('newest-in-1password');
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
    // One whose item 1Password hasn't been given yet is in no other place: it stays.
    const waiting = await addLogin('Waiting', 'mara', 'waiting-pass-1');
    fake.failNext.set('create', ['network']);
    await sync();
    expect((await linkOf(waiting))?.state).toBe('creating');
    const res = await w.call(api.connections.disconnect, { connectionId }, undefined, 'mara', {
      vaultEntries: 'remove',
    });
    expect(res.status, res.raw).toBe(200);
    expect(await entry(bank)).toBeUndefined();
    expect(await entry(waiting)).toBeDefined();
    expect(fake.items(vaultId).length).toBeGreaterThan(0);
  });
});

/** The pair of an entry kept in step: its item's id. */
async function itemOf(entryId: string): Promise<string> {
  const link = await linkOf(entryId);
  expect(link?.itemId).toBeTruthy();
  return link?.itemId as string;
}

function setPassword(itemId: string, value: string) {
  fake.edit(itemId, (i) => {
    const f = i.fields.find((x) => x.id === 'password');
    if (f) f.value = value;
  });
}

const passwordOf = async (entryId: string) =>
  t.services.custody.open(`vault:${entryId}:secret`, (await entry(entryId))?.sealed as string);

describe('restoring while work waits', () => {
  let connectionId = '';

  beforeAll(async () => {
    await reset();
    await addLogin('Bank', 'mara', 'hunter2-bank');
    connectionId = await connect('put');
  });

  it('a whole-box restore drops the backup’s waiting archive and item being made: nothing is archived after it', async () => {
    const shop = await addLogin('Shop', 'mara', 'shop-pass-1');
    await sync();
    const shopItem = await itemOf(shop);
    // In the backup: Later's item being made, and Shop removed with its item still to be archived.
    const later = await addLogin('Later', 'mara', 'later-pass-1');
    fake.loseCreates = 1;
    await sync();
    expect((await linkOf(later))?.state).toBe('creating');
    await w.call(api.vault.remove, { entryId: shop });
    expect((await links(connectionId)).some((l) => l.entryId === null && l.itemId === shopItem)).toBe(true);
    await forgetOnePasswordBases(t.services);
    const left = await links(connectionId);
    expect(left.some((l) => l.entryId === null)).toBe(false);
    expect(left.some((l) => l.state === 'creating')).toBe(false);
    // Doing it again changes nothing.
    await forgetOnePasswordBases(t.services);
    await sync();
    expect(fake.isArchived(shopItem)).toBe(false);
    // Later's item is found by its marker, not made twice.
    expect(fake.items(vaultId).filter((i) => i.title === 'Later')).toHaveLength(1);
    expect((await linkOf(later))?.state).toBe('synced');
  });

  it('an entry brought back while its item waits to be archived takes that pair again', async () => {
    const mail = await addLogin('Mail', 'mara', 'mail-pass-1');
    await sync();
    const mailItem = await itemOf(mail);
    await w.call(api.vault.remove, { entryId: mail });
    // Brought back from a backup before the next pass archived its item.
    const back = await addLogin('Mail', 'mara', 'mail-pass-old');
    await t.services.db.delete(vaultOnePasswordLinks).where(eq(vaultOnePasswordLinks.entryId, back));
    await relinkOnePassword(t.services.db, BURROW, back, mailItem);
    const link = await linkOf(back);
    expect(link).toMatchObject({ itemId: mailItem, state: 'synced', base: null });
    const before = fake.count('create');
    await sync();
    expect(fake.isArchived(mailItem)).toBe(false);
    expect(fake.count('create')).toBe(before);
    // 1Password's version wins.
    expect(await passwordOf(back)).toBe('mail-pass-1');
  });
});

describe('disconnecting while a pass reads', () => {
  beforeAll(reset);

  it('writes nothing to 1Password once the connection is gone', async () => {
    const changed = await addLogin('Bank', 'mara', 'hunter2-bank');
    const removed = await addLogin('Shop', 'mara', 'shop-pass-1');
    const connectionId = await connect('put');
    await w.call(api.vault.setSecret, { entryId: changed }, { value: 'changed-here' });
    await w.call(api.vault.remove, { entryId: removed });
    await addLogin('New', 'mara', 'new-pass-1');
    const writes = () => fake.count('create') + fake.count('put') + fake.count('archive');
    const before = writes();
    const held = fake.pause('list');
    const running = sync();
    await held.reached;
    const res = await w.call(api.connections.disconnect, { connectionId });
    expect(res.status, res.raw).toBe(200);
    held.release();
    await running;
    expect(writes()).toBe(before);
  });
});

describe('what starts a pass', () => {
  let connectionId = '';
  let bank = '';

  beforeAll(async () => {
    await reset();
    bank = await addLogin('Bank', 'mara', 'hunter2-bank');
    connectionId = await connect('put');
    await sync();
  });

  it('a use of an entry asks 1Password nothing; a change of its password does', async () => {
    const used = await t.services.pipeline.commit(
      recordVaultUse,
      {
        entryId: bank,
        dispatchId: null,
        what: 'GET /',
        outcome: 'done',
        status: 200,
        ms: 5,
        bytes: 10,
      },
      { burrowId: BURROW, actorId: IDS.dusty },
    );
    expect(used.status).toBe('ok');
    fake.calls = [];
    await onePasswordSyncFor(t.services).runNow('change');
    expect(fake.calls).toEqual([]);
    await w.call(api.vault.setSecret, { entryId: bank }, { value: 'changed-here' });
    await onePasswordSyncFor(t.services).runNow('change');
    expect(fake.count('put')).toBe(1);
  });

  it('Sync now reads the vault in full whatever its version says', async () => {
    await sync();
    fake.calls = [];
    await sync();
    expect(fake.calls).toEqual(['overview']);
    await onePasswordSyncFor(t.services).runNow('now');
    expect(fake.calls).toContain('list');
  });

  it('a change made here while a pull waits is taken by the next pass, which reads again', async () => {
    const itemId = await itemOf(bank);
    setPassword(itemId, 'from-1password');
    const held = fake.pause('get');
    const running = sync();
    await held.reached;
    await w.call(api.vault.setSecret, { entryId: bank }, { value: 'from-whombat' });
    held.release();
    await running;
    expect(await passwordOf(bank)).toBe('from-whombat');
    expect((await state(connectionId))?.contentVersion).toBeNull();
    await sync();
    // Both changed: Whombat's wins.
    expect(fake.field(itemId, 'password')).toBe('from-whombat');
  });

  it('a change of the home networks looks again only when something is held for an address Whombat may not reach', async () => {
    await sync();
    fake.calls = [];
    await onePasswordSyncFor(t.services).runNow('network');
    expect(fake.calls).toEqual([]);
    fake.addLogin(vaultId, {
      title: 'NAS',
      url: 'https://nas.home.test/',
      username: 'mara',
      password: 'nas-pass-1',
    });
    await sync();
    expect((await page(connectionId)).notInVault.map((n) => n.reason)).toContain('unreachable');
    // Held for an address Whombat may not reach: the version is still kept (a change of the home networks reads it
    // again), so the regular pass reads nothing more.
    expect((await state(connectionId))?.contentVersion).not.toBeNull();
    fake.calls = [];
    await sync();
    expect(fake.calls).toEqual(['overview']);
    const nas = fake.items(vaultId).find((i) => i.title === 'NAS')?.id as string;
    fake.gets = [];
    await onePasswordSyncFor(t.services).runNow('network');
    expect(fake.gets).toContain(nas);
  });

  it('a pair waiting for an address Whombat may not reach is read again when the home networks change', async () => {
    const router = await addLogin('Router', 'mara', 'router-pass-1', 'https://public.example/router');
    fake.loseCreates = 1;
    await sync();
    const made = fake.items(vaultId).find((i) => i.title === 'Router')?.id as string;
    fake.edit(made, (i) => {
      i.websites = [
        { url: 'https://nas.home.test/router', label: 'website', autofillBehavior: 'AnywhereOnWebsite' },
      ];
    });
    await sync();
    expect((await linkOf(router))?.problem).toBe(ONEPASSWORD_PASS_WORDS.unreachableAddress);
    fake.gets = [];
    await onePasswordSyncFor(t.services).runNow('network');
    expect(fake.gets).toContain(made);
  });
});

describe('a read that misses items', () => {
  let connectionId = '';

  beforeAll(async () => {
    await reset();
    await addLogin('Bank', 'mara', 'hunter2-bank');
    connectionId = await connect('put');
  });

  it('makes nothing in 1Password, says it couldn’t read everything, and keeps what it listed', async () => {
    fake.addLogin(vaultId, { title: 'Passport', url: null, username: 'mara', password: 'passport-1' });
    await sync();
    const passport = fake.items(vaultId).find((i) => i.title === 'Passport')?.id as string;
    // Changed, then unreadable this time; a new entry waits to go.
    fake.edit(passport, () => {});
    fake.unreadable.add(passport);
    const shop = await addLogin('Shop', 'mara', 'shop-pass-1');
    const before = fake.count('create');
    await sync();
    expect(fake.count('create')).toBe(before);
    const view = await page(connectionId);
    expect(view.outcome).toBe('failing');
    expect(view.problem).toBe(ONEPASSWORD_PASS_WORDS.partial);
    expect(view.notInVault.map((n) => n.title)).toContain('Passport');
    expect((await state(connectionId))?.contentVersion).toBeNull();
    fake.unreadable.clear();
    await sync();
    expect((await linkOf(shop))?.state).toBe('synced');
    expect((await page(connectionId)).outcome).toBe('ok');
  });
});

describe('writing into 1Password', () => {
  let connectionId = '';

  beforeAll(async () => {
    await reset();
    await addLogin('Bank', 'mara', 'hunter2-bank');
    connectionId = await connect('put');
  });

  it('a lost create whose item 1Password rotated since takes 1Password’s password', async () => {
    const shop = await addLogin('Shop', 'mara', 'shop-pass-1');
    fake.loseCreates = 1;
    await sync();
    const made = fake.items(vaultId).find((i) => i.title === 'Shop')?.id as string;
    setPassword(made, 'rotated-in-1password');
    await sync();
    expect((await linkOf(shop))?.itemId).toBe(made);
    expect(await passwordOf(shop)).toBe('rotated-in-1password');
    expect(fake.field(made, 'password')).toBe('rotated-in-1password');
  });

  it('an entry removed before its lost create was found has that item archived, never brought back', async () => {
    const gone = await addLogin('Gone', 'mara', 'gone-pass-1');
    fake.loseCreates = 1;
    await sync();
    const made = fake.items(vaultId).find((i) => i.title === 'Gone')?.id as string;
    expect(made).toBeTruthy();
    await w.call(api.vault.remove, { entryId: gone });
    const tomb = (await links(connectionId)).find((l) => l.markerEntryId === gone);
    expect(tomb).toMatchObject({ state: 'creating', entryId: null });
    await sync();
    expect(fake.isArchived(made)).toBe(true);
    expect(await entryByName('Gone')).toBeUndefined();
    expect((await links(connectionId)).some((l) => l.markerEntryId === gone)).toBe(false);
  });

  it('a change 1Password keeps refusing waits until either side changes', async () => {
    const bank = (await entryByName('Bank'))?.id as string;
    const itemId = await itemOf(bank);
    await w.call(api.vault.setSecret, { entryId: bank }, { value: 'refused-once' });
    fake.failNext.set('put', ['invalid']);
    await sync();
    const link = await linkOf(bank);
    expect(link?.problem).toBe(ONEPASSWORD_PASS_WORDS.writeFailed);
    expect(link?.refused).not.toBeNull();
    expect((await secretOf(bank)).source).toMatchObject({ state: 'problem' });
    fake.calls = [];
    await sync();
    expect(fake.count('put')).toBe(0);
    // Sync now tries it once more, and 1Password takes it this time.
    await onePasswordSyncFor(t.services).runNow('now');
    expect(fake.count('put')).toBe(1);
    expect(fake.field(itemId, 'password')).toBe('refused-once');
    await w.call(api.vault.setSecret, { entryId: bank }, { value: 'taken-now' });
    await sync();
    expect(fake.field(itemId, 'password')).toBe('taken-now');
    expect(await linkOf(bank)).toMatchObject({ problem: null, refused: null });
  });

  it('a new entry 1Password refused isn’t sent again until it changes, or Sync now', async () => {
    const odd = await addLogin('Odd', 'mara', 'odd-pass-1');
    fake.failNext.set('create', ['invalid']);
    await sync();
    expect((await linkOf(odd))?.problem).toBe(ONEPASSWORD_PASS_WORDS.writeFailed);
    // Not waiting either: it goes again when it changes.
    expect((await page(connectionId)).pending).toBe(0);
    fake.calls = [];
    await sync();
    expect(fake.count('create')).toBe(0);
    fake.failNext.set('create', ['invalid']);
    await onePasswordSyncFor(t.services).runNow('now');
    expect(fake.count('create')).toBe(1);
    await w.call(api.vault.setSecret, { entryId: odd }, { value: 'odd-pass-2' });
    await sync();
    expect((await linkOf(odd))?.state).toBe('synced');
  });

  it('follows one one-time password field: another never takes its place, removing the key removes only it', async () => {
    const KEY_A = 'JBSWY3DPEHPK3PXP';
    const KEY_B = 'KRSXG5CTMVRXEZLU';
    const item = fake.addLogin(vaultId, {
      title: 'Two keys',
      url: 'https://public.example/two',
      username: 'mara',
      password: 'two-pass-1',
      totp: KEY_A,
      extra: [{ id: 'second', title: 'backup code', sectionId: 'add more', fieldType: 'Totp', value: KEY_B }],
    });
    await sync();
    const two = (await entryByName('Two keys'))?.id as string;
    expect((await linkOf(two))?.totpFieldId).toBe('onetimepassword');
    // The followed field removed in 1Password: the key goes here, the second field is never taken instead.
    fake.edit(item.id, (i) => {
      i.fields = i.fields.filter((f) => f.id !== 'onetimepassword');
    });
    await sync();
    expect((await entry(two))?.totpSealed).toBeNull();
    expect((await linkOf(two))?.totpFieldId).toBe('onetimepassword');
    // A key set here goes into the followed field again; the second stays as it was.
    const set = await w.call(api.vault.setTotp, { entryId: two }, { totp: KEY_A });
    expect(set.status, set.raw).toBeLessThan(300);
    await sync();
    expect(fake.field(item.id, 'onetimepassword')).toContain(KEY_A);
    expect(fake.field(item.id, 'second')).toBe(KEY_B);
    // Removing the key here removes only the followed field.
    await w.call(api.vault.setTotp, { entryId: two }, { totp: null });
    await sync();
    expect(fake.field(item.id, 'onetimepassword')).toBeUndefined();
    expect(fake.field(item.id, 'second')).toBe(KEY_B);
    expect((await entry(two))?.totpSealed).toBeNull();
  });
});

describe('the guard’s answer while a pass reads', () => {
  let connectionId = '';

  beforeAll(async () => {
    await reset();
    for (const n of ['A', 'B', 'C', 'D', 'E', 'F']) await addLogin(`Login ${n}`, 'mara', `pass-${n}-123`);
    connectionId = await connect('put');
  });

  it('“Keep them here” answered while a pass that read the item runs: the entry keeps its value', async () => {
    const all = fake.items(vaultId);
    const gone = all.slice(0, 4);
    for (const item of gone) fake.remove(item.id);
    await sync();
    const view = await page(connectionId);
    expect(view.outcome).toBe('paused');
    // One of them comes back in 1Password, changed; a pass reads it while the person keeps them here.
    const back = gone[0] as (typeof gone)[number];
    const v = fake.vault(vaultId);
    v.items.set(back.id, {
      ...back,
      fields: back.fields.map((f) => (f.id === 'password' ? { ...f, value: 'came-back-changed' } : f)),
      version: back.version + 5,
      updatedAt: fake.now(),
    });
    v.contentVersion++;
    const entryId = (await t.services.db.select().from(vaultOnePasswordLinks)).find(
      (l) => l.itemId === back.id,
    )?.entryId as string;
    const before = await passwordOf(entryId);
    const held = fake.pause('get');
    const running = sync();
    await held.reached;
    const res = await w.call(
      api.connections.onePasswordRemovals,
      { connectionId },
      { answer: 'keep', token: view.removals?.token },
    );
    expect(res.status, res.raw).toBe(200);
    held.release();
    await running;
    expect(await passwordOf(entryId)).toBe(before);
    expect((await linkOf(entryId))?.state).toBe('local_only');
    // The answer stands: the pass that read before it brings no card back.
    expect(await state(connectionId)).toMatchObject({ removals: null, outcome: 'ok' });
    const items = await onePasswordNeedsYou({
      db: t.services.db,
      burrowId: BURROW,
      personId: IDS.mara,
      now: new Date(),
    });
    expect(items.some((i) => i.id.endsWith(':removals'))).toBe(false);
  });
});

describe('another vault, another token', () => {
  const BOTH = 'ops_both-vaults-token-0123456789abcdefABCD';
  let connectionId = '';
  let kept = '';

  beforeAll(async () => {
    await reset();
    fake.addToken(BOTH, [vaultId, otherVaultId]);
    kept = await addLogin('Kept here', 'mara', 'kept-pass-1');
    connectionId = await connect('keep', BOTH);
    await addLogin('Bank', 'mara', 'hunter2-bank');
    await sync();
  });

  it('a new token starts clean: the old one’s read-only finding, the limit’s wait and failures are forgotten', async () => {
    await t.services.db
      .update(vaultOnePasswordState)
      .set({
        readOnly: true,
        limitHits: 3,
        nextTryAt: new Date(Date.now() + 3600_000),
        outcome: 'failing',
        problem: ONEPASSWORD_WORDS.unreachable,
        failures: 4,
      })
      .where(eq(vaultOnePasswordState.connectionId, connectionId));
    const res = await w.call(api.connections.setSecret, { connectionId }, { secret: TOKEN });
    expect(res.status, res.raw).toBeLessThan(300);
    expect(await state(connectionId)).toMatchObject({
      readOnly: false,
      limitHits: 0,
      nextTryAt: null,
      outcome: null,
      failures: 0,
    });
  });

  it('refuses a new token that can’t see the vault, naming it', async () => {
    const elsewhere = 'ops_family-only-token-0123456789abcdefABCD';
    fake.addToken(elsewhere, [otherVaultId]);
    const res = await w.call(api.connections.setSecret, { connectionId }, { secret: elsewhere });
    expect(res.status).toBe(409);
    expect(res.raw).toContain('“Whombat”');
  });

  it('refuses another vault in plain words: linking again is the way', async () => {
    await w.call(api.connections.setSecret, { connectionId }, { secret: BOTH });
    const before = await links(connectionId);
    const res = await w.call(api.connections.update, { connectionId }, { fields: { vault: otherVaultId } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.raw).toContain('remove 1Password and link it again');
    expect(await links(connectionId)).toEqual(before);
    expect((await linkOf(kept))?.state).toBe('local_only');
    await sync();
    expect(fake.items(otherVaultId)).toEqual([]);
  });

  it('looks for the vault among every vault the new token sees, not only the first hundred', async () => {
    const many = 'ops_many-vaults-token-0123456789abcdefABCD';
    const others = Array.from({ length: 120 }, (_, i) => fake.addVault(`Team ${String(i).padStart(3, '0')}`));
    fake.addToken(many, [...others, vaultId]);
    const res = await w.call(api.connections.setSecret, { connectionId }, { secret: many });
    expect(res.status, res.raw).toBeLessThan(300);
  });
});

describe('linking again pairs by who signs in', () => {
  beforeAll(reset);

  it('pairs an unpaired item and entry signing in as the same, and Whombat’s values win in that pass', async () => {
    const bank = await addLogin('Bank', 'mara', 'old-in-whombat');
    fake.addLogin(vaultId, {
      title: 'My bank',
      url: 'https://public.example/login/',
      username: 'mara',
      password: 'new-in-1password',
    });
    // Two items signing in the same way: neither is taken for the entry signing in that way.
    await addLogin('Shop', 'mara', 'shop-pass-1', 'https://public.example/shop');
    for (const title of ['Shop one', 'Shop two'])
      fake.addLogin(vaultId, {
        title,
        url: 'https://public.example/shop',
        username: 'mara',
        password: `${title}-pass`,
      });
    await connect('put');
    // Nothing made twice on either side, and in that one pass Whombat's values went to the item: 1Password keeps the
    // replaced ones in its history.
    const item = await itemOf(bank);
    expect(fake.items(vaultId).filter((i) => i.title === 'My bank')).toHaveLength(0);
    expect(fake.item(item)?.title).toBe('Bank');
    expect(fake.field(item, 'password')).toBe('old-in-whombat');
    expect((await entry(bank))?.name).toBe('Bank');
    expect(await passwordOf(bank)).toBe('old-in-whombat');
    await sync();
    expect(
      (await t.services.db.select().from(vaultEntries).where(eq(vaultEntries.burrowId, BURROW))).length,
    ).toBe(4);
    expect((await entryByName('Shop one'))?.id).toBeTruthy();
    expect(fake.items(vaultId).filter((i) => i.title === 'Shop')).toHaveLength(1);
    // Paired with an item now: removing it would archive that item.
    expect((await secretOf(bank)).source).toMatchObject({ state: 'synced', paired: true });
  });
});

describe('a token replaced while a pass reads', () => {
  let connectionId = '';

  beforeAll(async () => {
    await reset();
    await addLogin('Bank', 'mara', 'hunter2-bank');
    connectionId = await connect('put');
  });

  it('the pass that read with the old token writes nothing: no entry, state or wait comes back', async () => {
    const fresh = 'ops_fresh-token-0123456789abcdefABCDEFGH';
    fake.addToken(fresh, [vaultId]);
    fake.addLogin(vaultId, {
      title: 'Mail',
      url: 'https://public.example/mail',
      username: 'mara',
      password: 'mail-pass-1',
    });
    const before = await state(connectionId);
    const held = fake.pause('list');
    const running = onePasswordSyncFor(t.services).runNow('now');
    await held.reached;
    const res = await w.call(api.connections.setSecret, { connectionId }, { secret: fresh });
    expect(res.status, res.raw).toBeLessThan(300);
    held.release();
    await running;
    expect(await entryByName('Mail')).toBeUndefined();
    expect((await state(connectionId))?.checkedAt).toEqual(before?.checkedAt);
    // The next pass, with the new token, takes it.
    await sync();
    expect(await entryByName('Mail')).toBeDefined();
  });
});

describe('pairing and removing after the list', () => {
  let connectionId = '';

  beforeAll(async () => {
    await reset();
    for (const n of ['A', 'B', 'C', 'D', 'E', 'F']) await addLogin(`Login ${n}`, 'mara', `pass-${n}-123`);
    connectionId = await connect('put');
  });

  it('an item listed but not found when read is not gone: the next list decides', async () => {
    const [first] = fake.items(vaultId);
    const entryId = (await links(connectionId)).find((l) => l.itemId === first?.id)?.entryId as string;
    fake.edit(first?.id as string, () => {});
    fake.readMissing.add(first?.id as string);
    await sync();
    expect(await entry(entryId)).toBeDefined();
    const view = await page(connectionId);
    expect(view.removals).toBeNull();
    expect(view.outcome).toBe('failing');
    fake.readMissing.clear();
    await sync();
    expect(await entry(entryId)).toBeDefined();
    expect((await page(connectionId)).outcome).toBe('ok');
  });

  it('a pair made twice answers gone, never a duplicate that undoes the rest of its batch', async () => {
    const [paired] = (await links(connectionId)).filter((l) => l.itemId && l.base);
    const twin = await addLogin('Twin', 'mara', 'twin-pass-1');
    const [conn] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, connectionId));
    const res = await t.services.pipeline.commit(
      applyOnePasswordOps,
      {
        connectionId,
        credentialVersion: conn?.credentialVersion ?? 0,
        ops: [
          {
            op: 'relink',
            linkId: 'opl_twintwintwin',
            entryId: twin,
            vaultId,
            item: { itemId: paired?.itemId as string, version: 1, updatedAt: '2026-11-24T08:00:00.000Z' },
            base: paired?.base as NonNullable<typeof paired>['base'] & object,
            nameShortened: false,
          },
        ],
      },
      { burrowId: BURROW, actorId: IDS.mara },
    );
    expect(res.status).toBe('ok');
    expect(res.status === 'ok' && res.result.results).toEqual([{ status: 'gone' }]);
    expect(await linkOf(twin)).toBeUndefined();
  });
});

describe('markers first', () => {
  beforeAll(reset);

  it('an item naming an entry is that entry’s, even when another entry holds exactly what it holds', async () => {
    const same = await addLogin('Shop', 'mara', 'same-pass', 'https://public.example/shop');
    const named = await addLogin('Shop old', 'mara', 'named-pass', 'https://public.example/shop-old');
    const marked = fake.addLogin(vaultId, {
      title: 'Shop',
      url: 'https://public.example/shop',
      username: 'mara',
      password: 'same-pass',
      extra: [
        { id: 'whombatentry', title: 'Whombat entry', sectionId: null, fieldType: 'Text', value: named },
      ],
    });
    await connect('put');
    expect((await linkOf(named))?.itemId).toBe(marked.id);
    expect((await linkOf(same))?.itemId).not.toBe(marked.id);
    // The entry it names wins its values at once; the other has an item of its own.
    expect(fake.field(marked.id, 'password')).toBe('named-pass');
    expect(fake.field((await linkOf(same))?.itemId as string, 'password')).toBe('same-pass');
  });
});

describe('an archive and a restore at once', () => {
  beforeAll(async () => {
    await reset();
    await addLogin('Bank', 'mara', 'hunter2-bank');
    await connect('put');
  });

  it('an entry brought back while a pass reads keeps its item', async () => {
    const mail = await addLogin('Mail', 'mara', 'mail-pass-1');
    await sync();
    const mailItem = await itemOf(mail);
    await w.call(api.vault.remove, { entryId: mail });
    const held = fake.pause('list');
    const running = sync();
    await held.reached;
    // Brought back from a backup while the pass reads: it takes the pair whose item waits to be archived.
    const back = await addLogin('Mail', 'mara', 'mail-pass-1');
    await relinkOnePassword(t.services.db, BURROW, back, mailItem);
    held.release();
    await running;
    expect(fake.isArchived(mailItem)).toBe(false);
    expect((await linkOf(back))?.itemId).toBe(mailItem);
  });
});

describe('a create sent again', () => {
  beforeAll(async () => {
    await reset();
    await connect('put');
  });

  it('carries the entry as it is then as its base, so a lost answer is read against what was sent', async () => {
    const shop = await addLogin('Shop', 'mara', 'shop-v1');
    fake.failNext.set('create', ['network']);
    await sync();
    expect((await linkOf(shop))?.state).toBe('creating');
    await w.call(api.vault.setSecret, { entryId: shop }, { value: 'shop-v2' });
    fake.loseCreates = 1;
    await sync();
    const made = fake.items(vaultId).find((i) => i.title === 'Shop')?.id as string;
    expect(fake.field(made, 'password')).toBe('shop-v2');
    // Changed in 1Password before the pass found it: 1Password's change, not a clash.
    setPassword(made, 'shop-v3-in-1password');
    await sync();
    expect(await passwordOf(shop)).toBe('shop-v3-in-1password');
  });
});

describe('fewer reads', () => {
  let connectionId = '';

  beforeAll(async () => {
    await reset();
    connectionId = await connect('put');
  });

  it('knows items of other kinds from the list alone', async () => {
    const doc = fake.addOther(vaultId, 'Passport', 'Document');
    const key = fake.addOther(vaultId, 'Server key', 'SshKey');
    fake.gets = [];
    await sync();
    expect(fake.gets).not.toContain(doc.id);
    expect(fake.gets).not.toContain(key.id);
    const reasons = (await page(connectionId)).notInVault.map((n) => n.reason);
    expect(reasons).toEqual(expect.arrayContaining(['other_kind', 'ssh_key']));
  });

  it('an item that won’t read stays out by itself after the second try, and is read again when it changes', async () => {
    const stubborn = fake.addLogin(vaultId, {
      title: 'Stubborn',
      url: 'https://public.example/stubborn',
      username: 'mara',
      password: 'stubborn-1',
    });
    fake.unreadable.add(stubborn.id);
    await sync();
    expect((await page(connectionId)).outcome).toBe('failing');
    await sync();
    const view = await page(connectionId);
    expect(view.outcome).toBe('ok');
    expect(view.notInVault).toContainEqual(
      expect.objectContaining({ itemId: stubborn.id, reason: 'unreadable' }),
    );
    fake.gets = [];
    await onePasswordSyncFor(t.services).runNow('now');
    expect(fake.gets).not.toContain(stubborn.id);
    fake.unreadable.clear();
    fake.edit(stubborn.id, () => {});
    await sync();
    expect(await entryByName('Stubborn')).toBeDefined();
  });

  it('remembers every item kept out, beyond the 200 the page shows', async () => {
    for (let i = 0; i < 205; i++)
      fake.addLogin(vaultId, {
        title: `No site ${i}`,
        url: null,
        username: 'mara',
        password: `site-pass-${i}`,
      });
    await sync();
    expect((await page(connectionId)).notInVault).toHaveLength(200);
    const fresh = fake.addLogin(vaultId, {
      title: 'Fresh',
      url: 'https://public.example/fresh',
      username: 'mara',
      password: 'fresh-1',
    });
    fake.gets = [];
    await sync();
    expect(fake.gets).toEqual([fresh.id]);
  });
});
