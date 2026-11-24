import {
  CATALOG,
  type CatalogEntryStatus,
  type Connection,
  type ConnectionToolView,
  type ConnectionView,
} from '@whombat/core';
import { SEED_NOW, SEED_TIME_ZONE } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import {
  ADD_CONNECTION_TEXT,
  addConnectionChips,
  addConnectionFooter,
  addConnectionGroups,
  addConnectionRows,
  addNoMatch,
  addSearchPlaceholder,
  CONNECTIONS_TEXT,
  connectedRows,
  connectionDetail,
  connectionLogo,
  connectionsLine,
  connectionsOverview,
  connectionsWebPath,
  connectionToolRow,
  feedbackRow,
  githubRow,
  labelName,
  matchesConnectionSearch,
} from './connections';

const minutesBefore = (m: number) => new Date(SEED_NOW.getTime() - m * 60_000).toISOString();

function connection(over: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id: 'cn_ha',
    catalogId: 'homeassistant',
    label: 'Home Assistant',
    handle: 'homeassistant',
    connectedBy: { id: 'usr_mara', name: 'Mara' },
    detail: 'home.lan:8123',
    signIn: 'token',
    transport: 'mcp',
    fields: { url: 'http://home.lan:8123' },
    status: 'active',
    reauthReason: null,
    checks: [],
    checkedAt: minutesBefore(12),
    toolCount: 2,
    createdAt: minutesBefore(600),
    lastUsedAt: null,
    ...over,
  } as ConnectionView;
}

const google = {
  id: 'cn_google',
  provider: 'google',
  email: 'mara@example.com',
  name: 'Mara',
  services: ['mail'],
  status: 'needs_reauth',
  reauthReason: 'revoked',
  checks: [],
  checkedAt: null,
  createdAt: minutesBefore(600),
  updatedAt: minutesBefore(600),
  lastUsedAt: null,
} as unknown as Connection;

function tool(over: Partial<ConnectionToolView> = {}): ConnectionToolView {
  return {
    name: 'get_state',
    description: 'Reads an entity’s state.',
    access: 'read',
    tier: 'can',
    sensitive: false,
    isNew: false,
    ...over,
  };
}

describe('the web page of a connection (CX-71, CX-72)', () => {
  it('opens the entry, or one connection, in this burrow', () => {
    expect(connectionsWebPath('hq', 'notion')).toBe('/settings?tab=connections&connection=notion&burrow=hq');
    expect(connectionsWebPath('hq', 'homeassistant', 'cn_ha')).toBe(
      '/settings?tab=connections&connection=homeassistant&id=cn_ha&burrow=hq',
    );
  });
});

describe('logos', () => {
  it('draws a brand mark, our icon for ours, else the name’s first letter', () => {
    expect(connectionLogo('notion')).toEqual({ kind: 'mark', mark: 'notion' });
    expect(connectionLogo('github')).toEqual({ kind: 'mark', mark: 'github' });
    // A computer found on the network (connect-in-chat.md).
    expect(connectionLogo('server', 'Debian server')).toEqual({ kind: 'icon', icon: 'server' });
    // A report tracker is any ticket system: the entry's generic inbox mark (a connection shows its driver's logo).
    expect(connectionLogo('tracker', 'Report tracker')).toEqual({ kind: 'mark', mark: 'tracker' });
    expect(connectionLogo('custom_mcp')).toEqual({ kind: 'mark', mark: 'custom_mcp' });
    expect(connectionLogo('custom_api')).toEqual({ kind: 'mark', mark: 'custom_api' });
    expect(connectionLogo('feedback')).toEqual({ kind: 'mark', mark: 'feedback' });
    expect(connectionLogo('moneybird')).toEqual({ kind: 'mark', mark: 'moneybird' });
    expect(connectionLogo('someday', 'later')).toEqual({ kind: 'monogram', letter: 'L' });
  });
});

