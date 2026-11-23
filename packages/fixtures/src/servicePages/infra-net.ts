/**
 * Fixture pages of the infra-net group: Cloudflare, OPNsense and Tailscale, their Summary in slots as the server builds
 * it. Each entry shows in the web's and the phone's fixture mode at `/things/<thing>` and in the sidebar; its shape and
 * an example are in `types.ts`. Add yours to the list; nothing else needs changing.
 */
import type {
  ThingGalleryItem,
  ThingLine,
  ThingPage,
  ThingPageButton,
  ThingPageItem,
  ThingPageNotice,
  ThingPagePanel,
} from '@whombat/core/domain';
import type { FixtureServiceCtx, FixtureServicePage } from './types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LOOK_ONLY = 'You can look at this connection, not change it.';

/** What every page here shares: buttons refused on Look only, a line's Ignore, the head. */
function kit(ctx: FixtureServiceCtx) {
  const button = (b: Omit<ThingPageButton, 'allowed'>): ThingPageButton =>
    ctx.lookOnly ? { ...b, allowed: false, reason: LOOK_ONLY } : { ...b, allowed: true };
  const line = (
    n: ThingPageNotice,
    nature: NonNullable<ThingPageNotice['nature']>,
    check: string,
    words: string,
    lifts: 'fixed' | 'newer' = 'fixed',
  ): ThingPageNotice => ({ ...n, nature, check, ...(ctx.lookOnly ? {} : { ignore: { lifts, words } }) });
  const head = (
    thing: `connection:${string}`,
    catalogId: string,
    name: string,
    status: ThingPage['status'],
    badge: string,
    facts: ThingLine[],
    address: string,
    open: string,
  ): Omit<ThingPage, 'tabs'> => ({
    id: thing,
    kind: 'connection',
    connectionId: thing.slice('connection:'.length) as ThingPage['connectionId'],
    catalogId,
    name,
    icon: catalogId,
    status,
    badge,
    facts,
    address,
    open: { label: `Open ${name}`, url: open },
    runsOn: null,
    settings: true,
    actions: [],
    readAt: ctx.ago(4_000),
  });
  /** The Summary with Worth a look as its strip, when there is a line. */
  const summary = (notices: ThingPageNotice[], panels: ThingPagePanel[]) => ({
    key: 'overview',
    label: 'Summary',
    panels: [
      ...(notices.length
        ? [
            {
              kind: 'notices' as const,
              id: 'worth',
              place: 'top' as const,
              title: 'Worth a look',
              items: notices,
            },
          ]
        : []),
      ...panels,
    ],
  });
  /** Two-hour bars of the last 24 hours, each from an even hour, the one going on last (as the server's). */
  const twoHours = () =>
    Array.from(
      { length: 12 },
      (_, i) => Math.floor((ctx.now() - (11 - i) * 2 * HOUR) / (2 * HOUR)) * 2 * HOUR,
    );
  /** The last 7 days, today last. */
  const week = () => {
    const at = Array.from({ length: 7 }, (_, i) => ctx.now() - (6 - i) * DAY);
    const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' });
    return {
      timestamps: at.map((t) => new Date(t).toISOString()),
      labels: at.map((t, i) => (i === 6 ? 'Today' : day.format(new Date(t)))),
    };
  };
  const count = (
    p: Omit<ThingPageItem, 'figure'> & {
      value: string;
      note?: string;
      noteTone?: 'ok' | 'warn' | 'bad';
    },
  ): ThingPageItem => {
    // A Live line's `right` says it in full (“4 connections”); a count's is its figure.
    const { value, note, noteTone, right, ...rest } = p;
    return {
      ...rest,
      right: right ?? value,
      figure: { value, ...(note ? { note } : {}), ...(noteTone ? { tone: noteTone } : {}) },
    };
  };
  return { button, line, head, summary, twoHours, week, count };
}

/* Cloudflare ---------------------------------------------------------------------------------------------------- */

