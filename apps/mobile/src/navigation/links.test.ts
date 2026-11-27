/** Web paths in either form (AP-366): the old `/<burrow>/…` every server writes, and the burrow-less one. */
import { fileMessageLink } from '@whombat/client';
import { linkPath } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  appOrigins,
  appScreenUrlForPath,
  appUrlForPath,
  burrowOfPath,
  routeForLink,
  urlTarget,
  webUrlForLink,
} from './routes';

describe('web paths on the phone (AP-366)', () => {
  it.each([
    // The person's rooms with the agent (Whombat one-agent.md OA-04; AP-4962).
    ['/chat', 'whombat://chat'],
    ['/burrow-hq/chat', 'whombat://chat'],
    ['/feedback', 'whombat://feedback'],
    // The message a link names comes along (MX-03).
    ['/chat?thread=msg_0#msg_2', 'whombat://threads/msg_0?anchor=msg_2'],
    ['/chat?thread=msg_0&focus=1', 'whombat://threads/msg_0'],
    ['/pr/482#msg_1', 'whombat://pr/482?anchor=msg_1'],
    ['/runs/1907', 'whombat://runs/1907'],
    ['/burrow-hq/runs/1907', 'whombat://runs/1907'],
    ['/pr/482?approval=12', 'whombat://approvals/12'],
    // Settings → Agent (AP-4961), its part and key; the agent's skills (AP-4967).
    ['/settings/agent', 'whombat://settings/agent'],
    // Notes is in Memory; the keys are a page under What it may do (at their key).
    ['/burrow-hq/settings/agent?part=notes', 'whombat://settings/agent?part=memory'],
    ['/settings?tab=agent&part=keys&key=merge.main', 'whombat://settings/advanced/keys?key=merge.main'],
    ['/settings?tab=agent&part=may', 'whombat://settings/agent?part=may'],
    // Settings → the assistant → Council, where the live council card's link goes (council.md CNL-54).
    ['/settings?tab=agent&part=council', 'whombat://settings/agent?part=council'],
    ['/settings?tab=agent&part=ahead', 'whombat://settings/agent?part=ahead'],
    ['/settings?tab=advanced&part=keys&key=deploy', 'whombat://settings/advanced/keys?key=deploy'],
    ['/settings?tab=advanced&part=spend', 'whombat://spend'],
    ['/settings?tab=agent&part=may&key=deploy', 'whombat://settings/advanced/keys?key=deploy'],
    // What moved out of Advanced: the home network ranges are the Vault's list, the schedules Automations'.
    ['/settings?tab=advanced&part=network', 'whombat://vault'],
    ['/settings?tab=advanced&part=schedules', 'whombat://automations'],
    ['/settings?tab=advanced&part=github', 'whombat://settings/connections/account/github'],
    ['/settings?tab=advanced', 'whombat://settings/advanced'],
    ['/settings?tab=agent&part=Keys%20%3Cb%3E', 'whombat://settings/agent'],
    ['/settings?tab=skills', 'whombat://skills'],
    ['/skills', 'whombat://skills'],
    // Channels, people's DMs and agents' pages are gone (OA-04, OA-09): no screen, the inbox.
    ['/c/general', 'whombat://inbox'],
    ['/dm/dusty', 'whombat://inbox'],
    ['/direct/cv_7', 'whombat://inbox'],
    ['/agents/banjo/settings?tab=access', 'whombat://inbox'],
    ['/automations', 'whombat://automations'],
    ['/automation-runs/41', 'whombat://automation-runs/41'],
    // The Work view is gone (work-removal-android.md AP-860): its address opens the Inbox.
    ['/work?burrow=side-quest', 'whombat://inbox'],
    // Search, with what it looks for (phone-shell-final.md).
    ['/search?q=invoice', 'whombat://search?q=invoice'],
    ['/search', 'whombat://search'],
    // Settings and its tabs open the Settings tab's pages (settings-tab-android.md AP-2625); old tabs where the web sends them.
    ['/settings', 'whombat://settings'],
    ['/settings?tab=usage', 'whombat://settings/agent?part=ai'],
    ['/burrow-hq/settings?tab=appliance', 'whombat://settings/whombat'],
    ['/settings?tab=notifications', 'whombat://settings/notifications'],
    // News and weather, a page of its own.
    ['/settings?tab=news', 'whombat://settings/news'],
    ['/settings/news', 'whombat://settings/news'],
    // The four groups: You's parts, This Whombat's that moved.
    ['/settings?part=notifications', 'whombat://settings/notifications'],
    ['/settings?part=prompts', 'whombat://settings/prompts'],
    ['/settings?tab=you&part=prompts', 'whombat://settings/prompts'],
    ['/settings?tab=you&part=devices', 'whombat://settings/profile'],
    ['/settings?tab=appliance&section=access', 'whombat://settings/agent?part=may'],
    ['/settings?tab=appliance&section=devices', 'whombat://settings/profile'],
    // Backups, and the Inbox's Finish and Try again of a bring back (backup-options.md BKO-28, BKO-34).
    ['/settings?tab=appliance&section=backups', 'whombat://settings/whombat/backups'],
    [
      '/settings?tab=appliance&section=backups&finish=restore',
      'whombat://settings/whombat/backups?bringBack=finish',
    ],
    [
      '/settings?tab=appliance&section=backups&restore=again',
      'whombat://settings/whombat/backups?bringBack=again',
    ],
    ['/settings?tab=about', 'whombat://settings/agent?part=memory'],
    // A connection's page, which the web opens on its Connections page.
    ['/connections?connection=google', 'whombat://settings/connections/account/google'],
    ['/settings?tab=repos', 'whombat://settings/connections/account/github'],
    // A mail account's thing links to `/settings/connections` (connections-more-android.md AP-2814); deeper paths don't.
    ['/settings/connections', 'whombat://settings/connections'],
    ['/burrow-hq/settings/connections', 'whombat://settings/connections'],
    ['/settings/feedback/fb_1', 'whombat://settings'],
  ])('%s opens %s', (path, url) => {
    expect(appUrlForPath(path)).toBe(url);
  });

  it('opens what linkPath() makes, as before', () => {
    expect(appUrlForPath(linkPath('burrow-hq', { type: 'run', number: 1907 }))).toBe('whombat://runs/1907');
    expect(appUrlForPath(linkPath('burrow-hq', { type: 'dm' }))).toBe('whombat://chat');
    expect(appUrlForPath(linkPath('burrow-hq', { type: 'dm', room: 'feedback' }))).toBe('whombat://feedback');
    expect(appUrlForPath(linkPath('burrow-hq', { type: 'agent' }))).toBe('whombat://settings/agent');
  });

  it('reads a route name first as the screen, and as a burrow only when the rest needs one (AP-362)', () => {
    expect(appUrlForPath('/work')).toBe('whombat://inbox');
    expect(appUrlForPath('/work/pr/482')).toBe('whombat://pr/482');
    expect(burrowOfPath('/work')).toBeNull();
    expect(burrowOfPath('/work/pr/482')).toBe('work');
  });

  it('names the burrow of the old form and of ?burrow=, none for the burrow-less form', () => {
    expect(burrowOfPath('/burrow-hq/pr/482')).toBe('burrow-hq');
    expect(burrowOfPath('/burrow-hq')).toBe('burrow-hq');
    expect(burrowOfPath('/canvases/plan?burrow=side-quest#x')).toBe('side-quest');
    expect(burrowOfPath('/pr/482?thread=msg_1')).toBeNull();
    expect(burrowOfPath('/burrow-hq/pr/482/more')).toBeNull();
  });
});

