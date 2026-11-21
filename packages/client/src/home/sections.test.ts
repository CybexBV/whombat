import type { ChangeEntry, ChatSummary, HomeChat, NeedsYouItem, ThingSummary, Widget } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { changeBy, doneRows, UNDO_REQUEST_HOLD_MS, undoOutcome } from './changes';
import { allChatRows } from './chats';
import { homeStatusLine, statusText } from './greeting';
import {
  connectedLine,
  factPhrase,
  type HomeInput,
  type HomeSection,
  homeSection,
  homeSections,
  homeThingRows,
  homeWebSlots,
  thingsLine,
  usedPhrase,
  usedShort,
} from './sections';

const TZ = 'Europe/Amsterdam';
/** Saturday 26 September 2026, 14:05 in Amsterdam (UTC+2). */
const NOW = new Date('2026-09-26T12:05:00Z');
const local = (day: number, hhmm: string) =>
  new Date(`2026-09-${String(day).padStart(2, '0')}T${hhmm}:00+02:00`).toISOString();

const thing = (over: Partial<ThingSummary>): ThingSummary => ({
  id: 'connection:con_x',
  kind: 'connection',
  name: 'X',
  icon: 'plug',
  status: 'ok',
  facts: [],
  href: '/things/connection%3Acon_x',
  ...over,
});

const change = (id: string, over: Partial<ChangeEntry> = {}): ChangeEntry =>
  ({
    id,
    title: `Change ${id}`,
    at: local(26, '10:12'),
    actor: { kind: 'whombat', id: 'prn_neo', name: 'Neo' },
    undo: { state: 'none' },
    ...over,
  }) as ChangeEntry;

const overview = (over: Partial<HomeInput> = {}): HomeInput => ({
  summary: { needsYou: 0, working: 0, problems: 0 },
  needsYou: [],
  things: [],
  widgets: [],
  ...over,
});

const web = { now: NOW, timeZone: TZ, servers: true, canAddConnection: true };
const kinds = (sections: readonly HomeSection[]) => sections.map((s) => s.kind);

describe('Home’s sections (HR-20, AP-2206, AP-2269)', () => {
  it('shows Servers and Your things; Needs you and panels only with something in them; no chats or changes', () => {
    expect(kinds(homeSections(overview(), web))).toEqual(['servers', 'things']);
    const full = overview({
      needsYou: [
        { id: 'ny_1', ref: { kind: 'alert', id: 'a' }, actions: [], at: local(26, '10:00') } as never,
      ],
      widgets: [{ id: 'wdg_1' } as Widget],
    });
    expect(kinds(homeSections(full, web))).toEqual(['needsYou', 'servers', 'things', 'panels']);
  });

  it('leaves Servers out without the hosts service, Your things out with nothing to show or add', () => {
    expect(kinds(homeSections(overview(), { ...web, servers: false, canAddConnection: false }))).toEqual([]);
    const things = homeSection(homeSections(overview(), web), 'things');
    expect(things).toMatchObject({ rows: [], add: true });
  });

  it('counts Needs you by the summary when the server holds some back', () => {
    const item = { id: 'ny_1', ref: { kind: 'alert', id: 'a' }, actions: [], at: local(26, '10:00') };
    const s = homeSections(
      overview({
        needsYou: [item as unknown as NeedsYouItem],
        summary: { needsYou: 3, working: 0, problems: 0 },
      }),
      web,
    );
    expect(homeSection(s, 'needsYou')).toMatchObject({ count: 3, rows: [{ id: 'ny_1' }] });
  });
});

describe('the status line (HR-21)', () => {
  it('says what the assistant is on from the working chat, not the default chat’s name', () => {
    const def: HomeChat = {
      conversationId: 'cnv_dm' as HomeChat['conversationId'],
      title: 'Neo',
      state: 'working',
      at: local(26, '11:00'),
      default: true,
    };
    const summary = { needsYou: 0, working: 1, problems: 0 };
    expect(statusText(homeStatusLine({ summary, chats: [def] }))).not.toContain('Neo');
    const task = {
      ...def,
      conversationId: 'cnv_w' as HomeChat['conversationId'],
      title: 'Tidying Home Assistant',
      default: undefined,
    };
    expect(statusText(homeStatusLine({ summary, chats: [task] }))).toContain('I’m tidying Home Assistant');
  });
});

describe('all chats (AP-2215)', () => {
  it('lists every chat but the archived ones, newest first, the default one by the assistant’s name', () => {
    const summary = (id: string, lastAt: string | null, over: Partial<ChatSummary> = {}): ChatSummary => ({
      id,
      title: `Chat ${id}`,
      lastAt,
      unread: 0,
      default: false,
      ...over,
    });
    const rows = allChatRows(
      [
        summary('a', local(25, '09:00')),
        summary('dm', local(26, '11:00'), { title: 'Neo', default: true, unread: 2 }),
        summary('gone', local(26, '12:00'), { archivedAt: local(26, '12:30') }),
        summary('b', null),
      ],
      NOW,
      TZ,
      'Neo',
    );
    expect(rows.map((r) => [r.id, r.when, r.unread])).toEqual([
      ['dm', '11:00', 2],
      ['a', 'Fri', 0],
      ['b', '', 0],
    ]);
    expect(rows[0]?.title).toBe('Your chat with Neo');
  });
});

