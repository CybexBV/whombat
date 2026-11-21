/**
 * Fixture pages of the storage group: TrueNAS, Synology, QNAP and Proxmox Backup Server, their Summary in slots as the
 * server builds it (`apps/server/src/things/kinds/storage/`), rows already packed into three columns. Each entry shows
 * in the web's and the phone's fixture mode at `/things/<thing>` and in the sidebar; its shape and an example are in
 * `types.ts`. Add yours to the list; nothing else needs changing.
 */
import type {
  ThingGalleryItem,
  ThingLine,
  ThingPage,
  ThingPageBar,
  ThingPageButton,
  ThingPageItem,
  ThingPageNotice,
  ThingPagePanel,
} from '@whombat/core/domain';
import { thingHref } from '@whombat/core/domain';
import type { FixtureServiceCtx, FixtureServicePage } from './types.js';

const H = 3_600_000;
const DAY = 24 * H;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LOOK_ONLY = 'Look only: changes are off for this connection.';

/** What every page here is made with: buttons and Worth a look lines as Look only allows them, a head, a week. */
function kit(ctx: FixtureServiceCtx) {
  const button = (b: Omit<ThingPageButton, 'allowed'>): ThingPageButton =>
    ctx.lookOnly ? { ...b, allowed: false, reason: LOOK_ONLY } : { ...b, allowed: true };
  const notice = (
    n: Omit<ThingPageNotice, 'ignore'>,
    ignore: { lifts: 'fixed' | 'newer' | 'period'; words: string },
  ): ThingPageNotice => ({ ...n, ...(ctx.lookOnly ? {} : { ignore }) });
  const strip = (items: ThingPageNotice[]): ThingPagePanel[] =>
    items.length ? [{ kind: 'notices', id: 'worth', place: 'top', title: 'Worth a look', items }] : [];
  /** The last 7 days, today last: their times and words. */
  const week = () => {
    const at = Array.from({ length: 7 }, (_, i) => new Date(ctx.now() - (6 - i) * DAY));
    return {
      timestamps: at.map((d) => d.toISOString()),
      labels: at.map((d, i) => (i === 6 ? 'Today' : (WEEKDAYS[d.getDay()] ?? ''))),
    };
  };
  const head = (p: {
    thing: `connection:${string}`;
    catalogId: string;
    name: string;
    status: ThingPage['status'];
    badge: string;
    facts: ThingLine[];
    address: string;
    open: { label: string; url: string };
  }): Omit<ThingPage, 'tabs'> => ({
    id: p.thing,
    kind: 'connection',
    connectionId: p.thing.slice('connection:'.length) as ThingPage['connectionId'],
    catalogId: p.catalogId,
    name: p.name,
    icon: p.catalogId,
    status: p.status,
    badge: p.badge,
    facts: p.facts,
    address: p.address,
    open: p.open,
    runsOn: null,
    settings: true,
    actions: [],
    readAt: ctx.ago(20_000),
  });
  const summary = (panels: ThingPagePanel[]) => [{ key: 'overview', label: 'Summary', panels }];
  return { button, notice, strip, week, head, summary };
}

const strong = (lead: string, bold: string, rest = ''): ThingLine => [
  ...(lead ? [{ text: lead }] : []),
  { text: bold, strong: true },
  ...(rest ? [{ text: rest }] : []),
];

/** A line of counts, as `countLine` makes it. */
function count(
  p: Omit<ThingPageItem, 'right' | 'figure'> & {
    value: string;
    note?: string;
    noteTone?: 'ok' | 'warn' | 'bad';
  },
) {
  const { value, note, noteTone, ...rest } = p;
  return {
    ...rest,
    right: value,
    figure: { value, ...(note ? { note } : {}), ...(noteTone ? { tone: noteTone } : {}) },
  } satisfies ThingPageItem;
}

/** A Trend of a week's bars, as `trend` makes it. */
function weekChart(p: {
  week: { timestamps: string[]; labels: string[] };
  title: string;
  meta: string;
  label: string;
  values: number[];
  color: 'violet' | 'green';
  unit?: string;
  figure: { value: string; rest: string };
  change?: string;
  span: 1 | 2 | 3;
}): ThingPagePanel {
  return {
    kind: 'chart',
    id: 'week',
    place: 'chart',
    span: p.span,
    title: p.title,
    meta: p.meta,
    style: 'bars',
    timestamps: p.week.timestamps,
    labels: p.week.labels,
    series: [
      {
        key: 'values',
        label: p.label,
        values: p.values,
        color: p.color,
        ...(p.unit ? { unit: p.unit } : {}),
      },
    ],
    figure: p.figure,
    ...(p.change ? { stats: [[{ text: p.change, strong: true }, { text: ' on last week' }]] } : {}),
    axis: { min: 0 },
  };
}