const CLOUDFLARE = 'connection:con_cloudflare' as const;
const CF_DASH = 'https://dash.cloudflare.com/';
const CF_CHECKS: NonNullable<ReturnType<FixtureServicePage['make']>['checks']> = [
  { check: 'cloudflare.tunnel_down', name: 'Tunnels going down', nature: 'problem', perItem: true },
  {
    check: 'cloudflare.tunnel_degraded',
    name: 'Tunnels losing connections',
    nature: 'problem',
    perItem: true,
  },
  { check: 'cloudflare.cert', name: 'Certificates ending', nature: 'problem', perItem: true },
  { check: 'cloudflare.zone', name: 'Sites that aren’t active', nature: 'you', perItem: true },
  { check: 'cloudflare.paused', name: 'Paused sites', nature: 'fyi', perItem: true },
];

const cloudflare: FixtureServicePage = {
  thing: CLOUDFLARE,
  catalogId: 'cloudflare',
  name: 'Cloudflare',
  make: (ctx) => {
    const { button, line, head, summary, twoHours, count } = kit(ctx);
    const cleared = new Set<string>();
    const sites: [string, string, string, string, string?][] = [
      ['shop.example', '48.2 k', '86 % from cache · 212 threats', 'requests'],
      ['lumio.example.org', '21.6 k', '79 % from cache · 2 threats', 'requests'],
      ['johndoe.example', '9,412', '91 % from cache', 'requests'],
      ['old-blog.example', '312', '40 % from cache', 'Paused', 'warn'],
    ];
    const purge = (name: string) =>
      button({
        action: 'purge',
        target: name,
        label: 'Clear cache',
        icon: 'clean',
        confirm: {
          title: `Clear Cloudflare’s cache for ${name}?`,
          body: 'Every file is fetched from your server again, so the site may be slower for a few minutes.',
          button: 'Clear cache',
        },
      });
    const page = (): ThingPage => {
      const hours = twoHours();
      const requests = hours.map((t) => {
        const h = new Date(t).getUTCHours();
        return Math.round(
          4200 + 4400 * Math.max(0, Math.sin(((h - 6) / 24) * Math.PI * 2)) + ((h * 53) % 400),
        );
      });
      const notices = [
        line(
          {
            id: 'tunnel-degraded-office',
            tone: 'warn',
            icon: 'network',
            title: 'Tunnel office is degraded',
            detail: 'Some of its connections to Cloudflare have been down for 42 min.',
            link: {
              kind: 'ask',
              label: 'Look into it',
              question: 'Why is the Cloudflare tunnel office degraded?',
            },
          },
          'problem',
          'cloudflare.tunnel_degraded',
          'Until it’s healthy again.',
        ),
        line(
          {
            id: 'paused-old-blog',
            tone: 'info',
            icon: 'power',
            title: 'Cloudflare is paused for old-blog.example',
            detail: 'Visitors reach your server directly, without its protection or cache.',
          },
          'fyi',
          'cloudflare.paused',
          'Until it’s unpaused.',
        ),
      ];
      return {
        ...head(
          CLOUDFLARE,
          'cloudflare',
          'Cloudflare',
          'warn',
          'Tunnel office degraded',
          [[{ text: '4 sites', strong: true }, { text: ' · ' }, { text: '3 tunnels', strong: true }]],
          'api.cloudflare.com',
          CF_DASH,
        ),
        tabs: [
          summary(notices, [
            {
              kind: 'list',
              id: 'tunnels',
              place: 'chart',
              span: 2,
              title: 'Tunnels',
              meta: '1 degraded · 2 healthy',
              items: [
                count({
                  id: 'office',
                  title: 'office',
                  icon: 'network',
                  detail: 'Degraded for 42 min · AMS',
                  tone: 'warn',
                  right: '1 connection',
                  value: '1',
                  note: 'Degraded',
                  noteTone: 'warn',
                }),
                count({
                  id: 'home',
                  title: 'home',
                  icon: 'network',
                  detail: 'Healthy · AMS01 · AMS08 · FRA08',
                  tone: 'ok',
                  right: '4 connections',
                  value: '4',
                  note: 'connections',
                }),
                count({
                  id: 'nas',
                  title: 'nas',
                  icon: 'network',
                  detail: 'Healthy · AMS01 · FRA08',
                  tone: 'ok',
                  right: '2 connections',
                  value: '2',
                  note: 'connections',
                }),
              ],
            },
            {
              kind: 'list',
              id: 'inventory',
              place: 'chart',
              span: 1,
              look: 'counts',
              title: 'Sites',
              meta: 'last 24 hours',
              items: sites.map(([name, value, detail, note, tone]) =>
                count({
                  id: name,
                  title: name,
                  icon: 'network',
                  value,
                  detail,
                  note: cleared.has(name) ? 'Cache cleared' : note,
                  ...(tone && !cleared.has(name) ? { noteTone: tone as 'warn' } : {}),
                  actions: [purge(name)],
                  url: `${CF_DASH}a1b2c3/${name}`,
                }),
              ),
            },
            {
              kind: 'chart',
              id: 'requests',
              place: 'chart',
              span: 1,
              title: 'Last 24 hours',
              meta: 'Requests per 2 hours',
              style: 'bars',
              timestamps: hours.map((t) => new Date(t).toISOString()),
              labels: hours.map((t, i) =>
                i === hours.length - 1 ? 'Now' : new Date(t).toISOString().slice(11, 13),
              ),
              series: [{ key: 'values', label: 'Requests', values: requests, color: 'orange' }],
              figure: { value: '79.5 k', rest: 'requests' },
              stats: [
                [{ text: '84 %', strong: true }, { text: ' from cache' }],
                [{ text: '214', strong: true }, { text: ' threats stopped' }],
              ],
              axis: { min: 0 },
            },
          ]),
        ],
      };
    };
    return {
      page,
      row: () => ({
        line: '4 sites',
        facts: [
          { label: 'Requests', value: '79.5 k' },
          { label: 'Tunnels', value: '2 of 3 healthy' },
        ],
        reason: 'Tunnel office degraded',
      }),
      action: ({ action, target }) => {
        if (action !== 'purge' || !target) return null;
        cleared.add(target);
        return { message: `Cleared Cloudflare’s cache for ${target}.`, recorded: true };
      },
      checks: CF_CHECKS,
    };
  },
};