describe('your things (HR-23, AP-2208, AP-2270)', () => {
  it('says when a connection was last used', () => {
    expect(usedPhrase(local(26, '09:00'), NOW, TZ)).toBe('used today');
    expect(usedPhrase(local(25, '22:00'), NOW, TZ)).toBe('used yesterday');
    expect(usedPhrase(local(23, '09:00'), NOW, TZ)).toBe('used Wednesday');
    expect(usedPhrase(local(10, '09:00'), NOW, TZ)).toBe('used 10 Sep');
    // A clock running early is still today.
    expect(usedPhrase(local(26, '18:00'), NOW, TZ)).toBe('used today');
    expect(
      [local(26, '09:00'), local(25, '22:00'), local(23, '09:00'), local(10, '09:00')].map((at) =>
        usedShort(at, NOW, TZ),
      ),
    ).toEqual(['today', 'yesterday', 'Wed', '10 Sep']);
  });

  it('lines up a thing without figures as connected, or what is wrong with it', () => {
    expect(connectedLine({ status: 'ok', usedAt: local(26, '09:00') }, NOW, TZ)).toBe(
      'Connected · used today',
    );
    expect(connectedLine({ status: 'ok' }, NOW, TZ)).toBe('Connected');
    expect(connectedLine({ status: 'unknown' }, NOW, TZ)).toBe('Connected');
    expect(connectedLine({ status: 'offline', usedAt: local(25, '09:00') }, NOW, TZ)).toBe(
      'Offline · used yesterday',
    );
    expect(connectedLine({ status: 'learning' }, NOW, TZ)).toBe('Learning');
  });

  it('lists connections and devices with figures first, leaves out servers and parts of a server', () => {
    const rows = homeThingRows(
      [
        thing({ id: 'server:pve-02', kind: 'server', name: 'pve-02' }),
        thing({ id: 'connection:con_tracker', name: 'Acme Desk dev', usedAt: local(26, '09:00') }),
        thing({
          id: 'connection:con_unifi',
          catalogId: 'unifi',
          name: 'UniFi',
          status: 'warn',
          line: '38 devices',
          usedAt: local(24, '09:00'),
          facts: [
            { label: 'Internet', value: '940 / 38', unit: 'Mbit/s' },
            { label: 'Access points', value: '21 of 22', note: 'online' },
            { label: 'Clients', value: '174' },
            { label: 'Alarms', value: '0' },
          ],
        }),
        thing({ id: 'connection:con_pve-api', name: 'Proxmox VE API', partOf: 'server:pve-02' }),
        thing({ id: 'device:con_heat', kind: 'device', name: 'Heat pump', status: 'learning' }),
      ],
      NOW,
      TZ,
    );
    expect(rows.map((r) => r.id)).toEqual([
      'connection:con_unifi',
      'connection:con_tracker',
      'device:con_heat',
    ]);
    expect(rows[0]).toMatchObject({
      name: 'UniFi',
      subtitle: 'Network · 38 devices',
      state: 'Needs a look',
      tone: 'warn',
      used: 'Thu',
      line: 'Network · 38 devices',
    });
    expect(rows[0]?.figures.map((f) => [f.value, f.label, f.note])).toEqual([
      ['940 / 38 Mbit/s', 'Internet', null],
      ['21 of 22', 'Access points', 'online'],
      ['174', 'Clients', null],
    ]);
    expect(rows[0]?.label).toContain('needs a look');
    expect(rows[1]).toMatchObject({
      name: 'Acme Desk dev',
      subtitle: null,
      state: null,
      tone: 'ok',
      figures: [],
      plain: 'Connected',
      used: 'today',
      line: 'Connected · used today',
    });
    // What is wrong is said once, beside the name: not again as the line or in the figures' place.
    expect(rows[2]).toMatchObject({ state: 'Learning', tone: 'learning', plain: '—', used: null, line: '' });
    const offline = homeThingRows(
      [thing({ status: 'offline', line: 'Daikin Altherma', usedAt: local(25, '09:00') })],
      NOW,
      TZ,
    )[0];
    expect(offline).toMatchObject({ state: 'Offline', line: 'Daikin Altherma · used yesterday' });
  });

  it('heads the list with how many work and what isn’t fine', () => {
    const of = (...statuses: ThingSummary['status'][]) => statuses.map((status) => ({ status }));
    expect(thingsLine([])).toBe('');
    expect(thingsLine(of('ok', 'ok', 'unknown', 'learning'))).toBe('3 working · 1 learning');
    expect(thingsLine(of('ok', 'warn', 'warn', 'offline'))).toBe('1 working · 2 need a look · 1 offline');
    expect(thingsLine(of('warn', 'bad'))).toBe('1 needs a look · 1 with a problem');
  });

  it('turns a figure into a phrase of a line', () => {
    expect(factPhrase({ label: 'Room', value: '21.0', unit: '°C' })).toBe('21.0 °C');
    expect(factPhrase({ label: 'Devices', value: '38' })).toBe('38 devices');
    expect(factPhrase({ label: 'Alarm', value: 'armed' })).toBe('alarm armed');
  });
});

