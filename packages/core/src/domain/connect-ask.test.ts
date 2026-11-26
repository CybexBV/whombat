import { describe, expect, it } from 'vitest';
import {
  CONNECT_HERE_DECLINE,
  CONNECT_HERE_FIELDS,
  CONNECT_HERE_FORM,
  catalogEntry,
  connectAccessLine,
  connectAccessOf,
  connectAskHref,
  connectEntryOf,
  connectHereAsk,
  connectHereCard,
  connectHereLocked,
  connectSignInCard,
  connectsByTalking,
  FOUND_SERVER_ID,
  foundServerName,
  foundServerUrl,
  GuideCard,
  guideCardText,
  suggestedAccess,
} from './index.js';

const entry = (id: string) => {
  const e = catalogEntry(id);
  if (!e) throw new Error(id);
  return e;
};

describe('connect from the chat (connect-in-chat.md)', () => {
  it('finds the entry by id, name or handle', () => {
    expect(connectEntryOf('homeassistant')?.id).toBe('homeassistant');
    expect(connectEntryOf('Home Assistant')?.id).toBe('homeassistant');
    expect(connectEntryOf('home-assistant')?.id).toBe('homeassistant');
    expect(connectEntryOf('unifi network')?.id).toBe('unifi_network');
    expect(connectEntryOf('a toaster')).toBeNull();
    // Only automations use a report tracker; the built-in Servers connection isn't connected this way.
    expect(connectEntryOf('tracker')).toBeNull();
    expect(connectEntryOf('whombat_servers')).toBeNull();
  });

  it('chooses Look only or Manage by risk', () => {
    expect(suggestedAccess(entry('homeassistant'))).toBe('manage');
    expect(suggestedAccess(entry('pihole'))).toBe('manage');
    // Connected to hand work to its agents.
    expect(suggestedAccess(entry('t3code'))).toBe('manage');
    expect(suggestedAccess(entry('synology'))).toBe('read');
    expect(suggestedAccess(entry('unifi_network'))).toBe('read');
    expect(suggestedAccess(entry('cloudflare'))).toBe('read');
  });

  it('says the level of the assistant', () => {
    expect(connectAccessLine(entry('proxmox'), 'read', 'Dusty')).toMatch(/^Dusty can see/);
    expect(connectAccessLine(entry('homeassistant'), 'manage', 'Neo')).toMatch(/^Neo /);
  });

  it('opens the connect form filled in', () => {
    const href = connectAskHref({
      catalogId: 'homeassistant',
      url: 'http://192.168.1.10:8123',
      access: 'manage',
    });
    expect(href.startsWith('/settings?tab=connections&connection=homeassistant&')).toBe(true);
    expect(href).toContain(`url=${encodeURIComponent('http://192.168.1.10:8123')}`);
    expect(href).toContain('access=manage');
    expect(connectAskHref({ catalogId: 'cloudflare', url: null, access: 'read' })).not.toContain('url=');
    expect(connectAccessOf('read')).toBe('read');
    expect(connectAccessOf('admin')).toBeNull();
  });

  it('points Proxmox VE, its Backup Server and Unraid to Add a server', () => {
    expect(entry('proxmox').asServer).toBe(true);
    expect(entry('proxmox_backup').asServer).toBe(true);
    expect(entry('unraid').asServer).toBe(true);
    expect(entry('homeassistant').asServer).toBe(false);
  });
});