describe('CONNECTED (CX-70)', () => {
  it('shows each connection with its detail and state, accounts first', () => {
    const rows = connectedRows(
      [
        connection(),
        connection({
          id: 'cn_todo',
          catalogId: 'todoist',
          label: 'Todoist',
          detail: null,
          fields: {},
          status: 'error',
        }),
      ],
      [google],
      'hq',
    );
    expect(rows.map((r) => [r.kind, r.title, r.meta, r.state.tone, r.state.label])).toEqual([
      ['account', 'Google', 'mara@example.com', 'warn', 'Needs you to sign in again'],
      ['catalog', 'Home Assistant', 'home.lan:8123', 'ok', 'Connected'],
      ['catalog', 'Todoist', null, 'bad', 'Needs attention'],
    ]);
    expect(rows[1]?.accessibilityLabel).toBe('Home Assistant, Connected. home.lan:8123');
    expect(rows[0]?.webPath).toBe('/settings?tab=connections&connection=google&burrow=hq');
    expect(rows[1]?.webPath).toBe('/settings?tab=connections&connection=homeassistant&id=cn_ha&burrow=hq');
  });

  it('falls back to the host from the fields when the server gives no detail', () => {
    const [row] = connectedRows([connection({ detail: null })], [], 'hq');
    expect(row?.meta).toBe('home.lan:8123');
  });
});

describe('an account’s page from Connections (session minor 7)', () => {
  const active = { ...google, status: 'active' } as Connection;
  const imap = { ...google, id: 'con_mail', provider: 'imap', status: 'active' } as Connection;
  const github = githubRow(
    { connected: true, login: 'mara', error: null },
    { connected: true, on: 3 },
    'hq',
    true,
  );
  const sites = [
    { integration: { name: 'Billing portal' }, health: { reportsLast24h: 2, warnings: [] } },
    { integration: { name: 'Docs' }, health: { reportsLast24h: 1, warnings: [] } },
  ];

  it('opens each account’s page on a box that has them', () => {
    const rows = connectedRows([connection()], [active, imap], 'hq', {
      pages: true,
      builtins: [github, feedbackRow(sites, 'hq', true)],
    });
    expect(rows.map((r) => [r.title, r.opens])).toEqual([
      ['Google', { screen: 'Thing', thingId: 'connection:cn_google' }],
      ['Email (IMAP)', { screen: 'Thing', thingId: 'connection:con_mail' }],
      ['GitHub', { screen: 'Thing', thingId: 'connection:github' }],
      ['Website feedback', { screen: 'Thing', thingId: 'connection:feedback' }],
      ['Home Assistant', null],
    ]);
  });

  it('keeps each account’s own screen on an older box', () => {
    const rows = connectedRows([], [active, imap], 'hq', {
      builtins: [
        githubRow({ connected: true, login: 'mara', error: null }, null, 'hq'),
        feedbackRow(sites, 'hq'),
      ],
    });
    expect(rows.map((r) => r.opens)).toEqual([
      { screen: 'ConnectAccount', page: 'google' },
      { screen: 'ConnectAccount', page: 'imap' },
      { screen: 'ConnectAccount', page: 'github' },
      { screen: 'ConnectAccount', page: 'feedback' },
    ]);
  });

  it('lists GitHub with its account and repositories, and Website feedback with its sites and reports', () => {
    expect(github).toMatchObject({
      kind: 'account',
      catalogId: 'github',
      line: '@mara · 3 repositories on',
      logo: { kind: 'mark', mark: 'github' },
      state: { tone: 'ok' },
    });
    const feedback = feedbackRow(sites, 'hq', true);
    expect(feedback).toMatchObject({
      catalogId: 'feedback',
      meta: '2 sites',
      logo: { kind: 'mark', mark: 'feedback' },
      state: { tone: 'ok', label: 'On' },
    });
    expect(feedback?.line).toContain('3 reports');
    expect(feedbackRow([sites[0] as (typeof sites)[number]], 'hq')?.meta).toBe('Billing portal');
    // GitHub sits with the accounts, Website feedback with the apps and services.
    const overview = connectionsOverview(connectedRows([], [], 'hq', { builtins: [github, feedback] }));
    expect(overview.accounts.map((r) => r.id)).toEqual(['github']);
    expect(overview.apps.map((r) => r.id)).toEqual(['feedback']);
  });

  it('leaves GitHub and Website feedback out until they’re connected, and says when they need a look', () => {
    expect(githubRow({ connected: false, login: null, error: null }, null, 'hq')).toBeNull();
    expect(githubRow(undefined, undefined, 'hq')).toBeNull();
    expect(githubRow(undefined, { connected: true, on: 1 }, 'hq')?.line).toBe('1 repository on');
    expect(feedbackRow([], 'hq')).toBeNull();
    expect(githubRow({ connected: true, login: 'mara', error: 'gone' }, null, 'hq')?.state.tone).toBe('bad');
    const warned = [{ ...sites[0], health: { reportsLast24h: 0, warnings: [{ code: 'x' }] } }] as never;
    expect(feedbackRow(warned, 'hq')?.state.tone).toBe('bad');
    expect(connectedRows([], [], 'hq', { builtins: [null, null] })).toEqual([]);
  });
});