describe('tapping a URL (AP-709)', () => {
  const origins = appOrigins(['https://ui.example.test/']);

  it('knows the build’s UI and Whombat’s own web app, prod and dev', () => {
    expect(origins).toEqual([
      'https://ui.example.test',
      'https://app.whombat.com',
      'https://dev.whombat.com',
    ]);
  });

  it.each([
    ['https://app.whombat.com/chat', 'whombat://chat', null],
    ['https://dev.whombat.com/burrow-hq/runs/12', 'whombat://runs/12', 'burrow-hq'],
    ['HTTPS://App.Whombat.com/settings/agent', 'whombat://settings/agent', null],
    ['https://ui.example.test/chat?thread=msg_9', 'whombat://threads/msg_9', null],
    ['https://app.whombat.com/chat?plan=pl_1&step=st_2', 'whombat://plans/pl_1?stepId=st_2', null],
    ['https://app.whombat.com/pr/42?repo=acme/site', 'whombat://pr/42?repo=acme%2Fsite', null],
    ['https://app.whombat.com/vault', 'whombat://vault', null],
    ['https://app.whombat.com/automations/aut_1', 'whombat://automations/aut_1', null],
    ['https://app.whombat.com/?burrow=side-quest', 'whombat://inbox', 'side-quest'],
    ['/feedback', 'whombat://feedback', null],
    ['whombat://runs/7', 'whombat://runs/7', null],
  ])('%s opens the app at %s', (href, url, burrow) => {
    expect(urlTarget(href, origins)).toEqual({
      kind: 'app',
      url,
      burrow,
      path: href.startsWith('whombat:') ? null : expect.any(String),
    });
  });

  it('opens pages without a screen, other sites and mail in the system’s app', () => {
    expect(urlTarget('https://app.whombat.com/burrow-hq/canvases', origins)).toEqual({
      kind: 'system',
      url: 'https://app.whombat.com/burrow-hq/canvases',
    });
    expect(urlTarget('/burrow-hq/canvases', origins)).toEqual({
      kind: 'system',
      url: 'https://ui.example.test/burrow-hq/canvases',
    });
    // Sign-in and appliance links: the app claims them itself, through the system.
    expect(urlTarget('https://app.whombat.com/auth/phone#t=x', origins)?.kind).toBe('system');
    expect(urlTarget('whombat://appliances/dev_1/c/general', origins)?.kind).toBe('system');
    expect(urlTarget('https://example.com/docs?a=1', origins)).toEqual({
      kind: 'system',
      url: 'https://example.com/docs?a=1',
    });
    expect(urlTarget('https://app.whombat.com.evil.test/c/general', origins)?.kind).toBe('system');
    expect(urlTarget('mailto:ops@example.com', origins)?.kind).toBe('system');
  });

  it('opens nothing for other schemes, empty links and push URLs', () => {
    for (const href of [
      '',
      'javascript:alert(1)',
      'intent://scan/#Intent;scheme=zxing;end',
      'file:///sdcard/x',
      '//evil.test/c/general',
      'whombat://push?kind=run&ref=AAAAAAAAAAAAAAAAAAAAAAAA',
    ])
      expect(urlTarget(href, origins)).toBeNull();
  });

  it('opens a notification URL’s screen without marking it read', () => {
    expect(
      urlTarget('whombat://open?path=%2Fburrow-hq%2Fruns%2F3&burrow=burrow-hq&notification=nt_1', origins),
    ).toEqual({ kind: 'app', url: 'whombat://runs/3', burrow: null, path: null });
  });

  it('has no screen for the canvas list, so appUrlForPath falls back to the inbox', () => {
    expect(appScreenUrlForPath('/burrow-hq/canvases')).toBeNull();
    expect(appUrlForPath('/burrow-hq/canvases')).toBe('whombat://inbox');
  });

  it('opens canvases, the audit log and external links on the web where the phone can’t', () => {
    expect(
      webUrlForLink({ type: 'canvas', slug: 'launch-plan' }, 'burrow-hq', 'https://app.whombat.com/'),
    ).toBe('https://app.whombat.com/canvases/launch-plan?burrow=burrow-hq');
    expect(webUrlForLink({ type: 'log' }, 'burrow-hq', 'https://app.whombat.com')).toBe(
      'https://app.whombat.com/log?burrow=burrow-hq',
    );
    expect(
      webUrlForLink({ type: 'external', url: 'https://example.com/x' }, 'burrow-hq', 'https://a.test'),
    ).toBe('https://example.com/x');
    expect(webUrlForLink({ type: 'run', number: 3 }, 'burrow-hq', 'https://a.test')).toBeNull();
  });
});

