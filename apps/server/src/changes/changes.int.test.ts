/**
 * What changed before it broke, end to end on a real database (docs/decisions/outside-changes.md): a connection's
 * version kept between health passes, the change it makes (outside Whombat, or by Whombat when its own change on the
 * thing came just before), a quick second change merged into the first and one undone gone; the thing's History and the
 * assistant's `what_changed` list it. A service's settings copy: the first, the same again, one with the same settings,
 * one with other settings (a `settings` change), a try that fails and the line that comes after two days without one,
 * and Download giving the bytes back from their seal. Postgres because each step is a pipeline write read back across
 * tables.
 */
import { newId } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogConnections, changes, settingsCopies, thingChanges } from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import { thingHistory } from '../incidents/history';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { insertConnection } from '../test/connections';
import { useTestServer } from '../test/harness';
import { mcpClient } from '../test/mcp';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { agentTokenFor } from '../test/tokens';
import { trackConnection } from './connections';
import { settingsCopyFile } from './copies/download';
import { takeSettingsCopy } from './copies/run';
import { CONTENT_KEY, hasClearKeys } from './copies/summary';
import { CopyFailed, type CopyService } from './copies/types';
import { settingsCopyOf } from './copies/view';
import { changesServerPass } from './servers';

const t = useTestServer({ seed: true, listen: true });
const MIN = 60_000;
const T0 = new Date('2026-11-24T13:00:00Z');
let now = T0;
let real: () => Date;
let mine: PersonalSetup;
let opn = '';

const at = (minutes: number) => {
  now = new Date(T0.getTime() + minutes * MIN);
  return now;
};
const row = async () => {
  const [r] = await t.services.db.select().from(catalogConnections).where(eq(catalogConnections.id, opn));
  if (!r) throw new Error('no connection');
  return r;
};
const changed = () =>
  t.services.db
    .select()
    .from(thingChanges)
    .where(eq(thingChanges.thingId, `connection:${opn}`));
const viewer = async () => {
  const person = await thePerson(t.services.db, TEST_BURROW_ID);
  if (!person) throw new Error('no person');
  return { accountId: person.accountId ?? '', burrowId: TEST_BURROW_ID, principal: person };
};

beforeAll(async () => {
  real = t.services.clock;
  t.services.clock = () => now;
  mine = await addPersonalAgent(t.services, TEST_BURROW_ID, IDS.mara, { services: null });
  opn = await insertConnection(t.services, {
    catalogId: 'opnsense',
    burrowId: TEST_BURROW_ID,
    label: 'Firewall',
    handle: 'firewall',
    fields: { url: 'http://127.0.0.1:9', apiKey: 'key' },
    secret: 'secret-opn',
  });
});

afterAll(() => {
  t.services.clock = real;
});

describe('changes older than 90 days', () => {
  it('go in the servers’ pass, through the pipeline', async () => {
    const id = newId('thingChange');
    await t.services.db.insert(thingChanges).values({
      id,
      burrowId: TEST_BURROW_ID,
      thingId: 'server:old-01',
      kind: 'restart',
      fact: { k: 'restart', kernel: null },
      by: 'outside',
      seenAt: new Date(T0.getTime() - 91 * 24 * 60 * MIN),
    });
    const pipeline = t.services.pipeline;
    const original = pipeline.transactAccount.bind(pipeline);
    let through = 0;
    pipeline.transactAccount = (fn) => {
      through++;
      return original(fn);
    };
    try {
      at(0);
      await changesServerPass(t.services);
    } finally {
      pipeline.transactAccount = original;
    }
    expect(through).toBeGreaterThan(0);
    expect(await t.services.db.select().from(thingChanges).where(eq(thingChanges.id, id))).toEqual([]);
  });
});

describe('a connection’s version', () => {
  it('sets the first read, then tells a change outside Whombat, merges a quick second one and drops one undone', async () => {
    expect(await trackConnection(t.services, await row(), { version: '25.7.1' }, null, at(0))).toBe(0);
    expect(await changed()).toEqual([]);
    expect(await trackConnection(t.services, await row(), { version: '25.7.2' }, null, at(5))).toBe(1);
    // Ten minutes on, it moved again: one change from the first to the last.
    expect(await trackConnection(t.services, await row(), { version: '25.7.3' }, null, at(15))).toBe(0);
    const [one, ...rest] = await changed();
    expect(rest).toEqual([]);
    expect(one).toMatchObject({ kind: 'version', by: 'outside', fact: { from: '25.7.1', to: '25.7.3' } });
    expect(one?.since).toEqual(new Date(T0.getTime()));
    // And back again: nothing changed after all.
    await trackConnection(t.services, await row(), { version: '25.7.1' }, null, at(20));
    expect(await changed()).toEqual([]);
  });

  it('says Whombat made it when Whombat changed the server it runs on just before', async () => {
    await t.services.db.insert(changes).values({
      id: newId('change'),
      burrowId: TEST_BURROW_ID,
      actorId: mine.agentId,
      kind: 'hosts.guest_power',
      title: 'Restarted the firewall',
      subjectKind: 'server',
      subjectId: 'gate-01',
      subjectName: 'gate-01',
      createdAt: at(100),
    });
    await trackConnection(t.services, await row(), { version: '25.7.4' }, 'gate-01', at(110));
    const [made] = await changed();
    expect(made).toMatchObject({ by: 'whombat', fact: { from: '25.7.1', to: '25.7.4' } });
  });

  it('lists it in the thing’s History and to the assistant', async () => {
    const history = await thingHistory(
      t.services,
      await viewer(),
      `connection:${opn}`,
      30,
      'Europe/Amsterdam',
    );
    expect(history.changes?.map((c) => [c.kind, c.by])).toEqual([['version', 'whombat']]);
    expect(history.changes?.[0]?.words).toContain('25.7.4');
    const token = await agentTokenFor(t.services, TEST_BURROW_ID, mine.agentId, mine.dmId);
    const mcp = await mcpClient(t.baseUrl, token.token);
    const out = await mcp.client.callTool({
      name: 'what_changed',
      arguments: { thing: 'firewall', hours: 48 },
    });
    expect(out.isError).toBeFalsy();
    const said = out.structuredContent as {
      changes: { name: string; kind: string; by: string; words: string }[];
    };
    expect(said.changes.map((c) => [c.name, c.kind, c.by])).toEqual([['Firewall', 'version', 'whombat']]);
    await mcp.close();
  });
});

