/** Connections on the phone (connections-page.md AP-2553…; mock 4, one-whombat-mobile.md AP-1350…) and the bar's tabs. */

import {
  homeSection,
  homeSections,
  homeStatusLine,
  needsYouListRow,
  needsYouListView,
  overviewSections,
  statusText,
} from '@whombat/client';
import { type NeedsYouItem, type ThingSummary, thingHref } from '@whombat/core';
import { at } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { CONNECTIONS_COPY, JUMP_MARGIN, jumpOffset, overviewChips, serviceRowOpens } from './home';
import {
  groupHeading,
  needsYouTabBadge,
  phoneRowActions,
  phoneRowInline,
  phoneRowOpens,
  phoneRowSwipe,
  phoneSheet,
  swipeEdgeLabel,
} from './needsYou';
import { HOME_TAB, INBOX_TAB, TAB_WORDS, TABS } from './shell';

const restart: NeedsYouItem = {
  id: 'approval:31',
  ref: { kind: 'approval', id: '31' },
  kind: 'approval',
  severity: 'warn',
  title: 'Restart arnica-prod-nest-01?',
  body: 'It needs a restart to get its extra memory (4 → 8 GB). It’s down for about 40 seconds.',
  at: at('13:58'),
  actions: [
    { id: 'approve', label: 'Yes, do it', style: 'primary', kind: 'approve' },
    { id: 'later', label: 'Tonight', style: 'secondary', kind: 'approve_later', at: at('03:00', 1) },
    { id: 'decline', label: 'No', style: 'secondary', kind: 'decline' },
  ],
  subject: { kind: 'server', id: 'pve-02', name: 'pve-02' },
  approvalNumber: 31,
};

const disk: NeedsYouItem = {
  id: 'hosts.alert:al_1',
  ref: { kind: 'alert', id: 'al_1' },
  kind: 'alert',
  severity: 'bad',
  title: 'blackbox’s disk array failed',
  body: 'Your files have no protection now',
  at: at('13:52'),
  actions: [
    { id: 'investigate', label: 'Ask Dusty', style: 'primary', kind: 'investigate' },
    { id: 'snooze', label: 'Remind me tomorrow', style: 'secondary', kind: 'snooze' },
  ],
  nature: 'problem',
  subject: { kind: 'server', id: 'blackbox', name: 'blackbox' },
};

const heat: NeedsYouItem = {
  id: 'device_skill:dvp_1',
  ref: { kind: 'device_skill', id: 'dvp_1' },
  kind: 'device_skill',
  severity: 'info',
  title: 'Heat pump: what may I change?',
  body: 'It reads fine already',
  at: at('13:41'),
  actions: [{ id: 'open', label: 'Choose', style: 'primary', kind: 'open', href: '/chats/cnv_heat' }],
};

function server(id: string, status: ThingSummary['status'], running: number, total: number): ThingSummary {
  return {
    id: `server:${id}`,
    kind: 'server',
    name: id,
    icon: 'server',
    status,
    facts: [{ label: 'Guests', value: String(running), note: `of ${total} running` }],
    href: thingHref('server', id),
  };
}

describe('the phone’s one layout (one-layout-android.md AP-2640)', () => {
  it('has Chat, Inbox, Overview, Automations and Settings, and opens on Chat', () => {
    // Needs you replaces Watch and Connections' Needs you (needs-you-list.md NYL-05); Automations follows Connections as
    // in the web's sidebar (automations-tab.md AP-6310); Settings ends the bar (settings-tab-android.md AP-2620).
    expect(TABS).toEqual(['ChatRoom', 'NeedsYou', 'Dashboard', 'Automations', 'Settings']);
    expect(TABS.map((t) => TAB_WORDS[t])).toEqual(['Chat', 'Inbox', 'Overview', 'Automations', 'Settings']);
    expect(HOME_TAB).toBe('ChatRoom');
    // “The inbox” of a link or a push that names no item is the Inbox (NYL-09).
    expect(INBOX_TAB).toBe('NeedsYou');
  });
});

