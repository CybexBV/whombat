import { type DeskWidgetSpec, DeskWidgetView, type Widget } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { PrincipalRow } from '../../read/principals';
import type { Services } from '../../services';
import type { DeskServer } from '../shapes';
import { type GlanceFacts, screenViews, trimView, WidgetResolver } from './resolve';
import type { ServerLine } from './servers';
import type { Resolved, ThingWidgets, WidgetCtx } from './types';

let now = Date.parse('2026-10-27T14:34:00.000Z');
const services = { clock: () => new Date(now) } as unknown as Services;
const ctx = (): WidgetCtx => ({
  services,
  viewer: {
    accountId: 'acc_1',
    burrowId: 'brw_1',
    principal: { id: 'prn_1', burrowId: 'brw_1' } as PrincipalRow,
  },
  now: new Date(now),
  timeZone: 'Europe/Amsterdam',
  assistant: 'Dusty',
});

const card: DeskServer = {
  id: 'pve-01',
  name: 'pve-01',
  mark: 'proxmox',
  state: 'ok',
  note: 'up 41 d',
  cpu: { value: 12, tone: 'ok' },
};
const facts: GlanceFacts = {
  work: { title: 'Updating the server agents', steps: [{ label: 'pve-01', state: 'now' }] },
  coming: [],
  recent: [],
  startOfToday: now - 3_600_000,
  servers: [card],
};

const spec = (id: string, over: Partial<DeskWidgetSpec>): DeskWidgetSpec => ({
  id,
  type: 'clock',
  opts: {},
  ...over,
});
const SPECS = [
  spec('w_clock', {}),
  spec('w_work', { type: 'work' }),
  spec('w_srv', { type: 'server', ref: 'server:pve-01' }),
  spec('w_home', { type: 'widget', ref: 'widget:wdg_1' }),
  spec('w_fig', { type: 'figures', ref: 'connection:con_plex' }),
  spec('w_now', { type: 'panel', ref: 'connection:con_plex', opts: { panel: 'now' } }),
];

const homeWidget: Widget = {
  id: 'wdg_1',
  title: 'Living room',
  kind: 'line',
  series: [{ key: 'temp', label: 'Temperature', color: 1 }],
  latest: [{ key: 'temp', value: 21 }],
  points: [],
  refreshSec: 300,
  updatedAt: null,
};

/** A thing's widgets that count their calls; `hold` keeps a read open until let go. */
function fakeThings() {
  const calls: string[][] = [];
  let hold: Promise<void> | null = null;
  let fail = false;
  const things: ThingWidgets = {
    async groups() {
      return [];
    },
    async resolve(_ctx, specs) {
      calls.push(specs.map((s) => s.id));
      if (hold) await hold;
      if (fail) throw new Error('down');
      return new Map(
        specs.map((s): [string, Resolved] => [
          s.id,
          {
            view: { kind: 'list', id: s.id, title: 'Now playing', rows: [{ title: `read ${calls.length}` }] },
            private: true,
            refreshS: 30,
          },
        ]),
      );
    },
  };
  return {
    things,
    calls,
    hold(): () => void {
      let release = () => {};
      hold = new Promise((r) => {
        release = () => {
          hold = null;
          r();
        };
      });
      return release;
    },
    fail(on: boolean) {
      fail = on;
    },
  };
}

function resolver(things: ThingWidgets) {
  const reads = { fleet: 0, line: 0, home: 0 };
  const r = new WidgetResolver(services, () => things, {
    fleet: async () => {
      reads.fleet++;
      return { cards: [card], rows: new Map() };
    },
    line: async (): Promise<ServerLine> => {
      reads.line++;
      return { spark: [1, 2, 3], avg: 2, peak: { percent: 3, at: new Date(now).toISOString() } };
    },
    homeWidgets: async () => {
      reads.home++;
      return [homeWidget];
    },
  });
  return { r, reads };
}

