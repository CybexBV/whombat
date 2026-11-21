import { DeskGlance, DeskState, deskStateValid } from '@whombat/control-contracts/local';
import type { Approval, HostServer, ThingSummary, Widget, WorkingTask } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { withNotice } from '../things/quiet/connection';
import {
  approveLabel,
  boxShown,
  boxWanted,
  deskApprovalAsk,
  deskDone,
  deskFleetOf,
  deskLooks,
  deskPerson,
  deskQuestionAsk,
  deskServer,
  deskWorking,
  type FullGlance,
  glanceFresh,
  lookNotice,
  notNowSnooze,
  QuestionNumbers,
  screenText,
  sortServers,
  thingTile,
  tileIcon,
  trimGlance,
  uptimeNote,
  widgetTile,
  withResearch,
  worstOf,
} from './glance';
import type { DeskAsk, DeskBox, DeskServer } from './shapes';

function server(over: Partial<HostServer> = {}): HostServer {
  return {
    id: 'pve-01',
    name: 'pve-01',
    group: 'home',
    status: 'ok',
    statusNote: null,
    platform: 'proxmox',
    os: 'Debian GNU/Linux 12 (bookworm)',
    cpu: null,
    uptimeS: 41 * 86_400 + 300,
    cpuPct: 18.4,
    memory: { usedPct: 54.2, totalGb: 64 },
    storage: { usedPct: 40, capacityTb: 4 },
    temperature: { maxC: 46, limitC: null },
    guests: [],
    agent: { version: '1.0.0', connected: true },
    lastSeen: null,
    cpu24h: [],
    remoteControl: { console: false, power: false },
    ...over,
  } as HostServer;
}

const ask = (n: number, over: Partial<FullGlance['asks'][number]> = {}): FullGlance['asks'][number] => ({
  number: n,
  kind: 'approval',
  title: `Restart Plex on blackbox? ${n}`,
  at: '2026-10-20T12:31:00.000Z',
  where: 'blackbox',
  detail: 'Plex stopped answering at 14:31.',
  facts: ['docker restart plex', 'blackbox · Unraid'],
  approveLabel: 'Restart Plex',
  onDesk: true,
  ...over,
});

const ok = (name: string): DeskServer => ({ name, mark: 'proxmox', state: 'ok', note: 'up 41 d' });

function full(over: Partial<FullGlance> = {}): FullGlance {
  return {
    asks: [ask(7), ask(8, { kind: 'question', onDesk: true })],
    places: {},
    askCount: 2,
    doing: 'updating your server agents, two of four are done',
    working: { title: 'Update the server agents', steps: [{ label: 'pve-01', state: 'done' }] },
    done: [{ text: 'Renewed the certificate on pve-01', at: '2026-10-20T07:12:00.000Z' }],
    servers: ['a', 'b', 'c', 'd', 'e', 'f'].map(ok),
    tiles: [{ icon: 'temperature', value: '21.4 °C', label: 'Living room' }],
    worst: null,
    looks: [],
    everyLook: [],
    keys: [],
    work: { title: 'Update the server agents', steps: [{ label: 'pve-01', state: 'done' }] },
    figures: [],
    services: 3,
    recent: [{ text: 'Renewed the certificate on pve-01', at: '2026-10-20T07:12:00.000Z' }],
    doneToday: 1,
    downSince: {},
    ...over,
  };
}