describe('what you have: NEEDS YOU, then CONNECTED · N (AP-1171, AP-1172)', () => {
  const todoist = connection({
    id: 'cn_todo',
    catalogId: 'todoist',
    label: 'Todoist',
    detail: null,
    fields: {},
    status: 'error',
  });

  it('puts every connection whose state isn’t fine first, with Connect again or Open', () => {
    const nextcloud = connection({
      id: 'cn_nc',
      catalogId: 'nextcloud',
      label: 'Nextcloud',
      detail: 'mara',
      fields: { url: 'https://cloud.example.com' },
      status: 'needs_reauth',
    });
    const overview = connectionsOverview(connectedRows([connection(), todoist, nextcloud], [google], 'hq'));
    expect(overview.needsYou.map((r) => [r.title, r.state.label, r.reason, r.action])).toEqual([
      ['Google', 'Needs you to sign in again', 'mara@example.com', 'Sign in again'],
      ['Todoist', 'Needs attention', null, 'Open'],
      ['Nextcloud', 'Needs you to sign in again', 'cloud.example.com', 'Sign in again'],
    ]);
    expect(overview.apps.map((r) => r.title)).toEqual(['Home Assistant']);
    expect(overview.appsTitle).toBe('APPS AND SERVICES · 1');
    expect(overview.accounts).toEqual([]);
  });

  it('says Nothing connected yet when nothing is connected at all', () => {
    expect(connectionsOverview([])).toMatchObject({ needsYou: [], accounts: [], apps: [], empty: true });
    expect(connectionsLine([])).toEqual({ value: 'Nothing connected yet.', tone: null });
  });

  it('puts accounts apart, says when two can’t be told apart, and gives Settings its line (sidebar-tabs.md)', () => {
    const hetzner = (id: string) =>
      connection({ id, catalogId: 'hetzner', label: 'Hetzner Cloud', fields: {} });
    const rows = connectedRows([hetzner('cn_1'), hetzner('cn_2')], [{ ...google, status: 'active' }], 'hq');
    const overview = connectionsOverview(rows);
    expect(overview.accounts.map((r) => r.title)).toEqual(['Google']);
    expect(overview.apps.map((r) => r.line)).toEqual([
      expect.stringContaining('Rename'),
      expect.stringContaining('Rename'),
    ]);
    expect(connectionsLine(rows)).toEqual({ value: '3 connected', tone: null });
    const broken = connectedRows([{ ...hetzner('cn_1'), status: 'error' }], [], 'hq');
    expect(connectionsLine(broken)).toEqual({ value: 'Hetzner Cloud needs you', tone: 'bad' });
  });

  it('says only where it is on the meta line (AP-1177), and still says Connected', () => {
    const [mail, ha] = connectedRows(
      [connection()],
      [{ ...google, status: 'active', reauthReason: null } as Connection],
      'hq',
    );
    expect(ha?.line).toBe('home.lan:8123');
    expect(ha?.accessibilityLabel).toBe('Home Assistant, Connected. home.lan:8123');
    expect(mail?.line).toBe('mara@example.com');
    expect(connectedRows([todoist], [], 'hq')[0]?.line).toBeNull();
    // The default label's address isn't said twice; “Look only” joins the line.
    const [named] = connectedRows(
      [connection({ label: 'Home Assistant · home.lan:8123', access: 'read' })],
      [],
      'hq',
    );
    expect([named?.title, named?.line]).toEqual(['Home Assistant', 'home.lan:8123 · Look only']);
    expect(labelName('Upstairs', 'home.lan:8123')).toBe('Upstairs');
  });
});

