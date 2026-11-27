/**
 * Links to the parity screens (mobile-parity.md MQ-01…MQ-06): the audit log opens on the phone at its event (a
 * receipt's `log` link, `/log?open=…`), Settings → Agent opens at its part (one-agent.md AP-4961); the linking config
 * names each screen's path. Members is gone (one person per Whombat, one-person-android.md AP-5730).
 */
import { describe, expect, it } from 'vitest';
import { appScreenUrlForPath, LINKING_SCREENS, routeForLink, urlTarget } from './routes';

describe('the audit log on the phone (MQ-03)', () => {
  it('opens a receipt’s log link at its event, or with “Only …”', () => {
    expect(routeForLink({ type: 'log' }, null)).toEqual({ name: 'AuditLog', params: {} });
    expect(routeForLink({ type: 'log', eventId: 'evt_9f18', who: 'banjo' }, null)).toEqual({
      name: 'AuditLog',
      params: { who: 'banjo', open: 'evt_9f18' },
    });
  });

  it('opens the web’s /log in either form, its filters kept and anything odd dropped', () => {
    expect(appScreenUrlForPath('/log')).toBe('whombat://log');
    expect(appScreenUrlForPath('/burrow-hq/log?who=banjo&open=evt_9f18')).toBe(
      'whombat://log?who=banjo&open=evt_9f18',
    );
    expect(appScreenUrlForPath('/log?actor=agents&kind=code&evil=1')).toBe(
      'whombat://log?actor=agents&kind=code',
    );
    expect(appScreenUrlForPath('/log?who=%3Cscript%3E')).toBe('whombat://log');
    // An approval in the log is the approval's screen, as before.
    expect(appScreenUrlForPath('/log?approval=12')).toBe('whombat://approvals/12');
    expect(urlTarget('https://app.whombat.com/log?open=evt_1', ['https://app.whombat.com'])).toEqual({
      kind: 'app',
      url: 'whombat://log?open=evt_1',
      burrow: null,
      path: '/log?open=evt_1',
    });
  });

  it('opens a canvas on its read-only screen (MQ-05), in either path form', () => {
    expect(routeForLink({ type: 'canvas', slug: 'launch-plan' }, null)).toEqual({
      name: 'Canvas',
      params: { slug: 'launch-plan' },
    });
    expect(appScreenUrlForPath('/canvases/launch-plan')).toBe('whombat://canvases/launch-plan');
    expect(appScreenUrlForPath('/burrow-hq/canvases/launch%20plan')).toBe('whombat://canvases/launch%20plan');
    expect(appScreenUrlForPath('/canvases')).toBeNull();
    expect(LINKING_SCREENS).toMatchObject({ Canvas: 'canvases/:slug' });
  });

  it('opens Deploys on its own screen where the Whombat records them, Needs you for the rest of Work (AP-860, NYL-09)', () => {
    expect(routeForLink({ type: 'work', section: 'deploys' }, null)).toEqual({ name: 'Deploys', params: {} });
    expect(
      routeForLink({ type: 'work', section: 'deploys' }, null, '#releases', { deployments: true }),
    ).toEqual({
      name: 'Deploys',
      params: { back: '#releases' },
    });
    const inbox = { name: 'Tabs', params: { screen: 'NeedsYou' } };
    expect(routeForLink({ type: 'work', section: 'deploys' }, null, 'Back', { deployments: false })).toEqual(
      inbox,
    );
    expect(routeForLink({ type: 'work', section: 'needs_you' }, null)).toEqual(inbox);
    expect(routeForLink({ type: 'work' }, null)).toEqual(inbox);
    expect(LINKING_SCREENS).toMatchObject({ Deploys: 'deploys' });
    expect(LINKING_SCREENS).not.toHaveProperty('Work');
  });

  it('opens Work’s old addresses, in either form: /work/deploys on Deploys, /work on the Inbox (AP-860)', () => {
    expect(appScreenUrlForPath('/work/deploys')).toBe('whombat://deploys');
    expect(appScreenUrlForPath('/work/deploys/')).toBe('whombat://deploys');
    expect(appScreenUrlForPath('/burrow-hq/work/deploys')).toBe('whombat://deploys');
    expect(appScreenUrlForPath('/work')).toBe('whombat://inbox');
    expect(appScreenUrlForPath('/work?burrow=side-quest')).toBe('whombat://inbox');
    expect(appScreenUrlForPath('/burrow-hq/work')).toBe('whombat://inbox');
    // `c` and `agents` are no screens' any more (OA-04, OA-09): a burrow of that name, and its Work the inbox.
    expect(appScreenUrlForPath('/c/work')).toBe('whombat://inbox');
    expect(appScreenUrlForPath('/agents/work')).toBe('whombat://inbox');
  });
});