/** The machine card as the page adds it: a machine Whombat knows (linked), the NAS's own figures, or “… itself”. */
const card = (
  title: string,
  items: ThingPageBar[],
  span: 1 | 2 | 3,
  meta?: string,
  href?: ReturnType<typeof thingHref>,
): ThingPagePanel => ({
  kind: 'bars',
  id: 'machine',
  place: 'chart',
  span,
  title,
  ...(meta ? { meta } : {}),
  ...(meta && href ? { link: { kind: 'href' as const, label: `See ${meta}`.slice(0, 30), href } } : {}),
  items,
});

/* TrueNAS ------------------------------------------------------------------------------------------------------------ */

const TRUENAS = 'https://10.100.0.30';

const truenas: FixtureServicePage = {
  thing: 'connection:con_truenas',
  catalogId: 'truenas',
  name: 'TrueNAS',
  fields: { url: TRUENAS },
  make(ctx) {
    const { button, notice, strip, week, head, summary } = kit(ctx);
    let immichStarted = false;
    let fastChecking = false;
    const app = (
      name: string,
      version: string,
      state: 'Running' | 'Stopped' | 'Crashed',
      update = false,
    ): ThingGalleryItem => ({
      id: `app-${name}`,
      title: name,
      sub: [state === 'Stopped' ? 'Stopped' : null, version, update ? 'Update waiting' : null]
        .filter(Boolean)
        .join(' · '),
      ...(state === 'Crashed' ? { badge: { text: 'Crashed', tone: 'bad' as const } } : {}),
      ...(state === 'Stopped' ? { muted: true } : {}),
      actions: [
        state === 'Running'
          ? button({
              action: 'stop',
              target: name,
              label: 'Stop',
              icon: 'stop',
              tone: 'danger',
              confirm: {
                title: `Stop ${name}?`,
                body: 'The app stops until someone starts it again. Anyone using it loses it meanwhile.',
                button: 'Stop',
              },
            })
          : button({ action: 'start', target: name, label: 'Start', icon: 'play' }),
      ],
      url: `${TRUENAS}/ui/apps/installed`,
    });
    const checkNow = (pool: string) =>
      button({
        action: 'scrub',
        target: pool,
        label: 'Check now',
        icon: 'check',
        confirm: {
          title: `Check ${pool} for damage now?`,
          body: 'TrueNAS reads all its data and repairs what it can. It takes hours on a big pool and slows it down meanwhile.',
          button: 'Check now',
        },
      });
    return {
      page() {
        const notices = [
          notice(
            {
              id: 'full-fast',
              tone: 'warn',
              icon: 'disk',
              title: 'fast is 90 % full',
              detail: '1.8 of 2.0 TB used.',
              link: {
                kind: 'ask',
                label: 'Look into it',
                question: 'What is taking the space on fast on TrueNAS?',
              },
              nature: 'problem',
              check: 'truenas.pool_full',
              subject: { id: 'pool:fast', name: 'fast' },
            },
            { lifts: 'fixed', words: 'Until it gets fuller.' },
          ),
          ...(immichStarted
            ? []
            : [
                notice(
                  {
                    id: 'crashed-immich',
                    tone: 'warn',
                    icon: 'power',
                    title: 'immich crashed',
                    detail: 'It stopped on its own 2 h ago.',
                    action: button({ action: 'start', target: 'immich', label: 'Start', icon: 'play' }),
                    nature: 'you',
                    check: 'truenas.app_crashed',
                    subject: { id: 'app:immich', name: 'immich' },
                  },
                  { lifts: 'fixed', words: 'Until it’s running again.' },
                ),
              ]),
        ];
        const apps = [
          ...(immichStarted ? [] : [app('immich', '2.1.0', 'Crashed')]),
          app('minio', '2025.4.22', 'Stopped'),
          app('plex', '1.42.2.10156', 'Running', true),
          ...(immichStarted ? [app('immich', '2.1.0', 'Running')] : []),
          app('nextcloud', '31.0.9', 'Running'),
          app('paperless', '2.18.4', 'Running'),
        ];
        const running = immichStarted ? 4 : 3;
        const work: ThingGalleryItem[] = [
          {
            id: 'work-pool-tank',
            title: 'Checking tank for damage',
            sub: 'A scrub reads every block',
            progress: 0.45,
            note: '45 %',
            noteEnd: 'about 2 h left',
            url: `${TRUENAS}/ui/storage`,
          },
          ...(fastChecking
            ? [
                {
                  id: 'work-pool-fast',
                  title: 'Checking fast for damage',
                  sub: 'A scrub reads every block',
                  progress: 0.01,
                  note: '1 %',
                  url: `${TRUENAS}/ui/storage`,
                },
              ]
            : []),
        ];
        const panels: ThingPagePanel[] = [
          ...strip(notices),
          {
            kind: 'gallery',
            id: 'apps',
            place: 'chart',
            span: 2,
            look: 'rows',
            title: 'Apps',
            meta: [
              `${work.length === 1 ? '1 job' : `${work.length} jobs`} running`,
              `${running} of 5 apps running`,
              immichStarted ? null : '1 crashed',
              '1 stopped',
            ]
              .filter(Boolean)
              .join(' · '),
            shape: 'square',
            link: { kind: 'url', label: 'Open apps', url: `${TRUENAS}/ui/apps/installed` },
            items: [...work, ...apps].slice(0, 5),
          },
          {
            kind: 'list',
            id: 'pools',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'Storage',
            meta: '7.2 of 12 TB',
            items: [
              count({
                id: 'pool-tank',
                title: 'tank',
                icon: 'disk',
                detail: 'RAIDZ1 · Checking now',
                value: '54 %',
                note: '4.6 TB free',
                url: `${TRUENAS}/ui/storage`,
              }),
              count({
                id: 'pool-fast',
                title: 'fast',
                icon: 'disk',
                detail: fastChecking ? 'Mirror · 2 disks · Checking now 1 %' : 'Mirror · 2 disks',
                tone: 'warn',
                value: '90 %',
                note: '199 GB free',
                noteTone: 'warn',
                ...(fastChecking ? {} : { actions: [checkNow('fast')] }),
                url: `${TRUENAS}/ui/storage`,
              }),
              count({
                id: 'disks',
                title: 'Disks',
                icon: 'disk',
                value: '6',
                note: 'All fine · warmest 41 °C',
                url: `${TRUENAS}/ui/storage/disks`,
              }),
              count({
                id: 'tasks',
                title: 'Snapshots and copies',
                icon: 'backup',
                value: '5',
                note: 'All OK',
                noteTone: 'ok',
                url: `${TRUENAS}/ui/data-protection`,
              }),
            ],
          },
          weekChart({
            week: week(),
            title: 'Space used',
            meta: 'Full in about 5 months',
            label: 'Added',
            values: [42, 18, 0, 65, 31, 12, 16],
            color: 'violet',
            unit: 'GB',
            figure: { value: '+184 GB', rest: 'this week' },
            change: '+12 %',
            span: 1,
          }),
          card(
            'TrueNAS itself',
            [
              {
                id: 'truenas',
                label: 'TrueNAS',
                value: '25.10.1',
                pct: null,
                sub: '25.10.2 is out',
                subTone: 'warn',
              },
              {
                id: 'processor',
                label: 'Processor',
                value: 'AMD Ryzen 7 5700G',
                pct: null,
                sub: '16 threads',
              },
              { id: 'memory', label: 'Memory', value: '64 GB', pct: null, sub: 'ECC' },
              { id: 'up', label: 'Up', value: '12 days', pct: null },
            ],
            2,
          ),
          {
            kind: 'list',
            id: 'tasks',
            place: 'main',
            title: 'Snapshots and copies',
            link: { kind: 'url', label: 'Open TrueNAS', url: `${TRUENAS}/ui/data-protection` },
            items: [
              ['snapshot-1', 'Snapshots of tank/photos', 'OK · 40 min ago'],
              ['snapshot-2', 'Snapshots of tank/docs', 'OK · 40 min ago'],
              ['replication-1', 'Replication tank/photos - offsite', 'OK · 6 h ago'],
              ['cloudsync-1', 'Cloud sync Photos to B2', 'OK · 18 h ago'],
              ['cloudbackup-1', 'Cloud backup Documents', 'OK · 20 h ago'],
            ].map(([id, title, detail]) => ({
              id: id as string,
              title: title as string,
              detail: detail as string,
              tone: 'ok' as const,
              icon: 'backup' as const,
            })),
          },
          {
            kind: 'table',
            id: 'disks',
            place: 'main',
            title: 'Disks',
            meta: '6 disks',
            columns: [
              { key: 'disk', label: 'Disk' },
              { key: 'pool', label: 'Pool' },
              { key: 'size', label: 'Size', numeric: true },
              { key: 'temp', label: 'Temperature', numeric: true },
            ],
            rows: [
              ['nvme0n1', 'Samsung 990 PRO', 'fast', '1.0 TB', '41 °C'],
              ['nvme1n1', 'Samsung 990 PRO', 'fast', '1.0 TB', '39 °C'],
              ['sda', 'WDC WD80EFZZ', 'tank', '8.0 TB', '34 °C'],
              ['sdb', 'WDC WD80EFZZ', 'tank', '8.0 TB', '35 °C'],
              ['sdc', 'WDC WD80EFZZ', 'tank', '8.0 TB', '36 °C'],
              ['sdd', 'WDC WD80EFZZ', 'tank', '8.0 TB', '35 °C'],
            ].map(([disk, model, pool, size, temp]) => ({
              id: disk as string,
              cells: {
                disk: { text: disk as string, mono: true, note: model as string },
                pool: { text: pool as string },
                size: { text: size as string, mono: true },
                temp: { text: temp as string, mono: true },
              },
            })),
          },
        ];
        return {
          ...head({
            thing: 'connection:con_truenas',
            catalogId: 'truenas',
            name: 'TrueNAS',
            status: 'warn',
            badge: 'fast is 90 % full',
            facts: [strong('TrueNAS ', '25.10.1'), strong('', 'nas')],
            address: '10.100.0.30',
            open: { label: 'Open TrueNAS', url: TRUENAS },
          }),
          refreshS: 30,
          tabs: summary(panels),
        };
      },
      row: () => ({
        line: 'NAS · TrueNAS 25.10.1',
        facts: [
          { label: 'Pools', value: '2 healthy' },
          { label: 'Alerts', value: immichStarted ? 'None' : '1' },
        ],
        reason: 'fast is 90 % full',
      }),
      action({ action, target }) {
        if (action === 'start' && target === 'immich' && !immichStarted) {
          immichStarted = true;
          return { message: 'Starting immich.', recorded: true };
        }
        if (action === 'scrub' && target === 'fast' && !fastChecking) {
          fastChecking = true;
          return {
            message: 'Scrubbing fast. It takes a while; the page shows how far it is.',
            recorded: true,
          };
        }
        if (action === 'stop' || action === 'start')
          return { message: `${action === 'stop' ? 'Stopping' : 'Starting'} ${target}.`, recorded: true };
        return null;
      },
      checks: [
        { check: 'truenas.pool', name: 'Pools not healthy', nature: 'problem', perItem: true },
        { check: 'truenas.pool_full', name: 'Pools filling up', nature: 'problem', perItem: true },
        { check: 'truenas.task', name: 'Snapshot and copy tasks', nature: 'problem', perItem: true },
        { check: 'truenas.app_crashed', name: 'Apps that crash', nature: 'you', perItem: true },
        { check: 'truenas.update', name: 'TrueNAS updates', nature: 'fyi', perItem: false },
      ],
    };
  },
};

