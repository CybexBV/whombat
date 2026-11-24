/** A thing's page on the phone (connection-pages-mobile.md AP-1950…): the pure mapping from `things.page`. */
import type { ThingPage, ThingPagePanel } from '@whombat/core';
import { at, mara } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { createThingPageFixtures } from '../fixtures/thingPages';
import {
  accessRows,
  headSpoken,
  linkRun,
  listRows,
  noticeRows,
  noticesBadge,
  partsOf,
  phoneThingTabs,
  problemLine,
  runsOnTarget,
  shownPanels,
  shownTab,
  thingSettingsOpens,
  thingSubject,
} from './thingPage';

const ZONE = 'Europe/Amsterdam';
const NOW = new Date(at('14:05'));

function world(heatOn = true) {
  return createThingPageFixtures({
    now: () => NOW,
    json: (body, status = 200) => new Response(JSON.stringify(body), { status }),
    notFound: (text) =>
      new Response(JSON.stringify({ error: { code: 'not_found', message: text } }), { status: 404 }),
    bodyOf: async <T>(init: RequestInit | undefined) => JSON.parse(String(init?.body ?? '{}')) as T,
    heatOn: () => heatOn,
    assistant: () => ({ id: mara.id, name: 'Neo' }),
    heatChatHref: '/chats/cnv_chat-heat',
  });
}

const ha = () => world().page('connection:con_ha') as ThingPage;
const panel = <K extends ThingPagePanel['kind']>(page: ThingPage, kind: K, tab = 'overview') =>
  page.tabs.find((t) => t.key === tab)?.panels.find((p) => p.kind === kind) as Extract<
    ThingPagePanel,
    { kind: K }
  >;

describe('tabs', () => {
  it('are the server’s, then Activity, then Connection, which opens the Connection screen', () => {
    const tabs = phoneThingTabs(ha());
    expect(tabs.map((t) => t.key)).toEqual([
      'overview',
      'integrations',
      'logs',
      'backups',
      'activity',
      'settings',
    ]);
    expect(tabs[0]).toMatchObject({ key: 'overview', label: 'Summary' });
    expect(tabs.find((t) => t.key === 'integrations')).toMatchObject({
      count: 102,
      spoken: 'Integrations, 102',
    });
    expect(tabs.filter((t) => t.settings).map((t) => [t.key, t.label])).toEqual([['settings', 'Connection']]);
  });

  it('leave Connection out for a device being learned (no connection yet)', () => {
    const learning = world(false).page('device:con_heatpump') as ThingPage;
    expect(phoneThingTabs(learning).map((t) => t.key)).toEqual(['overview', 'activity']);
  });

  it('open the asked tab when the page has it, else Overview; never Connection as a tab', () => {
    const tabs = phoneThingTabs(ha());
    expect(shownTab(tabs, 'logs')).toBe('logs');
    expect(shownTab(tabs, 'settings')).toBe('overview');
    expect(shownTab(tabs, 'nope')).toBe('overview');
    expect(shownTab(tabs, undefined)).toBe('overview');
  });
});

describe('a 1Password connection’s page (Whombat onepassword-sync.md)', () => {
  const page = {
    id: 'connection:con_1p',
    kind: 'connection',
    connectionId: 'con_1p',
    catalogId: 'onepassword',
    settings: true,
    tabs: [
      { key: 'onepassword', label: '1Password', panels: [] },
      { key: 'overview', label: 'Summary', panels: [] },
    ],
  } as unknown as ThingPage;

  it('opens on its own 1Password tab, the Summary after it and Connection last', () => {
    const tabs = phoneThingTabs(page);
    expect(tabs.map((t) => t.key)).toEqual(['onepassword', 'overview', 'activity', 'settings']);
    expect(shownTab(tabs, undefined)).toBe('onepassword');
    expect(shownTab(tabs, 'overview')).toBe('overview');
  });
});