/** The statuses a Whombat answers: every entry it has (available unless `over` says otherwise). */
function allStatuses(
  over: Record<string, Pick<CatalogEntryStatus, 'available' | 'reason'>> = {},
): CatalogEntryStatus[] {
  return CATALOG.map((e) => ({ catalogId: e.id, available: true, reason: null, ...over[e.id] }));
}

describe('Add a connection (AP-1173…AP-1175)', () => {
  const statuses = allStatuses({
    dropbox: { available: false, reason: 'app_not_configured' },
    notion: { available: false, reason: 'off' },
  });

  it('offers every entry not turned off, tagged Connected or Set up', () => {
    const rows = addConnectionRows(statuses, ['google', 'homeassistant'], 'hq');
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.has('notion')).toBe(false);
    expect(byId.get('google')?.tag).toEqual({ text: 'Connected', tone: 'ok' });
    expect(byId.get('homeassistant')?.tag).toEqual({ text: 'Connected', tone: 'ok' });
    expect(byId.get('dropbox')?.tag).toEqual({ text: 'Set up', tone: 'neutral' });
    expect(byId.get('dropbox')?.note).toBe(CONNECTIONS_TEXT.notSetUp);
    expect(byId.get('dropbox')?.accessibilityLabel).toBe(
      'Dropbox, Set up. Files and folders in your Dropbox. Not set up on this Whombat yet',
    );
    expect(byId.get('todoist')?.tag).toBeNull();
    expect(byId.get('microsoft')?.tag).toBeNull();
    expect(byId.get('homeassistant')?.webPath).toBe(
      '/settings?tab=connections&connection=homeassistant&burrow=hq',
    );
  });

  it('notes an entry that needs a secure address first, without the Set up tag', () => {
    const rows = addConnectionRows(
      allStatuses({ dropbox: { available: false, reason: 'needs_secure_address' } }),
      [],
      'hq',
    );
    const dropbox = rows.find((r) => r.id === 'dropbox');
    expect(dropbox?.note).toBe('Needs a secure address');
    expect(dropbox?.tag).toBeNull();
  });

  it('says Add a Mac first on Find My without a Mac, and opens Add a server', () => {
    const rows = addConnectionRows(
      allStatuses({ findmy: { available: false, reason: 'needs_mac' } }),
      [],
      'hq',
    );
    const findMy = rows.find((r) => r.id === 'findmy');
    expect(findMy?.note).toBe('Add a Mac first');
    expect(findMy?.tag).toBeNull();
    expect(findMy?.opens).toEqual({ screen: 'AddServer' });
    // With a Mac it opens its Connect screen, as every entry.
    const ready = addConnectionRows(allStatuses(), [], 'hq').find((r) => r.id === 'findmy');
    expect(ready?.opens).toEqual({ screen: 'Connect', catalogId: 'findmy' });
  });

  it('leaves out a report tracker without a driver here, and offers one with a driver', () => {
    const none = addConnectionRows(
      allStatuses({ tracker: { available: false, reason: 'no_driver' } }),
      [],
      'hq',
    );
    expect(none.map((r) => r.id)).not.toContain('tracker');
    expect(none.map((r) => r.id)).toContain('homeassistant');
    expect(addConnectionRows(allStatuses(), [], 'hq').map((r) => r.id)).toContain('tracker');
  });

  it('leaves out an entry the Whombat doesn’t list: one newer than it (connections-more-android.md AP-2816)', () => {
    const older = allStatuses().filter((st) => st.catalogId !== 'todoist');
    const ids = addConnectionRows(older, [], 'hq').map((r) => r.id);
    expect(ids).not.toContain('todoist');
    expect(ids).toContain('homeassistant');
    // Until the statuses answer, or when they fail, the catalog as it is.
    expect(addConnectionRows(null, [], 'hq').map((r) => r.id)).toContain('todoist');
  });

  it('counts what is offered in the search field', () => {
    // The whole catalog, Fusebox and the AI gateway included where the runtime has gateways.
    expect(
      addSearchPlaceholder(addConnectionRows(null, [], 'hq', { gateway: true, imap: true }).length),
    ).toBe('Search 59 services');
    expect(addSearchPlaceholder(addConnectionRows(statuses, [], 'hq').length)).toBe('Search 55 services');
    expect(addSearchPlaceholder(1)).toBe('Search 1 service');
  });

  it('has All, then each category with an entry, without Custom', () => {
    const rows = addConnectionRows(null, [], 'hq');
    expect(addConnectionChips(rows).map((c) => c.label)).toEqual([
      'All',
      'Accounts',
      'Productivity',
      'Files',
      'Home',
      'Business',
      'Developer',
      'Infrastructure',
    ]);
    const noBusiness = rows.filter((r) => r.category !== 'business');
    expect(addConnectionChips(noBusiness).map((c) => c.value)).not.toContain('business');
  });

  it('lists by category, only the chosen chip’s, Custom only while searching', () => {
    const rows = addConnectionRows(null, [], 'hq');
    expect(addConnectionGroups(rows, 'all', '').map((g) => g.title)).toEqual([
      'ACCOUNTS',
      'PRODUCTIVITY',
      'FILES',
      'HOME',
      'BUSINESS',
      'DEVELOPER',
      'INFRASTRUCTURE',
    ]);
    const home = addConnectionGroups(rows, 'home', '');
    expect(home.map((g) => g.title)).toEqual(['HOME']);
    expect(home[0]?.rows.map((r) => r.id)).toEqual([
      'homeassistant',
      'esphome',
      'ps5',
      'findmy',
      'plex',
      'jellyfin',
      'overseerr',
      'sabnzbd',
      'qbittorrent',
      'nzbhydra',
      'sonarr',
      'radarr',
      'unifi_protect',
      'frigate',
      'unifi_access',
      'adguard',
      'pihole',
    ]);
    expect(addConnectionGroups(rows, 'all', 'mcp').flatMap((g) => g.rows.map((r) => r.id))).toEqual([
      'custom_mcp',
    ]);
  });

  it('matches every word, in any order, in the name, description or category', () => {
    const row = {
      title: 'Home Assistant',
      description: 'Lights, sensors and automations in your home.',
      category: 'home' as const,
    };
    expect(matchesConnectionSearch(row, '')).toBe(true);
    expect(matchesConnectionSearch(row, 'SENSORS assist')).toBe(true);
    expect(matchesConnectionSearch(row, 'home lights')).toBe(true);
    expect(matchesConnectionSearch(row, 'lights cameras')).toBe(false);
    const rows = addConnectionRows(null, [], 'hq');
    const ids = (q: string, category: 'all' | 'files' = 'all') =>
      addConnectionGroups(rows, category, q).flatMap((g) => g.rows.map((r) => r.id));
    expect(ids('infrastructure proxmox')).toEqual(['proxmox', 'proxmox_backup']);
    expect(ids('photo')).toEqual(['immich']);
    expect(ids('photo', 'files')).toEqual(['immich']);
    expect(ids('dropbox', 'files')).toEqual(['dropbox']);
    expect(ids('zzz')).toEqual([]);
    expect(addNoMatch(' zzz ')).toBe('No connection matches “zzz”.');
  });

  it('offers the Custom entries in the footer, each only when offered', () => {
    const rows = addConnectionRows(null, [], 'hq');
    const footer = addConnectionFooter(rows);
    expect(footer.mcp?.webPath).toBe('/settings?tab=connections&connection=custom_mcp&burrow=hq');
    expect(footer.api?.webPath).toBe('/settings?tab=connections&connection=custom_api&burrow=hq');
    const off = addConnectionRows(allStatuses({ custom_api: { available: false, reason: 'off' } }), [], 'hq');
    expect(addConnectionFooter(off).api).toBeNull();
    expect(ADD_CONNECTION_TEXT.mcp).toBe('any MCP server');
  });
});

