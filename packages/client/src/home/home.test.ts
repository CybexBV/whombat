import type { ChangeEntry, ChatSummary, NeedsYouItem, ThingSummary, Widget } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { cardDisplay, deviceSkillLine } from '../cardDisplay';
import { canUndo, doneRows } from './changes';
import { chatBadge, chatRows, chatSubline } from './chats';
import { greetingFor, homeGreeting, homeStatusLine, statusText, workingPhrase } from './greeting';
import { investigateText, needsYouIntent, needsYouRows, withoutNeedsYou } from './needsYou';
import { listedThings, partsOf, thingRows, thingTiles } from './things';
import {
  atText,
  automationWhen,
  doneWhen,
  localAt,
  needsYouWhen,
  nextAt,
  tomorrowMorning,
  untilText,
} from './time';
import {
  movedWidgets,
  refreshPhrase,
  valueAxis,
  widgetChart,
  widgetFooter,
  widgetTimeTicks,
} from './widgets';

const TZ = 'Europe/Amsterdam';
/** Saturday 26 September 2026, 14:05 in Amsterdam (UTC+2). */
const NOW = new Date('2026-09-26T12:05:00Z');
const local = (day: number, hhmm: string) =>
  new Date(`2026-09-${String(day).padStart(2, '0')}T${hhmm}:00+02:00`).toISOString();

describe('Home’s first lines (AP-1265)', () => {
  it('greets by the local hour and the first name', () => {
    expect(greetingFor(new Date('2026-09-26T07:00:00Z'), TZ)).toBe('Good morning');
    expect(greetingFor(NOW, TZ)).toBe('Good afternoon');
    expect(greetingFor(new Date('2026-09-26T19:00:00Z'), TZ)).toBe('Good evening');
    expect(greetingFor(new Date('2026-09-26T01:00:00Z'), TZ)).toBe('Good evening');
    expect(homeGreeting('John Doe', NOW, TZ)).toBe('Good afternoon, John');
    expect(homeGreeting(null, NOW, TZ)).toBe('Good afternoon');
  });

  it('says what Whombat is doing as it would', () => {
    expect(workingPhrase('Adding your Daikin heat pump')).toBe('I’m adding your Daikin heat pump');
    expect(workingPhrase('Night-time heating')).toBe('I’m working on Night-time heating');
  });

  it('says what needs you in bold and what Whombat is on, and never “running” over something offline', () => {
    const line = homeStatusLine({
      summary: { needsYou: 3, working: 1, problems: 0 },
      chats: [
        {
          title: 'Adding your Daikin heat pump',
          state: 'working',
          default: false,
        } as never,
      ],
    });
    expect(statusText(line)).toBe('3 things need you, and I’m adding your Daikin heat pump.');
    expect(line.find((p) => p.strong)?.text).toBe('3 things need you');
    expect(
      statusText(
        homeStatusLine({
          summary: { needsYou: 1, working: 0, problems: 2 },
          things: [
            { name: 'pve-01', status: 'offline' },
            { name: 'pve-02', status: 'warn' },
          ],
        }),
      ),
    ).toBe('pve-01 is offline. 1 thing needs you.');
    expect(statusText(homeStatusLine({ summary: { needsYou: 0, working: 0, problems: 0 } }))).toBe(
      'All good. Nothing needs you.',
    );
  });
});