/* Synology ----------------------------------------------------------------------------------------------------------- */

const DSM = 'https://10.100.0.31:5001';

const synology: FixtureServicePage = {
  thing: 'connection:con_synology',
  catalogId: 'synology',
  name: 'Synology',
  fields: { url: DSM },
  make(ctx) {
    const { notice, strip, week, head, summary } = kit(ctx);
    return {
      page() {
        const notices = [
          notice(
            {
              id: 'backup-3',
              tone: 'bad',
              icon: 'backup',
              title: 'Photos offsite failed',
              detail: 'Hyper Backup couldn’t reach the other NAS last night.',
              link: {
                kind: 'ask',
                label: 'Look into it',
                question: 'Why did the Hyper Backup task Photos offsite fail?',
              },
              nature: 'problem',
              check: 'synology.backup_failed',
              subject: { id: 'backup:3', name: 'Photos offsite' },
            },
            { lifts: 'newer', words: 'Until the next backup.' },
          ),
        ];
        const task = (
          id: string,
          title: string,
          sub: string,
          note: string,
          next: string,
          badge?: ThingGalleryItem['badge'],
        ): ThingGalleryItem => ({
          id: `task-${id}`,
          title,
          sub,
          ...(badge ? { badge } : {}),
          note,
          noteEnd: `Next ${next}`,
          url: DSM,
        });
        const panels: ThingPagePanel[] = [
          ...strip(notices),
          {
            kind: 'gallery',
            id: 'backups',
            place: 'chart',
            span: 2,
            look: 'rows',
            title: 'Hyper Backup',
            meta: '3 tasks · last ran 5 h ago',
            shape: 'square',
            items: [
              task('1', 'To C2', 'To the cloud', 'Backed up 5 h ago', 'tomorrow 03:00'),
              task('2', 'To USB', 'To a local folder or USB disk', 'Backed up 2 days ago', 'Sat 03:00'),
              task('3', 'Photos offsite', 'To another NAS', 'Ran 3 h ago', 'tomorrow 05:00', {
                text: 'Failed',
                tone: 'bad',
              }),
            ],
            empty: 'No backup task is set up in Hyper Backup.',
          },
          {
            kind: 'list',
            id: 'storage',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'Storage',
            meta: '6.3 of 11 TB',
            items: [
              count({
                id: 'volume-volume_1',
                title: 'Volume 1 · Photos',
                icon: 'disk',
                detail: 'SHR · Btrfs · Healthy',
                value: '64 %',
                note: '2.8 TB free',
                url: DSM,
              }),
              count({
                id: 'volume-volume_2',
                title: 'Volume 2 · Media',
                icon: 'disk',
                detail: 'SHR · Btrfs · Healthy',
                value: '38 %',
                note: '2.4 TB free',
                url: DSM,
              }),
              count({
                id: 'disks',
                title: 'Disks',
                icon: 'disk',
                value: '4',
                note: 'All fine · warmest 37 °C',
                url: DSM,
              }),
            ],
          },
          weekChart({
            week: week(),
            title: 'Space used',
            meta: 'All volumes',
            label: 'Added',
            values: [3.1, 0.4, 12, 2.2, 0, 41, 6.5],
            color: 'violet',
            unit: 'GB',
            figure: { value: '+65 GB', rest: 'this week' },
            span: 1,
          }),
          card(
            'Synology itself',
            [
              {
                id: 'dsm',
                label: 'DSM',
                value: '7.2.2-72806 Update 3',
                pct: null,
                sub: 'Up to date',
                subTone: 'ok',
              },
              { id: 'temperature', label: 'Temperature', value: '45 °C', pct: null },
              { id: 'security', label: 'Security Advisor', value: 'No risks', pct: null },
              { id: 'memory', label: 'Memory', value: '20 GB', pct: null },
              { id: 'up', label: 'Up', value: '22 days', pct: null },
            ],
            2,
          ),
          {
            kind: 'table',
            id: 'disks',
            place: 'main',
            title: 'Disks',
            meta: '4 disks',
            columns: [
              { key: 'disk', label: 'Disk' },
              { key: 'health', label: 'Health' },
              { key: 'size', label: 'Size', numeric: true },
              { key: 'temp', label: 'Temperature', numeric: true },
            ],
            rows: [1, 2, 3, 4].map((n) => ({
              id: `sata${n}`,
              cells: {
                disk: { text: `Drive ${n}`, note: 'Synology HAT5300-4T' },
                health: { text: 'Healthy', dot: 'ok' as const },
                size: { text: '4.0 TB', mono: true },
                temp: { text: `${33 + n} °C`, mono: true },
              },
            })),
          },
        ];
        return {
          ...head({
            thing: 'connection:con_synology',
            catalogId: 'synology',
            name: 'Synology',
            status: 'bad',
            badge: 'Photos offsite failed',
            facts: [
              [
                { text: 'DS920+', strong: true },
                { text: ' · DSM ' },
                { text: '7.2.2-72806 Update 3', strong: true },
              ],
              strong('Up ', '22 days'),
            ],
            address: '10.100.0.31:5001',
            open: { label: 'Open DSM', url: DSM },
          }),
          tabs: summary(panels),
        };
      },
      row: () => ({
        line: 'NAS · DSM 7.2.2-72806 Update 3',
        facts: [
          { label: 'Volumes', value: '2 healthy' },
          { label: 'Last backup', value: 'Failed' },
        ],
        reason: 'Photos offsite failed',
      }),
      checks: [
        { check: 'synology.storage', name: 'Storage pools and volumes', nature: 'problem', perItem: true },
        { check: 'synology.volume_full', name: 'Volumes filling up', nature: 'problem', perItem: true },
        { check: 'synology.backup_failed', name: 'Hyper Backup failing', nature: 'problem', perItem: true },
        { check: 'synology.update', name: 'DSM updates', nature: 'fyi', perItem: false },
      ],
    };
  },
};

