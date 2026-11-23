/**
 * The phone's addresses and tabs (one-whombat-mobile.md AP-1351, AP-1374, AP-1376; one-layout-android.md AP-2640,
 * AP-2645).
 */
import { bootstrap } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import {
  RESTORE_WATCH,
  type RestoreWorld,
  restorableNavigation,
  restorableRoute,
  type SavedNavigation,
} from './persist';
import {
  appUrlForPath,
  LINKING_SCREENS,
  pushTapFallback,
  routeForLink,
  serverOfThingParam,
  urlTarget,
} from './routes';

describe('the shell’s addresses (AP-1351)', () => {
  it.each([
    // Needs you (needs-you-list.md NYL-05): Watch's address opens it; one item of it opens that item (NYL-09).
    ['/needs-you', 'whombat://needs-you'],
    ['/needs-you?item=hosts.alert%3Aal_1', 'whombat://needs-you/hosts.alert%3Aal_1'],
    ['/watch', 'whombat://needs-you'],
    ['/burrow-hq/watch', 'whombat://needs-you'],
    // Connections (AP-2550; the Dashboard and Home before it), Chat and Feedback; a thread in a room opens the thread.
    ['/connections', 'whombat://connections'],
    ['/burrow-hq/connections', 'whombat://connections'],
    ['/connections/extra', 'whombat://inbox'],
    ['/home', 'whombat://connections'],
    ['/dashboard', 'whombat://connections'],
    ['/burrow-hq/dashboard', 'whombat://connections'],
    ['/chat', 'whombat://chat'],
    ['/feedback', 'whombat://feedback'],
    ['/burrow-hq/feedback', 'whombat://feedback'],
    ['/chat?thread=msg_root1', 'whombat://threads/msg_root1'],
    ['/feedback?thread=msg_rep1#msg_r2', 'whombat://threads/msg_rep1?anchor=msg_r2'],
    ['/dashboard/extra', 'whombat://inbox'],
    // Things and the servers' list are folded into Connections (CN-07, CN-09).
    ['/things', 'whombat://connections'],
    // The servers' old list scrolls Overview to its Servers section; an old `?tab=` to its section (OVP-01).
    ['/things/servers', 'whombat://connections?tab=servers'],
    ['/things/servers?view=guests', 'whombat://connections?tab=servers'],
    ['/connections?tab=pinned', 'whombat://connections?tab=pinned'],
    ['/home?tab=connections', 'whombat://connections?tab=services'],
    ['/connections?tab=nothing', 'whombat://connections'],
    ['/things?add=server', 'whombat://connections'],
    ['/things/server%3Apve-02', 'whombat://things/server%3Apve-02'],
    ['/things/server:pve-02', 'whombat://things/server%3Apve-02'],
    ['/burrow-hq/things/connection%3Acon_ha', 'whombat://things/connection%3Acon_ha'],
    // An account's page (session minor 7): GitHub's and Website feedback's ids aren't a connection's `con_…`.
    ['/things/connection%3Agithub', 'whombat://things/connection%3Agithub'],
    ['/things/connection:feedback', 'whombat://things/connection%3Afeedback'],
    ['/burrow-hq/things/connection%3Acon_mara', 'whombat://things/connection%3Acon_mara'],
    ['/things/connection%3Agithub?tab=activity', 'whombat://things/connection%3Agithub?tab=activity'],
    ['/chats', 'whombat://chats'],
    ['/chats/cnv_chat-heat', 'whombat://chats/cnv_chat-heat'],
    ['/chats/cnv_chat-heat#msg_1', 'whombat://chats/cnv_chat-heat?anchor=msg_1'],
    // A branch room's address isn't a section's (OA-04: no channels or agents' pages).
    ['/pr/482', 'whombat://pr/482'],
    // Unknown deeper paths fall back to the inbox (Home in this shell).
    ['/watch/extra', 'whombat://inbox'],
    ['/chats/bad%20id', 'whombat://chats'],
    // A chat or a thing whose id is a section's name is still that chat or thing.
    ['/chats/things', 'whombat://chats/things'],
    ['/burrow-hq/chats/cnv_x', 'whombat://chats/cnv_x'],
    // A guest on a server's page (proxmox-mobile.md AP-1485) opens its own screen.
    ['/things/server%3Apve-02?guest=pve%3A118', 'whombat://things/server%3Apve-02/guests/pve%3A118'],
    ['/things/server:pve-02?guest=pve:118&gtab=backups', 'whombat://things/server%3Apve-02/guests/pve%3A118'],
    [
      '/burrow-hq/things/server%3Apve-02?guest=pve%3A118',
      'whombat://things/server%3Apve-02/guests/pve%3A118',
    ],
    // Only a server has guests.
    ['/things/connection%3Acon_ha?guest=pve%3A118', 'whombat://things/connection%3Acon_ha'],
    // A connection's tab rides along (connection-pages-mobile.md AP-1963); a key that isn't one doesn't.
    ['/things/connection%3Acon_ha?tab=logs', 'whombat://things/connection%3Acon_ha?tab=logs'],
    ['/burrow-hq/things/device%3Acon_hp?tab=activity', 'whombat://things/device%3Acon_hp?tab=activity'],
    ['/things/connection%3Acon_ha?tab=..%2Fx', 'whombat://things/connection%3Acon_ha'],
    ['/things/server%3Apve-02?tab=guests', 'whombat://things/server%3Apve-02'],
    // A server's updates have their own screen (server-updates-app.md AP-2880): Worth a look's way out and links.
    ['/things/server%3Apve-02?tab=updates', 'whombat://things/server%3Apve-02/updates'],
    ['/burrow-hq/things/server:pve-02?tab=updates', 'whombat://things/server%3Apve-02/updates'],
    ['/things/connection%3Acon_ha?tab=updates', 'whombat://things/connection%3Acon_ha?tab=updates'],
    // Add a server (server-signin-mobile.md AP-1697): Home's Review and the assistant's card, filled in.
    ['/things/servers?add=1', 'whombat://servers/add?user=root&control=full'],
    [
      '/things/servers?add=1&address=10.100.0.40&user=root&control=watch',
      'whombat://servers/add?address=10.100.0.40&user=root&control=watch',
    ],
    [
      '/burrow-hq/things/servers?add=1&address=pve-03.home',
      'whombat://servers/add?address=pve-03.home&user=root&control=full',
    ],
    ['/things/servers?add=0', 'whombat://connections?tab=servers'],
    // Point them here (backup-file.md AP-4421): BF-16's Needs you item, and Connections with it open on the web.
    ['/things/servers?repoint=1', 'whombat://servers/repoint'],
    ['/burrow-hq/things/servers?repoint=1', 'whombat://servers/repoint'],
    ['/connections?repoint=1', 'whombat://servers/repoint'],
    ['/connections?repoint=0', 'whombat://connections'],
  ])('%s opens %s', (path, url) => {
    expect(appUrlForPath(path)).toBe(url);
  });

  it('opens a Home link from the web app on the phone', () => {
    expect(urlTarget('https://dev.whombat.com/things/server%3Apve-02', ['https://dev.whombat.com'])).toEqual({
      kind: 'app',
      url: 'whombat://things/server%3Apve-02',
      burrow: null,
      path: '/things/server%3Apve-02',
    });
  });

  it('has the tabs’ addresses, the old tabs’ opening the nearest of them (AP-2645, AP-6310)', () => {
    expect(LINKING_SCREENS.Tabs.screens).toEqual({
      // The Code tab's old address opens Chat, where software work is.
      ChatRoom: { path: 'chat', alias: ['chats', 'code'] },
      // Needs you takes Watch's address and the inbox's (NYL-05, NYL-09).
      NeedsYou: { path: 'needs-you', alias: ['watch', 'inbox'] },
      // `dashboard`, `home` and `things` are Connections' old names (AP-2550).
      Dashboard: { path: 'connections', alias: ['dashboard', 'home', 'things'] },
      Automations: 'automations',
      Settings: 'settings',
    });
    expect('Automations' in LINKING_SCREENS || 'Settings' in LINKING_SCREENS).toBe(false);
    expect(LINKING_SCREENS.NeedsYouItem).toBe('needs-you/:itemId');
    expect(LINKING_SCREENS.Feedback).toBe('feedback');
    expect(LINKING_SCREENS.Settled).toBe('settled');
    expect(LINKING_SCREENS.Thread).toBe('threads/:messageId');
    // Settings → Agent (AP-4961); no agents' pages (OA-09).
    expect(LINKING_SCREENS.SettingsAgent).toBe('settings/agent');
    expect('Agent' in LINKING_SCREENS || 'Dm' in LINKING_SCREENS).toBe(false);
    expect(LINKING_SCREENS.Chat).toBe('chats/:conversationId');
    expect(LINKING_SCREENS.Thing).toBe('things/:thingId');
    expect(LINKING_SCREENS.Guest.path).toBe('things/:serverId/guests/:guestId');
    expect(LINKING_SCREENS.ServerUpdates.path).toBe('things/:serverId/updates');
    expect(LINKING_SCREENS.ServerUpdates.parse.serverId('server:pve-02')).toBe('pve-02');
  });

  it('opens what used to be the Inbox at Needs you, a search on the phone’s Search', () => {
    expect(routeForLink({ type: 'work' }, null)).toEqual({ name: 'Tabs', params: { screen: 'NeedsYou' } });
    expect(routeForLink({ type: 'search', q: 'disk' }, null)).toEqual({
      name: 'Search',
      params: { q: 'disk' },
    });
    expect(routeForLink({ type: 'search', q: 'disk' }, null, 'Chat')).toEqual({
      name: 'Search',
      params: { q: 'disk', back: 'Chat' },
    });
    expect(urlTarget('https://dev.whombat.com/search?q=disk', ['https://dev.whombat.com'])).toEqual({
      kind: 'app',
      url: 'whombat://search?q=disk',
      burrow: null,
      path: '/search?q=disk',
    });
  });
});