describe('a connection’s TOOLS (CX-72)', () => {
  it('shows the tier, Always asks and New', () => {
    expect(connectionToolRow(tool())).toMatchObject({
      tierLabel: 'Allowed',
      tierTone: 'ok',
      alwaysAsks: null,
      isNew: null,
      access: 'read',
      accessibilityLabel: 'get_state, Allowed. read. Reads an entity’s state.',
    });
    const sensitive = connectionToolRow(
      tool({ name: 'call_service', access: 'write', tier: 'can', sensitive: true, isNew: true }),
    );
    expect(sensitive).toMatchObject({
      tier: 'ask',
      tierLabel: 'Asks',
      alwaysAsks: 'Always asks',
      isNew: 'New',
    });
    expect(connectionToolRow(tool({ tier: 'off', sensitive: true })).tierLabel).toBe('Off');
    expect(connectionToolRow(tool({ description: '  ' })).description).toBeNull();
  });
});

describe('one connection (CX-72)', () => {
  it('says its state, last check, who connected it, and what the web button does', () => {
    const detail = connectionDetail(
      {
        connection: connection({
          checks: [
            { id: 'credential', state: 'ok', message: 'Signed in.' },
            { id: 'mcp', state: 'warning', message: 'The MCP server answered slowly.' },
          ],
        }),
        tools: [tool(), tool({ name: 'call_service', access: 'write', tier: 'ask' })],
        guide: ' ',
        truncated: false,
      },
      SEED_NOW,
      SEED_TIME_ZONE,
      'hq',
    );
    expect(detail).toMatchObject({
      title: 'Home Assistant',
      meta: 'Home Assistant',
      detail: 'home.lan:8123',
      checked: 'Checked 12 min ago',
      connectedBy: 'Connected by Mara',
      guide: null,
      truncated: null,
      stateLabel: 'Connected · Checked 12 min ago',
      webPath: '/settings?tab=connections&connection=homeassistant&id=cn_ha&burrow=hq',
    });
    expect(detail.checks).toEqual([{ id: 'mcp', tone: 'warn', message: 'The MCP server answered slowly.' }]);
    // What the agent may do (CT-314): Manage unless it looks only; an older runtime's connection manages.
    expect(detail.access).toBe('Manage');
    expect(detail.tools.map((t) => [t.name, t.tierLabel])).toEqual([
      ['get_state', 'Allowed'],
      ['call_service', 'Asks'],
    ]);
  });

  it('says it needs checking again (PC-09: no web button), and what the agent may do', () => {
    const base = { tools: [], guide: 'Use the REST API.', truncated: true };
    const reauth = connectionDetail(
      { ...base, connection: connection({ status: 'needs_reauth', checkedAt: null }) },
      SEED_NOW,
      SEED_TIME_ZONE,
      'hq',
    );
    expect(reauth).toMatchObject({
      checked: 'Not checked yet',
      guide: 'Use the REST API.',
      truncated: CONNECTIONS_TEXT.truncated,
    });
    const looks = connectionDetail(
      { ...base, connection: connection({ access: 'read' }) },
      SEED_NOW,
      SEED_TIME_ZONE,
      'hq',
    );
    expect(looks.access).toBe('Look only');
  });
});