describe('an MCP server or API set up by talking (connect-by-talking.md)', () => {
  const api = entry('custom_api');
  const mcp = entry('custom_mcp');
  const choice = {
    label: 'Weather',
    url: 'https://api.weather.example/v2',
    access: 'read' as const,
    notes: 'GET /forecast?city=…',
  };
  const ask = (e: typeof api, more: Partial<Parameters<typeof connectHereAsk>[1]>) => {
    const made = connectHereAsk(e, { ...choice, signIn: 'bearer', ...more });
    if ('problem' in made) throw new Error(made.problem);
    return made.ask;
  };
  const fieldIds = (card: GuideCard) =>
    card.blocks.flatMap((b) => (b.type === 'form' ? b.fields.map((f) => `${f.id}:${f.kind}`) : []));
  const actionIds = (card: GuideCard) =>
    card.blocks.flatMap((b) => (b.type === 'actions' ? b.actions.map((a) => a.id) : []));

  it('is for the Custom entries, found by their names', () => {
    expect(connectEntryOf('MCP server')?.id).toBe('custom_mcp');
    expect(connectEntryOf('custom_api')?.id).toBe('custom_api');
    expect(connectsByTalking(api)).toBe(true);
    expect(connectsByTalking(mcp)).toBe(true);
    expect(connectsByTalking(entry('homeassistant'))).toBe(false);
  });

  it('picks the entry’s sign-in way for the shape chosen', () => {
    expect(ask(api, {})).toMatchObject({ signIn: 'token', method: 0, notes: choice.notes });
    expect(ask(api, {}).auth).toBeUndefined();
    expect(ask(api, { signIn: 'header', keyName: 'Authorization', keyPrefix: 'Token ' })).toMatchObject({
      method: 1,
      auth: { type: 'header', name: 'Authorization', template: 'Token {secret}' },
    });
    expect(ask(api, { signIn: 'basic', username: 'mara' })).toMatchObject({ method: 2, username: 'mara' });
    expect(ask(api, { signIn: 'query', keyName: 'appid' })).toMatchObject({
      method: 3,
      auth: { type: 'query', name: 'appid' },
    });
    expect(ask(mcp, { signIn: 'none' })).toMatchObject({ signIn: 'none' });
  });

  it('tells the agent what doesn’t fit', () => {
    const problem = (e: typeof api, more: Partial<Parameters<typeof connectHereAsk>[1]>) =>
      'problem' in connectHereAsk(e, { ...choice, signIn: 'bearer', ...more });
    expect(problem(api, { signIn: 'none' })).toBe(true);
    expect(problem(api, { signIn: 'header' })).toBe(true);
    expect(problem(api, { signIn: 'header', keyName: 'Cookie' })).toBe(true);
    expect(problem(api, { signIn: 'query', keyName: 'a b' })).toBe(true);
    expect(problem(mcp, { signIn: 'basic' })).toBe(true);
  });

  it('makes a card that takes the key and connects, with Not now', () => {
    const card = connectHereCard(api, ask(api, {}), 'Dusty');
    expect(card).toMatchObject({ guide: 'add_connection', node: 'here', state: 'open' });
    expect(card.title).toContain('Weather');
    expect(card.body).toContain('api.weather.example/v2');
    expect(card.body).toContain('Dusty');
    // The agent's notes go to the connection, never onto the card.
    expect(card.body).not.toContain('/forecast');
    expect(card.connectAsk?.url).toBe(choice.url);
    expect(fieldIds(card)).toEqual([`${CONNECT_HERE_FIELDS.secret}:secret`]);
    expect(card.blocks.find((b) => b.type === 'form')).toMatchObject({ id: CONNECT_HERE_FORM });
    expect(actionIds(card)).toEqual([CONNECT_HERE_DECLINE]);
  });

  it('asks the username of a basic sign-in only when it isn’t known', () => {
    expect(fieldIds(connectHereCard(api, ask(api, { signIn: 'basic' }), 'Dusty'))).toEqual([
      `${CONNECT_HERE_FIELDS.username}:text`,
      `${CONNECT_HERE_FIELDS.secret}:secret`,
    ]);
    expect(fieldIds(connectHereCard(api, ask(api, { signIn: 'basic', username: 'mara' }), 'Dusty'))).toEqual([
      `${CONNECT_HERE_FIELDS.secret}:secret`,
    ]);
  });

  it('connects an open MCP server with one button', () => {
    const card = connectHereCard(
      mcp,
      ask(mcp, { signIn: 'none', url: 'https://mcp.example.com/mcp' }),
      'Dusty',
    );
    expect(fieldIds(card)).toEqual([]);
    expect(actionIds(card)).toEqual([CONNECT_HERE_FORM, CONNECT_HERE_DECLINE]);
    expect(card.body).toContain('MCP');
  });

  it('sends an MCP server with its own sign-in to the connect form, and carries OAuth data when given a return path', () => {
    const card = connectSignInCard(
      mcp,
      { label: 'Linear', url: 'https://mcp.linear.app/mcp', access: 'read' },
      'Dusty',
    );
    expect(card.connectAsk).toBeUndefined();
    expect(card.connectOAuth).toBeUndefined();
    const action = card.blocks.flatMap((b) => (b.type === 'actions' ? b.actions : []))[0];
    expect(action?.href).toContain('connection=custom_mcp');
    expect(action?.href).toContain(encodeURIComponent('https://mcp.linear.app/mcp'));

    const returnTo = '/burrow-hq/chat?thread=msg_root&guide=msg_card';
    const direct = connectSignInCard(
      mcp,
      { label: 'Linear', url: 'https://mcp.linear.app/mcp', access: 'read', returnTo },
      'Dusty',
    );
    expect(direct.connectOAuth).toEqual({
      catalogId: 'custom_mcp',
      method: 'mcp_oauth',
      label: 'Linear',
      url: 'https://mcp.linear.app/mcp',
      access: 'read',
      returnTo,
    });
    const actions = direct.blocks.flatMap((b) => (b.type === 'actions' ? b.actions : []));
    expect(actions.map((a) => a.id)).toEqual(['connect', CONNECT_HERE_DECLINE]);
    expect(actions[0]?.href).toContain(`returnTo=${encodeURIComponent(returnTo)}`);
    expect(connectHereLocked('allowed', 'Linear')).toContain('Linear');
  });

  it('names the connection on the locked card and in the history', () => {
    expect(connectHereLocked('connected', 'Weather')).toContain('Weather');
    const card = GuideCard.parse({
      ...connectHereCard(api, ask(api, {}), 'Dusty'),
      state: 'done',
      answer: {
        actionId: CONNECT_HERE_FORM,
        label: connectHereLocked('connected', 'Weather'),
        at: '2026-11-05T10:00:00.000Z',
        connectionId: 'con_0123456789abcdef',
      },
    });
    expect(guideCardText(card)).toContain('con_0123456789abcdef');
  });
});

