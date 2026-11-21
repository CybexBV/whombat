/**
 * Fixture pages of the infra-apps group: Grafana, Nginx Proxy Manager, Portainer and Pterodactyl, their Summary in
 * slots as the server builds it. Each entry shows in the web's and the phone's fixture mode at `/things/<thing>` and in
 * the sidebar; its shape and an example are in `types.ts`. Add yours to the list; nothing else needs changing.
 */
import {
  type NoticeIgnore,
  type NoticeNature,
  type ThingGalleryItem,
  type ThingLine,
  type ThingPage,
  type ThingPageBar,
  type ThingPageButton,
  type ThingPageItem,
  type ThingPageNotice,
  type ThingPagePanel,
  type ThingPageRow,
  thingHref,
} from '@whombat/core/domain';
import type { FixtureServiceCtx, FixtureServicePage } from './types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LOOK_ONLY = 'Look only: changes are off for this connection.';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** What every page here is built with: buttons and Worth a look lines as the server makes them for this world. */
function kit(ctx: FixtureServiceCtx) {
  const button = (b: Omit<ThingPageButton, 'allowed'>): ThingPageButton =>
    ctx.lookOnly ? { ...b, allowed: false, reason: LOOK_ONLY } : { ...b, allowed: true };
  const notice = (
    n: ThingPageNotice,
    nature: NoticeNature,
    check: string,
    ignore: NoticeIgnore,
  ): ThingPageNotice => ({ ...n, nature, check, ...(ctx.lookOnly ? {} : { ignore }) });
  const worth = (items: ThingPageNotice[]): ThingPagePanel[] =>
    items.length ? [{ kind: 'notices', id: 'worth', place: 'top', title: 'Worth a look', items }] : [];
  /** The last 7 days, today last: their times and words. */
  const week = () => {
    const at = Array.from({ length: 7 }, (_, i) => new Date(ctx.now() - (6 - i) * DAY));
    return {
      timestamps: at.map((d) => d.toISOString()),
      labels: at.map((d, i) => (i === 6 ? 'Today' : (WEEKDAYS[d.getDay()] ?? ''))),
    };
  };
  /** “The machine”: thetitan's figures, then the service's own lines; `span` as the server packs the row. */
  const machine = (span: 1 | 2 | 3, own: ThingPageBar[]): ThingPagePanel => ({
    kind: 'bars',
    id: 'machine',
    place: 'chart',
    span,
    title: 'The machine',
    meta: 'thetitan',
    link: { kind: 'href', label: 'See thetitan', href: thingHref('server', 'thetitan') },
    items: [
      { id: 'cpu', label: 'Processor', note: 'of 8 cores', value: '12 %', pct: 0.12 },
      { id: 'memory', label: 'Memory', value: '5.2 of 16 GB', pct: 0.33 },
      { id: 'disk', label: 'Disk', value: '7.1 of 12 TB', pct: 0.59, sub: 'Full in about 5 months' },
      ...own,
    ],
  });
  const head = (
    thing: string,
    catalogId: string,
    name: string,
    status: ThingPage['status'],
    badge: string,
    facts: ThingLine[],
    address: string,
    tabs: ThingPage['tabs'],
    openLabel = `Open ${name}`.slice(0, 40),
  ): ThingPage => ({
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
    open: { label: openLabel, url: `http://${address}` },
    runsOn: null,
    settings: true,
    actions: [],
    readAt: ctx.ago(4_000),
    tabs,
  });
  return { button, notice, worth, week, machine, head };
}

const summary = (panels: ThingPagePanel[]): ThingPage['tabs'] => [
  { key: 'overview', label: 'Summary', panels },
];

/* Grafana ------------------------------------------------------------------------------------------------------------ */

const GRAFANA = 'http://10.100.0.20:3000';
const FIRINGS = [1, 3, 0, 2, 1, 0, 2];