describe('the shell’s times (AP-1264)', () => {
  it('Needs you waits in days, changes by weekday, automations by what they did', () => {
    expect(needsYouWhen(local(26, '10:12'), NOW, TZ)).toBe('10:12');
    expect(needsYouWhen(local(23, '09:00'), NOW, TZ)).toBe('3 days ago');
    expect(doneWhen(local(26, '03:00'), NOW, TZ)).toBe('03:00');
    expect(doneWhen(local(25, '18:00'), NOW, TZ)).toBe('Fri');
    expect(doneWhen(local(10, '18:00'), NOW, TZ)).toBe('10 Sep');
    expect(automationWhen({ state: 'ran', at: local(26, '08:00') }, TZ)).toBe('ran 08:00');
    expect(automationWhen({ state: 'scheduled', at: local(26, '22:00') }, TZ)).toBe('runs 22:00');
  });

  it('“Remind me tomorrow” is 09:00 local tomorrow, “tonight at 03:00” the next 03:00, across a clock change', () => {
    expect(tomorrowMorning(NOW, TZ)).toBe('2026-09-27T07:00:00.000Z');
    expect(nextAt(NOW, TZ, '03:00')).toBe('2026-09-27T01:00:00.000Z');
    expect(nextAt(new Date('2026-09-26T00:30:00Z'), TZ, '03:00')).toBe('2026-09-26T01:00:00.000Z');
    // Summer time ends on Sunday 25 October: 09:00 on Monday is 08:00 UTC.
    expect(localAt(new Date('2026-10-25T00:30:00Z'), TZ, '09:00', 1)).toBe('2026-10-26T08:00:00.000Z');
    expect(untilText('2026-09-27T07:00:00.000Z', NOW, TZ)).toBe('until tomorrow 09:00');
    expect(atText('2026-09-27T07:00:00.000Z', NOW, TZ)).toBe('tomorrow at 09:00');
    expect(atText(local(26, '18:00'), NOW, TZ)).toBe('at 18:00');
  });
});

const item = (over: Partial<NeedsYouItem> = {}): NeedsYouItem => ({
  id: 'ny_1',
  ref: { kind: 'approval', id: '901' },
  kind: 'approval',
  severity: 'warn',
  title: 'Restart arnica-prod-nest-01 on pve-02?',
  body: 'It needs a restart.',
  at: local(26, '10:12'),
  actions: [],
  approvalNumber: 901,
  ...over,
});

describe('Needs you (AP-1266)', () => {
  it('turns each button into what it does', () => {
    expect(needsYouIntent(item(), { kind: 'approve' }, NOW, TZ)).toEqual({ type: 'approve', number: 901 });
    expect(
      needsYouIntent(item(), { kind: 'approve_later', at: '2026-09-27T01:00:00.000Z' }, NOW, TZ),
    ).toEqual({
      type: 'approveLater',
      number: 901,
      executeAt: '2026-09-27T01:00:00.000Z',
    });
    expect(needsYouIntent(item(), { kind: 'snooze' }, NOW, TZ)).toEqual({
      type: 'snooze',
      ref: { kind: 'approval', id: '901' },
      until: '2026-09-27T07:00:00.000Z',
    });
    expect(needsYouIntent(item({ approvalNumber: undefined }), { kind: 'approve' }, NOW, TZ)).toEqual({
      type: 'none',
    });
    const alert = item({
      kind: 'alert',
      title: 'The disk array on blackbox has failed',
      subject: { kind: 'server', id: 'blackbox', name: 'blackbox' },
    });
    expect(needsYouIntent(alert, { kind: 'investigate' }, NOW, TZ)).toEqual({
      type: 'investigate',
      text: 'The disk array on blackbox has failed\nCan you look into it?',
      subject: { kind: 'server', id: 'blackbox', name: 'blackbox' },
    });
    expect(investigateText(alert)).toMatch(/^The disk array/);
  });

  it('draws a glyph by kind and the corner time; a snoozed item leaves with its count', () => {
    const rows = needsYouRows(
      [item(), item({ id: 'ny_2', kind: 'device_skill', severity: 'info' })],
      NOW,
      TZ,
    );
    expect(rows.map((r) => [r.glyph, r.tone, r.when])).toEqual([
      ['power', 'warn', '10:12'],
      ['skill', 'info', '10:12'],
    ]);
    const overview = { needsYou: [item()], summary: { needsYou: 3 } };
    expect(withoutNeedsYou(overview, { kind: 'approval', id: '901' })).toEqual({
      needsYou: [],
      summary: { needsYou: 2 },
    });
  });
});

const thing = (over: Partial<ThingSummary>): ThingSummary => ({
  id: 'server:pve-02',
  kind: 'server',
  name: 'pve-02',
  icon: 'server',
  status: 'warn',
  facts: [],
  href: '/things/server%3Apve-02',
  ...over,
});

