/**
 * Generic declared settings plumbing: `declaredSettings`, `settingsTab` (normal, unread, custom unread message,
 * per-row elsewhere addresses), and `withCurrent`.
 */
import { ThingPageTab } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../../services';
import { rowOf } from './media/testing';
import {
  type DeclaredSettings,
  declaredSettings,
  omitFields,
  SERVICE_SETTINGS_TAB_KEY,
  settingAction,
  settingsPanels,
  settingsTab,
  withCurrent,
} from './settings';
import type { KindCtx } from './types';

const mockHttp = vi.hoisted(() => ({
  handler: null as
    | ((req: { method: string; url: string; headers?: Record<string, string>; body?: string }) => {
        status: number;
        headers: Record<string, string>;
        body: Buffer;
      })
    | null,
}));

vi.mock('../../connections/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../connections/http')>();
  return {
    ...real,
    signedConnectionFetch: async (
      _s: unknown,
      _r: unknown,
      req: { method: string; url: string; headers?: Record<string, string>; body?: string },
    ) => (mockHttp.handler ? mockHttp.handler(req) : { status: 200, headers: {}, body: Buffer.from('{}') }),
  };
});

interface DemoState {
  flag: boolean;
  level: string;
}

function makeDeclared(overrides: Partial<DeclaredSettings<DemoState>> = {}): DeclaredSettings<DemoState> {
  return {
    name: 'Demo',
    url: (base) => `${base}/settings`,
    groups: [
      { id: 'main', title: 'Main', ask: ['What does Flag do?'] },
      { id: 'other', title: 'Other' },
    ],
    specs: [
      {
        id: 'flag',
        group: 'main',
        label: 'Flag',
        help: 'Turns the demo flag on or off.',
        kind: 'switch',
        read: (s) => s.flag,
        write: (v) => ({ method: 'POST', path: '/flag', body: { flag: Boolean(v) } }),
      },
      {
        id: 'level',
        group: 'main',
        label: 'Level',
        help: 'How much detail Demo keeps.',
        kind: 'choice',
        read: (s) => s.level,
        choices: (s) =>
          withCurrent(
            [
              { value: 'low', label: 'Low' },
              { value: 'high', label: 'High' },
            ],
            s.level,
            (v) => `Custom (${String(v)})`,
          ),
        write: (v) => ({ method: 'POST', path: '/level', body: { level: String(v) } }),
      },
      {
        id: 'danger',
        group: 'other',
        label: 'Dangerous setting',
        help: 'Stays in Demo itself.',
        kind: 'elsewhere',
        read: () => 'Managed in Demo',
        elsewhere: (base) => `${base}/settings/danger`,
      },
      {
        id: 'same_page',
        group: 'other',
        label: 'Another external setting',
        help: 'Links to Demo’s main settings page.',
        kind: 'elsewhere',
        read: () => 'Automatic',
      },
    ],
    read: async () => ({ flag: true, level: 'high' }),
    ...overrides,
  };
}

function fakeCtx(overrides: Partial<KindCtx> = {}): KindCtx {
  return {
    services: { db: null } as unknown as Services,
    row: rowOf('plex', { id: 'con_demo', baseUrl: 'http://192.0.2.10:8080/' }),
    entry: {} as KindCtx['entry'],
    now: new Date('2026-11-04T20:13:00Z'),
    timeZone: 'UTC',
    machine: null,
    range: '24h',
    burrowId: 'brw_1',
    disk: { pct: [], gb: [] },
    viewer: {} as KindCtx['viewer'],
    ...overrides,
  };
}