describe('resolving a screen’s widgets (DK-142, DK-148)', () => {
  it('answers at once from what it has, and has the rest once read', async () => {
    const t = fakeThings();
    const { r } = resolver(t.things);
    const first = await r.resolve(ctx(), SPECS, facts, 0);
    // Whombat's own and a server the glance knows have views at once; the clock has none of its own.
    expect([...first.keys()].sort()).toEqual(['w_srv', 'w_work']);
    const second = await r.resolve(ctx(), SPECS, facts, 1_000);
    expect([...second.keys()].sort()).toEqual(['w_fig', 'w_home', 'w_now', 'w_srv', 'w_work']);
    const server = second.get('w_srv')?.view;
    expect(server?.kind === 'server' && server.spark).toEqual([1, 2, 3]);
    // One call for every thing's widget that was due.
    expect(t.calls).toEqual([['w_fig', 'w_now']]);
  });

  it('reads a widget again only when its time is up, showing the old one meanwhile', async () => {
    const t = fakeThings();
    const { r, reads } = resolver(t.things);
    const only = [SPECS[4] as DeskWidgetSpec, SPECS[2] as DeskWidgetSpec];
    await r.resolve(ctx(), only, facts, 1_000);
    now += 20_000;
    await r.resolve(ctx(), only, facts, 1_000);
    expect(t.calls).toHaveLength(1);
    expect(reads.fleet).toBe(1);
    now += 15_000;
    const release = t.hold();
    const stale = await r.resolve(ctx(), only, facts, 1_000);
    // Its time was up: read again in the background, the old view answered without waiting.
    expect(t.calls).toHaveLength(2);
    const old = stale.get('w_fig')?.view;
    expect(old?.kind === 'list' && old.rows[0]?.title).toBe('read 1');
    release();
    await r.idle();
    const fresh = await r.resolve(ctx(), only, facts, 1_000);
    const next = fresh.get('w_fig')?.view;
    expect(next?.kind === 'list' && next.rows[0]?.title).toBe('read 2');
  });

  it('reads the same widget on two pages once, each with its own id', async () => {
    const t = fakeThings();
    const { r } = resolver(t.things);
    const twice = [
      spec('w_a', { type: 'figures', ref: 'connection:con_plex' }),
      spec('w_b', { type: 'figures', ref: 'connection:con_plex', opts: { lock: 'show' } }),
    ];
    const out = await r.resolve(ctx(), twice, facts, 1_000);
    expect(t.calls).toEqual([['w_a']]);
    expect(out.get('w_a')?.view.id).toBe('w_a');
    expect(out.get('w_b')?.view.id).toBe('w_b');
  });

  it('says why a widget it couldn’t read can’t show, and tries again within a minute', async () => {
    const t = fakeThings();
    t.fail(true);
    const { r } = resolver(t.things);
    const one = [SPECS[4] as DeskWidgetSpec];
    const out = await r.resolve(ctx(), one, facts, 1_000);
    const view = out.get('w_fig')?.view;
    expect(view?.kind).toBe('text');
    expect(view?.problem?.text).toBeTruthy();
    t.fail(false);
    now += 30_000;
    await r.resolve(ctx(), one, facts, 1_000);
    expect(t.calls).toHaveLength(1);
    now += 31_000;
    await r.resolve(ctx(), one, facts, 1_000);
    expect(t.calls).toHaveLength(2);
    await r.idle();
    const again = await r.resolve(ctx(), one, facts, 0);
    expect(again.get('w_fig')?.view.kind).toBe('list');
  });

  it('has no server view until it knows the server, then says when it’s gone', async () => {
    const t = fakeThings();
    const { r } = resolver(t.things);
    const gone = [spec('w_gone', { type: 'server', ref: 'server:pve-09' })];
    expect((await r.resolve(ctx(), gone, null, 0)).get('w_gone')).toBeUndefined();
    const later = await r.resolve(ctx(), gone, null, 1_000);
    expect(later.get('w_gone')?.view.kind).toBe('text');
  });
});