describe('changes on a thing’s page (HR-05, HR-08, AP-2209)', () => {
  it('offers Undo while it can, else Review through the change’s link (the chat it was made in)', () => {
    const rows = doneRows(
      [
        change('chg_undo', { undo: { state: 'available' }, link: '/chats/cnv_ha' }),
        change('chg_review', { link: '/chats/cnv_mail' }),
        change('chg_none'),
        change('chg_undone', { undo: { state: 'undone' }, link: '/chats/cnv_ha' }),
      ],
      NOW,
      TZ,
    );
    expect(rows.map((r) => [r.id, r.action, r.href])).toEqual([
      ['chg_undo', 'undo', '/chats/cnv_ha'],
      ['chg_review', 'review', '/chats/cnv_mail'],
      ['chg_none', null, null],
      ['chg_undone', null, '/chats/cnv_ha'],
    ]);
  });

  it('says Undo asked the agent, links to its chat, and offers Undo again after the hold (AP-2217)', () => {
    expect(undoOutcome({ state: 'requested', conversationId: 'cnv_dm' }, 'Neo')).toMatchObject({
      kind: 'requested',
      href: '/chats/cnv_dm',
    });
    expect(undoOutcome({ state: 'requested', conversationId: 'cnv_dm' }, 'Neo').message).toContain('Neo');
    expect(undoOutcome({ state: 'asked', approvalNumber: 902 })).toMatchObject({
      kind: 'asked',
      approvalNumber: 902,
    });
    expect(undoOutcome({ state: 'undone' }).kind).toBe('undone');
    const reported = change('chg_r', { undo: { state: 'available' }, link: '/chats/cnv_dm' });
    const asked = { chg_r: { conversationId: 'cnv_dm', at: NOW.getTime() - 60_000 } };
    const [row] = doneRows([reported], NOW, TZ, { requests: asked, assistantName: 'Neo' });
    expect(row?.action).toBeNull();
    expect(row?.requested?.href).toBe('/chats/cnv_dm');
    expect(row?.requested?.text).toContain('Neo');
    const later = NOW.getTime() + UNDO_REQUEST_HOLD_MS;
    expect(doneRows([reported], later, TZ, { requests: asked })[0]).toMatchObject({
      action: 'undo',
      requested: null,
    });
    const undone = { ...reported, undo: { state: 'undone' as const } };
    expect(doneRows([undone], NOW, TZ, { requests: asked })[0]).toMatchObject({
      undone: true,
      requested: null,
    });
  });

  it('says who made a change when it wasn’t an agent', () => {
    const me = { kind: 'person' as const, id: 'prn_john', name: 'John Doe' };
    expect(changeBy(me, 'prn_john')).toBe('You');
    expect(changeBy(me, 'prn_mara')).toBe('John Doe');
    expect(changeBy({ kind: 'whombat', id: 'prn_neo', name: 'Neo' }, 'prn_john')).toBeNull();
    const rows = doneRows([change('chg_1', { actor: me })], NOW, TZ, { viewerId: 'prn_john' });
    expect(rows[0]?.by).toBe('You');
  });
});

describe('the web’s grid (HR-20, AP-2273)', () => {
  const sections = (over: Partial<HomeInput>, servers = true) =>
    homeSections(overview(over), { ...web, servers });
  const places = (slots: ReturnType<typeof homeWebSlots>) => slots.map((s) => `${s.key}:${s.place}`);
  const item = { id: 'ny_1', ref: { kind: 'alert', id: 'a' }, actions: [], at: local(26, '10:00') } as never;
  const widget = (id: string) => ({ id }) as Widget;

  it('puts every section across the width and the panels two by two', () => {
    expect(
      places(homeWebSlots(sections({ needsYou: [item], widgets: [widget('w1'), widget('w2')] }))),
    ).toEqual(['needsYou:full', 'servers:full', 'things:full', 'panel:w1:half', 'panel:w2:half']);
  });

  it('gives a last panel without a partner the whole width', () => {
    expect(places(homeWebSlots(sections({ widgets: [widget('w1')] }, false)))).toEqual([
      'things:full',
      'panel:w1:full',
    ]);
    expect(
      places(homeWebSlots(sections({ widgets: [widget('w1'), widget('w2'), widget('w3')] }, false))).slice(1),
    ).toEqual(['panel:w1:half', 'panel:w2:half', 'panel:w3:full']);
  });
});
