import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PLACES_WORDS } from '@whombat/client';
import { describe, expect, it } from 'vitest';
import { buildAssistantSidebarModel } from '../../app/shell/assistantSidebarModel';
import { fixtureServices, renderApp } from '../../test/renderApp';

const assistant = () => fixtureServices({});
const sidebar = () => screen.findByRole('complementary', { name: 'Sidebar' });

describe('the assistant shell before Chat (one-whombat-shell.md AP-1256…AP-1258)', () => {
  it('builds the sidebar model from Home, the chats and the counts', () => {
    const model = buildAssistantSidebarModel(
      {
        burrow: { name: 'Lumio', slug: 'lumio' } as never,
        me: {
          id: 'prn_john',
          name: 'John Doe',
          initials: 'JP',
          tone: '#c3cad9',
          title: '',
        } as never,
      },
      {
        location: { kind: 'thing', id: 'server:pve-02' },
        things: [
          {
            id: 'server:pve-02',
            kind: 'server',
            name: 'pve-02',
            icon: 'server',
            status: 'warn',
            facts: [],
            href: '/things/server%3Apve-02',
          },
        ],
        chats: [],
        needsYou: 3,
      },
    );
    // The places in one order; before the Chat shell Overview is the home page. Servers with its server, selected on
    // its page, with the mark of the one that needs a look. Automations without a count;
    // Settings is in the account menu.
    expect(model.nav.map((r) => [r.label, r.href, r.badge])).toEqual([
      ['Chat', '/chat', null],
      ['Inbox', '/inbox', 3],
      ['Overview', '/', null],
      ['Servers', '/servers', null],
      ['Automations', '/automations', null],
      ['Files', '/files', null],
      ['Vault', '/vault', null],
    ]);
    // An older Whombat doesn't say how bad: the badge stays red (AP-2601).
    expect(model.nav.find((r) => r.id === 'needsYou')?.badgeTone).toBe('bad');
    expect(model.servers?.rows.map((r) => [r.id, r.selected])).toEqual([['server:pve-02', true]]);
    expect(model.nav.find((r) => r.id === 'servers')).toMatchObject({
      selected: true,
      mark: 'warn',
      ariaLabel: 'Servers, something needs a look',
    });
    expect(model.things).toEqual([]);
    // No hosts status yet: the section shows its server, the `+` waits for the hosts service.
    expect(model.servers?.addHref).toBeNull();
  });

  it('shows Servers with the hosts service even before the first server, with Add a server', () => {
    const build = (hosts: { present: boolean } | undefined, location = { kind: 'home' }) =>
      buildAssistantSidebarModel(
        { burrow: { name: 'Lumio', slug: 'lumio' } as never, me: { id: 'prn_john', name: 'John' } as never },
        {
          location: location as never,
          things: [
            {
              id: 'connection:ha',
              kind: 'connection',
              name: 'Home Assistant',
              icon: 'home',
              status: 'ok',
              facts: [],
              href: '/things/connection%3Aha',
            },
          ] as never,
          chats: [],
          needsYou: 0,
          hosts,
        },
      );
    expect(build(undefined).servers).toBeNull();
    expect(build({ present: false }).servers).toBeNull();
    expect(build({ present: false }).nav.map((r) => r.id)).not.toContain('servers');
    const model = build({ present: true });
    // Add a server opens on Overview's Servers tab: `/` before the Chat shell (AP-2523, AP-2608).
    expect(model.servers).toMatchObject({ addHref: '/?tab=servers&add=1', rows: [] });
    expect(model.things.map((t) => t.id)).toEqual(['connection:ha']);
    expect(
      model.nav.filter((r) => r.id === 'servers' || r.id === 'connections').map((r) => [r.id, r.mark]),
    ).toEqual([
      ['servers', null],
      ['connections', null],
    ]);
    // A place's address selects it.
    const place = build({ present: true }, { kind: 'place', place: 'connections' } as never);
    expect(place.nav.find((r) => r.id === 'connections')).toMatchObject({
      selected: true,
      href: '/connected',
    });
    // Every guest of every server is reached from Overview, which stays selected.
    const guests = build({ present: true }, { kind: 'thing', id: 'servers' } as never);
    expect(guests.nav.find((r) => r.id === 'home')?.selected).toBe(true);
  });
});