/**
 * Cloudflare signed in with Cloudflare (`con_cloudflare_mcp`): its MCP server's only tool that reads is who signed in,
 * so the page is a connection's own (How it answers, Answer time) and the line under the name says a token shows more.
 */
const cloudflareMcp: FixtureServicePage = {
  thing: 'connection:con_cloudflare_mcp',
  catalogId: 'cloudflare',
  name: 'Cloudflare',
  make: (ctx) => {
    const { head, summary, week, count } = kit(ctx);
    const page = (): ThingPage => ({
      ...head(
        'connection:con_cloudflare_mcp',
        'cloudflare',
        'Cloudflare',
        'ok',
        'Running fine',
        [[{ text: 'Checked ' }, { text: '3 min', strong: true }, { text: ' ago' }]],
        'mcp.cloudflare.com',
        CF_DASH,
      ),
      problem: 'An API token shows its traffic and tunnels here.',
      tabs: [
        summary(
          [],
          [
            {
              kind: 'list',
              id: 'answers',
              place: 'chart',
              span: 1,
              look: 'counts',
              title: 'How it answers',
              meta: 'Whombat’s checks',
              items: [
                count({
                  id: 'answers',
                  title: 'Answers',
                  icon: 'network',
                  detail: '2,016 checks in 7 days',
                  value: '100 %',
                  note: 'All answered',
                  noteTone: 'ok',
                }),
                count({
                  id: 'answer-time',
                  title: 'Answers in',
                  icon: 'clock',
                  detail: 'Typical today',
                  value: '214 ms',
                  note: '+3 % on last week',
                }),
              ],
            },
            {
              kind: 'chart',
              id: 'week',
              place: 'chart',
              span: 1,
              title: 'Answer time',
              meta: 'Typical per day',
              style: 'bars',
              ...week(),
              series: [
                {
                  key: 'values',
                  label: 'Answer time',
                  values: [208, 199, 226, 241, 205, 192, 214],
                  color: 'blue',
                  unit: 'ms',
                },
              ],
              figure: { value: '212 ms', rest: 'typical this week' },
              stats: [[{ text: '+3 %', strong: true }, { text: ' on last week' }]],
              axis: { min: 0 },
            },
          ],
        ),
      ],
    });
    return {
      page,
      row: () => ({ line: 'Running fine' }),
      checks: [
        ...CF_CHECKS,
        {
          check: 'cloudflare.token_hint',
          name: 'The hint to connect with an API token',
          nature: 'fyi',
          perItem: false,
        },
      ],
    };
  },
};