const grafana: FixtureServicePage = {
  thing: 'connection:con_grafana',
  catalogId: 'grafana',
  name: 'Grafana',
  fields: { url: GRAFANA },
  make: (ctx) => {
    const { notice, worth, week, machine, head } = kit(ctx);
    const page = (): ThingPage => {
      const days = week();
      const firing: ThingGalleryItem[] = [
        {
          id: '1a6b2e0dbf55c214',
          title: 'Disk almost full',
          sub: 'The disk on nas is almost full · Homelab',
          badge: { text: 'Critical', tone: 'bad' },
          at: ctx.ago(2 * HOUR),
          noteEnd: 'for 2 h',
          url: `${GRAFANA}/alerting/grafana/disk-full/view`,
        },
        {
          id: '7c03ad91e4b2f816',
          title: 'Backup didn’t run',
          sub: 'The nightly backup of pve-02 is late · Homelab',
          badge: { text: 'Firing', tone: 'warn' },
          at: ctx.ago(25 * MIN),
          noteEnd: 'for 25 min',
          url: `${GRAFANA}/alerting/grafana/backup-late/view`,
        },
        {
          id: 'pending-0',
          title: 'Wi-Fi access point slow',
          sub: 'Network',
          badge: { text: 'About to fire', tone: 'warn' },
          paused: true,
        },
      ];
      const inventory: ThingPageItem[] = [
        {
          id: 'rules',
          title: 'Alert rules',
          icon: 'shield',
          right: '12',
          figure: { value: '12', note: '2 firing', tone: 'warn' },
          url: `${GRAFANA}/alerting/list`,
        },
        {
          id: 'sources',
          title: 'Data sources',
          icon: 'database',
          right: '8',
          figure: { value: '8', note: '1 failing', tone: 'warn' },
          url: `${GRAFANA}/connections/datasources`,
        },
        {
          id: 'dashboards',
          title: 'Dashboards',
          icon: 'info',
          right: '34',
          figure: { value: '34', note: '3 starred' },
          url: `${GRAFANA}/dashboards`,
        },
        {
          id: 'silenced',
          title: 'Silenced',
          icon: 'clock',
          right: '1',
          figure: { value: '1' },
          url: `${GRAFANA}/alerting/silences`,
        },
      ];
      return head(
        'connection:con_grafana',
        'grafana',
        'Grafana',
        'bad',
        'Disk almost full firing',
        [
          [{ text: 'Grafana ' }, { text: '13.3.0', strong: true }],
          [{ text: '12 alert rules', strong: true }],
        ],
        '10.100.0.20:3000',
        summary([
          ...worth([
            notice(
              {
                id: 'alert-disk-full',
                tone: 'bad',
                icon: 'warn',
                title: 'Disk almost full is firing for 2 h',
                detail: 'The disk on nas is almost full · Homelab',
                link: {
                  kind: 'ask',
                  label: 'Look into it',
                  question: 'Why is the Grafana alert “Disk almost full” firing?',
                },
              },
              'problem',
              'grafana.alert',
              { lifts: 'newer', words: 'Until this firing ends.' },
            ),
            notice(
              {
                id: 'alert-backup-late',
                tone: 'warn',
                icon: 'warn',
                title: 'Backup didn’t run is firing for 25 min',
                detail: 'The nightly backup of pve-02 is late · Homelab',
                link: {
                  kind: 'ask',
                  label: 'Look into it',
                  question: 'Why is the Grafana alert “Backup didn’t run” firing?',
                },
              },
              'problem',
              'grafana.alert',
              { lifts: 'newer', words: 'Until this firing ends.' },
            ),
            notice(
              {
                id: 'source-prom-garage',
                tone: 'warn',
                icon: 'plug',
                title: 'Data source failing: Prometheus garage',
                detail: 'Post “http://10.100.0.44:9090/api/v1/query”: dial tcp: connection refused',
                link: {
                  kind: 'ask',
                  label: 'Look into it',
                  question: 'Why is the Grafana data source Prometheus garage failing?',
                },
              },
              'problem',
              'grafana.source',
              { lifts: 'fixed', words: 'Until it works again.' },
            ),
          ]),
          {
            kind: 'gallery',
            id: 'firing',
            place: 'chart',
            span: 2,
            look: 'rows',
            title: 'Firing now',
            meta: '2 firing · 1 about to fire · 1 silenced',
            link: { kind: 'url', label: 'All alerts', url: `${GRAFANA}/alerting/list` },
            shape: 'square',
            items: firing,
            empty: 'Nothing is firing.',
          },
          {
            kind: 'list',
            id: 'inventory',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'In Grafana',
            items: inventory,
          },
          {
            kind: 'chart',
            id: 'week',
            place: 'chart',
            span: 1,
            title: 'Alerts this week',
            meta: 'Times an alert started firing',
            style: 'bars',
            ...days,
            series: [{ key: 'values', label: 'Firings', values: FIRINGS, color: 'red' }],
            figure: { value: '9', rest: 'firings this week' },
            stats: [[{ text: '+29 %', strong: true }, { text: ' on last week' }]],
            axis: { min: 0 },
          },
          machine(2, [
            { id: 'grafana-version', label: 'Grafana', value: '13.3.0', pct: null },
            { id: 'grafana-database', label: 'Database', value: 'Fine', pct: null },
          ]),
          {
            kind: 'list',
            id: 'starred',
            place: 'main',
            title: 'Starred dashboards',
            link: { kind: 'url', label: 'All dashboards', url: `${GRAFANA}/dashboards` },
            items: [
              { id: 'servers', title: 'Servers', detail: 'Homelab', url: `${GRAFANA}/d/servers/servers` },
              { id: 'network', title: 'Network', detail: 'Homelab', url: `${GRAFANA}/d/network/network` },
              { id: 'power', title: 'Power use', detail: 'House', url: `${GRAFANA}/d/power/power-use` },
            ],
          },
        ]),
      );
    };
    return {
      page,
      row: () => ({
        line: 'Grafana 13.3.0',
        facts: [{ label: 'Firing', value: '2' }],
        reason: 'Disk almost full firing',
      }),
      checks: [
        { check: 'grafana.database', name: 'Grafana’s database', nature: 'problem', perItem: false },
        { check: 'grafana.alert', name: 'Firing alerts', nature: 'problem', perItem: true },
        { check: 'grafana.source', name: 'Data sources failing', nature: 'problem', perItem: true },
      ],
    };
  },
};