describe('Files addresses (files-space.md FS-07, AP-772…)', () => {
  it.each([
    ['/files', 'whombat://files'],
    ['/burrow-hq/files', 'whombat://files'],
    ['/files/dm/chat', 'whombat://files/dm/chat'],
    [
      '/burrow-hq/files/dm/feedback?folder=Drawings/2024',
      'whombat://files/dm/feedback?folder=Drawings%2F2024',
    ],
    // A task chat's Files by its id; a channel's and another agent's are gone (OA-04).
    ['/files/direct/cv_7', 'whombat://files/direct/cv_7'],
    ['/files/c/general', 'whombat://inbox'],
    ['/files/dm/dusty', 'whombat://files'],
    ['/files/pr/482?repo=acme/site', 'whombat://files/pr/482?repo=acme%2Fsite'],
    ['/files/pr/482?repo=acme/site&folder=Logs', 'whombat://files/pr/482?repo=acme%2Fsite&folder=Logs'],
  ])('%s opens %s', (path, url) => {
    expect(appUrlForPath(path)).toBe(url);
  });

  it('opens a file’s message: a reply in its thread, a top-level one in its room (a thread in Chat)', () => {
    const where = { type: 'pr' as const, number: 482 };
    const reply = fileMessageLink({ messageId: 'msg_2', threadRootId: 'msg_1' }, where);
    expect(reply && routeForLink(reply, null, 'Files')).toEqual({
      name: 'Thread',
      params: { messageId: 'msg_1', back: 'Files', anchor: 'msg_2' },
    });
    const top = fileMessageLink({ messageId: 'msg_1', threadRootId: null }, { type: 'dm' });
    expect(top && routeForLink(top, null)).toEqual({ name: 'Thread', params: { messageId: 'msg_1' } });
  });
});