/* OPNsense ------------------------------------------------------------------------------------------------------ */

const OPNSENSE = 'connection:con_opnsense' as const;
const OPN_URL = 'https://192.168.1.1';

const opnsense: FixtureServicePage = {
  thing: OPNSENSE,
  catalogId: 'opnsense',
  name: 'OPNsense',
  fields: { url: OPN_URL },
  make: (ctx) => {
    const { button, line, head, summary, week, count } = kit(ctx);
    let checked = false;
    const services: [string, string, boolean][] = [
      ['unbound', 'Unbound DNS', true],
      ['dhcpd', 'DHCPv4 server', true],
      ['wireguard', 'WireGuard', true],
      ['ntpd', 'Network time', true],
      ['openssh', 'Secure shell', true],
      ['syslog-ng', 'System log', true],
    ];
    const page = (): ThingPage => {
      const days = week();
      // The default gateway's delay over the last 24 hours, every 5 minutes (Whombat's own readings).
      const steps = Array.from(
        { length: 288 },
        (_, i) => Math.floor((ctx.now() - (287 - i) * 5 * MIN) / (5 * MIN)) * 5 * MIN,
      );
      const delay = steps.map((t, i) => {
        const h = new Date(t).getUTCHours();
        return Math.round((3.8 + (h >= 19 && h <= 23 ? 1.4 : 0) + ((i * 37) % 11) / 20) * 10) / 10;
      });
      const loss = steps.map((_, i) => (i > 200 && i < 204 ? 2 : 0));
      const notices = [
        line(
          {
            id: 'firmware',
            tone: 'info',
            icon: 'update',
            title: 'OPNsense has an update',
            detail: 'Version 25.7.6; this one runs 25.7.5.',
            link: { kind: 'url', label: 'Open updates', url: `${OPN_URL}/ui/core/firmware` },
          },
          'fyi',
          'opnsense.updates',
          'Until a newer version is out.',
          'newer',
        ),
      ];
      return {
        ...head(
          OPNSENSE,
          'opnsense',
          'OPNsense',
          'ok',
          'Internet 4.2 ms',
          [
            [{ text: 'OPNsense ' }, { text: '25.7.5', strong: true }],
            [{ text: 'Up ' }, { text: '12 days', strong: true }],
          ],
          '192.168.1.1',
          OPN_URL,
        ),
        buttons: [
          button({
            action: 'check_updates',
            label: checked ? 'Checking…' : 'Check for updates',
            icon: 'search',
          }),
        ],
        // The internet over the range below the slots follows the picker.
        range: '24h',
        ranges: ['1h', '6h', '24h', '7d', '30d'],
        tabs: [
          summary(notices, [
            {
              kind: 'list',
              id: 'internet-now',
              place: 'chart',
              span: 2,
              title: 'Internet now',
              meta: 'Up 12 days',
              items: [
                count({
                  id: 'internet',
                  title: 'Internet',
                  icon: 'network',
                  detail: 'Online · WAN_DHCP · 0 % loss',
                  tone: 'ok',
                  value: '4.2 ms',
                  note: 'Online',
                  noteTone: 'ok',
                }),
                count({
                  id: 'gw-wan_dhcp6',
                  title: 'WAN_DHCP6',
                  icon: 'network',
                  detail: 'Online · IPv6 · 0 % loss',
                  tone: 'ok',
                  value: '5.1 ms',
                  note: 'Online',
                  noteTone: 'ok',
                }),
                count({
                  id: 'gw-lte_gw',
                  title: 'LTE_GW',
                  icon: 'network',
                  detail: 'Online · 0.3 % loss',
                  tone: 'ok',
                  value: '38 ms',
                  note: 'Online',
                  noteTone: 'ok',
                }),
                count({
                  id: 'connections',
                  title: 'Open connections',
                  icon: 'shield',
                  detail: 'of 1,622,000 the firewall keeps',
                  value: '1,234',
                }),
              ],
            },
            {
              kind: 'list',
              id: 'inventory',
              place: 'chart',
              span: 1,
              look: 'counts',
              title: 'On OPNsense',
              items: [
                count({
                  id: 'services',
                  title: 'Services',
                  icon: 'power',
                  value: '14',
                  note: 'All running',
                  url: `${OPN_URL}/ui/core/service`,
                }),
                count({ id: 'gateways', title: 'Gateways', icon: 'network', value: '3', note: 'All online' }),
                count({ id: 'peers', title: 'VPN devices', icon: 'key', value: '3', note: '2 online' }),
              ],
            },
            {
              kind: 'chart',
              id: 'week',
              place: 'chart',
              span: 1,
              title: 'Internet this week',
              meta: 'Average delay per day',
              style: 'bars',
              ...days,
              series: [
                {
                  key: 'values',
                  label: 'Delay',
                  values: [4.4, 4.1, 4.3, 5.2, 4.0, 3.9, 4.2],
                  color: 'green',
                  unit: 'ms',
                },
              ],
              figure: { value: '4.3 ms', rest: 'average delay' },
              stats: [[{ text: '−8 %', strong: true }, { text: ' on last week' }]],
              axis: { min: 0 },
            },
            {
              kind: 'bars',
              id: 'wireguard',
              place: 'chart',
              span: 1,
              title: 'On the VPN',
              meta: 'Data since it started',
              items: [
                {
                  id: 'person-0',
                  label: 'John’s phone',
                  person: true,
                  note: 'Online',
                  value: '2.4 GB',
                  pct: 1,
                },
                {
                  id: 'person-1',
                  label: 'Laptop',
                  person: true,
                  note: 'Online',
                  value: '860 MB',
                  pct: 0.86 / 2.4,
                },
                {
                  id: 'person-2',
                  label: 'Mara’s iPad',
                  person: true,
                  note: '3 days ago',
                  value: '120 MB',
                  pct: 0.12 / 2.4,
                },
              ],
            },
            {
              kind: 'bars',
              id: 'machine',
              place: 'chart',
              span: 1,
              title: 'The machine',
              meta: 'OPNsense',
              items: [
                { id: 'cpu', label: 'Processor', value: '4 %', pct: 0.04 },
                { id: 'memory', label: 'Memory', value: '2.4 of 7.9 GB', pct: 0.3 },
                {
                  id: 'opnsense-version',
                  label: 'OPNsense',
                  value: '25.7.5',
                  pct: null,
                  sub: 'Version 25.7.6 is out',
                },
                { id: 'up', label: 'Up', value: '12 days', pct: null },
              ],
            },
            {
              kind: 'chart',
              id: 'internet',
              place: 'main',
              title: 'Internet · WAN_DHCP',
              timestamps: steps.map((t) => new Date(t).toISOString()),
              series: [
                {
                  key: 'delay',
                  label: 'Delay',
                  unit: 'ms',
                  values: delay,
                  color: 'green',
                  fill: true,
                  latest: '4.2 ms',
                },
                {
                  key: 'loss',
                  label: 'Loss',
                  unit: '%',
                  values: loss,
                  axis: 'right',
                  color: 'red',
                  latest: '0.0 %',
                },
              ],
              figure: { value: '4.2 ms', rest: 'delay · 0.0 % loss' },
              stats: [
                [{ text: 'Average ' }, { text: '4.3 ms', strong: true }],
                [{ text: 'Peak ' }, { text: '5.7 ms', strong: true }, { text: ' at 21:10' }],
              ],
              axis: { min: 0, unit: 'ms' },
            },
            {
              kind: 'table',
              id: 'services',
              place: 'main',
              title: 'Services',
              meta: 'all running',
              columns: [
                { key: 'name', label: 'Service' },
                { key: 'state', label: 'State' },
                { key: 'action', label: '' },
              ],
              rows: services.map(([id, name]) => ({
                id,
                cells: {
                  name: { text: name },
                  state: { text: 'Running', dot: 'ok' },
                  action: {
                    text: 'Restart',
                    action: button({
                      action: 'restart',
                      target: id,
                      label: 'Restart',
                      icon: 'restart',
                      confirm: {
                        title: `Restart ${name}?`,
                        body: 'It stops for a moment; what depends on it may drop its connections.',
                        button: 'Restart',
                      },
                    }),
                  },
                },
              })),
            },
          ]),
        ],
      };
    };
    return {
      page,
      row: () => ({
        line: 'Firewall and router',
        facts: [
          { label: 'Internet', value: '4.2 ms' },
          { label: 'CPU', value: '4 %' },
        ],
      }),
      action: ({ action, target }) => {
        if (action === 'check_updates') {
          checked = true;
          return { message: 'OPNsense is checking for updates. Its answer shows here in a minute or two.' };
        }
        const service = services.find(([id]) => id === target);
        if (action === 'restart' && service) return { message: `Restarted ${service[1]}.`, recorded: true };
        return null;
      },
      checks: [
        { check: 'opnsense.gateway_down', name: 'Gateways going down', nature: 'problem', perItem: true },
        {
          check: 'opnsense.gateway_loss',
          name: 'Packet loss on a gateway',
          nature: 'problem',
          perItem: true,
        },
        { check: 'opnsense.service_stopped', name: 'Services stopping', nature: 'problem', perItem: true },
        {
          check: 'opnsense.states',
          name: 'The connection table filling up',
          nature: 'problem',
          perItem: false,
        },
        { check: 'opnsense.updates', name: 'OPNsense updates', nature: 'fyi', perItem: false },
      ],
    };
  },
};