describe('settingsTab and declaredSettings', () => {
  it('builds a valid service-settings tab and resolves elsewhere links against the base URL', async () => {
    const declared = makeDeclared();
    const bundled = declaredSettings(declared);
    expect(bundled.name).toBe('Demo');

    const tab = await bundled.tab(fakeCtx());
    expect(tab.key).toBe(SERVICE_SETTINGS_TAB_KEY);
    expect(tab.label).toBe('Demo settings');
    expect(ThingPageTab.safeParse(tab).success).toBe(true);

    const intro = tab.panels.find((p) => p.id === 'settings-intro');
    expect(intro?.kind === 'text' ? intro.link : null).toEqual({
      kind: 'url',
      label: 'All settings in Demo',
      url: 'http://192.0.2.10:8080/settings',
    });

    const rows = tab.panels.flatMap((p) => (p.kind === 'settings' ? p.rows : []));
    expect(rows.find((r) => r.id === 'danger')?.elsewhere?.url).toBe(
      'http://192.0.2.10:8080/settings/danger',
    );
    expect(rows.find((r) => r.id === 'same_page')?.elsewhere?.url).toBe('http://192.0.2.10:8080/settings');
  });

  it('shows an unread card when reading fails, using a custom unread message when declared', async () => {
    const generic = await settingsTab(
      fakeCtx({ row: rowOf('plex', { id: 'con_fail1', baseUrl: 'http://192.0.2.11', fields: {} }) }),
      makeDeclared({
        read: async () => {
          throw new Error('offline');
        },
      }),
    );
    expect(ThingPageTab.safeParse(generic).success).toBe(true);
    expect(generic.panels).toHaveLength(1);
    expect(generic.panels[0]).toMatchObject({
      kind: 'text',
      id: 'settings-unread',
      link: { kind: 'url', label: 'Open Demo', url: 'http://192.0.2.11/settings' },
    });

    const custom = await settingsTab(
      fakeCtx({ row: rowOf('plex', { id: 'con_fail2', baseUrl: 'http://192.0.2.12', fields: {} }) }),
      makeDeclared({
        read: async () => {
          throw new Error('forbidden');
        },
        unread: () => 'Only an administrator can read Demo’s settings.',
      }),
    );
    expect(custom.panels[0]?.kind === 'text' ? custom.panels[0].body : '').toContain('administrator');
  });

  it('adds an unlisted current value with withCurrent without duplicating known ones', () => {
    const base = [
      { value: 10, label: '10 min' },
      { value: 30, label: '30 min' },
    ];
    expect(withCurrent(base, 10, (v) => `${v} min`)).toBe(base);
    expect(withCurrent(base, 45, (v) => `${v} min`)).toEqual([...base, { value: 45, label: '45 min' }]);
    expect(withCurrent(base, undefined, (v) => `${v} min`)).toBe(base);
  });
});