describe('an account’s Connection', () => {
  it('stays on GitHub’s and Website feedback’s pages, which have no connection id', () => {
    for (const id of ['connection:github', 'connection:feedback', 'connection:con_mara']) {
      const page = world().page(id) as ThingPage;
      expect(page.catalogId).toBeTruthy();
      const tabs = phoneThingTabs(page);
      expect(tabs.filter((t) => t.settings).map((t) => t.label)).toEqual(['Connection']);
      expect(shownTab(tabs, undefined)).toBe('overview');
    }
  });

  it('opens the account’s own screen, by its catalog entry or, before the page answers, by its id', () => {
    const google = world().page('connection:con_mara') as ThingPage;
    expect(thingSettingsOpens(google.id, google.catalogId, google.connectionId)).toEqual({
      screen: 'ConnectAccount',
      page: 'google',
    });
    const email = world().page('connection:con_mail_mara_fastmail_com') as ThingPage;
    expect(thingSettingsOpens(email.id, email.catalogId, email.connectionId)).toEqual({
      screen: 'ConnectAccount',
      page: 'imap',
    });
    expect(thingSettingsOpens('connection:github', undefined, null)).toEqual({
      screen: 'ConnectAccount',
      page: 'github',
    });
    expect(thingSettingsOpens('connection:feedback', null, null)).toEqual({
      screen: 'ConnectAccount',
      page: 'feedback',
    });
    // An older box's 404 for Microsoft 365: the row the app holds names it.
    expect(thingSettingsOpens('connection:con_ms', 'microsoft', 'con_ms')).toEqual({
      screen: 'ConnectAccount',
      page: 'microsoft',
    });
  });

  it('leaves a catalog connection on its Connection screen', () => {
    const page = ha();
    expect(thingSettingsOpens(page.id, page.catalogId, page.connectionId)).toEqual({
      screen: 'Connection',
      connectionId: 'con_ha',
    });
    expect(thingSettingsOpens('device:con_heatpump', null, null)).toBeNull();
  });
});

describe('the head', () => {
  it('runs on a guest opens its screen, a server its page', () => {
    expect(runsOnTarget(ha().runsOn as NonNullable<ThingPage['runsOn']>)).toEqual({
      screen: 'Guest',
      serverId: 'pve-02',
      guestId: 'pve:132',
      title: 'homeassistant (pve-02)',
    });
    expect(
      runsOnTarget({
        serverId: 'pve-01',
        guestId: null,
        name: 'pve-01',
        href: '/things/server%3Apve-01',
        how: 'chosen',
      }),
    ).toEqual({ screen: 'Thing', thingId: 'server:pve-01', title: 'pve-01' });
  });

  it('asks about the thing by its own id', () => {
    expect(thingSubject(ha())).toEqual({ kind: 'connection', id: 'con_ha', name: 'Home Assistant' });
    expect(thingSubject({ id: 'device:dvp_heatpump', kind: 'device', name: 'Heat pump' })).toEqual({
      kind: 'device',
      id: 'dvp_heatpump',
      name: 'Heat pump',
    });
  });

  it('says why the figures couldn’t be read, and how old they are', () => {
    expect(problemLine({ problem: undefined, readAt: at('14:00') }, NOW, ZONE)).toBeNull();
    expect(problemLine({ problem: 'Home Assistant didn’t answer.', readAt: at('13:58') }, NOW, ZONE)).toBe(
      'Home Assistant didn’t answer. Figures from 13:58.',
    );
    expect(problemLine({ problem: 'Home Assistant didn’t answer.', readAt: null }, NOW, ZONE)).toBe(
      'Home Assistant didn’t answer.',
    );
  });

  it('is read aloud with its badge, and by name alone before its status is known (page-speed.md AP-2650)', () => {
    expect(headSpoken(ha())).toBe(`${ha().name}, ${ha().badge}`);
    expect(headSpoken({ name: 'Attic', badge: null })).toBe('Attic');
  });
});

