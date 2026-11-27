import { describe, expect, it } from 'vitest';
import { paneFor } from '../shell/shellState';
import {
  currentSettingsTab,
  type SettingsSearch,
  settingsHome,
  settingsRedirect,
  validateBranchSearch,
  validateConversationSearch,
  validateSettingsSearch,
} from './search';

describe('search param validators', () => {
  it('only keeps ?tab=files (conversation is the default)', () => {
    expect(validateBranchSearch({ tab: 'files' })).toEqual({ tab: 'files' });
    expect(validateBranchSearch({ tab: 'conversation' })).toEqual({});
    expect(validateBranchSearch({ tab: 'nope', thread: 'm' })).toEqual({ thread: 'm' });
  });

  it('keeps ?file= only on Files changed, as a plain path (AP-664)', () => {
    expect(validateBranchSearch({ tab: 'files', file: 'billing/pdf/format.ts' })).toEqual({
      tab: 'files',
      file: 'billing/pdf/format.ts',
    });
    expect(validateBranchSearch({ file: 'billing/pdf/format.ts' })).toEqual({});
    expect(validateBranchSearch({ tab: 'files', file: 'a\nb' })).toEqual({ tab: 'files' });
    expect(validateBranchSearch({ tab: 'files', file: 'x'.repeat(4097) })).toEqual({ tab: 'files' });
    expect(validateBranchSearch({ tab: 'files', file: 42 })).toEqual({ tab: 'files' });
  });

  it('opens one pane: a plan (and its step) wins over a thread; bad ids are dropped', () => {
    expect(validateConversationSearch({ plan: 'pln_1', step: 'stp_2', thread: 'msg_1' })).toEqual({
      plan: 'pln_1',
      step: 'stp_2',
    });
    expect(validateConversationSearch({ step: 'stp_2', thread: 'msg_1' })).toEqual({ thread: 'msg_1' });
    expect(validateConversationSearch({ plan: 'javascript:x' })).toEqual({});
    expect(validateConversationSearch({ plans: '1', thread: 'msg_1' })).toEqual({ plans: true });
    expect(paneFor({ kind: 'room', room: 'chat' }, { plan: 'pln_1', step: 'stp_2' })).toEqual({
      kind: 'plan',
      planId: 'pln_1',
      stepId: 'stp_2',
    });
    expect(paneFor({ kind: 'run', number: 1 }, { plan: 'pln_1' })).toBeNull();
  });

  it('opens the pins pane with ?pins=1, one pane at a time (essentials-messages.md AP-445)', () => {
    expect(validateConversationSearch({ pins: 'true', thread: 'msg_1', focus: 1 })).toEqual({ pins: 1 });
    expect(validateConversationSearch({ pins: '1', plans: '1' })).toEqual({ plans: true });
    expect(validateConversationSearch({ pins: '1', plan: 'pln_1' })).toEqual({ plan: 'pln_1' });
    expect(validateConversationSearch({ pins: 'no', thread: 'msg_1' })).toEqual({ thread: 'msg_1' });
    expect(paneFor({ kind: 'room', room: 'chat' }, { pins: 1 })).toEqual({ kind: 'pins' });
    expect(paneFor({ kind: 'pr', number: 12 }, { pins: '1' })).toEqual({ kind: 'pins' });
    expect(paneFor({ kind: 'settings' }, { pins: 1 })).toBeNull();
  });
});

describe('settings search', () => {
  it('takes the Vault tab and an open entry only with it (AP-111)', () => {
    expect(validateSettingsSearch({ tab: 'vault', entry: 'vlt_homeassistant' })).toEqual({
      tab: 'vault',
      entry: 'vlt_homeassistant',
    });
    expect(validateSettingsSearch({ tab: 'vault', entry: 'evt_1' })).toEqual({ tab: 'vault' });
    expect(validateSettingsSearch({ tab: 'packs', entry: 'vlt_homeassistant' })).toEqual({ tab: 'packs' });
  });
});