/* Tailscale ----------------------------------------------------------------------------------------------------- */

const TAILSCALE = 'connection:con_tailscale' as const;
const TS_ADMIN = 'https://login.tailscale.com/admin/machines';

interface TsDevice {
  id: string;
  name: string;
  os: string;
  version: string;
  owner: string | null;
  online: boolean;
  seenAgo?: number;
  key?: string;
  waiting?: boolean;
}

const tailscale: FixtureServicePage = {
  thing: TAILSCALE,
  catalogId: 'tailscale',
  name: 'Tailscale',
  make: (ctx) => {
    const { button, line, head, summary, count } = kit(ctx);
    let approved = false;
    const devices = (): TsDevice[] => [
      {
        id: 'n1',
        name: 'new-phone',
        os: 'Android',
        version: '1.90.1',
        owner: 'John Doe',
        online: true,
        waiting: !approved,
      },
      {
        id: 'n2',
        name: 'laptop',
        os: 'macOS',
        version: '1.88.3',
        owner: 'Anna de Vries',
        online: true,
        key: 'Key ends in 3 days',
      },
      { id: 'n3', name: 'john-mbp', os: 'macOS', version: '1.90.1', owner: 'John Doe', online: true },
      { id: 'n4', name: 'anna-iphone', os: 'iOS', version: '1.90.1', owner: 'Anna de Vries', online: true },
      { id: 'n5', name: 'home-assistant', os: 'Linux', version: '1.90.1', owner: null, online: true },
      { id: 'n6', name: 'nas', os: 'Linux', version: '1.90.1', owner: null, online: true },
      { id: 'n7', name: 'pve-01', os: 'Linux', version: '1.86.2', owner: null, online: true },
      {
        id: 'n8',
        name: 'sam-pc',
        os: 'Windows',
        version: '1.86.2',
        owner: 'Sam',
        online: false,
        seenAgo: 3 * HOUR,
      },
      {
        id: 'n9',
        name: 'old-pi',
        os: 'Linux',
        version: '1.60.0',
        owner: 'John Doe',
        online: false,
        seenAgo: 20 * DAY,
      },
    ];
    const approve = () =>
      button({
        action: 'approve',
        target: 'n1',
        label: 'Approve',
        icon: 'check',
        tone: 'primary',
        confirm: {
          title: 'Let new-phone join the tailnet?',
          body: 'It can reach what the tailnet’s access rules allow, like any other device.',
          button: 'Approve',
        },
      });
    const page = (): ThingPage => {
      const all = devices();
      const online = all.filter((d) => d.online && !d.waiting).length;
      // Four, as the server’s: waiting and keys first, people’s devices before tagged servers.
      const live: ThingGalleryItem[] = all
        .filter((d) => d.online)
        .slice(0, 4)
        .map((d) => ({
          id: d.id,
          title: d.name,
          sub: [d.os, d.version, d.owner ? null : 'Tagged'].filter(Boolean).join(' · '),
          ...(d.owner ? { person: { name: d.owner } } : {}),
          ...(d.waiting
            ? { badge: { text: 'Waiting', tone: 'warn' as const } }
            : d.key
              ? { badge: { text: d.key, tone: 'warn' as const } }
              : {}),
          ...(d.waiting ? {} : { noteEnd: 'Online' }),
          ...(d.waiting ? { actions: [approve()] } : {}),
        }));
      const notices: ThingPageNotice[] = [
        ...(approved
          ? []
          : [
              line(
                {
                  id: 'waiting-n1',
                  tone: 'warn',
                  icon: 'device',
                  title: 'new-phone is waiting for approval',
                  detail: 'It joins the tailnet once someone approves it.',
                  action: approve(),
                },
                'you',
                'tailscale.waiting',
                'Until it’s approved or removed.',
              ),
            ]),
        line(
          {
            id: 'key-n2',
            tone: 'warn',
            icon: 'key',
            title: 'laptop’s key ends in 3 days',
            detail: 'Sign in on it again, or turn off key expiry for it in Tailscale.',
            link: { kind: 'url', label: 'Open Tailscale', url: TS_ADMIN },
          },
          'you',
          'tailscale.key',
          'Until it’s signed in again.',
          'newer',
        ),
      ];
      const people: [string, number, string][] = [
        ['John Doe', 3, '2 online'],
        ['Anna de Vries', 2, '2 online'],
        ['Sam', 1, 'all offline'],
      ];
      return {
        ...head(
          TAILSCALE,
          'tailscale',
          'Tailscale',
          'warn',
          approved ? 'laptop’s key ends soon' : 'new-phone waits for approval',
          [
            [{ text: 'Tailnet ' }, { text: 'tail1234.ts.net', strong: true }],
            [{ text: '9 devices', strong: true }, { text: ' · ' }, { text: '3 people', strong: true }],
          ],
          'api.tailscale.com',
          TS_ADMIN,
        ),
        tabs: [
          summary(notices, [
            {
              kind: 'gallery',
              id: 'online',
              place: 'chart',
              span: 2,
              look: 'rows',
              shape: 'square',
              title: 'Online now',
              meta: `${online} of ${all.length} online`,
              items: live,
            },
            {
              kind: 'list',
              id: 'inventory',
              place: 'chart',
              span: 1,
              look: 'counts',
              title: 'In the tailnet',
              items: [
                count({
                  id: 'devices',
                  title: 'Devices',
                  icon: 'device',
                  detail: `${online} online`,
                  value: '9',
                  note: '+2 this week',
                  noteTone: 'ok',
                  url: TS_ADMIN,
                }),
                count({
                  id: 'people',
                  title: 'People',
                  icon: 'key',
                  value: '3',
                  note: 'Nothing new',
                  url: 'https://login.tailscale.com/admin/users',
                }),
                count({
                  id: 'tagged',
                  title: 'Tagged devices',
                  icon: 'device',
                  value: '3',
                  note: 'servers and the like',
                }),
                count({
                  id: 'keys',
                  title: 'Keys ending',
                  icon: 'key',
                  value: '1',
                  note: 'first in 3 days',
                  noteTone: 'warn',
                  url: TS_ADMIN,
                }),
                count({
                  id: 'updates',
                  title: 'Can update',
                  icon: 'update',
                  value: '3',
                  note: 'Tailscale itself',
                }),
              ],
            },
            {
              kind: 'bars',
              id: 'people',
              place: 'chart',
              span: 1,
              title: 'Who’s on it',
              meta: 'by devices',
              columns: 3,
              items: people.map(([name, n, note], i) => ({
                id: `person-${i}`,
                label: name,
                person: true,
                note,
                value: `${n} ${n === 1 ? 'device' : 'devices'}`,
                pct: n / 3,
              })),
            },
          ]),
          {
            key: 'devices',
            label: 'Devices',
            count: 9,
            panels: [
              {
                kind: 'table',
                id: 'devices',
                title: 'Devices',
                meta: '2 offline',
                columns: [
                  { key: 'device', label: 'Device' },
                  { key: 'owner', label: 'Owner' },
                  { key: 'os', label: 'OS' },
                  { key: 'seen', label: 'Seen' },
                  { key: 'version', label: 'Version' },
                  { key: 'key', label: 'Key ends' },
                ],
                rows: all.map((d) => ({
                  id: d.id,
                  cells: {
                    device: { text: d.name, ...(d.owner ? {} : { note: 'Tagged' }) },
                    owner: d.owner ? { text: d.owner } : { text: '—', tone: 'muted' as const },
                    os: { text: d.os },
                    seen: d.waiting
                      ? { text: 'Waiting for approval', dot: 'warn' as const }
                      : d.online
                        ? { text: 'Online', dot: 'ok' as const }
                        : {
                            text:
                              (d.seenAgo ?? 0) > DAY
                                ? `${Math.round((d.seenAgo ?? 0) / DAY)} days ago`
                                : '3 h ago',
                            dot: 'off' as const,
                          },
                    version: { text: d.version, mono: true },
                    key: d.key
                      ? { text: 'in 3 days', tone: 'warn' as const }
                      : { text: 'Never', tone: 'muted' as const },
                  },
                })),
              },
            ],
          },
        ],
      };
    };
    return {
      page,
      row: () => ({
        line: '9 devices',
        facts: [
          { label: 'Online', value: `${devices().filter((d) => d.online && !d.waiting).length} of 9` },
          { label: 'Waiting', value: approved ? '0' : '1' },
        ],
        reason: approved ? 'laptop’s key ends soon' : 'new-phone waits for approval',
      }),
      action: ({ action, target }) => {
        if (action !== 'approve' || target !== 'n1' || approved) return null;
        approved = true;
        return { message: 'Approved new-phone. It can join the tailnet now.', recorded: true };
      },
      checks: [
        { check: 'tailscale.key', name: 'Device keys ending', nature: 'you', perItem: true },
        { check: 'tailscale.waiting', name: 'Devices waiting for approval', nature: 'you', perItem: true },
        { check: 'tailscale.updates', name: 'Tailscale updates on devices', nature: 'fyi', perItem: false },
        { check: 'tailscale.offline', name: 'Devices offline for a week', nature: 'fyi', perItem: false },
      ],
    };
  },
};

export const INFRA_NET_PAGES: FixtureServicePage[] = [cloudflare, cloudflareMcp, opnsense, tailscale];