describe('a guest’s address (AP-1485)', () => {
  it('has the server’s thing id in the address and its server id in the params', () => {
    const { parse, stringify } = LINKING_SCREENS.Guest;
    expect(parse.serverId('server:pve-02')).toBe('pve-02');
    expect(serverOfThingParam('pve-02')).toBe('pve-02');
    expect(stringify.serverId('pve-02')).toBe('server:pve-02');
  });
});

describe('a push about the Whombat itself (desk-display-android.md AP-3055)', () => {
  it('opens This Whombat when the Whombat names nothing to open; the rest the inbox, Needs you', () => {
    expect(pushTapFallback('security')).toBe('whombat');
    expect(pushTapFallback('alert')).toBe('inbox');
    expect(pushTapFallback('approval')).toBe('inbox');
    expect(pushTapFallback('message')).toBe('inbox');
  });

  it('a link to Settings → This Whombat opens it', () => {
    expect(
      urlTarget('https://dev.whombat.com/settings?tab=appliance', ['https://dev.whombat.com']),
    ).toMatchObject({
      kind: 'app',
      url: 'whombat://settings/whombat',
    });
  });
});

describe('where the person was (AP-1374, AP-2645)', () => {
  const b = bootstrap();
  const world: RestoreWorld = { sidebar: b.sidebar, managed: false };
  const NOW = Date.UTC(2026, 9, 17, 12, 0);
  const saved = (tab: string, above: SavedNavigation['state']['routes'] = []): SavedNavigation => ({
    v: 1,
    savedAt: NOW - 1000,
    burrow: b.burrow.slug,
    state: {
      index: above.length,
      routes: [{ name: 'Tabs', state: { index: 0, routes: [{ name: tab }] } }, ...above],
    },
  });
  const restore = (s: SavedNavigation) => restorableNavigation(s, { now: NOW, burrow: b.burrow.slug, world });

  it('opens on Chat at every cold start, with what was open above it (CHT-22, AP-2451)', () => {
    const thread = { name: 'Thread', params: { messageId: 'msg_root1', back: 'Chat' } };
    const settled = { name: 'Settled', params: { room: 'feedback' } };
    // No tab is restored, whichever was open — the old layouts' too.
    for (const tab of [
      'Dashboard',
      'Watch',
      'Settings',
      'Things',
      'Home',
      'Chats',
      'Inbox',
      'Channels',
      'Search',
      'Code',
    ])
      expect(restore(saved(tab))).toBeUndefined();
    expect(restore(saved('Watch', [thread]))).toEqual({ index: 1, routes: [{ name: 'Tabs' }, thread] });
    expect(restore(saved('Inbox', [thread]))).toEqual({ index: 1, routes: [{ name: 'Tabs' }, thread] });
    expect(restorableRoute({ name: 'Feedback' }, world)).toBe(true);
    expect(restorableRoute(settled, world)).toBe(true);
    expect(restorableRoute({ name: 'Settled', params: { room: 'x' } }, world)).toBe(false);
    // What the Code tab opened comes back as Chat's: “‹ Chat”, and its Settled is Chat's.
    const job = { name: 'Thread', params: { messageId: 'msg_root1', back: 'Code' } };
    const jobs = { name: 'Settled', params: { room: 'chat', place: 'code' } };
    expect(restore(saved('Code', [jobs, job]))?.routes).toEqual([
      { name: 'Tabs' },
      { name: 'Settled', params: { room: 'chat' } },
      thread,
    ]);
    // Settings saved as a page over the tabs is a tab again: it isn't restored, as no tab is.
    expect(restorableRoute({ name: 'Settings' }, world)).toBe(false);
    // The list before it was Settled: a place saved on it opens on the tabs.
    expect(restorableRoute({ name: 'Threads', params: { room: 'chat' } }, world)).toBe(false);
    // Browse channels is gone (AP-2640): a place saved on it opens on the tabs.
    expect(restore(saved('Channels', [{ name: 'BrowseChannels' }]))).toBeUndefined();
  });

  it('restores a guest above its server (AP-1485)', () => {
    const thing = { name: 'Thing', params: { thingId: 'server:pve-02' } };
    const guest = { name: 'Guest', params: { serverId: 'pve-02', guestId: 'pve:118', title: 'web' } };
    expect(restorableRoute(guest, world)).toBe(true);
    expect(restorableRoute({ name: 'Guest', params: { serverId: 'pve-02' } }, world)).toBe(false);
    expect(restore(saved('Watch', [thing, guest]))?.routes.map((r) => r.name)).toEqual([
      'Tabs',
      'Thing',
      'Guest',
    ]);
    expect(RESTORE_WATCH.Guest).toBe('hosts.getGuest');
  });

  it('restores a chat and a thing', () => {
    const chat = { name: 'Chat', params: { conversationId: 'cnv_chat-heat', title: 'Add our heat pump' } };
    const thing = { name: 'Thing', params: { thingId: 'server:pve-02' } };
    expect(restorableRoute(chat, world)).toBe(true);
    expect(restorableRoute(thing, world)).toBe(true);
    expect(restorableRoute({ name: 'Thing', params: {} }, world)).toBe(false);
    expect(restore(saved('Watch', [thing, chat]))?.routes.map((r) => r.name)).toEqual([
      'Tabs',
      'Thing',
      'Chat',
    ]);
  });
});