describe('settingAction read-back verification', () => {
  const actionCtx = () => ({
    services: {} as Services,
    row: rowOf('plex', { id: 'con_rb', baseUrl: 'http://192.0.2.15' }),
    now: new Date('2026-11-04T20:13:00Z'),
    timeZone: 'UTC',
  });

  it('records an uncertain outcome with no Changed and no Undo when read-back fails', async () => {
    let calls = 0;
    const act = settingAction(
      makeDeclared({
        read: async () => {
          calls += 1;
          if (calls === 1) return { flag: true, level: 'high' };
          throw new Error('timeout');
        },
      }),
    );
    const out = await act(actionCtx(), { target: 'level', value: 'low' });
    expect(out.uncertain).toBe(true);
    expect(out.undo).toBeUndefined();
    expect(out.changeKind).toBeUndefined();
    expect(out.title).not.toMatch(/Changed/);
    expect(out.title).toContain('Demo');
    expect(out.message).toMatch(/couldn’t check/i);
    expect(out.message).not.toMatch(/Changed|is now/);
  });

  it('records an uncertain outcome with no Changed and no Undo when read-back drops the setting', async () => {
    let calls = 0;
    const act = settingAction(
      makeDeclared({
        read: async () => {
          calls += 1;
          if (calls === 1) return { flag: true, level: 'high' };
          return { flag: true, level: undefined as unknown as string };
        },
      }),
    );
    const out = await act(actionCtx(), { target: 'level', value: 'low' });
    expect(out.uncertain).toBe(true);
    expect(out.undo).toBeUndefined();
    expect(out.changeKind).toBeUndefined();
    expect(out.title).not.toMatch(/Changed/);
    expect(out.message).toMatch(/couldn’t check/i);
  });

  it('records an uncertain outcome with no Changed and no Undo when read-back returns a different third value', async () => {
    let calls = 0;
    const act = settingAction(
      makeDeclared({
        read: async () => {
          calls += 1;
          if (calls === 1) return { flag: true, level: 'high' };
          return { flag: true, level: 'medium' };
        },
      }),
    );
    const out = await act(actionCtx(), { target: 'level', value: 'low' });
    expect(out.uncertain).toBe(true);
    expect(out.undo).toBeUndefined();
    expect(out.changeKind).toBeUndefined();
    expect(out.title).not.toMatch(/Changed/);
    expect(out.message).toContain('Custom (medium)');
    expect(out.message).not.toMatch(/Changed|Checked with/);
  });

  it('still throws when read-back shows the old value unchanged, and records Changed + Undo only on match', async () => {
    const deaf = settingAction(
      makeDeclared({
        read: async () => ({ flag: true, level: 'high' }),
      }),
    );
    await expect(deaf(actionCtx(), { target: 'level', value: 'low' })).rejects.toThrow(/didn’t take/);

    let current = 'high';
    const ok = settingAction(
      makeDeclared({
        read: async () => ({ flag: true, level: current }),
        specs: makeDeclared().specs.map((s) =>
          s.id === 'level'
            ? {
                ...s,
                write: (v) => {
                  current = String(v);
                  return { method: 'POST', path: '/level', body: { level: current } };
                },
              }
            : s,
        ),
      }),
    );
    const confirmed = await ok(actionCtx(), { target: 'level', value: 'low' });
    expect(confirmed.uncertain).toBeUndefined();
    expect(confirmed.title).toContain('Changed');
    expect(confirmed.changeKind).toBe('setting.level');
    expect(confirmed.undo).toEqual({ target: 'level', value: 'high', expect: 'low' });
    expect(confirmed.message).toContain('Checked with Demo');
  });

  it('keeps concurrent sibling changes on field-only writes, rejects 412 on conditional writes, and marks whole-object sibling changes uncertain', async () => {
    // 1. Field-only write (PATCH): a concurrent change to a sibling field between read and write is preserved.
    let fieldState = { flag: true, level: 'high', sibling: 'before' };
    let patchReads = 0;
    mockHttp.handler = (req) => {
      if (req.method === 'PATCH' && req.body) {
        const patch = JSON.parse(req.body) as Partial<typeof fieldState>;
        fieldState = { ...fieldState, ...patch };
      }
      return { status: 200, headers: {}, body: Buffer.from('{}') };
    };
    try {
      const patchAct = settingAction<typeof fieldState>({
        ...makeDeclared(),
        specs: [
          {
            id: 'level',
            group: 'main',
            label: 'Level',
            help: 'Level',
            kind: 'choice',
            read: (s) => s.level,
            choices: () => [
              { value: 'low', label: 'Low' },
              { value: 'high', label: 'High' },
            ],
            write: (v) => ({ method: 'PATCH', path: '/config', body: { level: String(v) } }),
          },
        ],
        read: async () => {
          patchReads += 1;
          const snap = { ...fieldState };
          // Another actor changes `sibling` right after Whombat reads and before it writes.
          if (patchReads === 1) fieldState.sibling = 'changed-concurrently';
          return snap;
        },
      });
      const patchDone = await patchAct(actionCtx(), { target: 'level', value: 'low' });
      expect(patchDone.uncertain).toBeUndefined();
      expect(patchDone.message).toContain('Checked with Demo');
      expect(fieldState).toEqual({ flag: true, level: 'low', sibling: 'changed-concurrently' });

      // 2. Conditional write (If-Match / ETag): a concurrent change between read and write gets 412 and saves nothing.
      let etag = '"v1"';
      let condState = { level: 'high', sibling: 'before' };
      let condReads = 0;
      mockHttp.handler = (req) => {
        if (req.method === 'PUT') {
          if (req.headers?.['If-Match'] !== etag)
            return { status: 412, headers: {}, body: Buffer.from('{"error":"precondition_failed"}') };
          condState = JSON.parse(req.body ?? '{}') as typeof condState;
          etag = '"v2"';
        }
        return { status: 200, headers: { etag }, body: Buffer.from(JSON.stringify(condState)) };
      };
      const condAct = settingAction<{ etag: string; raw: typeof condState }>({
        ...makeDeclared(),
        specs: [
          {
            id: 'level',
            group: 'main',
            label: 'Level',
            help: 'Level',
            kind: 'choice',
            read: (s) => s.raw.level,
            choices: () => [
              { value: 'low', label: 'Low' },
              { value: 'high', label: 'High' },
            ],
            write: (v, s) => ({
              method: 'PUT',
              path: '/config',
              headers: { 'If-Match': s.etag },
              body: { ...s.raw, level: String(v) },
            }),
          },
        ],
        read: async () => {
          condReads += 1;
          const snap = { etag, raw: { ...condState } };
          // Concurrent change bumps the ETag between read and write.
          if (condReads === 1) {
            condState.sibling = 'concurrent';
            etag = '"v2"';
          }
          return snap;
        },
      });
      await expect(condAct(actionCtx(), { target: 'level', value: 'low' })).rejects.toThrow(
        /Something else changed/,
      );
      expect(condState).toEqual({ level: 'high', sibling: 'concurrent' });

      // 3. Whole-object write (`untouched`): if any untouched field differs on read-back, report uncertain (never done).
      let wholeState: Record<string, unknown> = { level: 'high', sibling: 'before', nested: { keep: 1 } };
      mockHttp.handler = (req) => {
        if (req.method === 'PUT' && req.body) {
          wholeState = JSON.parse(req.body) as Record<string, unknown>;
          // Simulate a concurrent change to a sibling field visible on read-back.
          wholeState.sibling = 'other-writer';
        }
        return { status: 200, headers: {}, body: Buffer.from('{}') };
      };
      const wholeAct = settingAction<Record<string, unknown>>({
        ...makeDeclared(),
        specs: [
          {
            id: 'level',
            group: 'main',
            label: 'Level',
            help: 'Level',
            kind: 'choice',
            read: (s) => String(s.level),
            untouched: (s) => omitFields(s, 'level'),
            choices: () => [
              { value: 'low', label: 'Low' },
              { value: 'high', label: 'High' },
            ],
            write: (v, s) => ({ method: 'PUT', path: '/config', body: { ...s, level: String(v) } }),
          },
        ],
        read: async () => structuredClone(wholeState),
      });
      const wholeOut = await wholeAct(actionCtx(), { target: 'level', value: 'low' });
      expect(wholeOut.uncertain).toBe(true);
      expect(wholeOut.undo).toBeUndefined();
      expect(wholeOut.changeKind).toBeUndefined();
      expect(wholeOut.title).not.toMatch(/Changed/);
      expect(wholeOut.message).toMatch(/Another setting.*changed/i);
      expect(wholeOut.message).not.toMatch(/Checked with/);
    } finally {
      mockHttp.handler = null;
    }
  });

  it('explains in settingsPanels intro when all declared settings stay in the service', () => {
    const readOnlyDeclared = makeDeclared({
      specs: makeDeclared().specs.filter((s) => s.kind === 'elsewhere'),
    });
    const panels = settingsPanels({
      declared: readOnlyDeclared,
      settings: { flag: true, level: 'high' },
      who: { row: rowOf('plex', { id: 'con_ro', baseUrl: 'http://192.0.2.10:8080/' }) },
      url: 'http://192.0.2.10:8080/settings',
      baseUrl: 'http://192.0.2.10:8080',
      changed: new Map(),
      assistant: 'Dusty',
      now: new Date('2026-11-04T20:13:00Z'),
      timeZone: 'UTC',
    });
    const intro = panels.find((p) => p.id === 'settings-intro');
    expect(intro?.kind === 'text' ? intro.body : '').not.toContain('Change one here');
    expect(intro?.kind === 'text' ? intro.body : '').toContain('stay in Demo');
  });
});