/* Nginx Proxy Manager ------------------------------------------------------------------------------------------------ */

const NPM = 'http://10.100.0.20:81';

const npm: FixtureServicePage = {
  thing: 'connection:con_nginx-proxy-manager',
  catalogId: 'nginx_proxy_manager',
  name: 'Nginx Proxy Manager',
  fields: { url: NPM },
  make: (ctx) => {
    const { button, notice, worth, machine, head } = kit(ctx);
    let renewed = false;
    const page = (): ThingPage => {
      const renew = button({
        action: 'renew',
        target: '4',
        label: 'Renew',
        icon: 'retry',
        confirm: {
          title: 'Renew the certificate for cloud.example.com?',
          body: 'Nginx Proxy Manager asks Let’s Encrypt for a new one; it takes up to a minute.',
          button: 'Renew',
        },
      });
      // [id, site, forwards to, answer, tone, certificate words, certificate cell]
      const sites: [string, string, string, string, ThingPageItem['tone'] | null, string | null, string][] = [
        ['p5', 'nas.example.com', '10.100.0.30:5000', 'No answer', 'bad', null, '61 days'],
        [
          'p4',
          'cloud.example.com',
          '10.100.0.21:11000',
          'Answering',
          renewed ? 'ok' : 'warn',
          renewed ? null : 'certificate ends in 9 days',
          renewed ? '89 days' : '9 days',
        ],
        ['p1', 'home.example.com', '10.100.0.5:8123', 'Answering', 'ok', null, '74 days'],
        ['p2', 'photos.example.com', '10.100.0.22:2283', 'Answering', 'ok', null, '74 days'],
        ['p3', 'plex.example.com', '10.100.0.20:32400', 'Answering', 'ok', null, '48 days'],
        ['r1', 'www.example.com', 'Redirect to example.com', 'Answering', 'ok', null, '48 days'],
        ['p6', 'old-wiki.example.com', '10.100.0.40:8080', 'Switched off', null, null, '—'],
      ];
      const live: ThingPageItem[] = sites.map(([id, site, to, answer, tone, cert]) => ({
        id,
        title: site,
        ...(answer === 'Switched off' ? {} : { detail: [to, cert].filter(Boolean).join(' · ') }),
        ...(tone ? { tone } : {}),
        icon: cert ? 'certificate' : 'network',
        right: answer,
        ...(answer === 'Switched off' ? {} : { url: `https://${site}/` }),
        ...(id === 'p4' && !renewed ? { actions: [renew] } : {}),
      }));
      const rows: ThingPageRow[] = sites.map(([id, site, to, answer, , cert, days]) => ({
        id,
        cells: {
          site: { text: site },
          target: id.startsWith('r')
            ? { text: 'https://example.com', mono: true, note: 'redirect' }
            : { text: `http://${to}`, mono: true },
          certificate:
            days === '—'
              ? { text: 'None', tone: 'muted' }
              : { text: days, ...(cert ? { tone: 'warn' as const } : {}) },
          answering:
            answer === 'Switched off'
              ? { text: answer, dot: 'off' }
              : answer === 'No answer'
                ? { text: answer, dot: 'bad' }
                : { text: answer, dot: 'ok' },
          ...(id === 'p4' && !renewed ? { renew: { text: 'Renew', action: renew } } : {}),
        },
      }));
      const notices: ThingPageNotice[] = [
        notice(
          {
            id: 'not-answering-p5',
            tone: 'warn',
            icon: 'network',
            title: 'nas.example.com isn’t answering',
            detail: 'No answer',
            link: {
              kind: 'ask',
              label: 'Look into it',
              question: 'Why isn’t nas.example.com answering behind Nginx Proxy Manager?',
            },
          },
          'problem',
          'nginx_proxy_manager.site',
          { lifts: 'fixed', words: 'Until it answers again.' },
        ),
      ];
      if (!renewed)
        notices.push(
          notice(
            {
              id: 'cert-ending-4',
              tone: 'warn',
              icon: 'certificate',
              title: 'The certificate for cloud.example.com ends in 9 days',
              detail: 'Nginx Proxy Manager usually renews it by now, so its renewal may be failing.',
              link: {
                kind: 'ask',
                label: 'Look into it',
                question: 'Why isn’t Nginx Proxy Manager renewing the certificate for cloud.example.com?',
              },
              action: renew,
            },
            'problem',
            'nginx_proxy_manager.cert',
            { lifts: 'newer', words: 'Until it’s renewed.' },
          ),
        );
      return {
        ...head(
          'connection:con_nginx-proxy-manager',
          'nginx_proxy_manager',
          'Nginx Proxy Manager',
          'warn',
          'nas.example.com not answering',
          [
            [{ text: 'Nginx Proxy Manager ' }, { text: '2.16.0', strong: true }],
            [
              { text: '6 proxy hosts', strong: true },
              { text: ' · ' },
              { text: '1 redirect', strong: true },
              { text: ' · ' },
              { text: '1 stream', strong: true },
            ],
          ],
          '10.100.0.20:81',
          [
            ...summary([
              ...worth(notices),
              {
                kind: 'list',
                id: 'answering',
                place: 'chart',
                span: 2,
                title: 'Sites now',
                meta: '1 of 6 not answering',
                items: live,
                empty: 'No sites in Nginx Proxy Manager yet.',
              },
              {
                kind: 'list',
                id: 'inventory',
                place: 'chart',
                span: 1,
                look: 'counts',
                title: 'In the proxy',
                items: [
                  {
                    id: 'proxy-hosts',
                    title: 'Proxy hosts',
                    icon: 'network',
                    detail: '1 switched off',
                    right: '6',
                    figure: { value: '6', note: '+1 this week', tone: 'ok' },
                    url: `${NPM}/nginx/proxy`,
                  },
                  {
                    id: 'redirects',
                    title: 'Redirects',
                    icon: 'network',
                    right: '1',
                    figure: { value: '1' },
                    url: `${NPM}/nginx/redirection`,
                  },
                  {
                    id: 'streams',
                    title: 'Streams',
                    icon: 'network',
                    right: '1',
                    figure: { value: '1' },
                    url: `${NPM}/nginx/stream`,
                  },
                  {
                    id: 'certificates',
                    title: 'Certificates',
                    icon: 'certificate',
                    right: '5',
                    figure: renewed
                      ? { value: '5', note: 'All valid', tone: 'ok' }
                      : { value: '5', note: '1 ending soon', tone: 'warn' },
                    url: `${NPM}/nginx/certificates`,
                  },
                ],
              },
              machine(3, [{ id: 'npm-version', label: 'Nginx Proxy Manager', value: '2.16.0', pct: null }]),
            ]),
            {
              key: 'sites',
              label: 'Sites',
              count: rows.length,
              panels: [
                {
                  kind: 'table',
                  id: 'sites',
                  title: 'Sites',
                  meta: '1 not answering',
                  columns: [
                    { key: 'site', label: 'Site' },
                    { key: 'target', label: 'Forwards to' },
                    { key: 'certificate', label: 'Certificate' },
                    { key: 'answering', label: 'Answering' },
                    { key: 'renew', label: '' },
                  ],
                  rows,
                },
              ],
            },
          ],
        ),
      };
    };
    return {
      page,
      row: () => ({
        line: '6 sites',
        facts: [
          { label: 'Sites', value: '6' },
          { label: 'Ending soon', value: renewed ? '0' : '1' },
        ],
        reason: 'nas.example.com not answering',
      }),
      action: ({ action, target }) => {
        if (action !== 'renew' || target !== '4' || renewed) return null;
        renewed = true;
        return {
          message: 'Renewed the certificate for cloud.example.com, good until 2 Feb.',
          recorded: true,
        };
      },
      checks: [
        { check: 'nginx_proxy_manager.cert', name: 'Certificates ending', nature: 'problem', perItem: true },
        { check: 'nginx_proxy_manager.site', name: 'Sites not answering', nature: 'problem', perItem: true },
        { check: 'nginx_proxy_manager.config', name: 'Config errors', nature: 'problem', perItem: true },
        {
          check: 'nginx_proxy_manager.switched_off',
          name: 'Switched-off sites',
          nature: 'fyi',
          perItem: false,
        },
      ],
    };
  },
};