describe('a settings copy', () => {
  /** A stand-in OPNsense that answers what each test sets. */
  let answer: { bytes: string; summary: Record<string, string> | null } | CopyFailed = {
    bytes: '<opnsense>1</opnsense>',
    summary: { 'filter/u1': 'a', [CONTENT_KEY]: 'settings-1' },
  };
  const fake: CopyService = {
    name: 'OPNsense',
    async take() {
      if (answer instanceof CopyFailed) throw answer;
      return {
        bytes: Buffer.from(answer.bytes),
        fileName: 'opnsense-config.xml',
        contentType: 'application/xml',
        summary: answer.summary,
      };
    },
  };
  const copies = () =>
    t.services.db.select().from(settingsCopies).where(eq(settingsCopies.connectionId, opn));
  const settingsChanges = async () => (await changed()).filter((c) => c.kind === 'settings');

  it('keeps the first, finds the same again, and replaces one whose settings compare the same', async () => {
    expect(await takeSettingsCopy(t.services, await row(), at(200), fake)).toBe('first');
    expect(await takeSettingsCopy(t.services, await row(), at(300), fake)).toBe('same');
    answer = { bytes: '<opnsense>1 </opnsense>', summary: { 'filter/u1': 'a', [CONTENT_KEY]: 'settings-1' } };
    expect(await takeSettingsCopy(t.services, await row(), at(400), fake)).toBe('replaced');
    const kept = await copies();
    expect(kept).toHaveLength(1);
    // Sealed at rest: the bytes aren't in the row, and the summary names no item.
    expect(Buffer.from(kept[0]?.sealed ?? []).includes(Buffer.from('opnsense'))).toBe(false);
    expect(Object.keys(kept[0]?.summary ?? {})).not.toContain('filter/u1');
    expect(await settingsChanges()).toEqual([]);
  });

  it('keeps a copy whose items compare the same when a password in it changed', async () => {
    answer = {
      bytes: '<opnsense>1  </opnsense>',
      summary: { 'filter/u1': 'a', [CONTENT_KEY]: 'settings-2' },
    };
    expect(await takeSettingsCopy(t.services, await row(), at(450), fake)).toBe('kept');
    expect(await copies()).toHaveLength(2);
    // Nothing a person reads changed: no line in the change log.
    expect(await settingsChanges()).toEqual([]);
  });

  it('hashes the keys of a copy an older Whombat kept with its items named', async () => {
    // The older of the two: the newest is written anew by any try.
    const [oldest] = await copies().then((all) => all.sort((a, b) => +a.madeAt - +b.madeAt));
    if (!oldest) throw new Error('no copy');
    await t.services.db
      .update(settingsCopies)
      .set({ summary: { 'filter/u1': 'a' } })
      .where(eq(settingsCopies.id, oldest.id));
    expect(await takeSettingsCopy(t.services, await row(), at(470), fake)).toBe('same');
    for (const copy of await copies()) expect(hasClearKeys(copy.summary)).toBe(false);
  });

  it('keeps one with other settings beside it and tells what changed', async () => {
    answer = {
      bytes: '<opnsense>2</opnsense>',
      summary: { 'filter/u1': 'b', 'filter/u2': 'c', [CONTENT_KEY]: 'settings-3' },
    };
    expect(await takeSettingsCopy(t.services, await row(), at(500), fake)).toBe('kept');
    expect(await copies()).toHaveLength(3);
    const [change] = await settingsChanges();
    expect(change?.fact).toEqual({
      k: 'settings',
      service: 'OPNsense',
      parts: [{ part: 'filter', added: 1, removed: 0, changed: 1 }],
    });
  });

  it('says a failing copy on the card, and the line only after two days without one', async () => {
    answer = new CopyFailed('notAllowed');
    expect(await takeSettingsCopy(t.services, await row(), at(600), fake)).toBe('notAllowed');
    const soon = await settingsCopyOf(t.services, await row(), now, 'Europe/Amsterdam', 'en');
    expect(soon?.view).toMatchObject({ failing: true, kept: 3, service: 'OPNsense' });
    expect(soon?.view.detail).toContain('OPNsense');
    expect(soon?.line).toBeNull();
    await takeSettingsCopy(t.services, await row(), at(500 + 49 * 60), fake);
    const late = await settingsCopyOf(t.services, await row(), now, 'Europe/Amsterdam', 'en');
    expect(late?.line).toMatchObject({ check: 'settings.copy', nature: 'problem' });
  });

  it('gives the newest copy back for Download', async () => {
    const file = await settingsCopyFile(t.services, await viewer(), `connection:${opn}`, undefined);
    expect(Buffer.from(file.base64, 'base64').toString()).toBe('<opnsense>2</opnsense>');
    expect(file).toMatchObject({ fileName: 'opnsense-config.xml', contentType: 'application/xml' });
  });
});