describe('what the screen shows (DK-03)', () => {
  it('unlocked: everything, with each ask’s detail and its button', () => {
    const g = DeskGlance.parse(trimGlance(full(), { unlocked: true, view: 'time' }));
    expect(g.needsYou.count).toBe(2);
    expect(g.needsYou.items[0]).toMatchObject({
      number: 7,
      approveLabel: 'Restart Plex',
      facts: expect.any(Array),
    });
    expect(g.working?.title).toBe('Update the server agents');
    expect(g.done).toHaveLength(1);
    expect(g.servers).toHaveLength(4);
    expect(g.moreServers).toBe(2);
    expect(g.status.text).toContain('updating your server agents');
    expect(g.status.more).toContain('needs a decision');
  });

  it('locked with Everything: the titles and the assistant’s line, never an ask’s detail', () => {
    const g = DeskGlance.parse(trimGlance(full(), { unlocked: false, view: 'everything' }));
    expect(g.needsYou.items.map((i) => i.number)).toEqual([7, 8]);
    for (const item of g.needsYou.items) {
      expect(item).not.toHaveProperty('detail');
      expect(item).not.toHaveProperty('facts');
      expect(item).not.toHaveProperty('approveLabel');
    }
    expect(g.working).not.toBeNull();
    expect(g.done).toHaveLength(1);
    expect(g.status.text).toContain('I’m updating');
  });

  it('locked with A summary: counts, servers and tiles, no titles or message words', () => {
    const g = DeskGlance.parse(trimGlance(full(), { unlocked: false, view: 'summary' }));
    expect(g.needsYou).toEqual({ count: 2, items: [] });
    expect(g.working).toBeNull();
    expect(g.done).toEqual([]);
    expect(g.servers).toHaveLength(4);
    expect(g.tiles).toHaveLength(1);
    expect(g.status.text).toContain('2 things need you');
    expect(g.status.more).toBeUndefined();
    expect(JSON.stringify(g)).not.toContain('Plex');
  });

  it('locked with Only the time: the line and nothing else', () => {
    const g = DeskGlance.parse(trimGlance(full(), { unlocked: false, view: 'time' }));
    expect(g.servers).toEqual([]);
    expect(g.moreServers).toBe(0);
    expect(g.tiles).toEqual([]);
    expect(g.needsYou.items).toEqual([]);
    expect(g.status.text).toContain('needs you');
    const quiet = trimGlance(full({ asks: [], askCount: 0 }), { unlocked: false, view: 'time' });
    expect(quiet.status.text).toContain('fine');
  });

  it('names the worst server when one is down', () => {
    const worst = worstOf([ok('pve-01'), { ...ok('pve-02'), state: 'off' }], []);
    expect(worst).toEqual({ name: 'pve-02', down: true });
    const g = trimGlance(full({ worst }), { unlocked: false, view: 'summary' });
    expect(g.status.text).toContain('pve-02');
    const things = [{ kind: 'device', name: 'Heat pump', status: 'warn' } as ThingSummary];
    expect(worstOf([ok('pve-01')], things)).toEqual({ name: 'Heat pump', down: false });
    expect(
      worstOf(
        [
          { ...ok('a'), state: 'warn' },
          { ...ok('b'), state: 'bad' },
        ],
        [],
      ),
    ).toEqual({
      name: 'b',
      down: false,
    });
    expect(worstOf([ok('pve-01')], [])).toBeNull();
  });
});

describe('Done today: the tasks the assistant finished (done-today.md DN-03)', () => {
  const today = Date.parse('2026-10-27T00:00:00+01:00');
  const finished = [
    { text: 'Restarted Plex', at: '2026-10-27T10:05:00.000Z' },
    { text: 'Checked the status of pve-01', at: '2026-10-27T09:12:00.000Z' },
    { text: 'Cleaned up\nold backups', at: '2026-10-27T08:00:00.000Z' },
    { text: 'Updated the server agents', at: '2026-10-27T07:30:00.000Z' },
    { text: 'Renewed the certificate', at: '2026-10-26T18:00:00.000Z' },
  ];

  it('counts today’s, shows the three newest and keeps the rest for Welcome back', () => {
    const d = deskDone(finished, today);
    expect(d.doneToday).toBe(4);
    expect(d.done.map((x) => x.text)).toEqual([
      'Restarted Plex',
      'Checked the status of pve-01',
      'Cleaned up old backups',
    ]);
    expect(d.recent).toHaveLength(5);
    expect(d.recent.at(-1)?.text).toBe('Renewed the certificate');
  });

  it('nothing finished: nothing to count', () => {
    expect(deskDone([], today)).toEqual({ recent: [], done: [], doneToday: 0 });
  });
});