/* Portainer ---------------------------------------------------------------------------------------------------------- */

const PORTAINER = 'https://10.100.0.20:9443';

/** [name, stack, state, health, image] */
const CONTAINERS: [string, string | null, 'running' | 'exited', 'healthy' | 'unhealthy' | null, string][] = [
  ['grafana', 'monitoring', 'running', 'unhealthy', 'grafana/grafana:13.3.0'],
  ['nextcloud-cron', 'nextcloud', 'exited', null, 'nextcloud:31-apache'],
  ['prometheus', 'monitoring', 'running', 'healthy', 'prom/prometheus:v3.7.0'],
  ['nextcloud-app', 'nextcloud', 'running', 'healthy', 'nextcloud:31-apache'],
  ['nextcloud-db', 'nextcloud', 'running', 'healthy', 'mariadb:11.8'],
  ['jellyfin', 'media', 'running', 'healthy', 'jellyfin/jellyfin:10.11'],
  ['sonarr', 'media', 'running', null, 'linuxserver/sonarr:4.0.16'],
  ['radarr', 'media', 'running', null, 'linuxserver/radarr:6.0.4'],
  ['sabnzbd', 'media', 'running', null, 'linuxserver/sabnzbd:4.5.3'],
  ['homeassistant', 'home', 'running', 'healthy', 'ghcr.io/home-assistant/home-assistant:2026.10'],
  ['mosquitto', 'home', 'running', null, 'eclipse-mosquitto:2.0'],
  ['portainer', null, 'running', null, 'portainer/portainer-ce:2.45.3'],
  ['watchtower', null, 'exited', null, 'containrrr/watchtower:latest'],
  ['nginx-proxy-manager', null, 'running', null, 'jc21/nginx-proxy-manager:2.16.0'],
];