describe('panels', () => {
  it('leave out what has nothing to say, but always say Worth a look', () => {
    const panels: ThingPagePanel[] = [
      { kind: 'table', id: 't', title: 'Empty', columns: [{ key: 'a', label: 'A' }], rows: [] },
      { kind: 'list', id: 'l', title: 'None yet', items: [], empty: 'No backups yet.' },
      { kind: 'bars', id: 'b', title: 'Storage', items: [] },
      { kind: 'facts', id: 'f', title: 'Facts', items: [] },
      { kind: 'access', id: 'a', title: 'Access', items: [], lookOnly: false },
      { kind: 'notices', id: 'n', title: 'Worth a look', items: [], empty: 'Nothing needs a look.' },
      {
        kind: 'chart',
        id: 'c',
        title: 'Chart',
        timestamps: [at('14:00')],
        series: [{ key: 'x', label: 'X', values: [null] }],
      },
    ];
    expect(shownPanels(panels).map((p) => p.id)).toEqual(['l', 'n']);
  });

  it('gives each notice its way out: Ask with the question, a tab, Settings', () => {
    const page = ha();
    const tabs = phoneThingTabs(page);
    const rows = noticeRows(panel(page, 'notices'), tabs);
    expect(rows.slice(0, 3).map((r) => [r.title, r.tone, r.action?.label, r.action?.run.kind])).toEqual([
      ['Disk full in about 2 months', 'warn', 'Look into it', 'ask'],
      ['Modbus fills the log', 'warn', 'Show them', 'tab'],
      ['2 integrations not loading', 'warn', 'Look into it', 'ask'],
    ]);
    expect(rows[0]?.spoken).toBe('Needs a look. Disk full in about 2 months. 8.7 GB is old backups');
    expect(rows.find((r) => r.id === 'homewizard')?.action?.run).toEqual({
      kind: 'url',
      url: 'http://10.100.0.131:8123/config/repairs',
    });
    // The count is what asks: the heads-ups wait folded.
    expect(noticesBadge(panel(page, 'notices'))).toEqual({ text: '4', tone: 'warn' });
    expect(linkRun({ kind: 'tab', label: 'Connect again', tab: 'settings' }, tabs)).toEqual({
      label: 'Connect again',
      run: { kind: 'settings' },
    });
    expect(linkRun({ kind: 'tab', label: 'Add-ons', tab: 'addons' }, tabs)).toBeNull();
  });

  it('dates a list’s lines when they carry no words on the right', () => {
    const rows = listRows(panel(ha(), 'list', 'backups'), NOW, ZONE);
    expect(rows.map((r) => [r.title, r.right])).toEqual([
      ['Whole machine, by Proxmox', '07:29'],
      ['Whole machine, by Proxmox', 'Tue'],
      ['Home Assistant’s own backups', '17 Mar'],
    ]);
    // The Summary's Backups: its lines say when on the right themselves.
    const summary = ha().tabs[0]?.panels.find((p) => p.id === 'backups') as Extract<
      ThingPagePanel,
      { kind: 'list' }
    >;
    expect(listRows(summary, NOW, ZONE).map((r) => r.right)).toEqual(['next in 21 h', null]);
  });

  it('words what Whombat may do by tier', () => {
    expect(accessRows(panel(ha(), 'access')).map((r) => [r.label, r.tier, r.tone, r.spoken])).toEqual([
      ['Read', 'Allowed', 'ok', 'Read: Allowed, 4 tools'],
      ['Lights and switches', 'Allowed', 'ok', 'Lights and switches: Allowed, 6 tools'],
      ['Locks and alarms', 'Asks you', 'warn', 'Locks and alarms: Asks you, 5 tools'],
    ]);
  });
});

describe('lists of things', () => {
  it('find what is part of a server, which lists it as Also connected', () => {
    const things = [
      { id: 'server:pve-02' },
      { id: 'connection:con_pve', partOf: 'server:pve-02' },
      { id: 'connection:con_ha' },
    ];
    expect(partsOf(things, 'pve-02').map((t) => t.id)).toEqual(['connection:con_pve']);
    expect(partsOf(things, 'pve-01')).toEqual([]);
  });
});