describe('what needs a look, in Needs you (DK-93, DK-S110, DK-S111)', () => {
  const thing = (over: Partial<ThingSummary>): ThingSummary =>
    ({
      id: 'connection:con_7Hq2v8LkP0aX',
      kind: 'connection',
      name: 'Home Assistant',
      icon: 'homeassistant',
      status: 'warn',
      reason: '2 integrations not loading',
      facts: [],
      ...over,
    }) as ThingSummary;

  it('lists the cards and things that aren’t fine, down first, with the reason and a server’s id', () => {
    const looks = deskLooks(
      [
        ok('pve-01'),
        { ...ok('nas'), id: 'nas', state: 'warn', note: 'filling up' },
        { ...ok('pve-02'), id: 'pve-02', state: 'off', note: 'off' },
      ],
      [
        thing({}),
        thing({ id: 'device:heat', kind: 'device', name: 'Heat pump', status: 'ok' }),
        thing({
          id: 'device:door',
          kind: 'device',
          name: 'Front door',
          status: 'offline',
          reason: undefined,
        }),
        thing({ id: 'server:pve-02', kind: 'server', name: 'pve-02', status: 'offline' }),
        thing({ id: 'device:new', kind: 'device', name: 'New sensor', status: 'learning' }),
      ],
    );
    expect(looks.map((l) => [l.name, l.state])).toEqual([
      ['Front door', 'down'],
      ['pve-02', 'down'],
      ['Home Assistant', 'look'],
      ['nas', 'look'],
    ]);
    expect(looks[1]).toEqual({
      key: 'server:pve-02',
      kind: 'server',
      name: 'pve-02',
      state: 'down',
      server: 'pve-02',
    });
    expect(looks[2]).toMatchObject({
      key: 'connection:con_7Hq2v8LkP0aX',
      reason: '2 integrations not loading',
    });
    expect(looks[3]).toMatchObject({ reason: 'Filling up', server: 'nas' });
    expect(looks[0]).not.toHaveProperty('reason');
  });

  it('says which line a look comes from, its kind and Ignore’s words (quiet-notices.md QN-20, QN-S17)', () => {
    const unifi = withNotice(
      thing({ id: 'connection:con_unifi', name: 'UniFi', reason: 'Hallway AP is offline' }),
      {
        check: 'unifi.device_offline',
        subject: 'device:aa',
        nature: 'problem',
        ignoreWords: 'Until it’s back online.',
        question: 'Why is Hallway AP offline in UniFi?',
      },
    );
    const signedOut = withNotice(thing({ id: 'connection:con_mail', name: 'Mail', status: 'bad' }), {
      check: 'conn.signin',
      nature: 'you',
      ignoreWords: 'Until it’s connected again.',
    });
    const looks = deskLooks([], [unifi, signedOut]);
    expect(looks.find((l) => l.name === 'UniFi')).toMatchObject({
      notice: { check: 'unifi.device_offline', subject: 'device:aa' },
      nature: 'problem',
      ignoreWords: 'Until it’s back online.',
      question: 'Why is Hallway AP offline in UniFi?',
    });
    expect(looks.find((l) => l.name === 'Mail')).toMatchObject({
      notice: { check: 'conn.signin' },
      nature: 'you',
    });
    // An older thing without a line keeps the 0.118 look.
    expect(deskLooks([], [thing({})])[0]).not.toHaveProperty('notice');
    expect(lookNotice({ check: 'x.y', nature: 'fyi' })).toEqual({});
  });

  it('leaves out a thing whose line is only a heads-up, as Needs you folds it away', () => {
    const fyi = withNotice(thing({ id: 'connection:con_ha', name: 'Home Assistant' }), {
      check: 'homeassistant.update',
      nature: 'fyi',
    });
    expect(deskLooks([], [fyi])).toEqual([]);
  });

  it('keeps five at most', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ({ ...ok(n), state: 'warn' as const }));
    expect(deskLooks(many, [])).toHaveLength(5);
    expect(deskLooks([ok('pve-01')], [])).toEqual([]);
  });

  it('shows them with the cards, locked too, never in Only the time', () => {
    const looks = deskLooks([{ ...ok('pve-02'), id: 'pve-02', state: 'off', note: 'off' }], [thing({})]);
    const summary = DeskGlance.parse(trimGlance(full({ looks }), { unlocked: false, view: 'summary' }));
    expect(summary.needsYou.looks?.map((l) => l.name)).toEqual(['pve-02', 'Home Assistant']);
    expect(summary.needsYou.count).toBe(2);
    expect(trimGlance(full({ looks }), { unlocked: false, view: 'time' }).needsYou).not.toHaveProperty(
      'looks',
    );
    expect(trimGlance(full(), { unlocked: true, view: 'time' }).needsYou).not.toHaveProperty('looks');
  });

  it('carries what the assistant found out, where titles show (look-research.md LR-09)', () => {
    const research = {
      key: 'connection:con_7Hq2v8LkP0aX',
      state: 'found' as const,
      title: 'Zigbee stopped',
      summary: 'It stopped after the update.',
      fix: 'Restart Zigbee',
      at: '2026-10-27T13:00:00.000Z',
    };
    const looks = withResearch(
      deskLooks([], [thing({})]),
      new Map([
        ['connection:con_7Hq2v8LkP0aX', research],
        ['connection:con_other', { ...research, key: 'connection:con_other' }],
      ]),
    );
    expect(looks[0]?.research).toEqual(research);
    // A research the screen couldn't draw stays out.
    const bad = new Map([['connection:con_7Hq2v8LkP0aX', { ...research, title: 'a\nb' }]]);
    expect(withResearch(deskLooks([], [thing({})]), bad)[0]).not.toHaveProperty('research');
    const open = DeskGlance.parse(trimGlance(full({ looks }), { unlocked: true, view: 'summary' }));
    expect(open.needsYou.looks?.[0]?.research?.fix).toBe('Restart Zigbee');
    const locked = DeskGlance.parse(trimGlance(full({ looks }), { unlocked: false, view: 'summary' }));
    expect(locked.needsYou.looks?.[0]).not.toHaveProperty('research');
  });
});

/** A box's panel as core makes it (its words aren't this test's). */
const BOX: DeskBox = {
  up: 'up 2 h 14 min',
  cpu: { percent: 12, cores: 8, tone: 'ok' },
  memory: { percent: 38, used: { value: '6.0', unit: 'GB' }, total: '16 GB', tone: 'ok' },
  history: { stepS: 60, cpu: [10, null, 12], memory: [37, null, 38] },
  storage: {
    percent: 86,
    free: { value: '13.0', unit: 'GB' },
    total: '100 GB',
    tone: 'warn',
    parts: [{ key: 'whombat', value: '11.0 GB', percent: 11 }],
  },
  network: { down: '2.4 MB/s', up: '310 kB/s' },
};