const portainer: FixtureServicePage = {
  thing: 'connection:con_portainer',
  catalogId: 'portainer',
  name: 'Portainer',
  fields: { url: PORTAINER },
  make: (ctx) => {
    const { button, notice, worth, machine, head } = kit(ctx);
    const restarted = new Set<string>();
    const health = (name: string, h: string | null) =>
      restarted.has(name) && h === 'unhealthy' ? 'healthy' : h;
    const restart = (name: string) =>
      button({
        action: 'restart',
        target: `1:${name}`,
        label: 'Restart',
        icon: 'restart',
        confirm: {
          title: `Restart ${name}?`,
          body: 'It stops and starts again; what it serves is away for a moment.',
          button: 'Restart',
        },
      });
    const stackRow = (
      id: string,
      title: string,
      sub: string,
      of: (typeof CONTAINERS)[number][],
    ): ThingGalleryItem => {
      const running = of.filter((c) => c[2] === 'running').length;
      const sick = of.filter((c) => health(c[0], c[3]) === 'unhealthy').length;
      const stopped = of.length - running;
      return {
        id,
        title,
        sub,
        ...(sick
          ? { badge: { text: 'Unhealthy', tone: 'bad' as const } }
          : stopped
            ? { badge: { text: `${stopped} stopped`, tone: 'warn' as const } }
            : {}),
        progress: running / of.length,
        note: `${running} of ${of.length} running`,
      };
    };
    const page = (): ThingPage => {
      const inStack = (s: string) => CONTAINERS.filter((c) => c[1] === s);
      const stacks: ThingGalleryItem[] = [
        stackRow('stack-1-monitoring', 'monitoring', '2 containers', inStack('monitoring')),
        stackRow('stack-1-nextcloud', 'nextcloud', '3 containers', inStack('nextcloud')),
        stackRow('stack-1-home', 'home', '2 containers', inStack('home')),
        stackRow('stack-1-media', 'media', '4 containers', inStack('media')),
        stackRow(
          'other',
          'Other containers',
          'Not in a stack',
          CONTAINERS.filter((c) => !c[1]),
        ),
      ];
      // Problems first, as the server sorts them.
      if (restarted.has('grafana')) stacks.push(stacks.shift() as ThingGalleryItem);
      const sick = CONTAINERS.filter((c) => health(c[0], c[3]) === 'unhealthy').length;
      const rows: ThingPageRow[] = CONTAINERS.map(([name, stack, state, h, image]) => {
        const now = health(name, h);
        return {
          id: `1:${name}`,
          cells: {
            name: { text: name, ...(stack ? { note: stack } : {}) },
            state: state === 'running' ? { text: 'Running', dot: 'ok' } : { text: 'Stopped', dot: 'off' },
            health:
              now === 'unhealthy'
                ? { text: 'Unhealthy', tone: 'bad' }
                : now === 'healthy'
                  ? { text: 'Healthy', tone: 'ok' }
                  : { text: '—', tone: 'muted' },
            image: { text: image, mono: true },
            restart: { text: 'Restart', action: restart(name) },
          },
        };
      });
      const notices: ThingPageNotice[] = [];
      if (sick)
        notices.push(
          notice(
            {
              id: 'unhealthy-1-grafana',
              tone: 'bad',
              icon: 'warn',
              title: 'grafana is unhealthy',
              detail: 'It fails its health check.',
              link: {
                kind: 'ask',
                label: 'Look into it',
                question: 'Why is the container grafana unhealthy?',
              },
              action: restart('grafana'),
            },
            'problem',
            'portainer.unhealthy',
            { lifts: 'fixed', words: 'Until it’s healthy again.' },
          ),
        );
      notices.push(
        notice(
          {
            id: 'stopped-1-nextcloud-cron',
            tone: 'warn',
            icon: 'power',
            title: 'nextcloud-cron has stopped in nextcloud',
            detail: 'It exited with an error (code 1).',
            link: {
              kind: 'ask',
              label: 'Look into it',
              question: 'Why did the container nextcloud-cron stop in nextcloud?',
            },
          },
          'problem',
          'portainer.stopped',
          { lifts: 'fixed', words: 'Until it’s running again.' },
        ),
      );
      return head(
        'connection:con_portainer',
        'portainer',
        'Portainer',
        sick ? 'bad' : 'warn',
        sick ? 'grafana unhealthy' : 'nextcloud-cron stopped',
        [
          [{ text: 'Portainer ' }, { text: '2.45.3', strong: true }],
          [{ text: '1 environment', strong: true }, { text: ' · ' }, { text: '4 stacks', strong: true }],
        ],
        '10.100.0.20:9443',
        summary([
          ...worth(notices),
          {
            kind: 'gallery',
            id: 'stacks',
            place: 'chart',
            span: 2,
            look: 'rows',
            title: 'Stacks now',
            meta: '4 stacks · 12 of 14 containers run',
            shape: 'square',
            items: stacks,
            empty: 'No stacks yet.',
          },
          {
            kind: 'list',
            id: 'inventory',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'In Portainer',
            items: [
              {
                id: 'containers',
                title: 'Containers',
                icon: 'device',
                detail: '12 running',
                right: '14',
                figure: sick
                  ? { value: '14', note: '1 unhealthy', tone: 'bad' }
                  : { value: '14', note: '2 stopped' },
                url: PORTAINER,
              },
              {
                id: 'images',
                title: 'Images',
                icon: 'disk',
                right: '23',
                figure: { value: '23' },
                url: PORTAINER,
              },
              {
                id: 'volumes',
                title: 'Volumes',
                icon: 'database',
                right: '17',
                figure: { value: '17' },
                url: PORTAINER,
              },
              {
                id: 'environments',
                title: 'Environments',
                icon: 'network',
                right: '1',
                figure: { value: '1', note: 'All up', tone: 'ok' },
                url: PORTAINER,
              },
            ],
          },
          machine(3, [
            {
              id: 'portainer-version',
              label: 'Portainer',
              note: 'CE · LTS',
              value: '2.45.3',
              pct: null,
              sub: 'Up to date',
              subTone: 'ok',
            },
            { id: 'docker-version', label: 'Docker', value: '29.9.2', pct: null },
          ]),
          {
            kind: 'table',
            id: 'containers',
            place: 'main',
            title: 'Containers',
            meta: '14 containers',
            columns: [
              { key: 'name', label: 'Container' },
              { key: 'state', label: 'State' },
              { key: 'health', label: 'Health' },
              { key: 'image', label: 'Image' },
              { key: 'restart', label: '' },
            ],
            rows,
            empty: 'No containers yet.',
          },
        ]),
      );
    };
    return {
      page,
      row: () => ({
        line: '14 containers',
        facts: [
          { label: 'Running', value: '12' },
          { label: 'Unhealthy', value: restarted.has('grafana') ? '0' : '1' },
        ],
        reason: restarted.has('grafana') ? 'nextcloud-cron stopped' : 'grafana unhealthy',
      }),
      action: ({ action, target }) => {
        const name = target?.slice('1:'.length);
        if (action !== 'restart' || !name || !CONTAINERS.some((c) => c[0] === name)) return null;
        restarted.add(name);
        return { message: `Restarted ${name}.`, recorded: true };
      },
      checks: [
        { check: 'portainer.env_down', name: 'Environments going down', nature: 'problem', perItem: true },
        { check: 'portainer.unhealthy', name: 'Unhealthy containers', nature: 'problem', perItem: true },
        {
          check: 'portainer.stopped',
          name: 'Containers stopping in a stack',
          nature: 'problem',
          perItem: true,
        },
        { check: 'portainer.images', name: 'Newer images', nature: 'fyi', perItem: false },
        { check: 'portainer.updates', name: 'Portainer updates', nature: 'fyi', perItem: false },
      ],
    };
  },
};