describe('Overview’s title and sentence (AP-2553; sidebar-tabs.md)', () => {
  it('is called Overview, its connections Connections, with the shared status sentence under it (AP-2501)', () => {
    expect(CONNECTIONS_COPY.title).toBe('Overview');
    expect(CONNECTIONS_COPY.services).toBe('Connections');
    expect(CONNECTIONS_COPY.failed).toContain('Overview');
    const parts = homeStatusLine({ summary: { needsYou: 3, working: 1, problems: 0 } });
    expect(parts.find((p) => p.strong)?.text).toBe('3 things need you');
    expect(statusText(homeStatusLine({ summary: { needsYou: 0, working: 0, problems: 0 } }))).toContain(
      'All good',
    );
  });
});

describe('the Inbox tab (inbox.md; needs-you-list.md NYL-01…NYL-09)', () => {
  const opts = { now: Date.parse(at('14:05')), timeZone: 'Europe/Amsterdam', assistant: 'Dusty' };
  const row = (item: NeedsYouItem) => needsYouListRow(item, opts);

  it('opens a sheet for what needs the person, the thread for what the assistant is on, the place of a heads-up', () => {
    expect(phoneRowOpens(row(restart))).toEqual({ to: 'sheet' });
    const looking = {
      ...disk,
      group: 'assistant' as const,
      research: {
        key: 'server:blackbox',
        state: 'looking' as const,
        threadRootId: 'msg_look',
        at: at('13:55'),
      },
    } as NeedsYouItem;
    expect(phoneRowOpens(row(looking))).toEqual({ to: 'href', href: '/chat?thread=msg_look' });
    const fyi = { ...disk, nature: 'fyi', group: 'fyi', href: '/things/server%3Ablackbox' } as NeedsYouItem;
    expect(phoneRowOpens(row(fyi))).toEqual({ to: 'href', href: '/things/server%3Ablackbox' });
  });

  it('makes the sheet: the group and thing as its badge, every button stacked in the shared words', () => {
    const sheet = phoneSheet(row(restart), { Name: 'Dusty' });
    expect(sheet.badge).toBe('Needs you · pve-02');
    // An approval is answered, never settled: its three, equal while tonight is on offer, then Talk to Dusty about it
    // as quiet words beside the others.
    expect(sheet.linksInRow).toBe(true);
    expect(sheet.buttons.map((b) => [b.label, b.variant])).toEqual([
      ['Yes, now', 'secondary'],
      ['Yes, tonight', 'secondary'],
      ['No', 'secondary'],
      ['Talk to Dusty about it', 'quiet'],
    ]);
    // A problem nobody looks at: hand it over, Settle, then More's.
    expect(phoneSheet(row(disk), { Name: 'Dusty' }).buttons.map((b) => b.button.kind)).toEqual([
      'handle',
      'settle',
      'talk',
      'snooze',
    ]);
    expect(phoneSheet(row(heat), { Name: 'Dusty' }).badge).toBe('Needs you');
    const settled = { ...disk, group: 'quiet', state: 'acknowledged' } as NeedsYouItem;
    expect(phoneSheet(row(settled), { Name: 'Dusty' })).toMatchObject({
      badge: 'Settled · blackbox',
      tone: 'mut',
      note: null,
      buttons: [{ label: 'Bring it back' }, { button: { kind: 'talk' } }],
    });
  });

  it('shows an approval’s answers and a line’s one way forward under the row, the rest in More', () => {
    const answers = phoneRowInline(row(restart));
    expect(answers?.answers.map((b) => b.label)).toEqual(['Yes, now', 'Yes, tonight', 'No']);
    expect(answers?.lead).toBeNull();
    const line = phoneRowInline(row(disk));
    expect(line?.lead?.kind).toBe('handle');
    expect(line?.more.map((b) => b.kind)).toEqual(['settle', 'talk', 'snooze']);
    // An approval's sheet carries its card's facts: no key named by the Inbox item, the exact later time.
    const sheet = phoneSheet(
      row(restart),
      { Name: 'Dusty' },
      { now: Date.parse(at('14:05')), timeZone: 'Europe/Amsterdam' },
    );
    expect(sheet.approval?.permission).toBe('Not supplied in this request');
    expect(sheet.approval?.tonight?.at).toMatch(/2026 at 03:00 · /);
    // Settled with nothing in it shows no zero.
    expect(groupHeading({ label: 'Settled', rows: [] })).toBe('Settled');
  });

  it('swipes left to Settle (or Bring back) with More beside it; Dusty’s rows only More', () => {
    expect(phoneRowSwipe(row(disk))).toMatchObject({
      edge: { kind: 'settle' },
      more: [{ kind: 'talk' }, { kind: 'snooze' }],
    });
    const edge = phoneRowSwipe(row(disk))?.edge;
    if (edge) expect(swipeEdgeLabel(edge)).toBe('Settle');
    // An approval waits on the answer: no Settle.
    expect(phoneRowSwipe(row(restart))).toMatchObject({ edge: null, more: [{ kind: 'talk' }] });
    const settled = row({ ...disk, group: 'quiet', state: 'acknowledged' } as NeedsYouItem);
    const back = phoneRowSwipe(settled)?.edge;
    expect(back?.kind).toBe('back');
    if (back) expect(swipeEdgeLabel(back)).toBe('Bring back');
    const looking = row({
      ...disk,
      group: 'assistant',
      research: { key: 'server:blackbox', state: 'looking', threadRootId: 'msg_look', at: at('13:55') },
    } as NeedsYouItem);
    expect(phoneRowSwipe(looking)).toMatchObject({ edge: null, more: [{ kind: 'talk' }] });
    // A screen reader gets the same as the row's actions, by the button's id.
    expect(phoneRowActions(row(disk)).map((a) => a.name)).toEqual(['settle', 'talk', 'snooze']);
  });

  it('badges the tab with the one count: amber, red only when something isn’t working', () => {
    const overview = {
      summary: { needsYou: 2, working: 0, problems: 0 },
      needsYou: [],
      needsYouList: [
        { ...disk, group: 'you' as const },
        { ...restart, group: 'you' as const },
        { ...heat, group: 'fyi' as const },
      ],
    };
    expect(needsYouTabBadge(overview)).toEqual({ count: 2, tone: 'bad' });
    expect(needsYouListView(overview, opts).count).toBe(2);
    expect(needsYouTabBadge(undefined)).toEqual({ count: 0, tone: null });
    // An ask alone is amber: red only when something isn't working.
    expect(
      needsYouTabBadge({
        ...overview,
        summary: { ...overview.summary, needsYou: 1 },
        needsYouList: [restart],
      }),
    ).toEqual({ count: 1, tone: 'warn' });
  });
});

