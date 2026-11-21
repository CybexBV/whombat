import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/client';
import { KeyCustody } from '../keys/custody';
import {
  type ChangeRow,
  type ChangeWriter,
  changeUndoAad,
  collectNeedsYou,
  collectThings,
  collectWatch,
  openChange,
  recordChange,
  registeredSources,
  registerNeedsYouSource,
  registerThingsSource,
  registerUndoer,
  registerWatchSource,
  type SourceCtx,
  undoerFor,
  undoStateOf,
  unregister,
} from './registry';
import type { NeedsYouItem, ThingSummary } from './types';

const custody = new KeyCustody(Buffer.alloc(32, 7).toString('base64'));
const ctx: SourceCtx = {
  db: {} as Db,
  burrowId: 'bur_1',
  personId: 'prn_mara',
  now: new Date('2026-10-17T10:00:00Z'),
};

const item = (id: string): NeedsYouItem => ({
  id,
  ref: { kind: 'approval', id },
  kind: 'approval',
  severity: 'warn',
  title: 'Restart pve-02?',
  body: 'Updates are waiting.',
  at: '2026-10-17T09:00:00.000Z',
  actions: [],
});

const thing = (id: string): ThingSummary => ({
  id: `connection:${id}`,
  kind: 'connection',
  name: 'Home Assistant',
  icon: 'home-assistant',
  status: 'ok',
  facts: [],
  href: `/things/${id}`,
});

/** A writer that keeps what it was given (the drizzle calls `recordChange` makes). */
function fakeWriter() {
  const inserted: ChangeRow[] = [];
  const updated: { set: Partial<ChangeRow> }[] = [];
  const tx = {
    insert: () => ({
      values: async (v: ChangeRow) => {
        inserted.push(v);
      },
    }),
    update: () => ({
      set: (set: Partial<ChangeRow>) => ({
        where: async () => {
          updated.push({ set });
        },
      }),
    }),
  };
  return { writer: { tx, services: { custody } } as unknown as ChangeWriter, inserted, updated };
}

afterEach(() => {
  for (const name of ['a', 'b', 'slow', 'broken']) {
    unregister('needsYou', name);
    unregister('things', name);
    unregister('watch', name);
  }
  unregister('undoer', 'test.toggle');
});

describe('Home registry sources', () => {
  it('collects every source and keeps the others when one throws or is too slow', async () => {
    registerNeedsYouSource('a', async (c) => [item(`${c.personId}-1`)]);
    registerNeedsYouSource('b', async () => [item('b-1'), item('b-2')]);
    registerNeedsYouSource('broken', async () => {
      throw new TypeError('boom');
    });
    registerNeedsYouSource(
      'slow',
      () => new Promise((resolve) => setTimeout(() => resolve([item('late')]), 200)),
    );
    const { items, failures } = await collectNeedsYou(ctx, 50);
    expect(items.map((i) => i.id).sort()).toEqual(['b-1', 'b-2', 'prn_mara-1']);
    expect(failures).toEqual(
      expect.arrayContaining([
        { source: 'broken', reason: 'error', error: 'TypeError' },
        { source: 'slow', reason: 'timeout' },
      ]),
    );
  });

  it('a name registers once: registering it again replaces the source', async () => {
    registerThingsSource('a', async () => [thing('one')]);
    registerThingsSource('a', async () => [thing('two')]);
    expect((await collectThings(ctx)).items.map((t) => t.id)).toEqual(['connection:two']);
    expect(registeredSources().things).toContain('a');
    expect((await collectWatch(ctx)).items).toEqual([]);
    registerWatchSource('a', async () => []);
    expect(registeredSources().watch).toContain('a');
  });
});

describe('recordChange', () => {
  it('seals the undo payload bound to the change and opens it back', async () => {
    const { writer, inserted } = fakeWriter();
    const id = await recordChange(writer, {
      burrowId: 'bur_1',
      actorId: 'prn_whombat',
      agentId: 'prn_whombat',
      personId: 'prn_mara',
      kind: 'connection.call',
      title: 'Turned off the hallway light',
      subject: { kind: 'connection', id: 'con_ha', name: 'Home Assistant' },
      undo: { kind: 'test.toggle', payload: { entity: 'light.hallway', was: 'on' } },
      at: new Date('2026-10-17T10:00:00Z'),
    });
    expect(id).toMatch(/^chg_/);
    const row = inserted[0] as ChangeRow;
    expect(row.id).toBe(id);
    expect(row.undoKind).toBe('test.toggle');
    expect(row.undoEnc).toMatch(/^v1:/);
    expect(row.undoEnc).not.toContain('hallway');
    // Bound to its row: another change's AAD doesn't open it.
    expect(() => custody.open(changeUndoAad('chg_other'), row.undoEnc as string)).toThrow();
    const opened = openChange(custody, row);
    expect(opened?.undo).toEqual({ kind: 'test.toggle', payload: { entity: 'light.hallway', was: 'on' } });
    expect(opened?.subject).toEqual({ kind: 'connection', id: 'con_ha', name: 'Home Assistant' });
  });

  it('a change without undo stores no recipe', async () => {
    const { writer, inserted } = fakeWriter();
    await recordChange(writer, {
      burrowId: 'bur_1',
      actorId: 'prn_mara',
      kind: 'note',
      title: 'x'.repeat(300),
    });
    expect(inserted[0]?.undoEnc).toBeNull();
    expect(inserted[0]?.title).toHaveLength(200);
    expect(openChange(custody, inserted[0] as ChangeRow)).toBeNull();
  });

  it('an undo marks the change it undoes', async () => {
    const { writer, updated } = fakeWriter();
    const id = await recordChange(writer, {
      burrowId: 'bur_1',
      actorId: 'prn_whombat',
      kind: 'connection.call',
      title: 'Turned the hallway light back on',
      undoes: { changeId: 'chg_first', byId: 'prn_mara' },
    });
    expect(updated[0]?.set).toMatchObject({ undoneById: 'prn_mara', undoChangeId: id });
  });
});

describe('undoStateOf', () => {
  const now = new Date('2026-10-17T10:00:00Z');
  it('available only with a registered undoer, in time, and not undone yet', () => {
    const row = { undoKind: 'test.toggle', undoEnc: 'v1:x', undoUntil: null, undoneAt: null };
    expect(undoStateOf(row, now)).toEqual({ state: 'none' });
    registerUndoer('test.toggle', async () => ({ ok: true }));
    expect(undoerFor('test.toggle')).not.toBeNull();
    expect(undoStateOf(row, now)).toEqual({ state: 'available' });
    const until = new Date('2026-10-18T10:00:00Z');
    expect(undoStateOf({ ...row, undoUntil: until }, now)).toEqual({
      state: 'available',
      until: until.toISOString(),
    });
    expect(undoStateOf({ ...row, undoUntil: new Date('2026-10-17T09:00:00Z') }, now)).toEqual({
      state: 'none',
    });
    expect(undoStateOf({ ...row, undoneAt: now }, now)).toEqual({ state: 'undone' });
    expect(undoStateOf({ ...row, undoKind: null }, now)).toEqual({ state: 'none' });
  });
});