describe('settings in four groups and their old addresses (SS-02)', () => {
  it('takes the four groups, You without `?tab=`, and the old tabs until they are redirected', () => {
    expect(validateSettingsSearch({ tab: 'you' })).toEqual({});
    expect(validateSettingsSearch({ tab: 'agent' })).toEqual({ tab: 'agent' });
    expect(validateSettingsSearch({ tab: 'appliance' })).toEqual({ tab: 'appliance' });
    expect(validateSettingsSearch({ tab: 'advanced' })).toEqual({ tab: 'advanced' });
    expect(validateSettingsSearch({ tab: 'profile' })).toEqual({ tab: 'profile' });
    expect(validateSettingsSearch({ tab: 'repos' })).toEqual({ tab: 'repos' });
    expect(validateSettingsSearch({ tab: 'nope' })).toEqual({});
    expect(currentSettingsTab(undefined)).toBe('you');
    expect(currentSettingsTab('agent')).toBe('agent');
    expect(currentSettingsTab('appliance')).toBe('appliance');
    expect(currentSettingsTab('advanced')).toBe('advanced');
    expect(currentSettingsTab('ai')).toBe('you');
    expect(currentSettingsTab('usage')).toBe('you');
  });

  it('opens the home only for /settings with nothing after it', () => {
    expect(settingsHome({})).toBe(true);
    expect(settingsHome({ part: 'profile' })).toBe(false);
    expect(settingsHome({ tab: 'agent' })).toBe(false);
    expect(settingsHome({}, '#passkeys')).toBe(false);
    expect(settingsHome({ connected: 'google' })).toBe(false);
  });

  it('takes each group’s parts only on its tab', () => {
    expect(validateSettingsSearch({ part: 'notifications' })).toEqual({ part: 'notifications' });
    expect(validateSettingsSearch({ part: 'devices' })).toEqual({ part: 'devices' });
    // Profile stays named: `/settings` alone is the home.
    expect(validateSettingsSearch({ part: 'profile' })).toEqual({ part: 'profile' });
    expect(validateSettingsSearch({ part: 'may' })).toEqual({});
    expect(validateSettingsSearch({ tab: 'agent', part: 'may' })).toEqual({ tab: 'agent', part: 'may' });
    expect(validateSettingsSearch({ tab: 'agent', part: 'memory' })).toEqual({
      tab: 'agent',
      part: 'memory',
    });
    expect(validateSettingsSearch({ tab: 'agent', part: 'profile' })).toEqual({ tab: 'agent' });
    expect(validateSettingsSearch({ tab: 'advanced', part: 'spend' })).toEqual({
      tab: 'advanced',
      part: 'spend',
    });
    expect(validateSettingsSearch({ tab: 'advanced', part: 'may' })).toEqual({ tab: 'advanced' });
    expect(validateSettingsSearch({ tab: 'advanced', part: 'nope' })).toEqual({ tab: 'advanced' });
    expect(validateSettingsSearch({ tab: 'appliance', part: 'keys' })).toEqual({ tab: 'appliance' });
  });

  it('takes a Connections page: GitHub, Google, Microsoft or Website feedback, only with Connections', () => {
    expect(validateSettingsSearch({ tab: 'connections', connection: 'github' })).toEqual({
      tab: 'connections',
      connection: 'github',
    });
    expect(validateSettingsSearch({ tab: 'connections', connection: 'feedback' }).connection).toBe(
      'feedback',
    );
    expect(validateSettingsSearch({ tab: 'connections', connection: 'google' }).connection).toBe('google');
    expect(validateSettingsSearch({ tab: 'connections', connection: 'slack' }).connection).toBeUndefined();
    expect(validateSettingsSearch({ tab: 'ai', connection: 'github' })).toEqual({ tab: 'ai' });
  });

  it('opens Add a connection at On your network for found=1, the assistant’s link (DF-05, AP-3801)', () => {
    const atNetwork = { tab: 'connections', connection: 'add', found: true };
    expect(validateSettingsSearch({ tab: 'connections', found: '1' })).toEqual(atNetwork);
    expect(validateSettingsSearch({ tab: 'connections', found: 1, connection: 'add' })).toEqual(atNetwork);
    // Another page wins, other tabs don't take it, and anything but a yes is dropped.
    expect(validateSettingsSearch({ tab: 'connections', found: '1', connection: 'github' })).toEqual({
      tab: 'connections',
      connection: 'github',
    });
    expect(
      validateSettingsSearch({
        tab: 'connections',
        found: '1',
        connection: 'proxmox',
        url: 'https://pve:8006',
      }),
    ).toEqual({ tab: 'connections', connection: 'proxmox', url: 'https://pve:8006' });
    expect(validateSettingsSearch({ tab: 'ai', found: '1' })).toEqual({ tab: 'ai' });
    expect(validateSettingsSearch({ tab: 'connections', found: 'no' })).toEqual({ tab: 'connections' });
  });

  it('preserves access and returnTo through settings validation and redirect', () => {
    const returnTo = '/burrow-hq/chat?thread=msg_root&guide=msg_card';
    const parsed = validateSettingsSearch({
      tab: 'connections',
      connection: 'custom_mcp',
      url: 'https://mcp.example.com/mcp',
      access: 'read',
      returnTo,
    });
    expect(parsed).toEqual({
      tab: 'connections',
      connection: 'custom_mcp',
      url: 'https://mcp.example.com/mcp',
      access: 'read',
      returnTo,
    });
    expect(settingsRedirect(parsed)).toEqual({
      to: '/connections',
      search: {
        connection: 'custom_mcp',
        url: 'https://mcp.example.com/mcp',
        access: 'read',
        returnTo,
      },
    });
    expect(
      validateSettingsSearch({
        tab: 'connections',
        connection: 'custom_mcp',
        access: 'admin',
        returnTo: 'https://evil.example/x',
      }),
    ).toEqual({ tab: 'connections', connection: 'custom_mcp' });
  });

  const settings = (search: Record<string, string>, hash?: string) => ({
    to: '/settings',
    search,
    ...(hash ? { hash } : {}),
  });
  const connections = (search: Record<string, string | number>) => ({ to: '/connections', search });
  // Usage is a place of its own at Advanced's old Spend address.
  const usage = settings({ tab: 'advanced', part: 'spend' });

  it.each([
    // You: Profile, its Notifications and Devices.
    [{ tab: 'profile' }, '', settings({ part: 'profile' })],
    [{ tab: 'general' }, '', settings({ part: 'profile' })],
    [{ tab: 'notifications' }, '', settings({ part: 'notifications' })],
    [{ tab: 'devices' }, '', settings({ part: 'devices' })],
    [{ tab: 'devices' }, 'passkeys', settings({ part: 'devices' }, 'passkeys')],
    [{ tab: 'appliance', section: 'devices' }, '', settings({ part: 'devices' })],
    [{ tab: 'appliance' }, 'devices', settings({ part: 'devices' })],
    // The assistant: its AI sign-in, Memory (About you, Notes) and What it may do.
    [{ tab: 'ai' }, '', settings({ tab: 'agent', part: 'ai' })],
    [{ tab: 'usage' }, '', settings({ tab: 'agent', part: 'ai' })],
    [{}, 'ai-provider', settings({ tab: 'agent', part: 'ai' })],
    [{ tab: 'about' }, '', settings({ tab: 'agent', part: 'memory' })],
    [{ tab: 'profile' }, 'about-you', settings({ tab: 'agent', part: 'memory' })],
    [{}, 'about-you', settings({ tab: 'agent', part: 'memory' })],
    [{ tab: 'agent', part: 'notes' }, '', settings({ tab: 'agent', part: 'memory' })],
    [{ tab: 'appliance', section: 'access' }, '', settings({ tab: 'agent', part: 'may' })],
    // Advanced: the AI programs, Spend, the old Agent parts, Skills; the keys are What it may do's.
    [{ tab: 'ai' }, 'clients', settings({ tab: 'advanced', part: 'ai' }, 'clients')],
    [{ tab: 'ai' }, 'spend', usage],
    [{ tab: 'spend' }, '', usage],
    [{ tab: 'agent', part: 'keys' }, '', settings({ tab: 'agent', part: 'may' })],
    [
      { tab: 'agent', part: 'keys', key: 'deploy' },
      '',
      settings({ tab: 'agent', part: 'may', key: 'deploy' }),
    ],
    [{ tab: 'agent', part: 'model' }, '', settings({ tab: 'advanced', part: 'model' })],
    [{ tab: 'agent', part: 'services' }, '', settings({ tab: 'advanced', part: 'running' })],
    [{ tab: 'agent', part: 'schedules' }, '', settings({ tab: 'advanced', part: 'schedules' })],
    [{ tab: 'agent', part: 'spend' }, '', usage],
    [{ tab: 'agent', part: 'skills' }, '', settings({ tab: 'advanced', part: 'skills' })],
    [{ tab: 'skills' }, '', settings({ tab: 'advanced', part: 'skills' })],
    [{ tab: 'packs' }, '', settings({ tab: 'advanced', part: 'skills' })],
    // GitHub and Website feedback: connections, with their own pages.
    [{ tab: 'repos' }, '', connections({ connection: 'github' })],
    [{ tab: 'dev' }, '', connections({ connection: 'github' })],
    [{ tab: 'feedback' }, '', connections({ connection: 'feedback' })],
    // Advanced's old list of every connection is the Connections tab, its anchor kept (sidebar-tabs.md).
    [{ tab: 'advanced', part: 'accounts' }, '', settings({ tab: 'connections' })],
    [
      { tab: 'advanced', part: 'accounts' },
      'connections-needs',
      settings({ tab: 'connections' }, 'connections-needs'),
    ],
    [{ tab: 'connections', connection: 'github' }, '', connections({ connection: 'github' })],
    [{ tab: 'connections', connection: 'feedback' }, '', connections({ connection: 'feedback' })],
    // Advanced's pages that moved out: where each one is now.
    [{ tab: 'advanced', part: 'keys' }, '', settings({ tab: 'agent', part: 'may' })],
    [
      { tab: 'advanced', part: 'keys', key: 'deploy' },
      '',
      settings({ tab: 'agent', part: 'may', key: 'deploy' }),
    ],
    [{ tab: 'advanced', part: 'network' }, '', settings({ tab: 'agent', part: 'may' }, 'local-network')],
    [{ tab: 'advanced', part: 'schedules' }, '', { to: '/automations', search: {} }],
    [{ tab: 'advanced', part: 'github' }, '', connections({ connection: 'github' })],
    [{ tab: 'advanced', part: 'feedback' }, '', connections({ connection: 'feedback' })],
    // This Whombat: its Screen.
    [{ tab: 'screen' }, '', settings({ tab: 'appliance', section: 'screen' })],
    [{ tab: 'screen', part: 'lock' }, '', settings({ tab: 'appliance', section: 'screen', part: 'lock' })],
    [
      { tab: 'screen', screen: 'scr_abcdefgh' },
      '',
      settings({ tab: 'appliance', section: 'screen', screen: 'scr_abcdefgh' }),
    ],
    [{ tab: 'appliance' }, 'screen', settings({ tab: 'appliance', section: 'screen' })],
    // Where this Whombat is and its news: their own page.
    [{ tab: 'appliance', section: 'about' }, 'place', settings({ tab: 'news' }, 'place')],
    [{ tab: 'appliance', section: 'about' }, 'news', settings({ tab: 'news' }, 'news')],
    [{ tab: 'appliance' }, 'news', settings({ tab: 'news' }, 'news')],
    // The Connections tab's pages open on the Connections page.
    [{ tab: 'connections', connection: 'add' }, '', connections({ connection: 'add' })],
    [
      { tab: 'connections', connection: 'add', found: true },
      '',
      connections({ connection: 'add', found: 1 }),
    ],
    [{ tab: 'connections', connection: 'google' }, '', connections({ connection: 'google' })],
    [{ tab: 'connections', connection: 'microsoft' }, '', connections({ connection: 'microsoft' })],
    [{ tab: 'connections', connection: 'imap' }, '', connections({ connection: 'imap' })],
    [
      { tab: 'connections', connection: 'homeassistant', id: 'con_1' },
      '',
      connections({ connection: 'homeassistant', id: 'con_1' }),
    ],
    [
      { tab: 'connections', connection: 'proxmox', url: 'https://pve:8006' },
      '',
      connections({ connection: 'proxmox', url: 'https://pve:8006' }),
    ],
    [
      { tab: 'connections', connected: 'google' },
      '',
      connections({ connection: 'google', connected: 'google' }),
    ],
    [
      { tab: 'connections', connect_error: 'access_denied' },
      '',
      connections({ connection: 'google', connect_error: 'access_denied' }),
    ],
    [
      { tab: 'connections', connection: 'homeassistant', connected: 'homeassistant' },
      '',
      connections({ connection: 'homeassistant', connected: 'homeassistant' }),
    ],
    [{ tab: 'general', connected: 'google' }, '', connections({ connection: 'google', connected: 'google' })],
    // The Vault is its own page.
    [{ tab: 'vault', entry: 'vlt_x' }, '', { to: '/vault', search: { entry: 'vlt_x' } }],
  ] as const)('sends %o#%s to its new place', (search, hash, expected) => {
    expect(settingsRedirect(search as SettingsSearch, hash)).toEqual(expected);
  });

  it('leaves the current addresses where they are', () => {
    expect(settingsRedirect({})).toBeNull();
    expect(settingsRedirect({ part: 'notifications' })).toBeNull();
    expect(settingsRedirect({ part: 'devices' }, 'passkeys')).toBeNull();
    expect(settingsRedirect({ tab: 'agent' })).toBeNull();
    // Connections is a tab again (sidebar-tabs.md), the restore's anchor with it.
    expect(settingsRedirect({ tab: 'connections' }, 'connections-needs')).toBeNull();
    expect(settingsRedirect({ tab: 'advanced', part: 'skills' })).toBeNull();
    expect(settingsRedirect({ tab: 'agent', part: 'may' })).toBeNull();
    expect(settingsRedirect({ tab: 'agent', part: 'memory' })).toBeNull();
    expect(settingsRedirect({ tab: 'agent', part: 'ai' })).toBeNull();
    expect(settingsRedirect({ tab: 'advanced' })).toBeNull();
    expect(settingsRedirect({ tab: 'advanced', part: 'running' })).toBeNull();
    expect(settingsRedirect({ tab: 'agent', part: 'may', key: 'deploy' })).toBeNull();
    expect(settingsRedirect({ tab: 'appliance' })).toBeNull();
    expect(settingsRedirect({ tab: 'appliance', section: 'about' })).toBeNull();
    expect(settingsRedirect({ tab: 'appliance', section: 'backups' }, 'set-up')).toBeNull();
    expect(settingsRedirect({ tab: 'appliance', section: 'screen', part: 'lock' })).toBeNull();
    expect(settingsRedirect({ tab: 'news' }, 'place')).toBeNull();
  });

  it('carries a validated old address to the same place as the route does', () => {
    const go = (raw: Record<string, unknown>, hash = '') =>
      settingsRedirect(validateSettingsSearch(raw), hash);
    expect(go({ tab: 'connections', found: '1' })).toEqual(connections({ connection: 'add', found: 1 }));
    expect(go({ tab: 'agent', part: 'keys', key: 'deploy' })).toEqual(
      settings({ tab: 'agent', part: 'may', key: 'deploy' }),
    );
    expect(go({ tab: 'advanced', part: 'keys', key: 'deploy' })).toEqual(
      settings({ tab: 'agent', part: 'may', key: 'deploy' }),
    );
    expect(go({ tab: 'screen', part: 'lock' })).toEqual(
      settings({ tab: 'appliance', section: 'screen', part: 'lock' }),
    );
    expect(go({ tab: 'appliance', section: 'screen', part: 'lock' })).toBeNull();
    expect(go({ tab: 'appliance', section: 'about' }, 'news')).toEqual(settings({ tab: 'news' }, 'news'));
    expect(validateSettingsSearch({ tab: 'news', part: 'x' })).toEqual({ tab: 'news' });
  });

  it('This Whombat’s part (AP-1221): one of its own, only on its tab; the Overview has none', () => {
    expect(validateSettingsSearch({ tab: 'appliance', section: 'backups' })).toEqual({
      tab: 'appliance',
      section: 'backups',
    });
    expect(validateSettingsSearch({ tab: 'appliance', section: 'overview' })).toEqual({ tab: 'appliance' });
    expect(validateSettingsSearch({ tab: 'appliance', section: 'nope' })).toEqual({ tab: 'appliance' });
    expect(validateSettingsSearch({ tab: 'ai', section: 'about' })).toEqual({ tab: 'ai' });
  });

  it('keeps the Inbox’s Finish and Try again of a bring back on Backups only (backup-v2.md AP-6906)', () => {
    expect(validateSettingsSearch({ tab: 'appliance', section: 'backups', finish: 'restore' })).toEqual({
      tab: 'appliance',
      section: 'backups',
      finish: 'restore',
    });
    expect(validateSettingsSearch({ tab: 'appliance', section: 'backups', restore: 'again' })).toMatchObject({
      restore: 'again',
    });
    expect(validateSettingsSearch({ tab: 'appliance', section: 'about', finish: 'restore' })).toEqual({
      tab: 'appliance',
      section: 'about',
    });
    expect(validateSettingsSearch({ tab: 'appliance', section: 'backups', finish: 'x' })).not.toHaveProperty(
      'finish',
    );
  });

  it('sends the old Skills & packs and Agent’s old Skills part to Advanced → Skills, anchor kept (AP-5530)', () => {
    expect(settingsRedirect({ tab: 'packs' }, 'skills-installed')).toEqual(
      settings({ tab: 'advanced', part: 'skills' }, 'skills-installed'),
    );
    expect(validateSettingsSearch({ tab: 'agent', part: 'skills' })).toEqual({
      tab: 'agent',
      part: 'skills',
    });
    expect(validateSettingsSearch({ tab: 'skills', part: 'skills' })).toEqual({ tab: 'skills' });
  });

  it('takes Keys’ key only on What it may do, and on the old Keys addresses until they are redirected (AP-250)', () => {
    expect(validateSettingsSearch({ tab: 'agent', part: 'may', key: 'deploy' })).toEqual({
      tab: 'agent',
      part: 'may',
      key: 'deploy',
    });
    expect(validateSettingsSearch({ tab: 'agent', part: 'memory', key: 'deploy' })).toEqual({
      tab: 'agent',
      part: 'memory',
    });
    expect(validateSettingsSearch({ tab: 'advanced', part: 'keys', key: 'deploy' })).toEqual({
      tab: 'advanced',
      part: 'keys',
      key: 'deploy',
    });
    expect(validateSettingsSearch({ tab: 'agent', part: 'keys', key: 'deploy' })).toEqual({
      tab: 'agent',
      part: 'keys',
      key: 'deploy',
    });
    expect(validateSettingsSearch({ tab: 'advanced', part: 'spend', key: 'deploy' })).toEqual({
      tab: 'advanced',
      part: 'spend',
    });
    expect(validateSettingsSearch({ tab: 'ai', part: 'keys' })).toEqual({ tab: 'ai' });
  });

  it('takes Screen’s part on This Whombat → Screen, and on the old Screen tab until it is redirected (AP-5831)', () => {
    expect(validateSettingsSearch({ tab: 'appliance', section: 'screen', part: 'night' })).toEqual({
      tab: 'appliance',
      section: 'screen',
      part: 'night',
    });
    expect(validateSettingsSearch({ tab: 'appliance', section: 'about', part: 'night' })).toEqual({
      tab: 'appliance',
      section: 'about',
    });
    expect(validateSettingsSearch({ tab: 'screen', part: 'night' })).toEqual({
      tab: 'screen',
      part: 'night',
    });
    expect(validateSettingsSearch({ tab: 'screen', part: 'shows' })).toEqual({ tab: 'screen' });
    expect(validateSettingsSearch({ tab: 'screen', part: 'keys' })).toEqual({ tab: 'screen' });
    expect(validateSettingsSearch({ tab: 'agent', part: 'night' })).toEqual({ tab: 'agent' });
  });
});
