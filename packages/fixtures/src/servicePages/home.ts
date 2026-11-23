/**
 * Fixture pages of the home group: UniFi Protect, UniFi Access and ESPHome, their Summary in slots as the server builds it. Each entry shows in the
 * web's and the phone's fixture mode at `/things/<thing>` and in the sidebar; its shape and an example are in
 * `types.ts`. Add yours to the list; nothing else needs changing.
 *
 * Protect's page replaces the world's built-in one (`connection:con_protect`): same cameras, the Garage camera offline
 * (the quiet-notice tests ignore and snooze its line), Arm and Disarm now on the alarm's line in Today.
 */
import type {
  NoticeIgnore,
  NoticeNature,
  NoticeSubject,
  ThingGalleryItem,
  ThingLine,
  ThingPage,
  ThingPageBar,
  ThingPageButton,
  ThingPageItem,
  ThingPageNotice,
  ThingPagePanel,
} from '@whombat/core/domain';
import { fixtureImage } from '../pictures.js';
import type { FixtureServiceCtx, FixtureServicePage } from './types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LOOK_ONLY = 'Look only: changes are off for this connection.';

/** What every page here is made with: buttons and Worth a look lines as the server words them, refused on Look only. */
function kit(ctx: FixtureServiceCtx) {
  const button = (b: Omit<ThingPageButton, 'allowed'> & { allowed?: boolean }): ThingPageButton =>
    ctx.lookOnly ? { ...b, allowed: false, reason: LOOK_ONLY } : { ...b, allowed: b.allowed ?? true };
  const notice = (
    n: ThingPageNotice,
    nature: NoticeNature,
    check: string,
    ignore: NoticeIgnore,
    subject?: NoticeSubject,
  ): ThingPageNotice => ({
    ...n,
    nature,
    check,
    ...(subject ? { subject } : {}),
    ...(ctx.lookOnly ? {} : { ignore }),
  });
  /** “14:02” that long ago, in the zone the app draws times in (the browser's), so it agrees with the lists' times. */
  const clock = (ms: number) =>
    new Date(ctx.now() - ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  /** The last 7 days, today last: their times and the words under each bar. */
  const week = () => {
    const at = Array.from({ length: 7 }, (_, i) => new Date(ctx.now() - (6 - i) * DAY));
    const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' });
    return {
      timestamps: at.map((d) => d.toISOString()),
      labels: at.map((d, i) => (i === 6 ? 'Today' : weekday.format(d))),
    };
  };
  const head = (
    p: Pick<ThingPage, 'id' | 'name' | 'status' | 'badge' | 'facts' | 'address'> & {
      catalogId: string;
      open: string;
    },
  ): Omit<ThingPage, 'tabs'> => ({
    id: p.id,
    kind: 'connection',
    connectionId: p.id.slice('connection:'.length) as ThingPage['connectionId'],
    catalogId: p.catalogId,
    name: p.name,
    icon: p.catalogId,
    status: p.status,
    badge: p.badge,
    facts: p.facts,
    address: p.address,
    open: { label: `Open ${p.name.replace(/^UniFi /, '')}`, url: p.open },
    runsOn: null,
    settings: true,
    actions: [],
    readAt: ctx.ago(4_000),
  });
  const summary = (panels: ThingPagePanel[]) => [{ key: 'overview', label: 'Summary', panels }];
  return { button, notice, clock, week, head, summary };
}

const strong = (before: string, bold: string, after = ''): ThingLine => [
  ...(before ? [{ text: before }] : []),
  { text: bold, strong: true },
  ...(after ? [{ text: after }] : []),
];

/* UniFi Protect ------------------------------------------------------------------------------------------------------ */

const PROTECT = 'connection:con_protect';
const PROTECT_URL = 'https://10.100.0.1/protect/dashboard';

/** Mara's cameras: id, name, a doorbell. The Garage camera is offline. */
const CAMERAS: [string, string, boolean?][] = [
  ['doorbell', 'Doorbell', true],
  ['front-door', 'Front door'],
  ['driveway', 'Driveway'],
  ['garden', 'Garden'],
  ['back-door', 'Back door'],
  ['side-path', 'Side path'],
  ['shed', 'Shed'],
  ['garage', 'Garage'],
];

/** Detections per day of the last 7 days, today last. */
const PROTECT_WEEK = [38, 52, 41, 47, 60, 55, 46];

const protect: FixtureServicePage = {
  thing: PROTECT,
  catalogId: 'unifi_protect',
  name: 'UniFi Protect',
  fields: { url: 'https://10.100.0.1' },
  make: (ctx) => {
    const { button, notice, clock, week, head, summary } = kit(ctx);
    let armed = false;
    const page = (): ThingPage => {
      const arm = armed
        ? button({
            action: 'disarm',
            label: 'Disarm',
            icon: 'shield',
            tone: 'danger',
            confirm: {
              title: 'Disarm the alarm?',
              body: 'UniFi Protect disarms its alarm right away.',
              button: 'Disarm',
            },
          })
        : button({
            action: 'arm',
            label: 'Arm',
            icon: 'shield',
            confirm: {
              title: 'Arm the alarm?',
              body: 'UniFi Protect arms its alarm with the profile chosen in Protect. Motion then sets it off.',
              button: 'Arm',
            },
          });
      const detections: ThingPageItem[] = [
        ['Person seen at Front door', 2 * MIN],
        ['Vehicle seen at Driveway', 14 * MIN],
        ['Doorbell rang at Doorbell', 25 * MIN, true],
        ['Animal seen at Garden', HOUR],
        ['Person and Package seen at Front door', 2 * HOUR],
        ['Person seen at Side path', 3 * HOUR],
      ].map(([title, ago, ring], i) => ({
        id: `evt-${i + 1}`,
        title: title as string,
        at: ctx.ago(ago as number),
        icon: ring ? ('door' as const) : ('camera' as const),
        ...(ring ? { tone: 'info' as const } : {}),
      }));
      const total = PROTECT_WEEK.reduce((a, b) => a + b, 0);
      const machine: ThingPageBar[] = [
        { id: 'protect-version', label: 'Protect', value: '7.3.70', pct: null, sub: 'On UNVR Pro' },
        {
          id: 'protect-follow',
          label: 'Detections',
          value: 'Followed live',
          pct: null,
          sub: 'Whombat keeps two weeks of them',
          subTone: 'ok',
        },
      ];
      return {
        ...head({
          id: PROTECT,
          catalogId: 'unifi_protect',
          name: 'UniFi Protect',
          status: 'warn',
          badge: 'Garage is offline',
          facts: [strong('Protect ', '7.3.70'), strong('Alarm ', armed ? 'armed' : 'disarmed')],
          address: '10.100.0.1',
          open: PROTECT_URL,
        }),
        // Arm and Disarm are on the alarm's line in Today.
        buttons: [],
        refreshS: 10,
        tabs: summary([
          {
            kind: 'notices',
            id: 'worth',
            place: 'top',
            title: 'Worth a look',
            items: [
              notice(
                {
                  id: 'camera-offline-garage',
                  tone: 'warn',
                  icon: 'camera',
                  title: 'Garage is offline',
                  detail: `Since ${clock(2 * HOUR)}`,
                  link: {
                    kind: 'ask',
                    label: 'Look into it',
                    question: 'Why is my camera Garage offline in UniFi Protect?',
                  },
                },
                'problem',
                'protect.camera_offline',
                { lifts: 'fixed', words: 'Until it’s back online.' },
                { id: 'camera:garage', name: 'Garage' },
              ),
            ],
          },
          {
            kind: 'list',
            id: 'detections',
            place: 'chart',
            span: 2,
            title: 'Today',
            meta: '46 detections · 3 rings',
            items: [
              {
                id: 'alarm',
                title: 'Alarm',
                icon: 'shield',
                detail: armed
                  ? `Armed since ${clock(MIN)} · motion sets it off`
                  : 'Motion doesn’t set it off',
                right: armed ? 'Armed' : 'Disarmed',
                figure: { value: armed ? 'Armed' : 'Disarmed' },
                ...(armed ? { tone: 'ok' as const } : {}),
                actions: [arm],
              },
              ...detections,
            ],
            empty: 'Nothing seen today.',
          },
          {
            kind: 'list',
            id: 'inventory',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'In Protect',
            items: [
              {
                id: 'cameras',
                title: 'Cameras',
                icon: 'camera',
                detail: '1 doorbell',
                right: '8',
                figure: { value: '8', note: '1 offline', tone: 'warn' },
                url: PROTECT_URL,
              },
              {
                id: 'detections-today',
                title: 'Detections today',
                icon: 'camera',
                detail: 'Most at Driveway',
                right: '46',
                figure: { value: '46', note: '3 rings' },
              },
              {
                id: 'sensors',
                title: 'Sensors',
                icon: 'device',
                detail: '1 open',
                right: '4',
                figure: { value: '4', note: '1 low battery', tone: 'warn' },
                url: PROTECT_URL,
              },
              {
                id: 'lights',
                title: 'Lights',
                icon: 'power',
                right: '2',
                figure: { value: '2', note: '1 on' },
                url: PROTECT_URL,
              },
            ],
          },
          {
            kind: 'gallery',
            id: 'cameras',
            place: 'chart',
            span: 3,
            look: 'shelf',
            title: 'Cameras',
            meta: '7 of 8 online',
            link: { kind: 'url', label: 'All cameras in Protect', url: PROTECT_URL },
            shape: 'wide',
            items: CAMERAS.map(([id, name, bell]): ThingGalleryItem => {
              const offline = id === 'garage';
              return {
                id,
                title: name,
                ...(offline
                  ? {
                      sub: `Offline since ${clock(2 * HOUR)}`,
                      badge: { text: 'Offline', tone: 'warn' as const },
                      muted: true,
                    }
                  : {
                      image: fixtureImage('wide', `protect-${id}`, name),
                      ...(bell ? { sub: `Rang at ${clock(25 * MIN)}` } : {}),
                    }),
                url: PROTECT_URL,
              };
            }),
            empty: 'No cameras in UniFi Protect yet.',
          },
          {
            kind: 'chart',
            id: 'week',
            place: 'chart',
            span: 1,
            title: 'This week',
            meta: 'Detections per day',
            style: 'bars',
            ...week(),
            series: [{ key: 'values', label: 'Detections', values: PROTECT_WEEK, color: 'violet' }],
            figure: { value: String(total), rest: 'detections' },
            stats: [[{ text: '+12 %', strong: true }, { text: ' on last week' }]],
            axis: { min: 0 },
          },
          // The machine Protect runs on isn't one Whombat watches: “UniFi Protect itself”, widened to close the row.
          {
            kind: 'bars',
            id: 'machine',
            place: 'chart',
            span: 2,
            title: 'UniFi Protect itself',
            items: machine,
          },
        ]),
      };
    };
    return {
      page,
      row: () => ({
        line: '8 cameras',
        facts: [
          { label: 'Cameras', value: '7 of 8' },
          { label: 'Detections today', value: '46' },
        ],
        reason: 'Garage is offline',
      }),
      action: ({ action }) => {
        if (action === 'arm' && !armed) {
          armed = true;
          return { message: 'Arming the alarm. Protect arms it after its delay.', recorded: true };
        }
        if (action === 'disarm' && armed) {
          armed = false;
          return { message: 'The alarm is disarmed.', recorded: true };
        }
        return null;
      },
      checks: [
        { check: 'protect.alarm', name: 'The alarm going off', nature: 'you', perItem: false },
        { check: 'protect.camera_offline', name: 'Cameras going offline', nature: 'problem', perItem: true },
        { check: 'protect.events', name: 'Following detections', nature: 'fyi', perItem: false },
      ],
    };
  },
};

/* UniFi Access ------------------------------------------------------------------------------------------------------- */

const ACCESS = 'connection:con_access';
const ACCESS_URL = 'https://10.100.0.1/access/';

/** Openings per day of the last 7 days, today last (refused ones too). */
const ACCESS_WEEK = [18, 22, 15, 19, 24, 9, 14];

const access: FixtureServicePage = {
  thing: ACCESS,
  catalogId: 'unifi_access',
  name: 'UniFi Access',
  fields: { url: 'https://10.100.0.1:12445' },
  make: (ctx) => {
    const { button, week, head, summary } = kit(ctx);
    /** The doors: id and name; the office is unlocked on its schedule. */
    const DOORS: [string, string][] = [
      ['office', 'Office door'],
      ['front', 'Front door'],
      ['back-gate', 'Back gate'],
      ['garage', 'Garage door'],
    ];
    const page = (): ThingPage => {
      const doorItems: ThingPageItem[] = DOORS.map(([id, name]) => {
        const schedule = id === 'office';
        return {
          id,
          title: name,
          icon: 'door',
          detail: schedule ? 'Closed · Unlocked on its schedule' : 'Closed',
          right: schedule ? 'Unlocked' : 'Locked',
          actions: [
            button({
              action: 'unlock',
              target: id,
              label: 'Unlock',
              icon: 'unlock',
              confirm: {
                title: `Unlock ${name}?`,
                body: 'It unlocks once, for the few seconds it does for a card, then locks again.',
                button: 'Unlock',
              },
            }),
          ],
        };
      });
      const opened: [string, string, number, boolean?][] = [
        ['Front door', 'Mara de Wit · app', 12 * MIN],
        ['Back gate', 'Lotte de Wit · PIN', 48 * MIN],
        ['Front door', 'Refused · card', 70 * MIN, false],
        ['Office door', 'Sam Bakker · card', 2 * HOUR],
        ['Front door', 'Sam Bakker · card', 3 * HOUR],
        ['Front door', 'Ines Visser · PIN', 4 * HOUR],
        ['Garage door', 'Mara de Wit · app', 6 * HOUR],
      ];
      const total = ACCESS_WEEK.reduce((a, b) => a + b, 0);
      const person = (id: number, label: string, note: string, n: number, most: number): ThingPageBar => ({
        id: `person-${id}`,
        label,
        person: true,
        note,
        value: `${n} times`,
        pct: n / most,
      });
      return {
        ...head({
          id: ACCESS,
          catalogId: 'unifi_access',
          name: 'UniFi Access',
          status: 'ok',
          badge: 'Running fine',
          facts: [strong('', '1', ' of 4 doors unlocked')],
          address: '10.100.0.1:12445',
          open: ACCESS_URL,
        }),
        verdict: 'UniFi Access is fine: 1 of 4 doors are unlocked.',
        buttons: [],
        tabs: summary([
          {
            kind: 'list',
            id: 'doors',
            place: 'chart',
            span: 2,
            title: 'Doors',
            meta: '1 of 4 unlocked',
            items: doorItems,
          },
          {
            kind: 'list',
            id: 'inventory',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'In Access',
            items: [
              {
                id: 'doors',
                title: 'Doors',
                icon: 'door',
                right: '4',
                figure: { value: '4', note: '1 unlocked' },
              },
              {
                id: 'readers',
                title: 'Readers',
                icon: 'device',
                right: '5',
                figure: { value: '5', note: 'All online', tone: 'ok' },
              },
              {
                id: 'openings',
                title: 'Openings today',
                icon: 'door',
                right: '13',
                figure: { value: '13', note: '1 refused', tone: 'warn' },
              },
              {
                id: 'people',
                title: 'People',
                icon: 'key',
                right: '6',
                figure: { value: '6', note: '+1 this week', tone: 'ok' },
              },
            ],
          },
          {
            kind: 'chart',
            id: 'week',
            place: 'chart',
            span: 1,
            title: 'This week',
            meta: 'Door openings per day',
            style: 'bars',
            ...week(),
            series: [{ key: 'values', label: 'Openings', values: ACCESS_WEEK, color: 'green' }],
            figure: { value: String(total), rest: 'openings' },
            stats: [[{ text: '−4 %', strong: true }, { text: ' on last week' }]],
            axis: { min: 0 },
          },
          // No machine card (Access says no version): Who came in closes the row.
          {
            kind: 'bars',
            id: 'people',
            place: 'chart',
            span: 2,
            title: 'Who came in',
            meta: 'this week',
            items: [
              person(0, 'Mara de Wit', 'Front door · app', 31, 31),
              person(1, 'Sam Bakker', 'Front door · card', 24, 31),
              person(2, 'Lotte de Wit', 'Back gate · PIN', 12, 31),
              person(3, 'Ines Visser', 'Front door · PIN', 4, 31),
            ],
          },
          {
            kind: 'list',
            id: 'today',
            place: 'main',
            title: 'Today',
            meta: 'door openings',
            items: opened.map(([door, who, ago, granted], i) => ({
              id: `open-${i + 1}`,
              title: door,
              detail: who,
              at: ctx.ago(ago),
              icon: 'door' as const,
              ...(granted === false ? { tone: 'warn' as const } : {}),
            })),
            empty: 'Nobody opened a door today.',
          },
        ]),
      };
    };
    return {
      page,
      row: () => ({
        line: '4 doors',
        facts: [
          { label: 'Doors', value: '3 locked' },
          { label: 'Openings today', value: '13' },
        ],
      }),
      action: ({ action, target }) => {
        const door = DOORS.find(([id]) => id === target);
        // It unlocks for a few seconds and locks again: nothing on the page changes.
        if (action === 'unlock' && door) {
          return { message: `${door[1]} is unlocked for a few seconds.`, recorded: true };
        }
        return null;
      },
      checks: [
        { check: 'access.door_open', name: 'Doors left open', nature: 'you', perItem: true },
        {
          check: 'access.reader_offline',
          name: 'Readers and hubs going offline',
          nature: 'problem',
          perItem: true,
        },
        { check: 'access.door_unlocked', name: 'Doors kept unlocked', nature: 'you', perItem: true },
      ],
    };
  },
};

/* ESPHome ------------------------------------------------------------------------------------------------------------ */

const ESPHOME = 'connection:con_esphome';
const ESPHOME_URL = 'http://10.100.0.30:6052';

/** Mara's devices: config, name, state, the ESPHome it runs, its address, what it needs. */
const DEVICES: [string, string, 'online' | 'offline', string, string, ('update' | 'changed')?][] = [
  ['garage-door', 'Garage door opener', 'offline', '2026.10.0', '10.100.0.71'],
  ['hallway-motion', 'Hallway motion', 'online', '2026.9.2', '10.100.0.62', 'update'],
  ['kitchen-sensor', 'Kitchen sensor', 'online', '2026.9.2', '10.100.0.60', 'update'],
  ['living-room-plug', 'Living room plug', 'online', '2026.10.0', '10.100.0.64', 'changed'],
  ['bedroom-climate', 'Bedroom climate', 'online', '2026.10.0', '10.100.0.61'],
  ['desk-lamp', 'Desk lamp', 'online', '2026.10.0', '10.100.0.65'],
  ['doorbell-chime', 'Doorbell chime', 'online', '2026.10.0', '10.100.0.66'],
  ['garden-lights', 'Garden lights', 'online', '2026.10.0', '10.100.0.67'],
  ['laundry-power', 'Laundry power', 'online', '2026.10.0', '10.100.0.68'],
  ['office-air', 'Office air quality', 'online', '2026.10.0', '10.100.0.69'],
  ['porch-light', 'Porch light', 'online', '2026.10.0', '10.100.0.70'],
  ['shed-temp', 'Shed temperature', 'online', '2026.10.0', '10.100.0.72'],
  ['water-meter', 'Water meter', 'online', '2026.10.0', '10.100.0.73'],
  ['tv-backlight', 'TV backlight', 'online', '2026.10.0', '10.100.0.74'],
];

const esphome: FixtureServicePage = {
  thing: ESPHOME,
  catalogId: 'esphome',
  name: 'ESPHome',
  fields: { url: ESPHOME_URL },
  make: (ctx) => {
    const { button, clock, head, summary } = kit(ctx);
    /** Installs and when each started: the kitchen sensor builds now. One takes 30 seconds here. */
    const started = new Map<string, number>([['kitchen-sensor', ctx.now()]]);
    const done = new Set<string>();
    const INSTALL_MS = 30_000;
    /** Installs that ran their time are done: the device runs this ESPHome and needs nothing more. */
    const settle = () => {
      for (const [config, at] of started)
        if (ctx.now() - at >= INSTALL_MS) {
          started.delete(config);
          done.add(config);
        }
    };
    const needOf = (d: (typeof DEVICES)[number]) => (done.has(d[0]) ? undefined : d[5]);
    const runsOf = (d: (typeof DEVICES)[number]) => (done.has(d[0]) ? '2026.10.0' : d[3]);
    const confirm = (label: string, name: string) => ({
      title: `${label} ${name}?`,
      body: 'ESPHome builds its firmware and sends it over the network. The device restarts and is gone for a moment.',
      button: label,
    });
    const page = (): ThingPage => {
      settle();
      const installing = new Set(started.keys());
      const waiting = DEVICES.filter((d) => needOf(d) && !installing.has(d[0]));
      const older = DEVICES.filter((d) => needOf(d) === 'update').length;
      const changed = DEVICES.filter((d) => needOf(d) === 'changed').length;
      const live: ThingPageItem[] = [
        ...DEVICES.filter(([config]) => installing.has(config)).map(([config, name], i) => ({
          id: `job-${config}`,
          title: name,
          icon: 'update' as const,
          detail: i === 0 ? 'Building it' : 'Waiting its turn',
          ...(i === 0 ? { right: '63 %' } : {}),
          tone: 'info' as const,
        })),
        ...waiting
          .slice()
          .sort((a, b) => Number(a[2] === 'offline') - Number(b[2] === 'offline'))
          .map((d): ThingPageItem => {
            const [config, name, state, runs] = d;
            const need = needOf(d);
            const label = need === 'update' ? 'Update' : 'Install';
            return {
              id: `${config}.yaml`,
              title: name,
              icon: 'device',
              detail:
                need === 'update'
                  ? `Runs ${runs}${state === 'offline' ? ` · Offline since ${clock(5 * HOUR)}` : ''}`
                  : 'Changed since it was installed',
              ...(state === 'offline' ? { tone: 'warn' as const } : {}),
              actions: [
                button({
                  action: 'install',
                  target: `${config}.yaml`,
                  label,
                  icon: 'up',
                  confirm: confirm(label, name),
                }),
              ],
            };
          }),
      ];
      const rows = DEVICES.slice()
        .sort((a, b) => Number(a[2] !== 'offline') - Number(b[2] !== 'offline'))
        .map((d) => {
          const [config, name, state, , address] = d;
          const need = needOf(d);
          const runs = runsOf(d);
          const label = need === 'update' ? 'Update' : 'Install';
          return {
            id: `${config}.yaml`,
            cells: {
              name: { text: name, note: `${config}.yaml` },
              state:
                state === 'online'
                  ? { text: 'Online', dot: 'ok' as const }
                  : { text: 'Offline', dot: 'warn' as const, note: `since ${clock(5 * HOUR)}` },
              version: {
                text: runs,
                mono: true,
                ...(need === 'update'
                  ? { note: 'older', tone: 'warn' as const }
                  : need === 'changed'
                    ? { note: 'changed' }
                    : {}),
              },
              address: { text: address, mono: true },
              ...(need && !installing.has(config)
                ? {
                    install: {
                      text: label,
                      action: button({
                        action: 'install',
                        target: `${config}.yaml`,
                        label,
                        icon: 'up',
                        confirm: confirm(label, name),
                      }),
                    },
                  }
                : {}),
            },
          };
        });
      const meta = [
        installing.size ? `${installing.size} installing` : '',
        waiting.length ? `${waiting.length} waiting` : '',
        older ? 'ESPHome 2026.10.0 is here' : '',
      ]
        .filter(Boolean)
        .join(' · ');
      // Nothing waits or installs: Live lists the devices, offline first, as the server does.
      const now: ThingPageItem[] = DEVICES.slice()
        .sort((a, b) => Number(a[2] !== 'offline') - Number(b[2] !== 'offline') || a[1].localeCompare(b[1]))
        .slice(0, 6)
        .map((d) => ({
          id: `now-${d[0]}.yaml`,
          title: d[1],
          icon: 'device' as const,
          detail:
            d[2] === 'offline'
              ? `Offline since ${clock(5 * HOUR)} · ${runsOf(d)} · ${d[4]}`
              : `Online · ${runsOf(d)} · ${d[4]}`,
          tone: d[2] === 'offline' ? ('warn' as const) : ('ok' as const),
        }));
      const quiet = !installing.size && !waiting.length;
      return {
        ...head({
          id: ESPHOME,
          catalogId: 'esphome',
          name: 'ESPHome',
          status: 'ok',
          badge: 'Running fine',
          facts: [strong('ESPHome ', '2026.10.0')],
          address: '10.100.0.30:6052',
          open: ESPHOME_URL,
        }),
        verdict: 'ESPHome is fine: 13 of 14 devices are online.',
        buttons: [],
        // An install runs: the page asks again every 5 seconds.
        ...(installing.size ? { refreshS: 5 } : {}),
        tabs: summary([
          quiet
            ? {
                kind: 'list',
                id: 'now',
                place: 'chart',
                span: 2,
                title: 'Devices now',
                meta: '13 online · 1 offline',
                items: now,
              }
            : {
                kind: 'list',
                id: 'updates',
                place: 'chart',
                span: 2,
                title: 'To update',
                ...(meta ? { meta } : {}),
                ...(older
                  ? {
                      buttons: [
                        button({
                          action: 'install-all',
                          label: 'Update all',
                          icon: 'up',
                          confirm: {
                            title: older === 1 ? 'Update 1 device?' : `Update ${older} devices?`,
                            body: 'ESPHome builds each one’s firmware and sends it over the network, one after another. Each restarts; one that is offline gets it when it is back.',
                            button: 'Update all',
                          },
                        }),
                      ],
                    }
                  : {}),
                items: live,
              },
          {
            kind: 'list',
            id: 'inventory',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'In ESPHome',
            items: [
              {
                id: 'devices',
                title: 'Devices',
                icon: 'device',
                detail: '10 ESP32 · 4 ESP8266',
                right: '14',
                figure: { value: '14', note: '1 offline', tone: 'warn' },
                url: ESPHOME_URL,
              },
              {
                id: 'up-to-date',
                title: 'Up to date',
                icon: 'update',
                right: String(14 - older),
                figure: older
                  ? { value: String(14 - older), note: `${older} on an older ESPHome`, tone: 'warn' }
                  : { value: '14', note: 'All on 2026.10.0', tone: 'ok' },
                url: ESPHOME_URL,
              },
              ...(changed
                ? [
                    {
                      id: 'changed',
                      title: 'Changed since installed',
                      icon: 'log' as const,
                      right: String(changed),
                      figure: { value: String(changed), note: 'Install to use it' },
                      url: ESPHOME_URL,
                    },
                  ]
                : []),
              {
                id: 'found',
                title: 'Found on the network',
                icon: 'network',
                right: '1',
                figure: { value: '1', note: 'Not added yet' },
                url: ESPHOME_URL,
              },
            ],
          },
          // ESPHome runs as a Home Assistant add-on here, on a machine Whombat doesn't watch: no machine card.
          {
            kind: 'table',
            id: 'devices',
            place: 'main',
            title: 'Devices',
            meta: '14 devices',
            columns: [
              { key: 'name', label: 'Device' },
              { key: 'state', label: 'State' },
              { key: 'version', label: 'ESPHome' },
              { key: 'address', label: 'Address' },
              { key: 'install', label: '' },
            ],
            rows,
            empty: 'No devices in ESPHome yet.',
          },
        ]),
      };
    };
    return {
      page,
      row: () => {
        settle();
        return {
          line: '14 devices',
          facts: [
            { label: 'Online', value: '13 of 14' },
            { label: 'Updates', value: String(DEVICES.filter((d) => needOf(d) === 'update').length) },
          ],
        };
      },
      action: ({ action, target }) => {
        settle();
        if (action === 'install-all') {
          const n = DEVICES.filter((d) => needOf(d) === 'update' && !started.has(d[0]));
          if (!n.length) return null;
          for (const [c] of n) started.set(c, ctx.now());
          return {
            message:
              n.length === 1
                ? 'Updating 1 device. ESPHome builds it first.'
                : `Updating ${n.length} devices. ESPHome builds them one after another.`,
          };
        }
        const d = DEVICES.find(([c]) => `${c}.yaml` === target);
        const need = d ? needOf(d) : undefined;
        if (action === 'install' && d && need && !started.has(d[0])) {
          started.set(d[0], ctx.now());
          return {
            message: `${need === 'update' ? 'Updating' : 'Installing'} ${d[1]}. ESPHome builds it first.`,
          };
        }
        return null;
      },
      checks: [
        { check: 'esphome.device_offline', name: 'Devices going offline', nature: 'problem', perItem: true },
        { check: 'esphome.install_failed', name: 'Installs that fail', nature: 'problem', perItem: true },
        { check: 'esphome.older', name: 'Devices on an older ESPHome', nature: 'fyi', perItem: true },
      ],
    };
  },
};

/* Frigate ------------------------------------------------------------------------------------------------------------ */

const FRIGATE = 'connection:con_frigate';
const FRIGATE_URL = 'http://10.100.0.40:5000';

/** Mara's Frigate cameras: id, name, live fps (0 = offline). */
const FRIGATE_CAMERAS: [string, string, number][] = [
  ['front_door', 'Front door', 15],
  ['driveway', 'Driveway', 10],
  ['garden', 'Garden', 10],
  ['garage', 'Garage', 0],
];

/** Detections per day over the last 7 days, today last. */
const FRIGATE_WEEK = [24, 31, 19, 28, 35, 29, 22];

const frigate: FixtureServicePage = {
  thing: FRIGATE,
  catalogId: 'frigate',
  name: 'Frigate',
  fields: { url: FRIGATE_URL },
  make: (ctx) => {
    const { notice, clock, week, head, summary } = kit(ctx);
    const page = (): ThingPage => {
      const detections: ThingPageItem[] = [
        ['Person seen at Front door', 'Porch', 4 * MIN],
        ['Car seen at Driveway', 'Driveway', 19 * MIN],
        ['Dog seen at Garden', undefined, 52 * MIN],
        ['Person seen at Front door', 'Walkway', 2 * HOUR],
        ['Package seen at Front door', 'Porch', 3 * HOUR],
      ].map(([title, detail, ago], i) => ({
        id: `frigate-evt-${i + 1}`,
        title: title as string,
        ...(detail ? { detail: detail as string } : {}),
        at: ctx.ago(ago as number),
        icon: 'camera' as const,
      }));
      const total = FRIGATE_WEEK.reduce((a, b) => a + b, 0);
      const machine: ThingPageBar[] = [
        { id: 'frigate-version', label: 'Frigate', value: '0.16.2', pct: null, sub: 'Up 9 days' },
        {
          id: 'detector-coral',
          label: 'Detector (coral)',
          value: '11 ms',
          pct: null,
          sub: 'Fast',
          subTone: 'ok',
        },
        {
          id: 'frigate-storage',
          label: 'Recordings disk',
          value: '420 GB of 1 TB',
          pct: 0.42,
          sub: '580 GB free',
        },
      ];
      return {
        ...head({
          id: FRIGATE,
          catalogId: 'frigate',
          name: 'Frigate',
          status: 'warn',
          badge: 'Garage is offline',
          facts: [strong('Frigate ', '0.16.2'), strong('', '4 cameras')],
          address: '10.100.0.40:5000',
          open: FRIGATE_URL,
        }),
        verdict: 'Frigate is fine: 3 of 4 cameras are online.',
        buttons: [],
        refreshS: 10,
        tabs: summary([
          {
            kind: 'notices',
            id: 'worth',
            place: 'top',
            title: 'Worth a look',
            items: [
              notice(
                {
                  id: 'camera-offline-garage',
                  tone: 'warn',
                  icon: 'camera',
                  title: 'Garage is offline',
                  detail: `No frames received since ${clock(2 * HOUR)}. Check the camera’s power and network.`,
                  link: {
                    kind: 'ask',
                    label: 'Look into it',
                    question: 'Why is my camera Garage offline in Frigate?',
                  },
                },
                'problem',
                'frigate.camera_offline',
                { lifts: 'fixed', words: 'Until it’s back online.' },
                { id: 'camera:garage', name: 'Garage' },
              ),
            ],
          },
          {
            kind: 'list',
            id: 'detections',
            place: 'chart',
            span: 2,
            title: 'Today',
            meta: '22 detections',
            ask: { questions: ['What was detected today?', 'Which camera saw the most this week?'] },
            items: detections,
            empty: 'Nothing seen today.',
          },
          {
            kind: 'list',
            id: 'inventory',
            place: 'chart',
            span: 1,
            look: 'counts',
            title: 'In Frigate',
            items: [
              {
                id: 'cameras',
                title: 'Cameras',
                icon: 'camera',
                right: '4',
                figure: { value: '4', note: '1 offline', tone: 'warn' },
                url: FRIGATE_URL,
              },
              {
                id: 'detections-today',
                title: 'Detections today',
                icon: 'camera',
                detail: 'Most at Front door',
                right: '22',
                figure: { value: '22' },
              },
              {
                id: 'detectors',
                title: 'Detector',
                icon: 'device',
                detail: 'coral',
                right: '11 ms',
                figure: { value: '11 ms', note: 'Healthy', tone: 'ok' },
              },
              {
                id: 'storage',
                title: 'Recordings',
                icon: 'disk',
                detail: '580 GB free of 1 TB',
                right: '42 %',
                figure: { value: '42 %' },
              },
            ],
          },
          {
            kind: 'gallery',
            id: 'cameras',
            place: 'chart',
            span: 3,
            look: 'shelf',
            title: 'Cameras',
            meta: '3 of 4 online',
            shape: 'wide',
            items: FRIGATE_CAMERAS.map(([id, name, fps]): ThingGalleryItem => {
              const offline = fps === 0;
              return {
                id,
                title: name,
                ...(offline
                  ? {
                      sub: `Offline since ${clock(2 * HOUR)}`,
                      badge: { text: 'Offline', tone: 'warn' as const },
                      muted: true,
                    }
                  : {
                      image: fixtureImage('wide', `frigate-${id}`, name),
                      sub: `${fps} fps`,
                    }),
                url: FRIGATE_URL,
              };
            }),
            empty: 'No cameras in Frigate yet.',
          },
          {
            kind: 'chart',
            id: 'week',
            place: 'chart',
            span: 1,
            title: 'This week',
            meta: 'Detections per day',
            style: 'bars',
            ...week(),
            series: [{ key: 'values', label: 'Detections', values: FRIGATE_WEEK, color: 'violet' }],
            figure: { value: String(total), rest: 'detections' },
            stats: [[{ text: '+8 %', strong: true }, { text: ' on last week' }]],
            axis: { min: 0 },
          },
          {
            kind: 'bars',
            id: 'machine',
            place: 'chart',
            span: 2,
            title: 'Frigate itself',
            items: machine,
          },
        ]),
      };
    };
    return {
      page,
      row: () => ({
        line: '4 cameras',
        facts: [
          { label: 'Cameras', value: '3 of 4' },
          { label: 'Detections today', value: '22' },
        ],
        reason: 'Garage is offline',
      }),
      checks: [
        { check: 'frigate.camera_offline', name: 'Cameras going offline', nature: 'problem', perItem: true },
        {
          check: 'frigate.storage_full',
          name: 'Recordings disk filling up',
          nature: 'problem',
          perItem: false,
        },
        { check: 'frigate.detector_slow', name: 'Slow object detector', nature: 'fyi', perItem: true },
        { check: 'frigate.skipped_fps', name: 'Cameras dropping frames', nature: 'fyi', perItem: true },
      ],
    };
  },
};

export const HOME_PAGES: FixtureServicePage[] = [protect, access, esphome, frigate];