describe('nobody looks after a connection (Whombat one-agent.md OA-07, AP-4991)', () => {
  it('has no caretaker on its screen', () => {
    const detail = connectionDetail(
      { connection: connection(), tools: [], guide: '', truncated: false },
      SEED_NOW,
      SEED_TIME_ZONE,
      'hq',
    );
    expect(detail).not.toHaveProperty('lookedAfter');
  });
});

describe('an AI gateway (Whombat ai-gateway.md AIG-01, AIG-05; AP-1123)', () => {
  const fusebox = connection({
    id: 'cn_fb',
    catalogId: 'fusebox',
    label: 'Fusebox',
    handle: 'fusebox',
    detail: null,
    transport: 'rest',
    fields: { url: 'https://10.100.0.235:8317' },
    toolCount: 0,
  });

  it('says only its address on its row: which tools go through it is on its screen (AP-1177)', () => {
    const [row] = connectedRows([fusebox], [], 'hq');
    expect(row?.line).toBe('10.100.0.235:8317');
    expect(row?.accessibilityLabel).toBe('Fusebox, Connected. 10.100.0.235:8317');
  });

  it('has none of the agent’s parts on its screen, but its kind for the switches', () => {
    const detail = connectionDetail(
      {
        connection: fusebox,
        tools: [tool()],
        guide: 'Your agent doesn’t use this connection.',
        truncated: true,
      },
      SEED_NOW,
      SEED_TIME_ZONE,
      'hq',
    );
    expect(detail).toMatchObject({
      gateway: { kind: 'fusebox' },
      tools: [],
      guide: null,
      truncated: null,
    });
    expect(
      connectionDetail(
        { connection: connection(), tools: [], guide: '', truncated: false },
        SEED_NOW,
        SEED_TIME_ZONE,
        'hq',
      ).gateway,
    ).toBeNull();
  });

  it('shows the Vault’s sync (1Password) without the agent’s parts either', () => {
    const detail = connectionDetail(
      {
        connection: connection({
          id: 'con_1p',
          catalogId: 'onepassword',
          label: '1Password',
          handle: 'onepassword',
          detail: null,
          transport: 'rest',
          fields: { vault: 'k3ntq6b7f2x4yhd5wzmuv9cj8a', entries: 'put' },
          toolCount: 0,
        }),
        tools: [tool()],
        guide: 'Make a vault in 1Password for Whombat.',
        truncated: true,
      },
      SEED_NOW,
      SEED_TIME_ZONE,
      'hq',
    );
    expect(detail).toMatchObject({ vaultSync: true, gateway: null, tools: [], guide: null, truncated: null });
    expect(
      connectionDetail(
        { connection: connection(), tools: [], guide: '', truncated: false },
        SEED_NOW,
        SEED_TIME_ZONE,
        'hq',
      ).vaultSync,
    ).toBe(false);
  });

  it('offers Fusebox and the AI gateway only where the runtime has ai.gateway', () => {
    const ids = (gateway: boolean) => addConnectionRows(null, [], 'hq', { gateway }).map((r) => r.id);
    expect(ids(true)).toEqual(expect.arrayContaining(['fusebox', 'ai_gateway']));
    expect(ids(false)).not.toContain('fusebox');
    expect(ids(false)).not.toContain('ai_gateway');
    expect(ids(false)).toContain('homeassistant');
  });
});