describe('your things (AP-1267)', () => {
  it('lists servers in mono, devices being learned as learning, with a labelled dot', () => {
    const rows = thingRows(
      [
        thing({}),
        thing({
          id: 'device:con_hp',
          kind: 'device',
          name: 'Heat pump',
          icon: 'thermometer',
          status: 'learning',
        }),
      ],
      'server:pve-02',
    );
    expect(rows.map((r) => [r.name, r.mono, r.learning, r.glyph, r.selected, r.label])).toEqual([
      ['pve-02', true, false, 'server', true, 'pve-02, needs a look'],
      ['Heat pump', false, true, 'thermometer', false, 'Heat pump, learning'],
    ]);
  });

  it('draws a dot only when it isn’t fine, and says why (SB-03, SB-04; AP-2603, AP-2604)', () => {
    const rows = thingRows([
      thing({ status: 'warn', reason: 'Filling up' }),
      thing({ id: 'server:pve-01', name: 'pve-01', status: 'ok', reason: 'stale' }),
      thing({ id: 'server:pve-03', name: 'pve-03', status: 'unknown' }),
      thing({ id: 'server:pve-04', name: 'pve-04', status: 'offline' }),
    ]);
    expect(rows.map((r) => [r.name, r.dot, r.reason, r.tip])).toEqual([
      ['pve-02', true, 'Filling up', 'pve-02 · Filling up'],
      ['pve-01', false, null, 'pve-01'],
      ['pve-03', false, null, 'pve-03'],
      ['pve-04', true, null, 'pve-04 · Offline'],
    ]);
    expect(rows[0]?.label).toBe('pve-02, needs a look: filling up');
    expect(rows[1]?.label).toBe('pve-01, running fine');
  });

  it('draws what tells a connection apart quieter, never a server’s host name', () => {
    const rows = thingRows([
      thing({ id: 'server:a · b', name: 'a · b' }),
      thing({ id: 'connection:con_1', kind: 'connection', name: 'Hetzner Cloud · dev' }),
      thing({ id: 'connection:con_2', kind: 'connection', name: 'Hetzner Cloud' }),
      thing({ id: 'connection:con_3', kind: 'connection', name: ' · dev' }),
    ]);
    expect(rows.map((r) => [r.main, r.note])).toEqual([
      ['a · b', null],
      ['Hetzner Cloud', 'dev'],
      ['Hetzner Cloud', null],
      [' · dev', null],
    ]);
  });

  it('gives a tile to connections with facts, titled by what they are for or by their name', () => {
    const tiles = thingTiles([
      thing({}),
      thing({
        id: 'connection:con_ha',
        kind: 'connection',
        catalogId: 'homeassistant',
        name: 'Home Assistant',
        icon: 'home',
        status: 'warn',
        line: 'Home Assistant 2026.10.2',
        facts: [{ label: 'Integrations', value: '169 of 171' }],
      }),
      thing({
        id: 'connection:con_unifi',
        kind: 'connection',
        catalogId: 'unifi',
        name: 'UniFi',
        icon: 'wifi',
        status: 'ok',
        line: '45 devices',
        facts: [{ label: 'Access points', value: '21 of 22', note: 'online' }],
      }),
      thing({
        id: 'connection:con_mail',
        kind: 'connection',
        name: 'Mail',
        icon: 'mail',
        status: 'ok',
        facts: [],
      }),
    ]);
    // Home Assistant's tile is titled by its name (connection-pages.md CP-16); UniFi's by what it is for.
    expect(tiles.map((t) => [t.title, t.meta, t.status, t.facts])).toEqual([
      [
        'Home Assistant',
        'Home Assistant 2026.10.2',
        'warn',
        [{ label: 'Integrations', value: '169 of 171', note: null }],
      ],
      [
        'Network',
        'UniFi · 45 devices',
        'ok',
        [{ label: 'Access points', value: '21 of 22', note: 'online' }],
      ],
    ]);
  });

  it('leaves the parts of a server out of the sidebar and Home, and finds them for the server’s page (CP-10)', () => {
    const api = thing({
      id: 'connection:con_pve',
      kind: 'connection',
      catalogId: 'proxmox',
      name: 'Proxmox VE API',
      status: 'ok',
      facts: [{ label: 'Guests', value: '23' }],
      partOf: 'server:pve-02',
    });
    const things = [thing({}), api];
    expect(listedThings(things).map((t) => t.id)).toEqual(['server:pve-02']);
    expect(thingRows(things).map((r) => r.id)).toEqual(['server:pve-02']);
    expect(thingTiles(things)).toEqual([]);
    expect(partsOf(things, 'server:pve-02').map((t) => t.name)).toEqual(['Proxmox VE API']);
    expect(partsOf(things, 'server:pve-01')).toEqual([]);
  });
});

