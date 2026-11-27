import { describe, expect, it } from 'vitest';
import {
  appPath,
  BURROW_SECTIONS,
  DEPLOYS_PATH,
  isBurrowRoutePath,
  splitBurrowPath,
  withBurrow,
  workPath,
} from './paths';

describe('burrow-less paths (AP-360…)', () => {
  it.each([
    '/',
    '/chat',
    '/feedback',
    '/pr/482',
    '/runs/1907',
    '/work',
    '/work/deploys',
    '/inbox',
    '/deploys',
    '/canvases',
    '/canvases/invoice-pdf-export-plan',
    '/log',
    '/search',
    '/settings',
    '/settings/agent',
    '/settings/feedback/new',
    '/settings/feedback/fbi_1',
    '/automations',
    '/automations/aut_1',
    '/automation-runs/12',
    '/chat/',
  ])('%s is a burrow screen in the new form', (path) => {
    expect(isBurrowRoutePath(path)).toBe(true);
    expect(splitBurrowPath(path)?.form).toBe('new');
  });

  it.each([
    ['/burrow-hq', 'burrow-hq', '/'],
    ['/burrow-hq/', 'burrow-hq', '/'],
    ['/burrow-hq/chat', 'burrow-hq', '/chat'],
    ['/burrow-hq/settings/agent', 'burrow-hq', '/settings/agent'],
    ['/burrow-hq/settings/feedback/new', 'burrow-hq', '/settings/feedback/new'],
    ['/burrow-hq/automation-runs/3', 'burrow-hq', '/automation-runs/3'],
  ])('%s is the old form of burrow %s', (path, burrow, rest) => {
    expect(splitBurrowPath(path)).toEqual({ form: 'old', burrow, path: rest });
  });

  it('reads a route name first as the screen, unless only a burrow makes sense of the rest (AP-362)', () => {
    // A burrow called “inbox”: its Inbox is `/inbox` either way; its Chat is the old form.
    expect(splitBurrowPath('/inbox')).toEqual({ form: 'new', path: '/inbox' });
    expect(splitBurrowPath('/inbox/chat')).toEqual({ form: 'old', burrow: 'inbox', path: '/chat' });
    // The Work view's old addresses stay burrow screens, so they reach the redirect (AP-851).
    expect(splitBurrowPath('/work')).toEqual({ form: 'new', path: '/work' });
    expect(splitBurrowPath('/burrow-hq/work/deploys')).toEqual({
      form: 'old',
      burrow: 'burrow-hq',
      path: '/work/deploys',
    });
    expect(splitBurrowPath('/settings/settings')).toEqual({
      form: 'old',
      burrow: 'settings',
      path: '/settings',
    });
    expect(splitBurrowPath('/search/settings/agent')).toEqual({
      form: 'old',
      burrow: 'search',
      path: '/settings/agent',
    });
    // `/settings/agent` is the agent's page, even when a burrow is called “settings”.
    expect(splitBurrowPath('/settings/agent')).toEqual({ form: 'new', path: '/settings/agent' });
    expect(splitBurrowPath('/c')).toEqual({ form: 'old', burrow: 'c', path: '/' });
    // What's new lives under Settings, so a burrow called “whats-new” keeps its old addresses.
    expect(splitBurrowPath('/settings/whats-new')).toEqual({ form: 'new', path: '/settings/whats-new' });
    expect(splitBurrowPath('/whats-new')).toEqual({ form: 'old', burrow: 'whats-new', path: '/' });
    expect(splitBurrowPath('/whats-new/connections')).toEqual({
      form: 'old',
      burrow: 'whats-new',
      path: '/connections',
    });
  });

  it('leaves every path outside the burrow app alone', () => {
    for (const path of [
      '/login/verify',
      '/appliances/dev_1/pair',
      '/auth/verify',
      '/connect/google',
      '/legal/privacy',
      '/burrow-hq/nothing',
      '/burrow-hq/c/general/more',
      '/a/b/c/d',
    ])
      expect(splitBurrowPath(path)).toBeNull();
  });

  it('lists the route names a burrow slug could clash with', () => {
    expect(BURROW_SECTIONS).toEqual([
      'pr',
      'runs',
      'work',
      'inbox',
      'deploys',
      'canvases',
      'log',
      'search',
      'settings',
      'automations',
      'automation-runs',
      'vault',
      'files',
      // The one-Whombat shell (AP-1258…AP-1263), Needs you with Watch's old address (needs-you-list.md NYL-05).
      'needs-you',
      'watch',
      'chats',
      // The Chat shell (chat-channel.md AP-2401).
      'chat',
      // Code's old address, still a screen (Whombat one-chat.md).
      'code',
      'feedback',
      // Connections (connections-page.md AP-2501), and the Dashboard's old address.
      'connections',
      'dashboard',
      // Servers and Connections as places (servers-connections-places.md).
      'servers',
      'connected',
      'things',
      'skills',
      'done',
      // Reports to the Whombat Team (Whombat team-reports.md).
      'reports',
    ]);
  });

  it('builds app paths from links without the burrow (appPath)', () => {
    expect(appPath({ type: 'dm' })).toBe('/chat');
    expect(appPath({ type: 'dm', room: 'feedback' })).toBe('/feedback');
    expect(appPath({ type: 'run', number: 1907 })).toBe('/runs/1907');
    expect(appPath({ type: 'agent' })).toBe('/settings/agent');
    expect(appPath({ type: 'search', q: 'invoice pdf' })).toBe('/search?q=invoice%20pdf');
    expect(appPath({ type: 'approval', number: 12 })).toBe('/log?approval=12');
    expect(
      appPath({
        type: 'message',
        in: { type: 'dm', room: 'chat' },
        messageId: 'msg_1',
        threadRootId: 'msg_0',
      }),
    ).toBe('/chat?thread=msg_0');
    expect(appPath({ type: 'external', url: 'https://example.com/x' })).toBe('https://example.com/x');
  });

  it('sends Work links to Deploys or the Inbox, now that there is no Work view (AP-851)', () => {
    expect(appPath({ type: 'work', section: 'deploys' })).toBe(DEPLOYS_PATH);
    expect(DEPLOYS_PATH).toBe('/deploys');
    expect(appPath({ type: 'work', section: 'needs_you' })).toBe('/inbox');
    expect(appPath({ type: 'work', section: 'running' })).toBe('/inbox');
    expect(appPath({ type: 'work' })).toBe('/inbox');
    expect(workPath(undefined)).toBe('/inbox');
    expect(workPath(['needs_you'])).toBe('/inbox');
  });

  it('adds ?burrow= before the fragment (withBurrow)', () => {
    expect(withBurrow('/settings?tab=ai', 'burrow-hq')).toBe('/settings?tab=ai&burrow=burrow-hq');
    expect(withBurrow('/c/general#msg_1', 'burrow-hq')).toBe('/c/general?burrow=burrow-hq#msg_1');
  });
});