describe('more connections on the phone (connections-more-android.md AP-2810…AP-2817)', () => {
  const NEW_IDS = [
    'unifi_access',
    'sabnzbd',
    'nzbhydra',
    'plex',
    'overseerr',
    'adguard',
    'pihole',
    'nginx_proxy_manager',
    'truenas',
    'esphome',
    'pterodactyl',
    'airtable',
    'hubspot',
    'pipedrive',
    'plausible',
    'imap',
  ];
  const imap = {
    ...google,
    id: 'cn_imap',
    provider: 'imap',
    email: 'mara@okafor.example',
    status: 'active',
    reauthReason: null,
    mail: { imapHost: 'imap.fastmail.com', smtpHost: 'smtp.fastmail.com', username: 'mara@okafor.example' },
  } as Connection;

  it('draws Synology’s and QNAP’s marks (AP-3800)', () => {
    expect(connectionLogo('synology')).toEqual({ kind: 'mark', mark: 'synology' });
    expect(connectionLogo('qnap')).toEqual({ kind: 'mark', mark: 'qnap' });
  });

  it('draws each new entry’s mark (AP-2811)', () => {
    expect(NEW_IDS.map((id) => connectionLogo(id).kind)).toEqual(NEW_IDS.map(() => 'mark'));
    expect(connectionLogo('truenas')).toEqual({ kind: 'mark', mark: 'truenas' });
  });

  it('shows an Email (IMAP) account like Google’s: its address and its page on the web (AP-2810)', () => {
    const [row] = connectedRows([], [imap], 'hq');
    expect(row).toMatchObject({
      kind: 'account',
      catalogId: 'imap',
      title: 'Email (IMAP)',
      line: 'mara@okafor.example',
      logo: { kind: 'mark', mark: 'imap' },
      webPath: '/settings?tab=connections&connection=imap&burrow=hq',
    });
    expect(row?.accessibilityLabel).toBe('Email (IMAP), Connected. mara@okafor.example');
    // A refused password: NEEDS YOU, and the person connects it again on the web.
    const again = connectionsOverview(connectedRows([], [{ ...imap, status: 'needs_reauth' }], 'hq'));
    expect(again.needsYou.map((r) => [r.title, r.action, r.reason])).toEqual([
      ['Email (IMAP)', 'Sign in again', 'mara@okafor.example'],
    ]);
  });

  it('offers Email (IMAP) where the Whombat says it is available, or when you have one (AP-2816)', () => {
    const ids = (options: { imap?: boolean }, connected: string[] = []) =>
      addConnectionRows(allStatuses(), connected, 'hq', options).map((r) => r.id);
    expect(ids({ imap: true })).toContain('imap');
    expect(ids({})).not.toContain('imap');
    expect(ids({ imap: false }, ['imap'])).toContain('imap');
    const row = addConnectionRows(allStatuses(), ['imap'], 'hq', { imap: true }).find((r) => r.id === 'imap');
    expect([row?.category, row?.tag?.text, row?.webPath]).toEqual([
      'accounts',
      'Connected',
      '/settings?tab=connections&connection=imap&burrow=hq',
    ]);
    // An older Whombat lists none of the new entries: none is offered.
    const older = allStatuses().filter((st) => !NEW_IDS.includes(st.catalogId));
    expect(addConnectionRows(older, [], 'hq', { imap: true }).filter((r) => NEW_IDS.includes(r.id))).toEqual(
      [],
    );
  });

  it('says a socket connection’s address like any other’s (AP-2812)', () => {
    const rows = connectedRows(
      [
        connection({
          id: 'cn_truenas',
          catalogId: 'truenas',
          label: 'TrueNAS',
          transport: 'socket',
          detail: null,
          fields: { url: 'https://truenas.lan' },
        }),
        connection({
          id: 'cn_esphome',
          catalogId: 'esphome',
          label: 'ESPHome',
          transport: 'socket',
          signIn: 'none',
          detail: null,
          fields: { url: 'http://esphome.lan:6052' },
        }),
        connection({
          id: 'cn_pihole',
          catalogId: 'pihole',
          label: 'Pi-hole',
          transport: 'rest',
          status: 'needs_reauth',
          reauthReason: 'token_invalid',
          detail: null,
          fields: { url: 'http://pi.hole' },
        }),
      ],
      [],
      'hq',
    );
    const { needsYou, apps } = connectionsOverview(rows);
    expect(apps.map((r) => [r.title, r.line, r.logo])).toEqual([
      ['TrueNAS', 'truenas.lan', { kind: 'mark', mark: 'truenas' }],
      ['ESPHome', 'esphome.lan:6052', { kind: 'mark', mark: 'esphome' }],
    ]);
    // A refused app password (a session sign-in, CM-11) says what every refused sign-in says (AP-2813).
    expect(needsYou.map((r) => [r.title, r.state.label, r.action])).toEqual([
      ['Pi-hole', 'Needs you to sign in again', 'Sign in again'],
    ]);
  });

  it('finds the new entries by their words', () => {
    const rows = addConnectionRows(allStatuses(), [], 'hq', { imap: true });
    const ids = (q: string) => addConnectionGroups(rows, 'all', q).flatMap((g) => g.rows.map((r) => r.id));
    expect(ids('pi-hole')).toEqual(['pihole']);
    expect(ids('fastmail')).toEqual(['imap']);
    expect(ids('dns')).toEqual(expect.arrayContaining(['adguard', 'pihole']));
    expect(ids('usenet')).toEqual(['nzbhydra']);
  });
});