const hours = (n: number, from: string) =>
  Array.from({ length: n }, (_, i) => new Date(Date.parse(from) + i * 900_000).toISOString());

describe('widgets (AP-1268)', () => {
  it('uses a round value axis from 0', () => {
    expect(valueAxis([4, 39.2, 21])).toEqual({ min: 0, max: 50, ticks: [0, 10, 20, 30, 40, 50] });
    expect(valueAxis([-3, 9]).min).toBeLessThan(0);
  });

  it('labels every 4 hours and the last point with its own time, never Now', () => {
    const times = hours(57, '2026-09-25T22:00:00Z').map((t) => Date.parse(t)); // 00:00 → 14:00 local
    const fiveLater = Date.parse('2026-09-26T12:05:00Z');
    const labels = widgetTimeTicks(times, TZ, fiveLater).map((t) => t.label);
    expect(labels).toEqual(['00:00', '04:00', '08:00', '5 min ago · 14:00']);
    expect(labels).not.toContain('Now');
    // Without a clock to compare with, the last point says its time alone.
    const short = hours(49, '2026-09-25T22:00:00Z').map((t) => Date.parse(t)); // 00:00 → 12:00 local
    expect(widgetTimeTicks(short, TZ).map((t) => t.label)).toEqual(['00:00', '04:00', '08:00', '12:00']);
  });

  it('shows the latest with the decimals its line carries, and says it refreshes without the AI', () => {
    const widget: Widget = {
      id: 'wdg_hp' as never,
      title: 'Heat pump · today',
      subtitle: 'Daikin Altherma',
      kind: 'line',
      series: [
        { key: 'room', label: 'Room', unit: '°C', color: 1 },
        { key: 'water', label: 'Water to radiators', unit: '°C', color: 2 },
      ],
      latest: [
        { key: 'room', value: 21, unit: '°C' },
        { key: 'water', value: 34, unit: '°C' },
      ],
      points: [
        { t: '2026-09-26T10:00:00Z', values: { room: 20.5, water: 30 } },
        { t: '2026-09-26T12:00:00Z', values: { room: 21, water: 34 } },
      ],
      refreshSec: 60,
      updatedAt: NOW.toISOString(),
      fromConversationId: 'cnv_heat' as never,
    };
    const model = widgetChart(widget, TZ);
    expect(model.lines.map((l) => [l.label, l.latest])).toEqual([
      ['Room', '21.0'],
      ['Water to radiators', '34'],
    ]);
    expect(model.tickLabel(50)).toBe('50°');
    expect(model.footer).toBe(
      'You pinned this from a conversation. It updates every minute without asking the AI.',
    );
    expect(widgetFooter({ refreshSec: 3600 })).toBe(
      'You pinned this. It updates every hour without asking the AI.',
    );
    expect(refreshPhrase(300)).toBe('every 5 minutes');
    expect(movedWidgets([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'c', 0).map((w) => w.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });
});

const change = (over: Partial<ChangeEntry>): ChangeEntry => ({
  id: 'chg_1' as never,
  title: 'Gave nextcloud more memory',
  detail: '2 → 4 GB, on pve-02',
  at: local(26, '10:12'),
  actor: { kind: 'whombat', id: 'prn_w' as never, name: 'Whombat' },
  undo: { state: 'available', until: '2026-09-27T08:12:00Z' },
  ...over,
});

describe('Done recently (AP-1269)', () => {
  it('offers Undo in its window, Review where there is a place to look, nothing once undone', () => {
    const rows = doneRows(
      [
        change({}),
        change({ id: 'chg_2' as never, undo: { state: 'none' }, link: '/chats/cnv_mail' }),
        change({ id: 'chg_3' as never, undo: { state: 'available', until: '2026-09-26T10:00:00Z' } }),
        change({ id: 'chg_4' as never, undo: { state: 'undone' }, link: '/x' }),
      ],
      NOW,
      TZ,
    );
    expect(rows.map((r) => [r.action, r.undone, r.when])).toEqual([
      ['undo', false, '10:12'],
      ['review', false, '10:12'],
      [null, false, '10:12'],
      [null, true, '10:12'],
    ]);
    expect(canUndo(change({ undo: { state: 'available' } }), NOW)).toBe(true);
  });

  it('offers no Review on the page the change links to (AP-4573)', () => {
    const here = '/things/connection%3Acon_sab';
    const rows = doneRows(
      [
        change({ id: 'chg_1' as never, undo: { state: 'none' }, link: here }),
        change({ id: 'chg_2' as never, undo: { state: 'none' }, link: '/chats/cnv_mail' }),
      ],
      NOW,
      TZ,
      { here },
    );
    expect(rows.map((r) => r.action)).toEqual([null, 'review']);
  });
});

const chat = (over: Partial<ChatSummary>): ChatSummary => ({
  id: 'cnv_a' as never,
  title: 'Add our heat pump',
  lastAt: local(26, '13:41'),
  unread: 0,
  default: false,
  ...over,
});

describe('task chats (AP-1270)', () => {
  it('lists chats newest first, archived out, the default chat only while unread or open', () => {
    const chats = [
      chat({ id: 'cnv_old' as never, title: 'Customer mail every morning', lastAt: local(24, '08:00') }),
      chat({}),
      chat({ id: 'cnv_def' as never, title: 'Whombat', default: true, lastAt: local(26, '14:00') }),
      chat({ id: 'cnv_arch' as never, title: 'Gone', archivedAt: local(25, '10:00') }),
    ];
    expect(chatRows(chats).map((r) => r.title)).toEqual(['Add our heat pump', 'Customer mail every morning']);
    expect(chatRows(chats, 'cnv_def').map((r) => [r.title, r.bold])).toEqual([
      ['Whombat', true],
      ['Add our heat pump', false],
      ['Customer mail every morning', false],
    ]);
  });

  it('says when a chat started and what it is about; a device being learned gets its badge', () => {
    const conversation = {
      createdAt: local(26, '13:20'),
      chat: {
        title: 'Add our heat pump',
        subject: { kind: 'device' as const, id: 'con_hp', name: 'Heat pump' },
      },
    };
    expect(chatSubline(conversation, TZ)).toBe('Started 13:20 · about Heat pump');
    expect(chatBadge(conversation, [{ id: 'device:con_hp', kind: 'device', status: 'learning' }])).toBe(
      'Learning a new device',
    );
    expect(chatBadge(conversation, [{ id: 'device:con_hp', kind: 'device', status: 'ok' }])).toBeNull();
  });
});

describe('the device skill card settles (AP-1274)', () => {
  it('is a card while proposed and one line once decided', () => {
    const card = {
      kind: 'device_skill',
      proposalId: 'dvp_1',
      name: 'Daikin Altherma heat pump',
      readings: [],
      moreReadings: 0,
      actions: [],
      testedAt: NOW.toISOString(),
      status: 'proposed',
    } as const;
    expect(cardDisplay(card as never)).toBe('full');
    expect(cardDisplay({ ...card, status: 'on' } as never)).toBe('line');
    expect(deviceSkillLine({ ...card, status: 'on' })).toEqual({
      lead: 'Switched on',
      detail: 'Daikin Altherma heat pump',
      tone: 'ok',
    });
    expect(deviceSkillLine({ ...card, status: 'declined' }).lead).toBe('Not switched on');
  });
});