describe('a new box (DK-22, DK-23)', () => {
  const fresh = () =>
    full({ asks: [], askCount: 0, doing: null, working: null, servers: [], tiles: [], done: [] });

  it('shows This Whombat while there are no servers and no tiles, locked too, not in Only the time', () => {
    for (const lock of [
      { unlocked: true, view: 'time' as const },
      { unlocked: false, view: 'summary' as const },
      { unlocked: false, view: 'everything' as const },
    ])
      expect(trimGlance(fresh(), lock, BOX).box).toEqual(BOX);
    expect(trimGlance(fresh(), { unlocked: false, view: 'time' }, BOX)).not.toHaveProperty('box');
    // The manager didn't answer: no panel.
    expect(trimGlance(fresh(), { unlocked: true, view: 'summary' }, null)).not.toHaveProperty('box');
  });

  it('gives its place to the first server or home tile', () => {
    expect(boxShown(full({ tiles: [] }), 'summary')).toBe(false);
    expect(boxShown(full({ servers: [] }), 'summary')).toBe(false);
    expect(trimGlance(full({ servers: [] }), { unlocked: true, view: 'summary' }, BOX)).not.toHaveProperty(
      'box',
    );
    // Asks and work don't take its place.
    expect(boxShown(full({ servers: [], tiles: [] }), 'everything')).toBe(true);
  });

  it('says it is ready, with how to connect something, in A summary and Everything', () => {
    expect(glanceFresh(fresh())).toBe(true);
    for (const view of ['summary', 'everything'] as const) {
      const g = DeskGlance.parse(trimGlance(fresh(), { unlocked: false, view }, BOX));
      expect(g.status.text).toContain('ready when you are');
      expect(g.status.more).toContain('Connect a server');
    }
    const time = trimGlance(fresh(), { unlocked: false, view: 'time' }, BOX);
    expect(time.status).toEqual({ text: 'All fine.' });
  });

  it('isn’t new once something needs the person or is worked on', () => {
    expect(glanceFresh(full({ servers: [], tiles: [], doing: null, working: null }))).toBe(false);
    const working = full({ asks: [], askCount: 0, servers: [], tiles: [] });
    expect(glanceFresh(working)).toBe(false);
    const g = trimGlance(working, { unlocked: false, view: 'summary' }, BOX);
    expect(g.status.text).not.toContain('ready');
    expect(g.box).toEqual(BOX);
  });
});