/* QNAP --------------------------------------------------------------------------------------------------------------- */

const QTS = 'https://10.100.0.32';

const qnap: FixtureServicePage = {
  thing: 'connection:con_qnap',
  catalogId: 'qnap',
  name: 'QNAP',
  fields: { url: QTS },
  make(ctx) {
    const { notice, strip, week, head, summary } = kit(ctx);
    return {
      page() {
        const notices = [
          notice(
            {
              id: 'full-2',
              tone: 'warn',
              icon: 'disk',
              title: 'Backups is 92 % full',
              detail: '3.5 of 3.8 TB used.',
              link: {
                kind: 'ask',
                label: 'Look into it',
                question: 'What is taking the space on Backups on the QNAP?',
              },
              nature: 'problem',
              check: 'qnap.volume_full',
              subject: { id: 'volume:2', name: 'Backups' },
            },
            { lifts: 'fixed', words: 'Until it gets fuller.' },
          ),
        ];
        const panels: ThingPagePanel[] = [
          ...strip(notices),
          {
            kind: 'list',
            id: 'volumes',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'Storage',
            meta: '8.4 of 11 TB',
            items: [
              count({
                id: 'volume-1',
                title: 'DataVol1',
                icon: 'disk',
                detail: '4.8 of 7.7 TB',
                value: '63 %',
                note: '2.8 TB free',
                url: QTS,
              }),
              count({
                id: 'volume-2',
                title: 'Backups',
                icon: 'disk',
                detail: '3.5 of 3.8 TB',
                tone: 'warn',
                value: '92 %',
                note: '306 GB free',
                noteTone: 'warn',
                url: QTS,
              }),
              count({
                id: 'disks',
                title: 'Disks',
                icon: 'disk',
                value: '3',
                note: 'All fine · warmest 38 °C',
                url: QTS,
              }),
            ],
          },
          weekChart({
            week: week(),
            title: 'Space used',
            meta: 'Full about 18 Dec',
            label: 'Added',
            values: [21, 19, 22, 20, 24, 18, 23],
            color: 'violet',
            unit: 'GB',
            figure: { value: '+147 GB', rest: 'this week' },
            change: '+4 %',
            span: 1,
          }),
          card(
            'The machine',
            [
              { id: 'cpu', label: 'Processor', value: '7 %', pct: 0.07 },
              { id: 'memory', label: 'Memory', value: '2.7 of 7.7 GB', pct: 0.35 },
              { id: 'qts', label: 'QTS', value: '5.2.1', pct: null, sub: 'Build 20240902' },
              { id: 'temperature', label: 'Temperature', value: '41 °C', pct: null, sub: 'Processor 52 °C' },
              { id: 'health', label: 'System health', value: 'Good', pct: null },
              { id: 'up', label: 'Up', value: '12 days', pct: null },
            ],
            1,
            'NAS-Home',
          ),
          {
            kind: 'table',
            id: 'disks',
            place: 'main',
            title: 'Disks',
            meta: '3 disks',
            columns: [
              { key: 'disk', label: 'Disk' },
              { key: 'health', label: 'Health' },
              { key: 'size', label: 'Size', numeric: true },
              { key: 'temp', label: 'Temperature', numeric: true },
            ],
            rows: [
              ['1', 'Disk 1', 'WDC WD40EFRX', '4.00 TB', '34 °C'],
              ['2', 'Disk 2', 'WDC WD40EFRX', '4.00 TB', '36 °C'],
              ['3', 'Disk 3', 'Seagate IronWolf', '4.00 TB', '38 °C'],
            ].map(([id, disk, model, size, temp]) => ({
              id: id as string,
              cells: {
                disk: { text: disk as string, note: model as string },
                health: { text: 'OK', dot: 'ok' as const },
                size: { text: size as string, mono: true },
                temp: { text: temp as string, mono: true },
              },
            })),
          },
        ];
        return {
          ...head({
            thing: 'connection:con_qnap',
            catalogId: 'qnap',
            name: 'QNAP',
            status: 'warn',
            badge: 'Backups is 92 % full',
            facts: [
              [{ text: 'TS-453D', strong: true }, { text: ' · QTS ' }, { text: '5.2.1', strong: true }],
              strong('', 'NAS-Home'),
            ],
            address: '10.100.0.32',
            open: { label: 'Open QTS', url: QTS },
          }),
          tabs: summary(panels),
        };
      },
      row: () => ({
        line: 'NAS · QTS 5.2.1',
        facts: [
          { label: 'Volumes', value: '2' },
          { label: 'Disks', value: '3 healthy' },
        ],
        reason: 'Backups is 92 % full',
      }),
      checks: [
        { check: 'qnap.volume_full', name: 'Volumes filling up', nature: 'problem', perItem: true },
        { check: 'qnap.disk', name: 'Disk health', nature: 'you', perItem: true },
        { check: 'qnap.disk_temp', name: 'Disks running hot', nature: 'you', perItem: true },
      ],
    };
  },
};

