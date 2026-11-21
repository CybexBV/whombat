import { describe, expect, it } from 'vitest';
import { SetRunsOnBody } from '../contracts/connections.js';
import { ThingActionBody } from '../contracts/home.js';
import { api } from '../contracts/index.js';
import { ThingSummary, Widget } from './home.js';
import { ThingPage, ThingPagePanel } from './thing-page.js';

const at = '2026-10-18T09:00:00.000Z';

const homeAssistant = {
  id: 'connection:con_ha1',
  kind: 'connection',
  connectionId: 'con_ha1',
  catalogId: 'homeassistant',
  name: 'Home Assistant',
  icon: 'homeassistant',
  status: 'warn',
  badge: 'Needs a look',
  facts: [
    [{ text: 'Home Assistant ' }, { text: '2026.10.2', strong: true }, { text: ' · Container' }],
    [{ text: 'Restarted ' }, { text: '23 h', strong: true }, { text: ' ago' }],
  ],
  address: '10.100.0.5:8123',
  open: { label: 'Open Home Assistant', url: 'http://10.100.0.5:8123/' },
  runsOn: {
    serverId: 'pve-02',
    guestId: 'pve:131',
    name: 'pve-02 · CT 131',
    href: '/things/server%3Apve-02?guest=pve%3A131',
    how: 'address',
  },
  settings: true,
  tabs: [
    {
      key: 'overview',
      label: 'Overview',
      panels: [
        {
          kind: 'kpis',
          id: 'figures',
          items: [
            { key: 'cpu', label: 'CPU', value: '5 %', sub: 'of 4 cores' },
            { key: 'disk', label: 'Disk', value: '30', rest: '/ 40 GB', sub: '76 % used', tone: 'warn' },
          ],
        },
        {
          kind: 'chart',
          id: 'load',
          width: 'wide',
          title: 'CPU and memory',
          meta: 'last 24 h',
          timestamps: [at],
          series: [
            { key: 'cpu', label: 'CPU', unit: '%', values: [5], latest: '5 %' },
            { key: 'mem', label: 'Memory', unit: 'GB', values: [null], axis: 'right' },
          ],
        },
        {
          kind: 'notices',
          id: 'look',
          width: 'narrow',
          title: 'Worth a look',
          empty: 'Nothing needs a look.',
          items: [
            {
              id: 'disk',
              tone: 'warn',
              icon: 'disk',
              title: 'Disk 76 % full',
              detail: 'Old backups on the same disk use 8.7 GB',
              link: {
                kind: 'ask',
                label: 'Look into it',
                question: 'Why is Home Assistant’s disk 76 % full?',
              },
            },
          ],
        },
        {
          kind: 'table',
          id: 'failing',
          title: 'Integrations not loading',
          link: { kind: 'tab', label: 'All 171', tab: 'integrations' },
          columns: [
            { key: 'name', label: 'Integration' },
            { key: 'state', label: 'State' },
          ],
          rows: [
            {
              id: 'shelly',
              cells: { name: { text: 'Shelly', note: 'Kantoor' }, state: { text: 'Retrying', dot: 'warn' } },
            },
          ],
        },
        {
          kind: 'access',
          id: 'may',
          title: 'What Whombat may do',
          lookOnly: false,
          items: [{ label: 'Read', tier: 'allowed', count: 4 }],
        },
        { kind: 'changes', id: 'did', title: 'Whombat did here', limit: 5 },
        { kind: 'widgets', id: 'more', title: 'Show more here', suggestions: ['Database size'] },
      ],
    },
    {
      key: 'logs',
      label: 'Logs',
      panels: [
        {
          kind: 'list',
          id: 'log',
          title: 'Errors today',
          items: [{ id: 'e1', title: 'knx: Connection lost', at, right: '×12', tone: 'bad', icon: 'log' }],
        },
      ],
    },
  ],
  actions: [
    {
      id: 'restart',
      label: 'Restart',
      icon: 'restart',
      confirm: { title: 'Restart Home Assistant?', body: 'It’s away for about a minute.', button: 'Restart' },
      allowed: true,
    },
  ],
  readAt: at,
};

describe('contracts 0.88.0: thing pages (CT-390…CT-393)', () => {
  it('takes a Home Assistant page', () => {
    expect(ThingPage.parse(homeAssistant).tabs[0]?.panels).toHaveLength(7);
  });

  it('takes a device being learned', () => {
    const page = ThingPage.parse({
      id: 'device:dvp_hp1',
      kind: 'device',
      proposalId: 'dvp_hp1',
      catalogId: 'device',
      name: 'Heat pump',
      icon: 'thermometer',
      status: 'learning',
      badge: 'Learning',
      facts: [],
      runsOn: null,
      settings: false,
      tabs: [
        {
          key: 'overview',
          label: 'Overview',
          panels: [{ kind: 'text', id: 'learning', body: 'Whombat is learning it.' }],
        },
      ],
      actions: [],
      readAt: null,
    });
    expect(page.proposalId).toBe('dvp_hp1');
  });

  it('refuses a panel of a kind it doesn’t know, a bad key and a bad outside link', () => {
    expect(ThingPagePanel.safeParse({ kind: 'map', id: 'x' }).success).toBe(false);
    expect(
      ThingPagePanel.safeParse({ kind: 'kpis', id: 'Bad Key', items: [{ key: 'a', label: 'A', value: '1' }] })
        .success,
    ).toBe(false);
    expect(
      ThingPagePanel.safeParse({
        kind: 'text',
        id: 't',
        body: 'x',
        link: { kind: 'url', label: 'Open', url: 'not a url' },
      }).success,
    ).toBe(false);
  });

  it('keeps partOf and a widget’s thingId optional', () => {
    const thing = {
      id: 'connection:con_p1',
      kind: 'connection',
      name: 'Proxmox VE',
      icon: 'proxmox',
      status: 'ok',
      facts: [],
      href: '/things/connection%3Acon_p1',
    };
    expect(ThingSummary.parse(thing).partOf).toBeUndefined();
    expect(ThingSummary.parse({ ...thing, partOf: 'server:pve-02' }).partOf).toBe('server:pve-02');
    const widget = {
      id: 'wdg_a1',
      title: 'Database size',
      kind: 'line',
      series: [{ key: 'db', label: 'Database', color: 1 }],
      latest: [],
      points: [],
      refreshSec: 300,
      updatedAt: null,
    };
    expect(Widget.safeParse(widget).success).toBe(true);
    expect(Widget.parse({ ...widget, thingId: 'connection:con_ha1' }).thingId).toBe('connection:con_ha1');
  });

  it('has the three ops and their bodies', () => {
    expect(api.things.page.path).toBe('/burrows/:burrow/things/:thing');
    expect(api.things.action.method).toBe('POST');
    expect(api.connections.setRunsOn.path).toBe('/burrows/:burrow/connections/:connectionId/runs-on');
    expect(ThingActionBody.parse({ action: 'restart' }).action).toBe('restart');
    expect(SetRunsOnBody.parse({ mode: 'chosen', serverId: 'pve-02', guestId: 'pve:131' }).mode).toBe(
      'chosen',
    );
    expect(SetRunsOnBody.safeParse({ mode: 'chosen', serverId: 'pve-02' }).success).toBe(false);
  });
});