describe('Home’s sections on the phone (home-redesign-mobile.md AP-2264)', () => {
  const ha: ThingSummary = {
    id: 'connection:con_ha',
    kind: 'connection',
    catalogId: 'homeassistant',
    name: 'Home Assistant',
    icon: 'home',
    status: 'ok',
    facts: [
      { label: 'Inside', value: '21.0', unit: '°C' },
      { label: 'Alarm', value: 'armed' },
    ],
    href: thingHref('connection', 'con_ha'),
  };
  const mail: ThingSummary = {
    ...ha,
    id: 'connection:con_mail',
    catalogId: 'google_mail',
    name: 'Mail',
    facts: [],
  };
  const proxmox: ThingSummary = {
    ...ha,
    id: 'connection:con_pve',
    catalogId: 'proxmox',
    name: 'Proxmox VE API',
    partOf: 'server:pve-02',
  };
  const change = (n: number) => ({
    id: `chg_${n}` as never,
    title: `Change ${n}`,
    at: at('13:00'),
    actor: { kind: 'whombat' as const, id: 'prn_neo' as never, name: 'Neo' },
    undo: { state: 'none' as const },
  });
  const overview = {
    summary: { needsYou: 1, working: 1, problems: 0 },
    needsYou: [restart],
    working: null,
    things: [server('pve-02', 'warn', 23, 40), ha, proxmox, mail],
    automationsToday: [],
    widgets: [],
    doneRecently: [1, 2, 3, 4, 5].map(change),
    chats: ['a', 'b', 'c', 'd'].map((id, i) => ({
      conversationId: `cnv_${id}`,
      title: `Chat ${id}`,
      state: i === 0 ? ('working' as const) : ('recent' as const),
      at: at('13:00'),
    })),
  };

  it('draws Needs you, Servers and Services in that order: no chats or changes (CN-03, AP-2269)', () => {
    const sections = homeSections(overview, {
      now: Date.parse(at('14:05')),
      timeZone: 'Europe/Amsterdam',
      servers: true,
      canAddConnection: true,
    });
    expect(sections.map((s) => s.kind)).toEqual(['needsYou', 'servers', 'things']);
    // Servers have their own card; a server's own connection stays on its page; a quiet one says it's connected.
    expect(
      homeSection(sections, 'things')?.rows.map((r) => [r.name, r.line, r.figures[0]?.value ?? null]),
    ).toEqual([
      ['Home Assistant', '', '21.0 °C'],
      ['Mail', 'Connected', null],
    ]);
  });
});