/* Proxmox Backup Server ---------------------------------------------------------------------------------------------- */

const PBS = 'https://10.100.0.33:8007';

const pbs: FixtureServicePage = {
  thing: 'connection:con_pbs',
  catalogId: 'proxmox_backup',
  name: 'Backups',
  fields: { url: PBS },
  make(ctx) {
    const { button, notice, strip, week, head, summary } = kit(ctx);
    let verified = false;
    const job = (
      id: string,
      title: string,
      detail: string,
      action?: ThingPageButton,
      tone?: 'bad',
    ): ThingPageItem => ({
      id,
      title,
      detail,
      icon: 'backup',
      ...(tone ? { tone } : {}),
      ...(action ? { actions: [action] } : {}),
    });
    const verify = (id: string, store: string) =>
      button({
        action: 'verify',
        target: id,
        label: 'Run verify',
        icon: 'check',
        confirm: {
          title: `Run verify job ${id} now?`,
          body: `Proxmox Backup Server reads the backups on ${store} to make sure they can be restored. On a big datastore that takes hours.`,
          button: 'Run verify',
        },
      });
    const cleanup = (store: string) =>
      button({
        action: 'cleanup',
        target: store,
        label: 'Run cleanup',
        icon: 'clean',
        confirm: {
          title: `Clean up ${store} now?`,
          body: 'Garbage collection frees the space that pruned backups left behind. It reads the whole datastore and takes a while; backups keep working.',
          button: 'Run cleanup',
        },
      });
    return {
      page() {
        const notices = [
          notice(
            {
              id: 'late-tank--ct-131',
              tone: 'bad',
              icon: 'backup',
              title: 'mail hasn’t been backed up for 3 days',
              detail: 'Its last two backups failed: connection reset by peer.',
              link: {
                kind: 'ask',
                label: 'Look into it',
                question: 'Why are the backups of mail (CT 131) failing?',
              },
              nature: 'problem',
              check: 'pbs.backup_late',
              subject: { id: 'guest:tank//ct/131', name: 'mail' },
            },
            { lifts: 'newer', words: 'Until the next backup.' },
          ),
        ];
        const guest = (
          id: string,
          name: string,
          note: string,
          last: string,
          size: string,
          kept: string,
          late = false,
        ) => ({
          id,
          cells: {
            guest: { text: name, note },
            last: {
              text: last,
              dot: late ? ('bad' as const) : ('ok' as const),
              ...(late ? { tone: 'bad' as const } : {}),
            },
            size: { text: size, mono: true },
            count: { text: kept, mono: true },
            verified: { text: 'OK', dot: 'ok' as const },
          },
        });
        const panels: ThingPagePanel[] = [
          ...strip(notices),
          {
            kind: 'list',
            id: 'jobs',
            place: 'chart',
            span: 2,
            title: 'Jobs',
            meta: 'Next: prune 22:30',
            items: [
              job(
                'verify:v-weekly',
                'Verify · tank',
                verified ? 'OK · just now · next Sat 02:00' : 'OK · 2 days ago · next Sat 02:00',
                verify('v-weekly', 'tank'),
              ),
              job(
                'gc:tank',
                'Garbage collection · tank',
                'OK · 18 h ago · next tomorrow 04:00',
                cleanup('tank'),
              ),
              job('prune:p-tank', 'Prune · tank', 'OK · 23 h ago · next 22:30'),
              job('sync:s-offsite', 'Sync from pbs-home', 'OK · 40 min ago · next 21:00'),
            ],
          },
          {
            kind: 'list',
            id: 'datastores',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'What it keeps',
            meta: '1 datastore',
            items: [
              count({
                id: 'store-tank',
                title: 'tank',
                icon: 'disk',
                detail: 'Full in about 5 months',
                value: '68 %',
                note: '+134 GB this week',
                url: PBS,
              }),
              count({
                id: 'guests',
                title: 'Guests',
                icon: 'device',
                detail: 'Oldest backup 3 days ago · mail',
                tone: 'bad',
                value: '12',
                note: '1 late',
                noteTone: 'bad',
              }),
              count({
                id: 'backups',
                title: 'Backups',
                icon: 'backup',
                detail: 'Kept on all datastores',
                value: '248',
                note: '+38 this week',
                noteTone: 'ok',
              }),
            ],
          },
          weekChart({
            week: week(),
            title: 'Backups this week',
            meta: 'Made per day',
            label: 'Backups',
            values: [6, 5, 6, 5, 6, 5, 5],
            color: 'green',
            figure: { value: '38', rest: 'backups this week' },
            change: '−3 %',
            span: 1,
          }),
          card(
            'The machine',
            [
              { id: 'cpu', label: 'Processor', note: 'of 4 cores', value: '3 %', pct: 0.03 },
              { id: 'memory', label: 'Memory', value: '2.1 of 8 GB', pct: 0.26 },
              { id: 'disk', label: 'Disk', value: '9.8 of 32 GB', pct: 0.31 },
              { id: 'pbs-version', label: 'Proxmox Backup Server', value: '4.0.18', pct: null },
            ],
            2,
            'pve-02 · CT 140',
            thingHref('server', 'pve-02'),
          ),
          {
            kind: 'table',
            id: 'guests',
            place: 'main',
            title: 'Guests',
            meta: '12 guests · oldest backup first',
            columns: [
              { key: 'guest', label: 'Guest' },
              { key: 'last', label: 'Last backup' },
              { key: 'size', label: 'Size', numeric: true },
              { key: 'count', label: 'Backups', numeric: true },
              { key: 'verified', label: 'Verified' },
            ],
            rows: [
              guest('tank::ct/131', 'mail', 'CT 131', '3 days ago', '18 GB', '19', true),
              guest('tank::vm/105', 'web', 'VM 105', '21 h ago', '32 GB', '21'),
              guest('tank::vm/110', 'homeassistant', 'VM 110', '21 h ago', '12 GB', '21'),
              guest('tank::ct/120', 'paperless', 'CT 120', '21 h ago', '6.4 GB', '21'),
              guest('tank::ct/121', 'immich', 'CT 121', '20 h ago', '41 GB', '21'),
            ],
          },
        ];
        return {
          ...head({
            thing: 'connection:con_pbs',
            catalogId: 'proxmox_backup',
            name: 'Backups',
            status: 'bad',
            badge: '11 of 12 guests backed up',
            facts: [strong('Proxmox Backup Server ', '4.0.18'), strong('', '12 guests', ' backed up')],
            address: '10.100.0.33:8007',
            open: { label: 'Open Proxmox Backup Server', url: PBS },
          }),
          runsOn: {
            serverId: 'pve-02',
            guestId: 'lxc/140',
            name: 'pve-02 · CT 140',
            href: thingHref('server', 'pve-02'),
            how: 'address',
          },
          tabs: summary(panels),
        };
      },
      row: () => ({
        line: 'Backups · Proxmox Backup Server 4.0.18',
        facts: [
          { label: 'Oldest backup', value: '3 days' },
          { label: 'Failed', value: '2' },
        ],
        reason: '11 of 12 guests backed up',
      }),
      action({ action, target }) {
        if (action === 'verify' && target === 'v-weekly' && !verified) {
          verified = true;
          return {
            message: 'Verify job v-weekly started. It reads every backup it covers, which can take a while.',
            recorded: true,
          };
        }
        if (action === 'cleanup' && target === 'tank')
          return { message: 'Cleanup of tank started. Space comes free as it goes.', recorded: true };
        return null;
      },
      checks: [
        { check: 'pbs.backup_late', name: 'Guests not backed up', nature: 'problem', perItem: true },
        { check: 'pbs.verify_failed', name: 'Backups that fail a verify', nature: 'problem', perItem: true },
        { check: 'pbs.store_full', name: 'Datastores filling up', nature: 'problem', perItem: true },
        { check: 'pbs.job_failed', name: 'Jobs that fail', nature: 'problem', perItem: true },
      ],
    };
  },
};

export const STORAGE_PAGES: FixtureServicePage[] = [truenas, synology, qnap, pbs];