describe('the web’s Inbox and Deploys pages (AP-862)', () => {
  it('opens /inbox on the Inbox, whatever its filter, and /deploys on Deploys, in either form', () => {
    expect(appScreenUrlForPath('/inbox')).toBe('whombat://inbox');
    expect(appScreenUrlForPath('/inbox?filter=needs_you')).toBe('whombat://inbox');
    expect(appScreenUrlForPath('/burrow-hq/inbox')).toBe('whombat://inbox');
    expect(appScreenUrlForPath('/deploys')).toBe('whombat://deploys');
    expect(appScreenUrlForPath('/burrow-hq/deploys')).toBe('whombat://deploys');
  });
});

describe('Settings → Agent (MQ-01, MQ-02; one-agent.md AP-4961)', () => {
  it('opens Settings → Agent at its part, from the agent’s link and the web’s tab', () => {
    expect(routeForLink({ type: 'agent' }, null)).toEqual({ name: 'SettingsAgent', params: {} });
    // Its old parts open where they went: schedules in Automations, notes in Memory.
    expect(appScreenUrlForPath('/settings?tab=agent&part=schedules')).toBe('whombat://automations');
    expect(appScreenUrlForPath('/burrow-hq/settings/agent?part=notes')).toBe(
      'whombat://settings/agent?part=memory',
    );
    // The agents' pages are gone (OA-09): no screen of theirs.
    expect(appScreenUrlForPath('/agents/banjo/settings?tab=spend')).toBeNull();
    expect(appScreenUrlForPath('/agents/banjo')).toBeNull();
  });

  it('opens the settings tabs on the Settings tab, an old Members link the tab itself (AP-2625, AP-5730)', () => {
    expect(appScreenUrlForPath('/settings?tab=members')).toBe('whombat://settings');
    expect(appScreenUrlForPath('/settings?tab=ai')).toBe('whombat://settings/agent?part=ai');
    expect(appScreenUrlForPath('/settings')).toBe('whombat://settings');
  });

  it('names a path for each linked parity screen', () => {
    expect(LINKING_SCREENS).toMatchObject({
      SettingsAgent: 'settings/agent',
      SettingsNews: 'settings/news',
      Spend: 'spend',
      AuditLog: 'log',
    });
    for (const gone of ['AgentSchedules', 'AgentNotes', 'CommandAllowances', 'ChannelSettings', 'Members'])
      expect(LINKING_SCREENS).not.toHaveProperty(gone);
  });
});

describe('the Connections page’s addresses (connections-page.md AP-2550)', () => {
  it('opens Connections from the web’s page and its old names, and Add a server where it was', () => {
    for (const path of ['/connections', '/dashboard', '/dashboard?from=chat', '/home', '/things'])
      expect(appScreenUrlForPath(path)).toBe('whombat://connections');
    // The servers' old list lands on Overview's Servers section.
    expect(appScreenUrlForPath('/things/servers')).toBe('whombat://connections?tab=servers');
    expect(appScreenUrlForPath('/things/servers?add=1&address=10.100.0.40')).toBe(
      'whombat://servers/add?address=10.100.0.40&user=root&control=full',
    );
    expect(urlTarget('https://dev.whombat.com/connections', ['https://dev.whombat.com'])).toMatchObject({
      kind: 'app',
      url: 'whombat://connections',
    });
  });
});