describe('a server widget while the servers can’t be read', () => {
  it('says so instead of showing the figures it read before', async () => {
    let failing = false;
    const r = new WidgetResolver(services, () => fakeThings().things, {
      fleet: async () => {
        if (failing) throw new Error('hosts down');
        return { cards: [card], rows: new Map() };
      },
      line: async (): Promise<ServerLine> => ({ spark: [], avg: 0, peak: null }),
    });
    const one = [spec('w_srv', { type: 'server', ref: 'server:pve-01' })];
    await r.resolve(ctx(), one, null, 1_000);
    expect((await r.resolve(ctx(), one, null, 0)).get('w_srv')?.view.kind).toBe('server');
    failing = true;
    now += 61_000;
    await r.resolve(ctx(), one, null, 1_000);
    await r.idle();
    const after = (await r.resolve(ctx(), one, null, 0)).get('w_srv')?.view;
    expect(after?.kind).toBe('text');
    expect(after?.problem?.text).toBeTruthy();
  });
});

describe('the lock’s trimming (DK-138)', () => {
  const list: Resolved = {
    view: {
      kind: 'list',
      id: 'w_now',
      title: 'Now playing',
      name: 'Plex',
      mark: 'plex',
      head: '2 watching',
      rows: [{ title: 'Dune' }],
    },
    private: true,
    refreshS: 30,
  };

  it('leaves out a private widget’s words in a summary, unless the person chose to show them', () => {
    const trimmed = trimView(list, {}, 'summary');
    expect(trimmed).toEqual({
      kind: 'list',
      id: 'w_now',
      title: 'Now playing',
      name: 'Plex',
      mark: 'plex',
      rows: [],
      locked: true,
    });
    expect(trimView(list, { lock: 'show' }, 'summary')).toBe(list.view);
    expect(trimView(list, {}, 'everything')).toBe(list.view);
    expect(trimView(list, { lock: 'show' }, 'time')).toBeNull();
    expect(trimView({ ...list, private: false }, {}, 'summary')).toBe(list.view);
  });

  it('keeps every kind one the screen takes', () => {
    const views: Resolved['view'][] = [
      { kind: 'figures', id: 'w_1', title: 'T', items: [{ value: '1', label: 'x' }] },
      { kind: 'posters', id: 'w_2', title: 'T', items: [{ title: 'Dune' }], shape: 'poster' },
      { kind: 'chart', id: 'w_3', title: 'T', series: [{ points: [1, 2] }], figure: { value: '2' } },
      { kind: 'camera', id: 'w_4', title: 'T', event: 'Someone at the door' },
      { kind: 'server', id: 'w_5', title: 'T', state: 'ok', server: 'pve-01', cpu: 3 },
      { kind: 'text', id: 'w_6', title: 'T', body: 'Private words' },
    ];
    for (const view of views) {
      const trimmed = trimView({ view, private: true, refreshS: 60 }, {}, 'summary');
      expect(DeskWidgetView.safeParse(trimmed).success).toBe(true);
      expect(trimmed?.locked).toBe(true);
      expect(JSON.stringify(trimmed)).not.toMatch(/Dune|door|Private words/);
    }
  });

  it('leaves out a view the contract wouldn’t take, and says so', () => {
    const warned: string[] = [];
    const bad: Resolved = {
      view: { kind: 'text', id: 'w_bad', title: '', body: 'x' },
      private: false,
      refreshS: 60,
    };
    const views = screenViews(
      [spec('w_now', {}), spec('w_bad', {})],
      new Map([
        ['w_now', list],
        ['w_bad', bad],
      ]),
      'everything',
      (_m, id) => warned.push(id),
    );
    expect(views.map((v) => v.id)).toEqual(['w_now']);
    expect(warned).toEqual(['w_bad']);
  });
});