describe('servers found on the network (connect-in-chat.md)', () => {
  it('have an ssh address and a name from their system', () => {
    expect(FOUND_SERVER_ID).toBe('server');
    expect(foundServerUrl('10.0.0.5', 22)).toBe('ssh://10.0.0.5');
    expect(foundServerUrl('10.0.0.5', 2222)).toBe('ssh://10.0.0.5:2222');
    expect(foundServerName('Debian')).toBe('Debian server');
    expect(foundServerName(null)).toBe('Server');
  });
});

describe('the Vault card (connect-in-chat.md)', () => {
  const card = GuideCard.parse({
    kind: 'guide',
    guide: 'secret',
    node: 'new',
    title: 'Dusty needs the UniFi password',
    blocks: [],
    state: 'done',
    vaultAsk: { kind: 'login', name: 'UniFi', url: 'https://192.168.1.1' },
    answer: {
      actionId: 'save',
      label: 'Saved to your Vault · UniFi',
      at: '2026-10-30T09:00:00.000Z',
      vaultEntryId: 'vlt_abc123',
    },
  });

  it('keeps where it goes, never a value', () => {
    expect(card.vaultAsk).toMatchObject({ kind: 'login', name: 'UniFi', username: null, entryId: null });
  });

  it('reads as the entry it went to', () => {
    expect(guideCardText(card)).toContain('Vault entry vlt_abc123');
    const answer = card.answer ?? { actionId: 'save', optionIds: null, label: 'x', at: '' };
    expect(guideCardText({ ...card, answer: { ...answer, vaultEntryId: undefined } })).not.toContain(
      'Vault entry',
    );
  });
});