describe('a task chat’s links (feedback-chat.md AP-1836)', () => {
  const chat = { type: 'chat' as const, id: 'cnv_chat-feedback-billing' };

  it('open the chat as a chat, as a row of Chats does', () => {
    expect(routeForLink(chat, null)).toEqual({ name: 'Chat', params: { conversationId: chat.id } });
  });

  it('open a report in a feedback chat at its message, and its assessment in the report’s thread', () => {
    expect(routeForLink({ type: 'message', in: chat, messageId: 'msg_report' }, null)).toEqual({
      name: 'Chat',
      params: { conversationId: chat.id, anchor: 'msg_report' },
    });
    expect(
      routeForLink(
        { type: 'message', in: chat, messageId: 'msg_answer', threadRootId: 'msg_report' },
        null,
        'Connections',
      ),
    ).toEqual({
      name: 'Thread',
      params: { messageId: 'msg_report', back: 'Connections', anchor: 'msg_answer' },
    });
  });
});

describe('Settings → Connections’ pages open the phone’s own screens (phone-connect.md PC-02, AP-2902)', () => {
  it.each([
    // John's loop: an entry of Add a connection opens its Connect {Name}, not the list.
    ['/settings?tab=connections&connection=proxmox', 'whombat://settings/connections/connect/proxmox'],
    [
      '/burrow-hq/settings?tab=connections&connection=homeassistant',
      'whombat://settings/connections/connect/homeassistant',
    ],
    [
      '/settings?tab=connections&connection=proxmox&burrow=burrow-hq',
      'whombat://settings/connections/connect/proxmox',
    ],
    // Found on your network fills the address in (CS-51); only an http(s) address of one line comes along.
    [
      '/settings?tab=connections&connection=proxmox&url=https%3A%2F%2F10.100.0.2%3A8006',
      'whombat://settings/connections/connect/proxmox?url=https%3A%2F%2F10.100.0.2%3A8006',
    ],
    [
      '/settings?tab=connections&connection=proxmox&url=javascript%3Ax',
      'whombat://settings/connections/connect/proxmox',
    ],
    // Assistant connect cards pass access and returnTo through; external returnTo is dropped.
    [
      '/settings?tab=connections&connection=custom_mcp&url=https%3A%2F%2Fmcp.example.com%2Fmcp&access=read&returnTo=%2Fburrow-hq%2Fchat%3Fthread%3Dmsg_1%26guide%3Dmsg_2',
      'whombat://settings/connections/connect/custom_mcp?url=https%3A%2F%2Fmcp.example.com%2Fmcp&access=read&returnTo=%2Fburrow-hq%2Fchat%3Fthread%3Dmsg_1%26guide%3Dmsg_2',
    ],
    [
      '/settings?tab=connections&connection=custom_mcp&returnTo=https%3A%2F%2Fevil.example%2Fx',
      'whombat://settings/connections/connect/custom_mcp',
    ],
    // One connection: its page.
    [
      '/settings?tab=connections&connection=homeassistant&id=con_ha1',
      'whombat://things/connection%3Acon_ha1',
    ],
    // A sign-in's return: the connection's id where the page was, or beside it (CX-D04).
    [
      '/settings?tab=connections&connected=homeassistant&connection=con_ha1',
      'whombat://things/connection%3Acon_ha1',
    ],
    [
      '/settings?tab=connections&connection=homeassistant&connected=homeassistant&connection=con_ha1',
      'whombat://things/connection%3Acon_ha1',
    ],
    // A refused sign-in says why on the entry's form, once.
    [
      '/settings?tab=connections&connection=dropbox&connect_error=access_denied',
      'whombat://settings/connections/connect/dropbox?error=access_denied',
    ],
    ['/settings?tab=connections&connection=add', 'whombat://settings/connections/add'],
    // The assistant's link after the first scan (DF-05, AP-3804): Add a connection, Found on your network at its top.
    ['/settings?tab=connections&found=1', 'whombat://settings/connections/add'],
    ['/settings?tab=connections&found=1&connection=github', 'whombat://settings/connections/account/github'],
    ['/settings?tab=connections&connection=google', 'whombat://settings/connections/account/google'],
    ['/settings?tab=connections&connection=microsoft', 'whombat://settings/connections/account/microsoft'],
    ['/settings?tab=connections&connection=imap', 'whombat://settings/connections/account/imap'],
    ['/settings?tab=connections&connection=github', 'whombat://settings/connections/account/github'],
    ['/settings?tab=connections&connection=feedback', 'whombat://settings/connections/account/feedback'],
    // An account's settings address stays its own screen, even with its connection's id (a page has its own address).
    [
      '/settings?tab=connections&connection=google&id=con_mara',
      'whombat://settings/connections/account/google',
    ],
    // Google's return names no page (CN-04).
    ['/settings?tab=connections&connected=google', 'whombat://settings/connections'],
    [
      '/settings?tab=connections&connect_error=access_denied',
      'whombat://settings/connections/account/google?error=access_denied',
    ],
    ['/settings?tab=feedback', 'whombat://settings/connections/account/feedback'],
    // Builtins with no screen, unknown ids and a connection id without an entry: the list.
    ['/settings?tab=connections&connection=whombat_servers', 'whombat://settings/connections'],
    ['/settings?tab=connections&connection=nope', 'whombat://settings/connections'],
    ['/settings?tab=connections&id=con_ha1', 'whombat://settings/connections'],
    ['/settings?tab=connections', 'whombat://settings/connections'],
  ])('%s opens %s', (path, url) => {
    expect(appUrlForPath(path)).toBe(url);
  });

  it('opens the same screens from the web app’s address on a managed Whombat', () => {
    const origins = ['https://dev.whombat.com'];
    expect(
      urlTarget('https://dev.whombat.com/settings?tab=connections&connection=proxmox', origins),
    ).toMatchObject({ url: 'whombat://settings/connections/connect/proxmox' });
  });
});