/* Pterodactyl -------------------------------------------------------------------------------------------------------- */

const PANEL = 'https://games.example.com';

const pterodactyl: FixtureServicePage = {
  thing: 'connection:con_pterodactyl',
  catalogId: 'pterodactyl',
  name: 'Pterodactyl',
  fields: { url: PANEL },
  make: (ctx) => {
    const { button, notice, worth, machine, head } = kit(ctx);
    let terrariaOn = false;
    const power = (id: string, name: string, on: boolean): ThingPageButton[] =>
      on
        ? [
            button({
              action: 'restart',
              target: id,
              label: 'Restart',
              icon: 'restart',
              confirm: {
                title: `Restart ${name}?`,
                body: 'Players are disconnected while it restarts; it’s usually back within a minute or two.',
                button: 'Restart',
              },
            }),
            button({
              action: 'stop',
              target: id,
              label: 'Stop',
              icon: 'stop',
              tone: 'danger',
              confirm: {
                title: `Stop ${name}?`,
                body: 'Players are disconnected and it stays off until someone starts it again.',
                button: 'Stop',
              },
            }),
          ]
        : [button({ action: 'start', target: id, label: 'Start', icon: 'play', tone: 'primary' })];
    const page = (): ThingPage => {
      const servers: ThingGalleryItem[] = [
        {
          id: '1a7ce997',
          title: 'Minecraft',
          sub: 'Node 1 · up 2 days',
          progress: 0.62,
          note: '2.7 GB of 4.3 GB',
          noteEnd: '38 % CPU',
          actions: power('1a7ce997', 'Minecraft', true),
        },
        {
          id: '5b3c8f21',
          title: 'Valheim',
          sub: 'Node 1 · up 6 h',
          progress: 0.41,
          note: '3.5 GB of 8.6 GB',
          noteEnd: '61 % CPU',
          actions: power('5b3c8f21', 'Valheim', true),
        },
        terrariaOn
          ? {
              id: '9d0e4a77',
              title: 'Terraria',
              sub: 'Node 1',
              badge: { text: 'Starting', tone: 'warn' },
              progress: 0.08,
              note: '86 MB of 1.1 GB',
              noteEnd: '12 % CPU',
              actions: power('9d0e4a77', 'Terraria', true),
            }
          : {
              id: '9d0e4a77',
              title: 'Terraria',
              sub: 'Node 1',
              badge: { text: 'Offline', tone: 'warn' },
              paused: true,
              actions: power('9d0e4a77', 'Terraria', false),
            },
        {
          id: 'c4f2aa10',
          title: 'Old Rust',
          sub: 'Node 1',
          badge: { text: 'Suspended', tone: 'bad' },
          paused: true,
        },
      ];
      const rows: ThingPageRow[] = [
        ['c4f2aa10', 'Old Rust', 'Suspended', 'bad', '—', '—', '—'],
        ['1a7ce997', 'Minecraft', 'Running', 'ok', '38 %', '2.7 GB', '5 GB'],
        ['5b3c8f21', 'Valheim', 'Running', 'ok', '61 %', '3.5 GB', '9.2 GB'],
        [
          '9d0e4a77',
          'Terraria',
          terrariaOn ? 'Starting' : 'Offline',
          terrariaOn ? 'warn' : 'off',
          '—',
          '—',
          '0.4 GB',
        ],
      ].map(([id, name, state, dot, cpu, memory, disk]) => ({
        id: id as string,
        cells: {
          name: { text: name as string, note: 'Node 1' },
          state: { text: state as string, dot: dot as 'ok' },
          cpu: { text: cpu as string, mono: true },
          memory: { text: memory as string, mono: true },
          disk: { text: disk as string, mono: true },
        },
      }));
      return head(
        'connection:con_pterodactyl',
        'pterodactyl',
        'Pterodactyl',
        'warn',
        'Old Rust suspended',
        [[{ text: '4 game servers', strong: true }]],
        'games.example.com',
        [
          ...summary([
            ...worth([
              notice(
                {
                  id: 'suspended-c4f2aa10',
                  tone: 'warn',
                  icon: 'power',
                  title: 'Old Rust is suspended',
                  detail: 'It can’t start until an administrator lifts the suspension.',
                  link: { kind: 'url', label: 'Open the panel', url: PANEL },
                },
                'you',
                'pterodactyl.suspended',
                { lifts: 'fixed', words: 'Until it’s unsuspended.' },
              ),
            ]),
            {
              kind: 'gallery',
              id: 'servers',
              place: 'chart',
              span: 2,
              look: 'rows',
              title: 'Game servers',
              meta: terrariaOn ? '3 of 4 running' : '2 of 4 running',
              shape: 'square',
              items: servers,
              empty: 'No game servers this key can see.',
            },
            {
              kind: 'list',
              id: 'inventory',
              place: 'chart',
              span: 1,
              look: 'counts',
              title: 'In the panel',
              items: [
                {
                  id: 'game-servers',
                  title: 'Game servers',
                  icon: 'power',
                  detail: terrariaOn ? '3 running' : '2 running',
                  right: '4',
                  figure: { value: '4', note: '1 suspended', tone: 'warn' },
                },
                {
                  id: 'cpu',
                  title: 'CPU',
                  icon: 'device',
                  right: '99 %',
                  figure: { value: '99 %', note: 'of 700 % allowed' },
                },
                {
                  id: 'memory',
                  title: 'Memory',
                  icon: 'device',
                  right: '6.2 GB',
                  figure: { value: '6.2 GB', note: 'of 14 GB' },
                },
                {
                  id: 'disk',
                  title: 'Disk',
                  icon: 'disk',
                  right: '15 GB',
                  figure: { value: '15 GB', note: 'of 34 GB' },
                },
              ],
            },
            machine(3, []),
          ]),
          {
            key: 'servers',
            label: 'Game servers',
            count: 4,
            panels: [
              {
                kind: 'table',
                id: 'all-servers',
                title: 'Game servers',
                meta: terrariaOn ? '3 running' : '2 running',
                columns: [
                  { key: 'name', label: 'Server' },
                  { key: 'state', label: 'State' },
                  { key: 'cpu', label: 'CPU', numeric: true },
                  { key: 'memory', label: 'Memory', numeric: true },
                  { key: 'disk', label: 'Disk', numeric: true },
                ],
                rows,
              },
            ],
          },
        ],
        'Open the panel',
      );
    };
    return {
      page,
      row: () => ({
        line: '4 game servers',
        facts: [{ label: 'Running', value: terrariaOn ? '3' : '2', note: 'of 4' }],
        reason: 'Old Rust suspended',
      }),
      action: ({ action, target }) => {
        const names: Record<string, string> = { '1a7ce997': 'Minecraft', '5b3c8f21': 'Valheim' };
        const name = target ? names[target] : undefined;
        if (name)
          return action === 'restart' || action === 'stop'
            ? { message: `${action === 'stop' ? 'Stopping' : 'Restarting'} ${name}.` }
            : null;
        if (target !== '9d0e4a77') return null;
        if (action === 'start' && !terrariaOn) {
          terrariaOn = true;
          return { message: 'Starting Terraria.', recorded: true };
        }
        if (action === 'stop' && terrariaOn) {
          terrariaOn = false;
          return { message: 'Stopping Terraria.', recorded: true };
        }
        return null;
      },
      checks: [
        {
          check: 'pterodactyl.stopped',
          name: 'Game servers stopping on their own',
          nature: 'problem',
          perItem: true,
        },
        { check: 'pterodactyl.suspended', name: 'Suspended game servers', nature: 'you', perItem: true },
        { check: 'pterodactyl.install', name: 'Failed installs', nature: 'you', perItem: true },
        { check: 'pterodactyl.disk', name: 'Game server disks filling up', nature: 'problem', perItem: true },
      ],
    };
  },
};

export const INFRA_APPS_PAGES: FixtureServicePage[] = [grafana, npm, portainer, pterodactyl];