describe('the sidebar (sidebar.md AP-2600…AP-2609)', () => {
  const me = { id: 'prn_john', name: 'John' } as never;
  const rooms = { chat: { unread: 0 }, feedback: { unread: 2 } } as never;

  it('lists the places in one order; Chat counts Feedback’s unread too; the Inbox’s badge takes the worst colour', () => {
    const build = (
      needsYouWorst: 'bad' | 'warn' | 'info' | null,
      needsYou = 18,
      location: unknown = { kind: 'room', room: 'chat' },
    ) =>
      buildAssistantSidebarModel(
        { burrow: { name: 'Lumio', slug: 'lumio' } as never, me },
        {
          location: location as never,
          things: [],
          chats: [],
          needsYou,
          needsYouWorst,
          needsYouBroken: needsYouWorst === 'bad',
          rooms,
        },
      );
    expect(build('warn').nav.map((r) => r.id)).toEqual([
      'chat',
      'needsYou',
      'dashboard',
      'automations',
      'files',
      'vault',
    ]);
    // Reading Chat, Feedback's 2 unread still show on Chat; elsewhere the two rooms' together; none: no badge.
    const chat = (model: ReturnType<typeof build>) => model.nav.find((r) => r.id === 'chat');
    expect(chat(build('warn'))).toMatchObject({ unread: 2, selected: true });
    expect(chat(build('warn', 1, { kind: 'search' }))?.ariaLabel).toMatch(/^Chat, 2 unread/);
    expect(chat(build('warn', 1, { kind: 'room', room: 'feedback' }))).toMatchObject({
      unread: null,
      selected: true,
    });
    expect(build('warn').roomPaths).toEqual(['/chat', '/feedback']);
    // Settings has no row: in Settings, Usage's page too, no place is selected.
    expect(build('warn', 1, { kind: 'settings', usage: true }).nav.filter((r) => r.selected)).toEqual([]);
    expect(build('warn', 1, { kind: 'settings' }).nav.filter((r) => r.selected)).toEqual([]);
    const watch = (model: ReturnType<typeof build>) => model.nav.find((r) => r.id === 'needsYou');
    expect(watch(build('warn'))).toMatchObject({
      badge: 18,
      badgeTone: 'warn',
      href: '/inbox',
      ariaLabel: PLACES_WORDS.inboxWaiting(18, false),
    });
    expect(watch(build('bad'))?.ariaLabel).toBe(PLACES_WORDS.inboxWaiting(18, true));
    expect(watch(build('info'))?.badgeTone).toBe('info');
    expect(watch(build('bad'))?.badgeTone).toBe('bad');
    expect(watch(build(null, 0))).toMatchObject({ badge: null, badgeTone: null });
    // Servers' `+` opens Add a server on Overview's Servers tab (AP-2608).
    expect(
      buildAssistantSidebarModel(
        { burrow: { name: 'Lumio', slug: 'lumio' } as never, me },
        {
          location: { kind: 'dashboard' } as never,
          things: [],
          chats: [],
          needsYou: 0,
          rooms,
          hosts: { present: true },
        },
      ).servers?.addHref,
    ).toBe('/connections?tab=servers&add=1');
  });

  it('counts every thread of Chat with news on Chat, software work too, and has no place apart for it', () => {
    const model = buildAssistantSidebarModel(
      { burrow: { name: 'Lumio', slug: 'lumio' } as never, me },
      {
        location: { kind: 'search' } as never,
        things: [],
        chats: [],
        needsYou: 0,
        rooms: { chat: { unread: 3 }, feedback: null } as never,
      },
    );
    expect(model.nav.find((r) => r.id === 'chat')?.unread).toBe(3);
    expect(model.nav.some((r) => r.href === '/code')).toBe(false);
  });

  it('carries the worst mark of what each place holds, and Connections only once something is connected', () => {
    const thing = (id: string, kind: 'server' | 'connection', status: string) => ({
      id,
      kind,
      name: id,
      icon: kind === 'server' ? 'server' : 'film',
      status,
      facts: [],
      href: `/things/${id}`,
    });
    const build = (things: unknown[], location: unknown = { kind: 'search' }) =>
      buildAssistantSidebarModel(
        { burrow: { name: 'Lumio', slug: 'lumio' } as never, me },
        { location: location as never, things: things as never, chats: [], needsYou: 0, rooms },
      );
    const model = build(
      [
        thing('server:a', 'server', 'ok'),
        thing('server:b', 'server', 'warn'),
        thing('connection:plex', 'connection', 'ok'),
        thing('connection:hetzner', 'connection', 'offline'),
      ],
      { kind: 'thing', id: 'connection:plex' },
    );
    expect(model.nav.map((r) => r.id)).toEqual([
      'chat',
      'needsYou',
      'dashboard',
      'servers',
      'connections',
      'automations',
      'files',
      'vault',
    ]);
    const place = (id: string) => model.nav.find((r) => r.id === id);
    expect(place('servers')).toMatchObject({ mark: 'warn', selected: false, href: '/servers' });
    expect(place('connections')).toMatchObject({
      mark: 'bad',
      selected: true,
      href: '/connected',
      ariaLabel: 'Connections, something isn’t working',
    });
    // Nothing connected and no server: neither place.
    expect(build([]).nav.map((r) => r.id)).not.toContain('connections');
    expect(build([]).nav.map((r) => r.id)).not.toContain('servers');
  });

  it('has Servers and Connections as places with their marks, and keeps the theme in the account menu', async () => {
    const user = userEvent.setup();
    renderApp('/connections', assistant());
    const side = await sidebar();
    // The burrow alone at the top: the theme moved to the account menu (AP-2605).
    expect(within(side).queryByRole('button', { name: /theme/ })).toBeNull();
    // The Inbox's badge: the one count (needs-you-list.md NYL-04).
    expect(within(side).getByRole('link', { name: /^Inbox, \d+ things need you/ })).toBeTruthy();
    // Servers and Connections are places with the worst mark of what they hold; no list of servers in the sidebar
    //.
    const servers = await within(side).findByRole('link', { name: /^Servers/ });
    expect(servers.getAttribute('href')).toBe('/servers');
    expect(servers.querySelector('[data-level]')).toBeTruthy();
    const connections = within(side).getByRole('link', { name: /^Connections/ });
    expect(connections.getAttribute('href')).toBe('/connected');
    expect(connections.getAttribute('aria-label')).toMatch(/^Connections, something/);
    expect(within(side).queryByRole('link', { name: /^pve-02/ })).toBeNull();
    expect(within(side).queryByRole('tablist')).toBeNull();
    // Right-click Connections: Add a connection.
    await user.pointer({ keys: '[MouseRight]', target: connections });
    expect(await screen.findByRole('menuitem', { name: 'Add a connection' })).toBeTruthy();
    await user.keyboard('{Escape}');
    // No Settings, Usage or Search among the places: Settings is in the account menu.
    const places = within(side).getByRole('navigation', { name: 'Whombat' });
    expect(within(places).queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(within(side).queryByRole('link', { name: 'Usage' })).toBeNull();
    expect(within(side).queryByRole('link', { name: 'Search' })).toBeNull();
    // The person's row opens the account menu: their face as the way to their profile, the theme, Settings, the rest.
    await user.click(within(side).getByRole('button', { name: /^Account,/ }));
    const menu = side.querySelector('[data-account-menu]') as HTMLElement;
    expect(
      within(menu)
        .getByRole('link', { name: /Your profile/ })
        .getAttribute('href'),
    ).toBe('/settings?part=profile');
    const theme = within(menu).getByRole('group', { name: 'Theme' });
    expect(
      within(theme)
        .getAllByRole('radio')
        .map((r) => r.getAttribute('value')),
    ).toEqual(['light', 'dark', 'system']);
    const settings = within(menu).getByRole('link', { name: /^Settings/ });
    expect(settings.getAttribute('href')).toBe('/settings');
    expect(settings.getAttribute('aria-keyshortcuts')).toBe('Control+, Meta+,');
    expect(within(menu).getByRole('link', { name: 'Get the phone app' }).getAttribute('href')).toBe(
      '/settings?tab=phone',
    );
    expect(within(menu).getByRole('button', { name: 'Sign out' })).toBeTruthy();
    // The person's other settings and the old one-way switches are in Settings now.
    for (const gone of ['Profile', 'Notifications', 'Devices', 'Shared links', 'Prompts'])
      expect(within(menu).queryByRole('link', { name: gone })).toBeNull();
    expect(within(menu).queryByRole('button', { name: /notifications|theme/i })).toBeNull();
  });
});

describe('Overview (one-whombat-shell.md AP-1265…AP-1273; connections-page.md AP-2501; overview-one-page.md)', () => {
  it('shows every section of #conn-web from home.overview', async () => {
    const app = renderApp('/dashboard?x=1', assistant());
    // The Dashboard's address opens Overview, the query kept (AP-2501).
    await waitFor(() => expect(app.location()).toBe('/connections?x=1'));
    expect(await screen.findByRole('heading', { name: 'Overview', level: 1 })).toBeTruthy();
    expect(
      within(await sidebar())
        .getByRole('link', { name: 'Overview' })
        .getAttribute('aria-current'),
    ).toBe('page');
    // The broken thing first (overview-server-connection-final.md): its title leads to its Inbox row, one Look into it,
    // and how many other things need Mara.
    const broken = await screen.findByRole('region', { name: /disk array on blackbox has failed/ });
    expect(
      within(broken)
        .getByRole('link', { name: /disk array on blackbox has failed/ })
        .getAttribute('href'),
    ).toMatch(/^\/inbox\?item=/);
    expect(
      within(broken)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Look into it']);
    expect(screen.getByRole('link', { name: /^\d+ other things? needs? you/ }).getAttribute('href')).toBe(
      '/inbox',
    );
    // What needs Mara is the Inbox's, not a card here (needs-you-list.md NYL-01).
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
    // No Ask box, Chats or Done recently on Home (AP-2269): asking is the sidebar's, changes are each thing's.
    expect(screen.queryByRole('region', { name: 'Chats with Neo' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Done recently' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /^Ask Neo/ })).toBeNull();
    // One page, no tabs (overview-one-page.md OVP-01): the jump links at the top, each with its count and a dot when
    // something in it isn't fine; without servers here, Connections and Pinned.
    const page = document.querySelector('[data-screen="home"]') as HTMLElement;
    expect(within(page).queryByRole('tablist')).toBeNull();
    const nav = within(page).getByRole('navigation', { name: 'On this page' });
    const jumps = within(nav).getAllByRole('link');
    expect(jumps.map((l) => l.getAttribute('href'))).toEqual(['#overview-connections', '#overview-pinned']);
    expect(within(jumps[0] as HTMLElement).getByRole('img', { name: 'something needs a look' })).toBeTruthy();
    expect(within(page).getByText('2 connected · 2 need a look · 1 learning')).toBeTruthy();
    // Connections as small tiles, worst first (OVP-09), each level in the server's order; Add a connection in its
    // heading (OVP-10).
    const things = within(page).getByRole('region', { name: 'Connections' });
    const rows = within(things)
      .getAllByRole('link')
      .map((r) => r.dataset.thing)
      .filter(Boolean);
    expect(rows).toEqual([
      'connection:con_home-assistant',
      'connection:con_unifi',
      'device:con_heat-pump',
      'connection:con_hetzner',
      'connection:con_mara',
    ]);
    // Why, in plain words, on what isn't connected; a tile's line has no full stop.
    expect(within(things).getByText('2 integrations not loading')).toBeTruthy();
    const ha = within(things).getByRole('link', { name: /^Home Assistant, needs a look, / });
    expect(ha.getAttribute('href')).toBe('/things/connection%3Acon_home-assistant');
    expect(ha.dataset.edge).toBe('warn');
    expect(within(things).getByRole('link', { name: /^Google, .*Used today$/ })).toBeTruthy();
    const heat = within(things).getByRole('link', { name: /^Heat pump, learning/ });
    expect(within(heat).getByText(/Neo is still learning it/)).toBeTruthy();
    expect(within(heat).getByRole('img', { name: 'Learning' })).toBeTruthy();
    expect(within(things).getAllByText('Used today').length).toBeGreaterThan(0);
    expect(within(things).getByRole('link', { name: 'Add a connection' }).getAttribute('href')).toBe(
      '/connections?connection=add',
    );
    // Pinned is the last section, its widgets as they were.
    const pinned = within(page).getByRole('region', { name: 'Pinned' });
    expect(within(pinned).getByRole('region', { name: 'Heat pump · today' })).toBeTruthy();
    expect(
      screen.getByText('You pinned this from a conversation. It updates every minute without asking the AI.'),
    ).toBeTruthy();
    expect(app.location()).toBe('/connections?x=1');
  });

  it('undoes a change on Everything I did', async () => {
    const user = userEvent.setup();
    renderApp('/done', assistant());
    await user.click(await screen.findByRole('button', { name: 'Undo: Gave nextcloud more memory' }));
    expect(await screen.findByText('Undone.')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('Undone').length).toBeGreaterThan(0));
  });

  it('asks Neo to undo a change it reported and opens its chat (AP-2217, BPL-15)', async () => {
    const user = userEvent.setup();
    const app = renderApp('/done', assistant());
    await user.click(await screen.findByRole('button', { name: /^Undo: Removed 14 old Zonneplan entities/ }));
    expect(await screen.findByText('Asked Neo to undo this.')).toBeTruthy();
    await waitFor(() => expect(app.location()).toMatch(/^\/chat/));
  });
});