describe('one glance that fits what there is (DK-37…DK-42)', () => {
  const tile = (n: number) => ({ icon: 'temperature' as const, value: `${n} °C`, label: `Room ${n}` });

  it('gives This Whombat beside tiles as self, never beside servers nor in Only the time (DK-100)', () => {
    const tilesOnly = full({ servers: [] });
    const g = DeskGlance.parse(trimGlance(tilesOnly, { unlocked: false, view: 'summary' }, BOX));
    expect(g.self).toEqual(BOX);
    expect(g).not.toHaveProperty('box');
    for (const over of [{ tiles: [] }, {}]) {
      const s = DeskGlance.parse(trimGlance(full(over), { unlocked: true, view: 'everything' }, BOX));
      expect(s).not.toHaveProperty('self');
      expect(s).not.toHaveProperty('box');
      expect(boxWanted(full(over), 'everything')).toBe(false);
    }
    expect(trimGlance(tilesOnly, { unlocked: false, view: 'time' }, BOX)).not.toHaveProperty('self');
    // Unlocked shows everything, whatever was chosen for locked.
    expect(trimGlance(tilesOnly, { unlocked: true, view: 'time' }, BOX).self).toEqual(BOX);
    // The manager didn't answer: nothing.
    expect(trimGlance(tilesOnly, { unlocked: true, view: 'summary' }, null)).not.toHaveProperty('self');
  });

  it('keeps the first four servers and tiles where they were and sends the next four beside them', () => {
    const many = full({
      servers: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map(ok),
      tiles: Array.from({ length: 8 }, (_, i) => tile(i)),
    });
    const g = DeskGlance.parse(trimGlance(many, { unlocked: false, view: 'summary' }, BOX));
    expect(g.servers.map((s) => s.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(g.extraServers?.map((s) => s.name)).toEqual(['e', 'f', 'g', 'h']);
    // Every server not in `servers` is counted, as before (an older console says “+6 more”).
    expect(g.moreServers).toBe(6);
    expect(g.tiles.map((t) => t.label)).toEqual(['Room 0', 'Room 1', 'Room 2', 'Room 3']);
    expect(g.extraTiles?.map((t) => t.label)).toEqual(['Room 4', 'Room 5', 'Room 6', 'Room 7']);
  });

  it('sends no extra members when four or fewer, or while only the time shows', () => {
    const few = trimGlance(full({ servers: ['a', 'b'].map(ok) }), { unlocked: false, view: 'summary' });
    expect(few).not.toHaveProperty('extraServers');
    expect(few).not.toHaveProperty('extraTiles');
    const many = full({ tiles: Array.from({ length: 8 }, (_, i) => tile(i)) });
    const time = trimGlance(many, { unlocked: false, view: 'time' }, BOX);
    expect(time.servers).toEqual([]);
    expect(time.moreServers).toBe(0);
    expect(time).not.toHaveProperty('extraServers');
    expect(time).not.toHaveProperty('extraTiles');
  });

  it('passes the console server’s check with every member', () => {
    const many = full({
      servers: ['a', 'b', 'c', 'd', 'e'].map(ok),
      tiles: Array.from({ length: 6 }, (_, i) => tile(i)),
    });
    for (const unlocked of [false, true]) {
      const state = DeskState.parse({
        v: 1,
        now: '2026-10-20T12:34:00.000Z',
        paired: {
          person: { name: 'Mara', initial: 'M', tone: 1 },
          assistant: { name: 'Dusty', face: 'hazel' },
          timeZone: 'Europe/Amsterdam',
          lockedView: 'everything',
          night: 'dim',
          quiet: false,
          voice: false,
          hasPin: false,
        },
        pairing: null,
        lock: unlocked ? { state: 'unlocked', until: '2026-10-20T12:36:00.000Z' } : { state: 'locked' },
        glance: trimGlance(many, { unlocked, view: 'everything' }, BOX),
        power: null,
        talk: null,
      });
      expect(deskStateValid(state)).toBe(true);
    }
  });
});

describe('asks with nothing more to say', () => {
  const at = '2026-10-20T12:31:00.000Z';
  /** The whole state the screen would get with these asks, checked as the console server checks it. */
  const stateOf = (asks: DeskAsk[], unlocked: boolean) =>
    DeskState.parse({
      v: 1,
      now: '2026-10-20T12:34:00.000Z',
      paired: {
        person: { name: 'Mara', initial: 'M', tone: 1 },
        assistant: { name: 'Dusty', face: 'hazel' },
        timeZone: 'Europe/Amsterdam',
        lockedView: 'everything',
        night: 'dim',
        quiet: false,
        voice: false,
        hasPin: false,
      },
      pairing: null,
      lock: unlocked ? { state: 'unlocked', until: '2026-10-20T12:36:00.000Z' } : { state: 'locked' },
      glance: trimGlance(full({ asks, askCount: asks.length }), { unlocked, view: 'everything' }),
      power: null,
      talk: null,
    });

  it('leaves out the detail of a one-line question and of an approval without an explainer', () => {
    const question = deskQuestionAsk(
      1_000_000,
      { title: 'Shall I restart Plex?', at },
      'Shall I restart Plex?',
    );
    const approval = deskApprovalAsk({
      number: 41,
      item: { title: 'Run CI on main?', body: '', at },
      approval: {
        action: {
          type: 'custom',
          params: { name: 'Run CI', keyId: 'ci.run', data: {} },
        } as Approval['action'],
        keyId: 'ci.run',
        explainer: '',
        summary: '',
      },
      view: { question: 'Run CI on main?', title: 'Run CI on main', target: '', content: null },
      args: null,
    });
    expect(question).not.toHaveProperty('detail');
    expect(approval).not.toHaveProperty('detail');
    expect(approval).not.toHaveProperty('where');
    expect(approval).toMatchObject({ number: 41, approveLabel: 'Run CI on main', onDesk: true, deny: true });
    expect(question).not.toHaveProperty('deny');
    for (const unlocked of [true, false]) {
      const state = stateOf([approval, question as DeskAsk], unlocked);
      expect(deskStateValid(state)).toBe(true);
      expect(state.glance?.needsYou.items.map((i) => i.number)).toEqual([41, 1_000_000]);
    }
    // A question's lines after the first are its detail.
    expect(
      deskQuestionAsk(1_000_001, { title: 'Restart Plex?', at }, 'Restart Plex?\n\nIt stopped at 14:31.'),
    ).toMatchObject({ detail: 'It stopped at 14:31.' });
    expect(deskQuestionAsk(1_000_002, { title: '**', at }, '**')).toBeNull();
  });
});

describe('the web card’s choices and who asks (task-feedback.md TF-14, TF-15)', () => {
  const at = '2026-10-20T12:31:00.000Z';
  const servers = deskApprovalAsk({
    number: 51,
    item: { title: 'Dusty asks: install updates', body: '', at },
    approval: {
      action: {
        type: 'connection_call',
        params: {
          connectionId: 'con_servers',
          handle: 'servers',
          tool: 'server_update',
          toolHash: 'a'.repeat(64),
          scope: 'shared',
          words: 'install 23 updates on Home Assistant',
          server: { id: 'home-assistant', name: 'Home Assistant' },
        },
      } as Approval['action'],
      keyId: 'connections.write',
      explainer: '',
      summary: '',
    },
    view: {
      question: 'Install 23 updates on Home Assistant?',
      title: 'Install 23 updates on Home Assistant',
      target: '',
      content: null,
      scopeChoices: [
        { scope: 'once', label: 'Approve and install' },
        { scope: 'agent', label: 'Don’t ask again on Home Assistant' },
      ],
    },
    args: null,
    from: 'Dusty',
  });

  it('takes the card’s title, names who asks and offers the choices beyond once', () => {
    expect(servers).toMatchObject({
      title: 'Install 23 updates on Home Assistant',
      from: 'Dusty',
      choices: [{ scope: 'agent', label: 'Don’t ask again on Home Assistant' }],
    });
  });

  it('shows them only unlocked, on a screen with a PIN, on an ask it may approve', () => {
    const items = (lock: Parameters<typeof trimGlance>[1], a: DeskAsk = servers) =>
      trimGlance(full({ asks: [a], askCount: 1 }), lock).needsYou.items;
    expect(items({ unlocked: true, view: 'everything', hasPin: true })[0]?.choices).toHaveLength(1);
    expect(items({ unlocked: true, view: 'everything', hasPin: false })[0]).not.toHaveProperty('choices');
    expect(items({ unlocked: false, view: 'everything', hasPin: true })[0]).not.toHaveProperty('choices');
    // A risky ask the screen approves with the PIN keeps them; one it can't approve has none.
    const risky = { ...servers, onDesk: false, phoneReason: 'delete' as const };
    expect(items({ unlocked: true, view: 'everything', hasPin: true }, risky)[0]).toMatchObject({
      approveWithPin: true,
      choices: [{ scope: 'agent' }],
    });
    for (const unlocked of [true, false]) {
      const g = trimGlance(full({ asks: [servers], askCount: 1 }), {
        unlocked,
        view: 'everything',
        hasPin: true,
      });
      const state = DeskState.parse({
        v: 1,
        now: '2026-10-20T12:34:00.000Z',
        paired: {
          person: { name: 'Mara', initial: 'M', tone: 1 },
          assistant: { name: 'Dusty', face: 'hazel' },
          timeZone: 'Europe/Amsterdam',
          lockedView: 'everything',
          night: 'dim',
          quiet: false,
          voice: false,
          hasPin: true,
        },
        pairing: null,
        lock: unlocked ? { state: 'unlocked', until: '2026-10-20T12:36:00.000Z' } : { state: 'locked' },
        glance: g,
        power: null,
        talk: null,
      });
      expect(deskStateValid(state)).toBe(true);
    }
  });
});

describe('servers (mock 1)', () => {
  it('draws a server with its mark, uptime and meters', () => {
    expect(deskServer(server())).toEqual({
      id: 'pve-01',
      name: 'pve-01',
      mark: 'proxmox',
      state: 'ok',
      note: 'up 41 d',
      cpu: { value: 18, tone: 'ok' },
      memory: { value: 54, tone: 'ok' },
      disk: { value: 40, tone: 'ok' },
      temp: { value: 46, tone: 'ok' },
    });
    expect(uptimeNote(5 * 3600)).toBe('up 5 h');
    expect(uptimeNote(30)).toBe('up 1 min');
  });

  it('says why one isn’t fine, colours hot or busy meters, and leaves out one still waiting to be let in', () => {
    const updating = deskServer(server({ name: 'the-falcon', statusNote: 'Updating' }));
    expect(updating).toMatchObject({ state: 'ok', note: 'updating' });
    const busy = deskServer(server({ status: 'warn', statusNote: 'Filling up', cpuPct: 95 }));
    expect(busy).toMatchObject({ state: 'warn', note: 'filling up', cpu: { tone: 'bad' } });
    const off = deskServer(server({ status: 'offline' }));
    expect(off).toMatchObject({ state: 'off', note: 'off' });
    expect(off).not.toHaveProperty('cpu');
    expect(deskServer(server({ status: 'pending' }))).toBeNull();
    expect(deskServer(server({ platform: 'standard', os: null }))?.mark).toBe('server');
  });

  it('has disk as its third line, coloured as This Whombat’s storage, and opens only with an id the desk can carry (DK-80, DK-88)', () => {
    expect(deskServer(server({ storage: { usedPct: 88.4, capacityTb: 4 } }))?.disk).toEqual({
      value: 88,
      tone: 'warn',
    });
    expect(deskServer(server({ storage: { usedPct: 95.2, capacityTb: 4 } }))?.disk?.tone).toBe('bad');
    expect(deskServer(server({ storage: { usedPct: null, capacityTb: null } }))).not.toHaveProperty('disk');
    // A slug of any length is an id; one the desk can't carry leaves the card closed.
    expect(deskServer(server({ id: 'nas', name: 'nas' }))?.id).toBe('nas');
    expect(deskServer(server({ id: '../fleet' }))).not.toHaveProperty('id');
    // The colour fits the number shown: 74.6 % reads 75 %, amber.
    expect(deskServer(server({ cpuPct: 74.6 }))?.cpu).toEqual({ value: 75, tone: 'warn' });
  });

  it('says a hot server is hot and colours it, leaving one that is off or in trouble as it is (DK-81)', () => {
    const warm = deskServer(server({ temperature: { maxC: 71, limitC: 85 } }));
    expect(warm).toMatchObject({ state: 'warn', note: 'hot · 71°', temp: { value: 71, tone: 'warn' } });
    const hot = deskServer(server({ statusNote: 'Updating', temperature: { maxC: 84.4, limitC: 80 } }));
    expect(hot).toMatchObject({ state: 'bad', note: 'hot · 84°' });
    // Without a limit, warm from 70°, hot from 85°.
    expect(deskServer(server({ temperature: { maxC: 69, limitC: null } }))?.state).toBe('ok');
    // A server to look at turns red when it is hot, and keeps what it says; warm, it stays as it is.
    const look = deskServer(
      server({ status: 'warn', statusNote: 'Disk wear', temperature: { maxC: 90, limitC: 85 } }),
    );
    expect(look).toMatchObject({ state: 'bad', note: 'disk wear' });
    const lookWarm = deskServer(
      server({ status: 'warn', statusNote: 'Disk wear', temperature: { maxC: 72, limitC: 85 } }),
    );
    expect(lookWarm).toMatchObject({ state: 'warn', note: 'disk wear' });
    const trouble = deskServer(
      server({ status: 'bad', statusNote: 'Backup failed', temperature: { maxC: 90, limitC: 85 } }),
    );
    expect(trouble).toMatchObject({ state: 'bad', note: 'backup failed' });
    expect(deskServer(server({ status: 'offline', temperature: { maxC: 90, limitC: 85 } }))).toMatchObject({
      state: 'off',
      note: 'off',
    });
    // It sorts with the servers that need a look, and the status line names it.
    const fleet = deskFleetOf([
      server({ id: 'a', name: 'a' }),
      server({ id: 'z', name: 'z', temperature: { maxC: 88, limitC: 85 } }),
    ]);
    expect(fleet.cards.map((c) => c.name)).toEqual(['z', 'a']);
    expect(worstOf(fleet.cards, [])).toEqual({ name: 'z', down: false });
  });

  it('keeps the fleet’s rows by the cards’ ids, leaving out one still waiting to be let in', () => {
    const fleet = deskFleetOf([
      server({ id: 'b', name: 'b' }),
      server({ id: 'p', name: 'p', status: 'pending' }),
    ]);
    expect(fleet.cards.map((c) => c.id)).toEqual(['b']);
    expect([...fleet.rows.keys()]).toEqual(['b']);
  });

  it('puts the worst first, then by name', () => {
    const list = sortServers([ok('b'), { ...ok('z'), state: 'warn' }, ok('a'), { ...ok('y'), state: 'bad' }]);
    expect(list.map((s) => s.name)).toEqual(['y', 'z', 'a', 'b']);
  });
});

describe('tiles', () => {
  const thing = (over: Partial<ThingSummary>): ThingSummary =>
    ({
      id: 'device:x',
      kind: 'device',
      name: 'Living room',
      icon: 'cpu',
      status: 'ok',
      facts: [],
      href: '/',
      ...over,
    }) as ThingSummary;

  it('turns a thing with a figure into a tile', () => {
    expect(thingTile(thing({ facts: [{ label: 'Temperature', value: '21.4', unit: '°C' }] }))).toEqual({
      icon: 'temperature',
      value: '21.4 °C',
      label: 'Living room',
    });
    const solar = thingTile(
      thing({
        name: 'Solar',
        facts: [
          { label: 'Now', value: '3.2', unit: 'kW' },
          { label: 'Today', value: '14.6', unit: 'kWh' },
        ],
      }),
    );
    expect(solar).toMatchObject({ icon: 'sun', value: '3.2 kW' });
    expect(solar?.label).toContain('today 14.6 kWh');
    expect(thingTile(thing({ facts: [] }))).toBeNull();
    expect(
      thingTile(thing({ kind: 'connection', catalogId: 'google', facts: [{ label: 'Unread', value: '3' }] })),
    ).toBeNull();
    expect(thingTile(thing({ status: 'offline', facts: [{ label: 'Door', value: 'Locked' }] }))?.tone).toBe(
      'bad',
    );
  });

  it('turns a pinned widget into a tile', () => {
    const w = {
      id: 'wid_1',
      title: 'Heat pump',
      kind: 'line',
      series: [{ key: 'water', label: 'Water', unit: '°C', color: 1 }],
      latest: [{ key: 'water', value: 38.04 }],
      points: [],
      refreshSec: 300,
      updatedAt: null,
    } as Widget;
    expect(widgetTile(w)).toEqual({ icon: 'heat', value: '38 °C', label: 'Heat pump' });
    expect(widgetTile({ ...w, latest: [{ key: 'water', value: null }] })).toBeNull();
    expect(tileIcon('Front door')).toBe('lock');
    expect(tileIcon('Router', 'Mbit/s')).toBe('network');
  });
});

describe('working on, asks and words', () => {
  it('keeps up to six steps around the one going on', () => {
    const steps = Array.from({ length: 9 }, (_, i) => ({
      title: `step ${i}`,
      state: (i < 5 ? 'done' : i === 5 ? 'active' : 'todo') as WorkingTask['steps'][number]['state'],
    }));
    const w = deskWorking({
      conversationId: 'c',
      title: 'Update',
      startedAt: '',
      progress: { done: 5, total: 9 },
      steps,
    });
    expect(w?.steps).toHaveLength(6);
    expect(w?.steps.map((s) => s.label)).toEqual([
      'step 3',
      'step 4',
      'step 5',
      'step 6',
      'step 7',
      'step 8',
    ]);
    expect(w?.steps.map((s) => s.state)).toEqual(['done', 'done', 'now', 'next', 'next', 'next']);
    expect(deskWorking(null)).toBeNull();
  });

  it('labels Approve with the ask’s own words', () => {
    expect(approveLabel('Restart Plex on blackbox?', 'blackbox')).toBe('Restart Plex');
    expect(approveLabel('Create the channel #ops', undefined)).toBe('Create the channel #ops');
    expect(approveLabel('x'.repeat(60), undefined)).toBe('Approve');
  });

  it('keeps display strings on one printable line', () => {
    expect(screenText('Hello\n\n**world**‮​  again', 200)).toBe('Hello world again');
    expect(screenText('abcdefghij', 5)).toBe('abcd…');
    expect(screenText(null, 5)).toBe('');
  });

  it('numbers questions on their own, stable while it runs', () => {
    const q = new QuestionNumbers();
    const a = q.of('msg_a');
    expect(q.of('msg_b')).toBe(a + 1);
    expect(q.of('msg_a')).toBe(a);
    expect(a).toBeGreaterThanOrEqual(1_000_000);
    expect(q.messageOf(a + 1)).toBe('msg_b');
    expect(q.messageOf(12)).toBeNull();
  });

  it('makes the screen’s Not now Home’s: snoozed until tomorrow at 09:00, never a decline (DK-S19)', () => {
    const now = new Date('2026-10-20T21:30:00.000Z'); // 23:30 in Amsterdam
    expect(notNowSnooze({ kind: 'approval', number: 12 }, now, 'Europe/Amsterdam')).toEqual({
      ref: { kind: 'approval', id: '12' },
      until: '2026-10-21T07:00:00.000Z',
    });
    expect(notNowSnooze({ kind: 'question', messageId: 'msg_q' }, now, 'UTC')).toEqual({
      ref: { kind: 'question', id: 'msg_q' },
      until: '2026-10-21T09:00:00.000Z',
    });
  });

  it('draws the person by their first name, initial and tone', () => {
    expect(deskPerson({ name: 'John Doe', kind: 'person', shortName: 'John', tone: '#dcc0cc' })).toEqual({
      name: 'John',
      initial: 'J',
      tone: 2,
    });
    expect(deskPerson({ name: 'Éva', kind: 'person', shortName: null, tone: null }).tone).toBe(1);
  });
});

describe('what an ask allows (DK-61, DK-62, DK-S62)', () => {
  const risky = ask(9, { onDesk: false, phoneReason: 'release', deny: true });
  const glance = full({ asks: [ask(7, { deny: true }), risky], askCount: 2 });

  it('approves a risky ask with the PIN only on a screen that has one', () => {
    const items = (hasPin: boolean) =>
      trimGlance(glance, { unlocked: true, view: 'summary', hasPin }).needsYou.items;
    expect(items(true).map((a) => a.approveWithPin ?? false)).toEqual([false, true]);
    expect(items(false).map((a) => a.approveWithPin ?? false)).toEqual([false, false]);
    expect(items(true).map((a) => a.deny)).toEqual([true, true]);
  });

  it('says which asks were made in the open conversation, locked too, and stays valid', () => {
    for (const unlocked of [true, false]) {
      const g = trimGlance(glance, {
        unlocked,
        view: 'everything',
        hasPin: true,
        inTalk: (n) => n === 9,
      });
      expect(g.needsYou.items.map((a) => a.inTalk ?? false)).toEqual([false, true]);
      const state = DeskState.parse({
        v: 1,
        now: '2026-10-20T12:34:00.000Z',
        paired: {
          person: { name: 'Mara', initial: 'M', tone: 1 },
          assistant: { name: 'Dusty', face: 'neo' },
          timeZone: 'Europe/Amsterdam',
          lockedView: 'everything',
          night: 'dim',
          quiet: false,
          voice: true,
          hasPin: false,
        },
        pairing: null,
        lock: unlocked ? { state: 'unlocked', until: '2026-10-20T12:36:00.000Z' } : { state: 'locked' },
        glance: g,
        power: null,
        talk: null,
      });
      expect(deskStateValid(state)).toBe(true);
    }
  });
});