describe('Overview’s sections and jump chips on the phone (overview-one-page.md OVP-01, OVP-11)', () => {
  const opts = {
    now: Date.parse(at('14:05')),
    timeZone: 'Europe/Amsterdam',
    servers: true,
    canAddConnection: false,
  };
  const lamp: ThingSummary = {
    id: 'connection:con_ha',
    kind: 'connection',
    catalogId: 'homeassistant',
    name: 'Home Assistant',
    icon: 'home',
    status: 'warn',
    facts: [],
    href: thingHref('connection', 'con_ha'),
  };
  const overview = {
    summary: { needsYou: 1, working: 0, problems: 1 },
    needsYou: [restart],
    working: null,
    things: [server('pve-02', 'ok', 19, 22), server('nas-old', 'offline', 0, 4), lamp],
    automationsToday: [],
    widgets: [],
    doneRecently: [],
    chats: [],
  };

  it('has a chip per section, with its count and dot, each scrolling to its own place', () => {
    const chips = overviewChips(overviewSections(homeSections(overview, opts)));
    expect(chips.map((c) => [c.key, c.count, c.tone, c.anchor])).toEqual([
      ['servers', 2, 'bad', 'overview-servers'],
      ['services', 1, 'warn', 'overview-connections'],
    ]);
  });

  it('has no chips with one section alone', () => {
    const one = overviewSections(homeSections({ ...overview, needsYou: [] }, { ...opts, servers: false }));
    expect(one.map((s) => s.key)).toEqual(['services']);
    expect(overviewChips(one)).toEqual([]);
  });

  it('stops a jump just above the section’s heading, never above the list', () => {
    expect(jumpOffset(400)).toBe(400 - JUMP_MARGIN);
    expect(jumpOffset(2)).toBe(0);
  });
});

describe('where a connection’s tile goes (AP-2814)', () => {
  const thing = (over: Partial<ThingSummary> & Pick<ThingSummary, 'id' | 'name'>): ThingSummary => ({
    kind: 'connection',
    icon: 'plug',
    status: 'ok',
    facts: [],
    href: thingHref('connection', over.id.split(':')[1] ?? over.id),
    ...over,
  });

  it('sends a mail account’s tile where its href says: the server has no page for it', () => {
    // The server's Google mail glance: a builtin entry's connection, linked to Settings → Connections.
    const gmail = thing({
      id: 'connection:con_g',
      name: 'Mail',
      catalogId: 'google',
      href: '/settings/connections',
    });
    expect(serviceRowOpens(gmail)).toBe('/settings/connections');
    // A builtin entry whose href is a thing's page after all, a catalog connection, a device, an entry this phone
    // doesn't know (a newer server's) and a server open their page.
    expect(serviceRowOpens({ ...gmail, href: '/burrow-hq/things/connection%3Acon_g' })).toBeNull();
    expect(serviceRowOpens({ ...gmail, catalogId: 'homeassistant' })).toBeNull();
    expect(serviceRowOpens({ ...gmail, kind: 'device', catalogId: 'device' })).toBeNull();
    expect(serviceRowOpens({ ...gmail, catalogId: 'not_yet_known' })).toBeNull();
    expect(serviceRowOpens({ ...gmail, kind: 'server', catalogId: undefined })).toBeNull();
  });
});
