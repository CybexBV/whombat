/**
 * The desk's fixtures (dev only, CG-27): every desk scene and sub-state, from the mockups' world (Lumio BV, Neo,
 * pve-01, pve-02, blackbox, the-falcon; John's box). `trim` does what the runtime does per lock state and
 * `lockedView` (DK-03), so the fixtures show what a real screen would. The demo desk takes the PIN 123456 (2580 for a
 * 4-digit one, DK-26).
 */

import type { DeskInitial } from '../desk/Desk';
import type { ConsoleState } from '../lib/api';
import type {
  DeskAsk,
  DeskBox,
  DeskFound,
  DeskFoundItem,
  DeskGlance,
  DeskLockedView,
  DeskLook,
  DeskPaired,
  DeskServer,
  DeskServerPage,
  DeskSession,
  DeskState,
  DeskTalk,
  DeskTile,
  ServerRange,
} from '../lib/desk';
import type { Fixture } from './fixtures';

/** 14:34 on Tuesday 20 October in Amsterdam (mockups 1–3), a little into the minute so the shots don't flip. */
const DAY = '2026-10-20T12:34:20Z';
/** 02:41 the night after (mockup 4). */
const NIGHT = '2026-10-21T00:41:20Z';
const at = (base: string, minutes: number) => new Date(Date.parse(base) + minutes * 60_000).toISOString();

const paired = (p: Partial<DeskPaired> = {}): DeskPaired => ({
  person: { name: 'John', initial: 'J', tone: 3 },
  hasPin: true,
  assistant: { name: 'Neo', face: 'neo' },
  burrow: 'Lumio BV',
  timeZone: 'Europe/Amsterdam',
  lockedView: 'everything',
  night: 'dim',
  quiet: false,
  voice: true,
  ...p,
});

const PLEX: DeskAsk = {
  number: 41,
  kind: 'approval',
  title: 'Restart Plex on blackbox?',
  at: at(DAY, -3),
  where: 'blackbox',
  detail:
    'Plex stopped answering at 14:31. A restart usually fixes it and takes about a minute. Nobody is watching anything right now.',
  facts: ['docker restart plex', 'blackbox · Unraid'],
  approveLabel: 'Restart Plex',
  onDesk: true,
  phoneReason: null,
};

const TRACKER: DeskAsk = {
  number: 40,
  kind: 'approval',
  title: 'Send the reply to an Acme Desk customer?',
  at: at(DAY, -20),
  where: 'Acme Desk',
  detail: 'A customer asked when their order ships. I wrote a short reply with the tracking link.',
  facts: ['To: an Acme Desk customer'],
  approveLabel: 'Send the reply',
  onDesk: false,
  phoneReason: 'outside',
};

const QUESTION: DeskAsk = {
  number: 42,
  kind: 'question',
  title: 'Which backups can I delete on blackbox?',
  at: at(DAY, -8),
  where: 'blackbox',
  detail:
    'The backup share is 91 % full. The oldest backups are from March. Should I keep the last three months?',
  facts: [],
  approveLabel: null,
  onDesk: true,
  phoneReason: null,
};

const server = (
  name: string,
  mark: string | null,
  note: string,
  cpu: number,
  memory: number,
  temp: number,
  tones: ['ok' | 'warn' | 'bad', 'ok' | 'warn' | 'bad', 'ok' | 'warn' | 'bad'] = ['ok', 'ok', 'ok'],
  state: DeskServer['state'] = 'ok',
): DeskServer => ({
  name,
  mark,
  state,
  note,
  cpu: { value: cpu, tone: tones[0] },
  memory: { value: memory, tone: tones[1] },
  temp: { value: temp, tone: tones[2] },
});

const SERVERS: DeskServer[] = [
  server('pve-01', 'proxmox', 'up 41 d', 18, 54, 46),
  server('pve-02', 'proxmox', 'up 41 d', 12, 61, 49),
  server('blackbox', 'unraid', 'up 9 d', 34, 72, 58),
  server('the-falcon', 'linux', 'updating', 63, 48, 71, ['ok', 'ok', 'warn']),
];

/** Everything Whombat has for John (unlocked, or “Everything” while locked). */
const FULL: DeskGlance = {
  status: {
    text: 'Everything’s fine. I’m updating your server agents, two of four are done.',
    more: 'Plex on blackbox needs a decision.',
  },
  needsYou: { count: 2, items: [PLEX, TRACKER] },
  working: {
    title: 'Update the server agents',
    steps: [
      { label: 'pve-01', state: 'done' },
      { label: 'pve-02', state: 'done' },
      { label: 'the-falcon', state: 'now' },
      { label: 'blackbox', state: 'next' },
    ],
  },
  done: [
    { text: 'Cleaned 14 GB of old backups on blackbox', at: '2026-10-20T04:40:00Z' },
    { text: 'Renewed the certificate on pve-01', at: '2026-10-20T07:12:00Z' },
    { text: 'Answered 3 Acme Desk reports', at: '2026-10-20T09:05:00Z' },
  ],
  servers: SERVERS,
  moreServers: 0,
  tiles: [
    { icon: 'temperature', mark: null, value: '21.4 °C', label: 'Living room', tone: null },
    { icon: 'heat', mark: null, value: 'Heating', label: 'Heat pump · water 38 °C', tone: null },
    { icon: 'sun', mark: null, value: '3.2 kW', label: 'Solar now · 14.6 kWh today', tone: null },
    { icon: 'lock', mark: null, value: 'Locked', label: 'Front door', tone: null },
  ],
  box: null,
};

/**
 * What the runtime leaves on a locked screen (DK-03, §2.3): “Everything” keeps titles but not an ask's detail;
 * “A summary” keeps counts, servers, tiles and power; “Only the time” keeps the one line.
 */
function trim(g: DeskGlance, view: DeskLockedView): DeskGlance {
  const bare = (a: DeskAsk): DeskAsk => ({ ...a, detail: null, facts: [], approveLabel: null, choices: [] });
  if (view === 'everything') return { ...g, needsYou: { ...g.needsYou, items: g.needsYou.items.map(bare) } };
  // A new box (DK-23): nothing to watch yet, nothing asked, nothing worked on.
  const fresh = g.box !== null && g.needsYou.count === 0 && g.working === null;
  const line =
    g.needsYou.count === 0
      ? 'Everything’s fine.'
      : g.needsYou.count === 1
        ? '1 thing needs you.'
        : `${g.needsYou.count} things need you.`;
  const summary: DeskGlance = {
    ...g,
    status: fresh ? READY : { text: line, more: null },
    // What needs a look shows with the cards (DK-93).
    needsYou: { count: g.needsYou.count, items: [], ...(g.needsYou.looks && { looks: g.needsYou.looks }) },
    working: null,
    done: [],
  };
  if (view === 'summary') return summary;
  return {
    ...summary,
    status: { text: line, more: null },
    needsYou: { count: g.needsYou.count, items: [] },
    servers: [],
    moreServers: 0,
    tiles: [],
    box: null,
    self: null,
    extraServers: [],
    extraTiles: [],
    found: null,
  };
}

const UNLOCKED = (now: string) =>
  ({ state: 'unlocked', until: at(now, 2), retryAt: null, expiresAt: null }) as const;
/** Unlocked with the camera on (DK-28, DK-30): someone in front of it (30 s ahead), or nobody seen yet (2 minutes). */
const HERE = (now: string) =>
  ({ ...UNLOCKED(now), until: at(now, 0.5), camera: true, present: true }) as const;
const LOOKING = (now: string) => ({ ...UNLOCKED(now), camera: true, present: false }) as const;
/** Unlocked until Lock (DK-74): `until` is 2 minutes after the state's now, moving on with every state. */
const STAYS = (now: string) => ({ ...UNLOCKED(now), stays: true }) as const;
/** The camera looking for someone (DK-72): it sees John, or nobody (watching, so the clock after a minute). */
const SEEN = { camera: true, watching: true, here: true } as const;
const NOBODY = { camera: true, watching: true, here: false } as const;
const LOCKED = { state: 'locked', until: null, retryAt: null, expiresAt: null } as const;

const PLUGGED = {
  source: 'ac',
  percent: 80,
  charging: false,
  minutesLeft: null,
  chargeLimit: 80,
  since: null,
} as const;
const POWER_CUT = {
  source: 'battery',
  percent: 76,
  charging: false,
  minutesLeft: 190,
  chargeLimit: 80,
  since: '2026-10-21T00:14:00Z',
} as const;

const ANSWER: DeskTalk = {
  id: 'talk-0001',
  state: 'answered',
  question: 'Is pve-02 okay, and did last night’s backup run?',
  answer: 'Yes, pve-02 is fine. The backup ran at 03:00 and finished in 14 minutes.',
  thing: { ...server('pve-02', 'proxmox', 'up 41 d · backup ran 03:00', 12, 61, 49) },
  audio: true,
  reason: null,
};

const FOOTER = 'To repair this Whombat, restart it, hold Space and choose Whombat Recovery.';

function desk(
  p: Partial<DeskState> & { view?: DeskLockedView; glance?: DeskGlance | null } = {},
): ConsoleState {
  const { view, ...rest } = p;
  const pr = rest.paired === undefined ? paired(view ? { lockedView: view } : {}) : rest.paired;
  const lock = rest.lock ?? LOCKED;
  const unlocked = lock.state === 'unlocked';
  const glance =
    rest.glance === undefined ? (unlocked ? FULL : trim(FULL, pr?.lockedView ?? 'summary')) : rest.glance;
  return {
    mode: 'console',
    now: rest.now ?? DAY,
    claim: {
      state: 'claimed',
      code: '',
      claimUrl: 'app.whombat.com/claim',
      appUrl: 'app.whombat.com',
      retryAt: null,
      burrows: { first: 'Lumio BV', more: 0 },
    },
    footer: FOOTER,
    desk: {
      now: rest.now ?? DAY,
      paired: pr,
      pairing: rest.pairing ?? null,
      lock,
      glance: pr ? glance : null,
      power: rest.power === undefined ? PLUGGED : rest.power,
      talk: rest.talk ?? null,
      ...(rest.presence && pr ? { presence: rest.presence } : {}),
    },
  };
}

const one = (state: ConsoleState) => [{ at: 0, state }];

/** The desk with a device waiting to sign in at the screen (BX-06, CG-150), 4½ minutes left on the desk's clock. */
const signingIn = (state: ConsoleState): ConsoleState => ({
  ...state,
  claim: state.claim && {
    ...state.claim,
    signIn: { code: 'KXQMTR', name: 'John Doe', device: 'Pixel 9', expiresAt: at(state.now, 4.5) },
  },
});

/** A new box's line (DK-23). */
const READY = {
  text: 'All fine. I’m ready when you are.',
  more: 'Connect a server or your home, and I’ll keep an eye on it here.',
};

/** The mockup's hour (new-box.html): a point a minute, whole percentages, from its seeded wobble and spikes. */
function hour(base: number, wobble: number, seed: number, spikes: number[] = [], n = 60): number[] {
  let x = seed;
  const r = () => {
    x = (x * 16807) % 2147483647;
    return x / 2147483647;
  };
  return Array.from({ length: n }, (_, i) =>
    Math.round(Math.max(1, base + (r() - 0.5) * wobble + (spikes.includes(i) ? wobble * 2.4 : 0))),
  );
}

/** This Whombat on John's Z13 (mockup new-box.html): 16 cores, 64 GB, a 1 TB disk, cool, a little traffic. */
const BOX: DeskBox = {
  up: 'up 2 h 14 min',
  cpu: { percent: 7, cores: 16, tone: 'ok' },
  memory: { percent: 18, used: { value: '11.2', unit: 'GB' }, total: '64 GB', tone: 'ok' },
  history: { stepS: 60, cpu: hour(7, 6, 12, [22, 23, 41]), memory: hour(17.5, 1.2, 8) },
  storage: {
    percent: 13,
    free: { value: '812', unit: 'GB' },
    total: '937 GB',
    tone: 'ok',
    parts: [
      { key: 'whombat', value: '41 GB', percent: 4 },
      { key: 'agent', value: '84 GB', percent: 9 },
    ],
  },
  temp: { value: 46, tone: 'ok' },
  network: { down: '2.4 MB/s', up: '310 kB/s' },
};

/** A new box: nothing connected, nothing asked, nothing worked on (DK-22, DK-23). */
const NEW_BOX: DeskGlance = {
  status: READY,
  needsYou: { count: 0, items: [] },
  working: null,
  done: [],
  servers: [],
  moreServers: 0,
  tiles: [],
  box: BOX,
};

/** The new box an hour later, unlocked: connecting the first server, and what it did today. */
const NEW_BOX_WORKING: DeskGlance = {
  ...NEW_BOX,
  status: { text: 'All fine. I’m connecting pve-01, one of three steps is done.', more: null },
  working: {
    title: 'Connect pve-01',
    steps: [
      { label: 'Sign in', state: 'done' },
      { label: 'Install the agent', state: 'now' },
      { label: 'First look', state: 'next' },
    ],
  },
  done: [
    { text: 'Checked this Whombat’s disks', at: '2026-10-20T10:58:00Z' },
    { text: 'Set up your Vault', at: '2026-10-20T11:20:00Z' },
  ],
};

/** A VM (John's DEV box): 4 cores, 16 GB, no sensor, no battery. */
const VM_BOX: DeskBox = {
  ...BOX,
  up: 'up 41 d',
  cpu: { percent: 12, cores: 4, tone: 'ok' },
  memory: { percent: 46, used: { value: '7.4', unit: 'GB' }, total: '16 GB', tone: 'ok' },
  history: { stepS: 60, cpu: hour(11, 8, 31, [9, 10, 37]), memory: hour(46, 3, 5) },
  storage: {
    percent: 31,
    free: { value: '86.8', unit: 'GB' },
    total: '126 GB',
    tone: 'ok',
    parts: [
      { key: 'whombat', value: '14.2 GB', percent: 11 },
      { key: 'agent', value: '22.6 GB', percent: 18 },
    ],
  },
  temp: null,
};

/** A busy, full and hot box: every tone, a scale of 100 %, storage without parts (not btrfs). */
const BUSY_BOX: DeskBox = {
  ...BOX,
  cpu: { percent: 92, cores: 16, tone: 'bad' },
  memory: { percent: 86, used: { value: '55.1', unit: 'GB' }, total: '64 GB', tone: 'warn' },
  history: { stepS: 60, cpu: hour(60, 30, 3, [50, 51, 52, 58, 59]), memory: hour(80, 6, 9) },
  storage: {
    percent: 88,
    free: { value: '112', unit: 'GB' },
    total: '937 GB',
    tone: 'warn',
    parts: [],
  },
  temp: { value: 91, tone: 'bad' },
  network: { down: '48.3 MB/s', up: '1.2 MB/s' },
};

/** Measured for twelve minutes, with a gap: the line starts late and breaks (a 50 % scale). */
const SHORT_BOX: DeskBox = {
  ...BOX,
  up: 'up 12 min',
  cpu: { percent: 31, cores: 16, tone: 'ok' },
  history: {
    stepS: 60,
    cpu: [44, 38, 35, null, null, 22, 18, 26, 30, 29, 33, 31],
    memory: [16, 17, 17, null, null, 18, 18, 18, 18, 18, 18, 18],
  },
};

const CALM: DeskGlance = {
  status: { text: 'pve-02 is down.', more: null },
  needsYou: { count: 0, items: [] },
  working: null,
  done: [{ text: 'Renewed the certificate on pve-01', at: '2026-10-20T07:12:00Z' }],
  servers: [
    {
      ...server('pve-02', 'proxmox', 'not answering', 0, 0, 0),
      state: 'bad',
      cpu: null,
      memory: null,
      temp: null,
    },
    server('nas', 'truenas', 'up 120 d', 4, 38, 41),
    server('pi-hole', 'raspberrypi', 'up 3 d', 2, 22, 52),
    { ...server('backup-box', 'debian', 'off', 0, 0, 0), state: 'off', cpu: null, memory: null, temp: null },
  ],
  moreServers: 3,
  tiles: [
    { icon: 'temperature', mark: null, value: '19.8 °C', label: 'Office', tone: null },
    { icon: 'power', mark: 'homeassistant', value: '412 W', label: 'The house now', tone: null },
  ],
  box: null,
};

/** Servers five to eight (DK-41): all fine, so they come after the first four (worst first, DK-S08). */
const MORE_SERVERS: DeskServer[] = [
  server('nas', 'truenas', 'up 120 d', 4, 38, 41),
  server('pi-hole', 'raspberrypi', 'up 3 d', 2, 22, 52),
  server('backup-box', 'debian', 'up 12 d', 1, 17, 38),
  server('media', 'ubuntu', 'up 6 d', 9, 44, 47),
];

/** Tiles five to eight (DK-41). */
const MORE_TILES: DeskTile[] = [
  { icon: 'power', mark: 'homeassistant', value: '412 W', label: 'The house now', tone: null },
  { icon: 'water', mark: null, value: '128 L', label: 'Water today', tone: null },
  { icon: 'light', mark: null, value: '3 on', label: 'Lights downstairs', tone: null },
  { icon: 'network', mark: null, value: '940 Mb/s', label: 'Internet · fibre', tone: null },
];

/** The mockup's world with This Whombat beside it (0.104, DK-39): `self`, and the next four of each. */
const WITH_SELF: DeskGlance = { ...FULL, self: BOX };
const EIGHT: Pick<DeskGlance, 'servers' | 'extraServers' | 'moreServers'> = {
  servers: SERVERS,
  extraServers: MORE_SERVERS,
  moreServers: MORE_SERVERS.length,
};
const EIGHT_TILES: Pick<DeskGlance, 'tiles' | 'extraTiles'> = {
  tiles: FULL.tiles,
  extraTiles: MORE_TILES,
};
const NOTHING_TO_DO: Pick<DeskGlance, 'needsYou' | 'working' | 'done'> = {
  needsYou: { count: 0, items: [] },
  working: null,
  done: [],
};

/* Found on your network (Whombat desk-found.md DF-01…DF-12, mockups docs/design/desk-found/, CG-230…) */

const item = (catalogId: string, name: string, tagline: string, address: string): DeskFoundItem => ({
  catalogId,
  name,
  tagline,
  address,
});

/** What the scan found on John's network (the mockups' eight), in catalog order then by address (DF-03). */
const FOUND_ITEMS: DeskFoundItem[] = [
  item('homeassistant', 'Home Assistant', 'Lights, heating and sensors', '10.100.0.5'),
  item('proxmox', 'Proxmox VE', 'Virtual machines and backups', '10.100.0.240'),
  item('unifi_network', 'UniFi Network', 'Wi-Fi and everything on it', '10.100.0.1'),
  item('proxmox', 'Proxmox VE', 'Virtual machines and backups', '10.100.0.241'),
  item('unraid', 'Unraid', 'Storage, Docker and VMs', '10.100.0.20'),
  item('truenas', 'TrueNAS', 'Storage and snapshots', '10.100.1.30'),
  item('pihole', 'Pi-hole', 'Ad blocking for the house', '10.100.0.3'),
  item('plex', 'Plex', 'Films, series and music', '10.100.0.20'),
];
const SYNOLOGY = item('synology', 'Synology DSM', 'Storage, shares and backups', '10.100.1.40:5001');
const QNAP = item('qnap', 'QNAP', 'Storage, shares and snapshots', '10.100.1.41');
/** A Modbus device (DF-S*): no mark, its first letter. */
const HEAT_PUMP = item('device', 'Heat pump', 'A device Whombat can learn to read', '10.100.0.60:502');

/** The first scan a minute after the claim (frame 1): 412 of 1 022 addresses, three found so far. */
const FOUND_LOOKING: DeskFound = {
  scanning: true,
  progress: { done: 412, total: 1022 },
  items: FOUND_ITEMS.slice(0, 3),
  count: 3,
  finishedAt: null,
};

/** Done (frame 2): eight things it can look after, just now. */
const FOUND_DONE: DeskFound = {
  scanning: false,
  progress: null,
  items: FOUND_ITEMS,
  count: 8,
  finishedAt: at(DAY, -0.3),
};

/** A new box with what it found: This Whombat is still sent (the console puts the panel in its place, DF-06). */
const foundBox = (found: DeskFound, g: Partial<DeskGlance> = {}): DeskGlance => ({ ...NEW_BOX, found, ...g });

/** Two days later (frame 3): the Proxmox hosts and Home Assistant connected, the rest a strip. */
const FRAME3_TIME = at(DAY, -322);
const FRAME3: DeskGlance = {
  status: { text: 'All fine.', more: 'Your two Proxmox servers and your home look good.' },
  ...NOTHING_TO_DO,
  servers: [
    { ...server('pve-1', 'proxmox', '', 12, 46, 0), temp: null },
    { ...server('pve-2', 'proxmox', '', 4, 31, 0), temp: null },
  ],
  moreServers: 0,
  tiles: [
    { icon: 'temperature', mark: null, value: '20.5 °C', label: 'Living room', tone: null },
    { icon: 'power', mark: null, value: '1.4 kW', label: 'House now', tone: null },
    { icon: 'light', mark: null, value: '3 on', label: 'Lights', tone: null },
    { icon: 'lock', mark: null, value: 'Closed', label: 'Front door', tone: null },
  ],
  box: null,
  found: {
    scanning: false,
    progress: null,
    items: [FOUND_ITEMS[4], FOUND_ITEMS[2], FOUND_ITEMS[6], FOUND_ITEMS[7], FOUND_ITEMS[5]].filter(
      (i): i is DeskFoundItem => i !== undefined,
    ),
    count: 5,
    finishedAt: at(FRAME3_TIME, -95),
  },
};

const DESK_FOUND_FIXTURES: Record<string, Fixture> = {
  'desk-found-looking': {
    note: 'Found on your network, the first scan a minute after the claim: 412 of 1 022, three so far, the newest edged (frame 1)',
    desk: { foundSeen: ['homeassistant@10.100.0.5', 'proxmox@10.100.0.240'] },
    timeline: one(
      desk({ now: at(DAY, -3), view: 'summary', glance: trim(foundBox(FOUND_LOOKING), 'summary') }),
    ),
  },
  'desk-found-looking-none': {
    note: 'The first scan just started: nothing found yet, eight dashed places',
    timeline: one(
      desk({
        now: at(DAY, -4),
        view: 'summary',
        glance: trim(
          foundBox({ ...FOUND_LOOKING, progress: { done: 38, total: 1022 }, items: [], count: 0 }),
          'summary',
        ),
      }),
    ),
  },
  'desk-found-live': {
    note: 'The first scan finds more while the page watches, then finishes: cards fade in once (DF-10)',
    timeline: [
      {
        at: 0,
        state: desk({ now: at(DAY, -3), view: 'summary', glance: trim(foundBox(FOUND_LOOKING), 'summary') }),
      },
      {
        at: 1500,
        state: desk({
          now: at(DAY, -2),
          view: 'summary',
          glance: trim(
            foundBox({
              ...FOUND_LOOKING,
              progress: { done: 803, total: 1022 },
              items: FOUND_ITEMS.slice(0, 6),
              count: 6,
            }),
            'summary',
          ),
        }),
      },
      { at: 3000, state: desk({ view: 'summary', glance: trim(foundBox(FOUND_DONE), 'summary') }) },
    ],
  },
  'desk-found': {
    note: 'Found on your network, done: eight things, where to connect them, Not now (frame 2)',
    timeline: one(desk({ view: 'summary', glance: trim(foundBox(FOUND_DONE), 'summary') })),
  },
  'desk-found-one': {
    note: 'Found one thing (a Synology, its mark from Simple Icons): “Connect it”',
    timeline: one(
      desk({
        view: 'summary',
        glance: trim(
          foundBox({ ...FOUND_DONE, items: [SYNOLOGY], count: 1, finishedAt: at(DAY, -12) }),
          'summary',
        ),
      }),
    ),
  },
  'desk-found-letters': {
    note: 'More than eight: QNAP’s mark and a device without one (its first letter), eleven found, eight named',
    timeline: one(
      desk({
        view: 'summary',
        glance: trim(
          foundBox({
            ...FOUND_DONE,
            items: [HEAT_PUMP, ...FOUND_ITEMS.slice(0, 5), SYNOLOGY, QNAP],
            count: 11,
          }),
          'summary',
        ),
      }),
    ),
  },
  'desk-found-unlocked': {
    note: 'Found on your network unlocked: the same panel, Talk to Neo in the top bar',
    timeline: one(desk({ lock: UNLOCKED(DAY), glance: foundBox(FOUND_DONE) })),
  },
  'desk-found-short': {
    note: 'Found on a new box with Working on and Done today: one row of compact cards',
    timeline: one(
      desk({
        lock: UNLOCKED(DAY),
        glance: foundBox(FOUND_DONE, {
          status: NEW_BOX_WORKING.status,
          working: NEW_BOX_WORKING.working,
          done: NEW_BOX_WORKING.done,
        }),
      }),
    ),
  },
  'desk-found-short-battery': {
    note: 'The same on battery: one row still fits',
    timeline: one(
      desk({
        lock: UNLOCKED(DAY),
        power: { ...POWER_CUT, since: at(DAY, -27) },
        glance: foundBox(FOUND_DONE, {
          status: NEW_BOX_WORKING.status,
          working: NEW_BOX_WORKING.working,
          done: NEW_BOX_WORKING.done,
        }),
      }),
    ),
  },
  'desk-found-tight': {
    note: 'Found on a new box with a three-line status, two asks, every row and on battery: the strip stands in for the panel',
    timeline: one(
      desk({
        lock: UNLOCKED(DAY),
        power: { ...POWER_CUT, since: at(DAY, -27) },
        glance: foundBox(FOUND_DONE, {
          status: {
            text: 'All fine. I’m connecting pve-01, one of three steps is done, and then I’ll look at blackbox’s disks.',
            more: 'Plex on blackbox needs a decision.',
          },
          needsYou: FULL.needsYou,
          working: NEW_BOX_WORKING.working,
          done: NEW_BOX_WORKING.done,
        }),
      }),
    ),
  },
  'desk-found-time': {
    note: 'Locked, “Only the time”: no found (DF-06)',
    unlockedGlance: foundBox(FOUND_DONE),
    timeline: one(desk({ view: 'time', glance: trim(foundBox(FOUND_DONE), 'time') })),
  },
  'desk-found-strip': {
    note: 'Two days later: two servers, four tiles, the rest a strip (frame 3; a runtime that sends no This Whombat)',
    timeline: one(desk({ now: FRAME3_TIME, view: 'everything', glance: trim(FRAME3, 'everything') })),
  },
  'desk-found-strip-self': {
    note: 'The same with This Whombat beside them (DK-39): its card first among the servers, the strip still fits',
    timeline: one(
      desk({ now: FRAME3_TIME, view: 'everything', glance: trim({ ...FRAME3, self: BOX }, 'everything') }),
    ),
  },
  'desk-found-strip-more': {
    note: 'The strip beside four servers and four tiles: what doesn’t fit counted, “+k more”',
    timeline: one(
      desk({
        view: 'summary',
        glance: trim(
          {
            ...WITH_SELF,
            ...NOTHING_TO_DO,
            found: { ...FOUND_DONE, items: [...FOUND_ITEMS.slice(4), SYNOLOGY, QNAP, HEAT_PUMP], count: 12 },
          },
          'summary',
        ),
      }),
    ),
  },
  'desk-found-strip-looking': {
    note: 'The first scan beside servers (a burrow from before): the strip with what it looked at, no Not now yet',
    timeline: one(
      desk({
        now: FRAME3_TIME,
        view: 'everything',
        glance: trim(
          { ...FRAME3, found: { ...FOUND_LOOKING, items: FOUND_ITEMS.slice(4, 6), count: 2 } },
          'everything',
        ),
      }),
    ),
  },
};

/* Asks that come to you and Talk as a conversation (DK-60…DK-65, CG-194…CG-198) */

/** Plex from a runtime from 0.108: Deny too (DK-61). */
const PLEX_D: DeskAsk = { ...PLEX, deny: true };
/** A risky ask (DK-62): Approve with the PIN, Deny and Not now without. */
const DEPLOY: DeskAsk = {
  number: 45,
  kind: 'approval',
  title: 'Deploy the Acme website to production?',
  at: at(DAY, -1),
  where: 'Acme Desk',
  detail:
    'The new checkout page passed its tests. Deploying takes about two minutes and customers see it at once.',
  facts: ['main → production', 'acme.example'],
  approveLabel: 'Deploy the website',
  onDesk: false,
  phoneReason: 'release',
  deny: true,
  approveWithPin: true,
};
const TRACKER_D: DeskAsk = { ...TRACKER, deny: true, approveWithPin: true };
const ASKS_GLANCE: DeskGlance = { ...FULL, needsYou: { count: 3, items: [PLEX_D, DEPLOY, TRACKER_D] } };

const msg = (
  id: string,
  from: 'you' | 'assistant',
  minutes: number,
  paragraphs: string[],
  more: Partial<DeskSession['messages'][number]> = {},
): DeskSession['messages'][number] => ({
  id: `msg_${id.padEnd(8, '0')}`,
  from,
  at: at(DAY, minutes),
  paragraphs,
  more: false,
  ask: null,
  talk: null,
  audio: false,
  thing: null,
  ...more,
});

const BLACKBOX = server('blackbox', 'unraid', 'Plex back · up 9 d', 31, 70, 57);
/** A conversation at the desk: a question, the answer with blackbox, an ask approved, its result, a follow-up. */
const CONVO: DeskSession = {
  open: true,
  earlier: 0,
  until: at(DAY, 30),
  messages: [
    msg('q1', 'you', -6, ['Plex isn’t working on the TV. Can you look?'], { talk: 'talk-0101' }),
    msg(
      'a1',
      'assistant',
      -5.8,
      ['Plex on blackbox stopped answering at 14:28. A restart usually fixes it.'],
      {
        talk: 'talk-0101',
      },
    ),
    msg('k1', 'assistant', -5.7, ['Restart Plex on blackbox?'], { ask: { number: 39, state: 'approved' } }),
    msg('a2', 'assistant', -4.9, ['Done, Plex is back. It took 40 seconds and your TV can see it again.'], {
      thing: BLACKBOX,
    }),
    msg('q2', 'you', -1.2, ['Did last night’s backup run?'], { talk: 'talk-0102' }),
    msg(
      'a3',
      'assistant',
      -1,
      [
        'Yes. The backup on pve-02 ran at 03:00 and finished in 14 minutes.',
        '• 212 GB, all checks passed',
        '• The next one runs tonight at 03:00',
      ],
      { talk: 'talk-0102', audio: true, more: true },
    ),
  ],
};
/** …and Neo asking in it (DK-60): the card opens over Talk. */
const CONVO_ASKING: DeskSession = {
  ...CONVO,
  messages: [
    ...CONVO.messages.slice(0, 2),
    msg('k2', 'assistant', -0.2, ['Restart Plex on blackbox?'], { ask: { number: 41, state: 'waiting' } }),
  ],
};
/** A long one, read from the top: newer messages below (“New message”). */
const CONVO_LONG: DeskSession = {
  ...CONVO,
  earlier: 6,
  messages: [
    msg('q0', 'you', -12, ['Is the-falcon done updating?']),
    msg('a0', 'assistant', -11.8, [
      'Not yet. It is on the third of four steps and should be done in ten minutes.',
    ]),
    ...CONVO.messages,
  ],
};

/* Task feedback (Whombat task-feedback.md TF-14…TF-18, contracts 0.116, CG-280…) */

/** Neo asks to install Home Assistant's updates; the web card's wider choice for an owner (SA-07). */
const HA_UPDATE: DeskAsk = {
  number: 47,
  kind: 'approval',
  title: 'Install 23 updates on Home Assistant?',
  at: at(DAY, -0.5),
  where: 'Home Assistant',
  detail:
    'Home Assistant OS 16.2 and 22 add-on updates. It restarts once at the end and is back in about a minute.',
  facts: ['23 updates', 'Home Assistant · HAOS'],
  approveLabel: 'Install updates',
  onDesk: true,
  phoneReason: null,
  deny: true,
  choices: [{ scope: 'agent', label: 'Don’t ask again on Home Assistant' }],
};
/** Banjo asks (TF-15), with both wider choices (a command on its computer: this task, and always). */
const BANJO_ASK: DeskAsk = {
  number: 48,
  kind: 'approval',
  title: 'Run npm install in the Acme website?',
  at: at(DAY, -1),
  where: 'Acme Desk',
  detail: 'It adds the two packages the new checkout page needs. It runs on Banjo’s computer.',
  facts: ['npm install', 'acme-web'],
  approveLabel: 'Run it',
  onDesk: true,
  phoneReason: null,
  deny: true,
  from: 'Banjo',
  choices: [
    { scope: 'task', label: 'Allow commands for this task' },
    { scope: 'agent', label: 'Always allow Banjo to run npm install' },
  ],
};
/** A risky ask approved with the PIN (DK-62) that offers “Always allow” too (RA-06). */
const DEPLOY_ALWAYS: DeskAsk = {
  ...DEPLOY,
  number: 49,
  from: 'Banjo',
  choices: [{ scope: 'agent', label: 'Always allow Banjo to deploy' }],
};
const CHOICE_GLANCE: DeskGlance = {
  ...FULL,
  needsYou: { count: 3, items: [HA_UPDATE, BANJO_ASK, DEPLOY_ALWAYS] },
};

/** A task Neo started on Home Assistant, running for 47 s now. */
const TASK_RUNNING = {
  title: 'Installing 23 updates on Home Assistant',
  state: 'running' as const,
  startedAt: at(DAY, -47 / 60),
  endedAt: null,
  result: null,
};
/** Last night's backup on pve-02 that didn't work, and one that did. */
const TASK_FAILED = {
  title: 'Backing up web on pve-02',
  state: 'error' as const,
  startedAt: at(DAY, -9),
  endedAt: at(DAY, -7),
  result:
    'Backing up web on pve-02 didn’t work: the storage is full. Free up space on local-lvm and I can try again.',
};
const TASK_DONE = {
  title: 'Installing 4 updates on pve-01',
  state: 'ok' as const,
  startedAt: at(DAY, -16),
  endedAt: at(DAY, -12),
  result: 'pve-01 is up to date: 4 updates installed. No restart needed.',
};
/** Updating Home Assistant at the desk (John's 2026-10-21 case, TF-10…TF-17): asked, approved, the task running. */
const CONVO_WORK: DeskSession = {
  open: true,
  earlier: 0,
  until: at(DAY, 30),
  messages: [
    msg('q5', 'you', -17, ['Update pve-01 too, please.'], { talk: 'talk-0201' }),
    msg('t5', 'assistant', -16, ['pve-01 is up to date: 4 updates installed · 4 min'], { task: TASK_DONE }),
    msg('q6', 'you', -2, ['Can you update Home Assistant?'], { talk: 'talk-0202' }),
    msg('a6', 'assistant', -1.8, ['There are 23 updates. I need your yes before I install them.'], {
      talk: 'talk-0202',
    }),
    msg('k6', 'assistant', -1.7, ['Install 23 updates on Home Assistant?'], {
      ask: { number: 46, state: 'approved' },
    }),
    msg('t6', 'assistant', -47 / 60, ['Installing 23 updates on Home Assistant · 47 s'], {
      task: TASK_RUNNING,
    }),
  ],
  working: { since: at(DAY, -47 / 60), doing: 'Installing updates on Home Assistant' },
};
/** …the task ended, and Neo said how it went; one from earlier didn't work. */
const CONVO_DONE: DeskSession = {
  ...CONVO_WORK,
  messages: [
    msg('t4', 'assistant', -9, ['Backing up web on pve-02 didn’t work: the storage is full · 2 min'], {
      task: TASK_FAILED,
    }),
    ...CONVO_WORK.messages.slice(2, 5),
    msg('t6', 'assistant', -47 / 60, ['Home Assistant is up to date: 23 updates installed · 4 min'], {
      task: {
        ...TASK_RUNNING,
        startedAt: at(DAY, -4.6),
        state: 'ok',
        endedAt: at(DAY, -0.4),
        result: 'Home Assistant is up to date: 23 updates installed. It restarted once and is back.',
      },
    }),
    msg(
      'a7',
      'assistant',
      -0.3,
      ['Done. Home Assistant has all 23 updates and is back up after one restart.'],
      {
        talk: 'talk-0203',
        audio: true,
      },
    ),
  ],
  working: null,
};

/* Server cards three to a row, and a server's own screen (Whombat desk-display.md DK-80…DK-89, mockups
   docs/design/desk-servers/, CG-250…) */

/** 14:34 on Wednesday 21 October (the mockups' frames 1 and 2). */
const WED = '2026-10-21T12:34:20Z';

/** A card as a runtime from 0.115 sends it: its id and its disk (DK-80, DK-83). */
const card = (
  id: string,
  mark: string,
  note: string,
  cpu: number,
  memory: number,
  disk: number,
  o: Partial<DeskServer> = {},
): DeskServer => ({
  id,
  name: id,
  mark,
  state: 'ok',
  note,
  cpu: { value: cpu, tone: cpu >= 95 ? 'bad' : cpu >= 85 ? 'warn' : 'ok' },
  memory: { value: memory, tone: memory >= 95 ? 'bad' : memory >= 85 ? 'warn' : 'ok' },
  temp: { value: 46, tone: 'ok' },
  disk: { value: disk, tone: disk >= 95 ? 'bad' : disk >= 85 ? 'warn' : 'ok' },
  ...o,
});

const OFF: Partial<DeskServer> = { state: 'off', cpu: null, memory: null, temp: null, disk: null };

/** Frame 1's servers, in its order, then the two it counts (“+2 more”). */
const FLEET: DeskServer[] = [
  card('pve-01', 'proxmox', 'up 41 d', 18, 54, 33),
  card('pve-02', 'proxmox', 'up 41 d', 12, 61, 47, { temp: { value: 49, tone: 'ok' } }),
  card('the-falcon', 'linux', 'updating', 63, 48, 71, { state: 'warn', temp: { value: 71, tone: 'warn' } }),
  card('nas', 'unraid', 'up 120 d', 4, 38, 88),
  card('pi-hole', 'linux', 'up 3 d', 2, 22, 9, { temp: { value: 52, tone: 'ok' } }),
  card('media', 'ubuntu', 'up 6 d', 9, 44, 52),
  card('backup-box', 'debian', 'off', 0, 0, 0, OFF),
];
/** More servers for every server's list (DK-86): twelve in all. */
const FLEET_12: DeskServer[] = [
  ...FLEET,
  card('blackbox', 'unraid', 'up 9 d', 34, 72, 64),
  card('k3s-01', 'kubernetes', 'up 18 d', 27, 66, 41),
  card('k3s-02', 'kubernetes', 'up 18 d', 22, 59, 38),
  card('truenas', 'truenas', 'up 61 d', 6, 31, 77),
  card('mail', 'debian', 'up 12 d', 3, 28, 22),
];

/** The glance's servers as Whombat sends them (DK-41): four, the next four, and how many in all beyond the four. */
const fleet = (servers: DeskServer[]): Pick<DeskGlance, 'servers' | 'extraServers' | 'moreServers'> => ({
  servers: servers.slice(0, 4),
  extraServers: servers.length > 4 ? servers.slice(4, 8) : [],
  moreServers: Math.max(0, servers.length - 4),
});

/** Frame 1: This Whombat beside seven servers and four tiles, two things waiting. */
const SERVERS_GLANCE: DeskGlance = { ...WITH_SELF, ...fleet(FLEET) };

/** What needs a look (DK-93): John's Home Assistant, the fleet's server that is off and the one that runs hot. */
const HA_LOOK: DeskLook = {
  key: 'connection:con_7Hq2v8LkP0aX',
  kind: 'connection',
  name: 'Home Assistant',
  state: 'look',
  reason: '2 integrations not loading',
};
const BACKUP_BOX_DOWN: DeskLook = {
  key: 'server:backup-box',
  kind: 'server',
  name: 'backup-box',
  state: 'down',
  reason: null,
  server: 'backup-box',
};
const DRAGON_HOT: DeskLook = {
  key: 'server:the-falcon',
  kind: 'server',
  name: 'the-falcon',
  state: 'look',
  reason: 'Hot · 71°',
  server: 'the-falcon',
};
/** John's desk (2026-10-21): nothing to approve, Home Assistant to look at. */
const LOOKS_GLANCE: DeskGlance = {
  ...SERVERS_GLANCE,
  working: null,
  done: [],
  needsYou: { count: 0, items: [], looks: [HA_LOOK] },
};
/** A server off, two asks, two more to look at. */
const LOOKS_MANY: DeskGlance = {
  ...SERVERS_GLANCE,
  needsYou: { count: 2, items: [PLEX, TRACKER], looks: [BACKUP_BOX_DOWN, HA_LOOK, DRAGON_HOT] },
};
/** Nothing needs you (DK-94): no assistant's line. */
const NOTHING_GLANCE: DeskGlance = { ...SERVERS_GLANCE, needsYou: { count: 0, items: [] } };

/**
 * Looks from a runtime from 0.122 (QN-20): the line each comes from, its kind, Ignore's words and its question. John's
 * hallway access point (a problem), Google to connect again and nas's disk to replace (only him), the-falcon hot.
 */
const UNIFI_LOOK: DeskLook = {
  key: 'connection:con_9UnF1aP0x2Lk',
  kind: 'connection',
  name: 'UniFi',
  state: 'look',
  reason: 'Hallway AP is offline',
  notice: { check: 'unifi.device_offline', subject: 'device:64a1f0c2e9b3' },
  nature: 'problem',
  ignoreWords: 'Until it’s back online.',
  question: 'Why is Hallway AP offline in UniFi?',
};
const GOOGLE_LOOK: DeskLook = {
  key: 'connection:con_G00g1eW0rk5',
  kind: 'connection',
  name: 'Google',
  state: 'look',
  reason: 'Needs to be connected again',
  notice: { check: 'conn.signin' },
  nature: 'you',
  ignoreWords: 'Until it’s connected again.',
};
const DRAGON_QUIET: DeskLook = {
  ...DRAGON_HOT,
  notice: { check: 'host.temperature_high' },
  nature: 'problem',
  ignoreWords: 'Until it cools down.',
  question: 'Why is the-falcon running hot?',
};
const NAS_DISK: DeskLook = {
  key: 'server:nas',
  kind: 'server',
  name: 'nas',
  state: 'bad',
  reason: 'Disk 3 is failing',
  server: 'nas',
  notice: { check: 'host.disk.smart_failing', subject: 'disk:WD-WX12D80H1234' },
  nature: 'you',
  ignoreWords: 'Until it’s replaced.',
};
/** Unlocked: the four, worst first. */
const QUIET_GLANCE: DeskGlance = {
  ...SERVERS_GLANCE,
  working: null,
  done: [],
  needsYou: { count: 0, items: [], looks: [NAS_DISK, UNIFI_LOOK, GOOGLE_LOOK, DRAGON_QUIET] },
};
/** Only Google, which only John can do: the assistant doesn't offer to look into it. */
const YOU_GLANCE: DeskGlance = { ...QUIET_GLANCE, needsYou: { count: 0, items: [], looks: [GOOGLE_LOOK] } };

/** A day's, an hour's or a week's line from the mockup's seeded wobble (whole percentages). */
function line(n: number, base: number, wobble: number, seed: number, spikes: number[] = []): number[] {
  return hour(base, wobble, seed, spikes, n);
}

/** The points of a range: 60 a minute apart, 96 a quarter apart, 84 two hours apart. */
const RANGE_POINTS: Record<ServerRange, { n: number; stepS: number }> = {
  '1h': { n: 60, stepS: 60 },
  '24h': { n: 96, stepS: 900 },
  '7d': { n: 84, stepS: 7200 },
};

/** A history ending at the mockups' clock: the CPU's peak and when, the memory's average. */
function history(range: ServerRange, cpu: number[], memory: number[]): DeskServerPage['history'] {
  const { stepS } = RANGE_POINTS[range];
  const peak = Math.max(...cpu);
  const i = cpu.lastIndexOf(peak);
  const at = new Date(Date.parse(WED) - (cpu.length - 1 - i) * stepS * 1000).toISOString();
  return {
    range,
    stepS,
    cpu,
    memory,
    cpuPeak: { percent: peak, at },
    memoryAvg: Math.round(memory.reduce((a, b) => a + b, 0) / memory.length),
  };
}

/** A server's lines for a range, from a base and a seed: the CPU with a few spikes, the memory steadier. */
function lines(range: ServerRange, cpu: number, memory: number, seed: number): DeskServerPage['history'] {
  const { n } = RANGE_POINTS[range];
  const spikes = [Math.round(n * 0.14), Math.round(n * 0.15), Math.round(n * 0.62)];
  return history(range, line(n, cpu, cpu * 0.6, seed, spikes), line(n, memory, 3, seed + 7));
}

const NO_ALERTS = { count: 0, items: [] };

/** pve-01 as frame 2 draws it: Proxmox with three volumes and five guests. */
const PVE_01 = (range: ServerRange): Omit<DeskServerPage, 'now'> => ({
  server: card('pve-01', 'proxmox', 'up 41 d', 18, 54, 33) as DeskServer & { id: string },
  os: 'Proxmox VE 9.0.10',
  up: 'up 41 d',
  cpu: { percent: 18, cores: 16, load: '2.9', tone: 'ok' },
  memory: { percent: 54, used: { value: '69', unit: 'GB' }, total: '128 GB', tone: 'ok' },
  disk: { percent: 33, used: '1.2', total: '3.6 TB', tone: 'ok' },
  temp: { value: 46, limit: 85, tone: 'ok' },
  history: lines(range, 16, 53, 23),
  volumes: [
    { name: 'local-zfs', note: 'nvme mirror', percent: 41, used: '0.8', total: '1.9 TB', tone: 'ok' },
    { name: 'nas-backup', note: 'on nas', percent: 72, used: '5.8', total: '8 TB', tone: 'ok' },
    { name: 'local', note: 'boot disk', percent: 18, used: '17', total: '94 GB', tone: 'ok' },
  ],
  guests: {
    running: 4,
    off: 1,
    items: [
      { name: 'plex', kind: 'vm', state: 'running', cpu: 22, memory: '6.1 GB' },
      { name: 'home-assistant', kind: 'vm', state: 'running', cpu: 9, memory: '3.8 GB' },
      { name: 'nextcloud', kind: 'container', state: 'running', cpu: 6, memory: '2.2 GB' },
      { name: 'unifi', kind: 'container', state: 'running', cpu: 3, memory: '1.4 GB' },
      { name: 'win11-test', kind: 'vm', state: 'stopped', cpu: null, memory: '' },
    ],
  },
  network: { down: '24 MB/s', up: '3.1 MB/s' },
  alerts: NO_ALERTS,
});

/** A plain Linux server: one disk, no guests. */
const PI_HOLE = (range: ServerRange): Omit<DeskServerPage, 'now'> => ({
  server: card('pi-hole', 'linux', 'up 3 d', 2, 22, 9) as DeskServer & { id: string },
  os: 'Debian 13',
  up: 'up 3 d',
  cpu: { percent: 2, cores: 4, load: '0.1', tone: 'ok' },
  memory: { percent: 22, used: { value: '0.9', unit: 'GB' }, total: '4 GB', tone: 'ok' },
  disk: { percent: 9, used: '2.7', total: '29 GB', tone: 'ok' },
  temp: { value: 52, limit: 85, tone: 'ok' },
  history: lines(range, 3, 22, 41),
  volumes: [{ name: '/', note: 'sd card', percent: 9, used: '2.7', total: '29 GB', tone: 'ok' }],
  guests: null,
  network: { down: '310 kB/s', up: '88 kB/s' },
  alerts: NO_ALERTS,
});

/** the-falcon while its agent updates, hot, two things to look at. */
const THE_DRAGON = (range: ServerRange): Omit<DeskServerPage, 'now'> => ({
  server: card('the-falcon', 'linux', 'updating', 63, 48, 71, {
    state: 'warn',
    temp: { value: 71, tone: 'warn' },
  }) as DeskServer & { id: string },
  os: 'Ubuntu 26.04',
  up: 'up 12 d',
  cpu: { percent: 63, cores: 24, load: '14.2', tone: 'ok' },
  memory: { percent: 48, used: { value: '31', unit: 'GB' }, total: '64 GB', tone: 'ok' },
  disk: { percent: 71, used: '1.4', total: '2 TB', tone: 'ok' },
  temp: { value: 71, limit: 85, tone: 'warn' },
  history: lines(range, 48, 46, 7),
  volumes: [
    { name: 'nvme0n1', note: 'system', percent: 71, used: '1.4', total: '2 TB', tone: 'ok' },
    { name: 'sda', note: 'scratch', percent: 93, used: '3.7', total: '4 TB', tone: 'warn' },
  ],
  guests: {
    running: 3,
    off: 0,
    items: [
      { name: 'builder', kind: 'container', state: 'running', cpu: 41, memory: '12 GB' },
      { name: 'grafana', kind: 'container', state: 'unhealthy', cpu: 1, memory: '0.4 GB' },
      { name: 'postgres', kind: 'container', state: 'running', cpu: 4, memory: '2.1 GB' },
    ],
  },
  network: { down: '1.2 MB/s', up: '640 kB/s' },
  alerts: {
    count: 2,
    items: [
      { tone: 'warn', title: 'The scratch disk is 93 % full' },
      { tone: 'warn', title: 'Grafana doesn’t answer its health check' },
    ],
  },
});

/** backup-box, off: the card, its OS, no figures; the week it was on. */
const BACKUP_BOX = (range: ServerRange): Omit<DeskServerPage, 'now'> => ({
  server: card('backup-box', 'debian', 'off', 0, 0, 0, OFF) as DeskServer & { id: string },
  os: 'Debian 13',
  up: '',
  cpu: null,
  memory: null,
  disk: null,
  temp: null,
  history: { range, stepS: RANGE_POINTS[range].stepS, cpu: [], memory: [], cpuPeak: null, memoryAvg: null },
  volumes: [],
  guests: null,
  network: null,
  alerts: NO_ALERTS,
});

/** Any other server: its card's figures, a disk, no guests. */
const plainPage = (c: DeskServer, range: ServerRange): Omit<DeskServerPage, 'now'> => ({
  server: c as DeskServer & { id: string },
  os: '',
  up: c.note.startsWith('up ') ? c.note : '',
  cpu: c.cpu ? { percent: c.cpu.value, cores: 8, load: '0.6', tone: c.cpu.tone } : null,
  memory: c.memory
    ? { percent: c.memory.value, used: { value: '12', unit: 'GB' }, total: '32 GB', tone: c.memory.tone }
    : null,
  disk: c.disk ? { percent: c.disk.value, used: '1.1', total: '4 TB', tone: c.disk.tone } : null,
  temp: c.temp ? { value: c.temp.value, limit: 90, tone: c.temp.tone } : null,
  history: lines(range, c.cpu?.value ?? 5, c.memory?.value ?? 30, c.name.length * 13),
  volumes: c.disk
    ? [{ name: 'data', note: '', percent: c.disk.value, used: '1.1', total: '4 TB', tone: c.disk.tone }]
    : [],
  guests: null,
  network: { down: '1.4 MB/s', up: '220 kB/s' },
  alerts: NO_ALERTS,
});

const PAGES: Record<string, (range: ServerRange) => Omit<DeskServerPage, 'now'>> = {
  'pve-01': PVE_01,
  'pi-hole': PI_HOLE,
  'the-falcon': THE_DRAGON,
  'backup-box': BACKUP_BOX,
};

/** The demo hosts: every server of the fleet, the four above as drawn, the rest from their cards. */
function serverPage(id: string, range: ServerRange): Omit<DeskServerPage, 'now'> | null {
  const page = PAGES[id];
  if (page) return page(range);
  const c = FLEET_12.find((x) => x.id === id);
  return c ? plainPage(c, range) : null;
}

/** The world of the server fixtures: every server's list and each server's screen. */
const HOSTS = { servers: { servers: FLEET_12, more: 0 }, serverPage } satisfies Partial<Fixture>;

/** A server's screen opened from the glance (DK-83): the glance's servers with ids, the one at `id`. */
const opened = (id: string, list: DeskServer[] = FLEET): DeskInitial => {
  const withId = list.filter((x) => x.id !== undefined);
  return {
    page: { kind: 'server', list: withId, index: withId.findIndex((x) => x.id === id), from: 'glance' },
  };
};

/** A runtime before 0.115 (DK-88): no ids, no disk. */
const before = (x: DeskServer): DeskServer => {
  const { id: _id, disk: _disk, ...rest } = x;
  return rest;
};

const DESK_SERVER_FIXTURES: Record<string, Fixture> = {
  // What needs a look, in Needs you, and the assistant only when something needs you (DK-90…DK-97)
  'desk-looks': {
    note: 'John’s desk: Home Assistant needs a look, nothing to approve: one Needs you row and the line that opens it (DK-93, DK-94)',
    ...HOSTS,
    timeline: one(desk({ now: WED, view: 'summary', glance: trim(LOOKS_GLANCE, 'summary') })),
  },
  'desk-looks-many': {
    note: 'Unlocked: a server off first, then two asks, then two to look at; the line names the first (DK-93)',
    ...HOSTS,
    timeline: one(desk({ now: WED, lock: UNLOCKED(WED), glance: LOOKS_MANY })),
  },
  'desk-looks-nothing': {
    note: 'Nothing needs you: no assistant’s line, the cards at the bottom (DK-92, DK-94)',
    ...HOSTS,
    timeline: one(desk({ now: WED, view: 'summary', glance: trim(NOTHING_GLANCE, 'summary') })),
  },
  'desk-look-card': {
    note: 'Home Assistant’s card from a runtime before 0.122: what it is, why, Ask Neo to look into it and Close (DK-95, QN-20)',
    ...HOSTS,
    desk: { overlay: { kind: 'look', key: HA_LOOK.key } },
    timeline: one(desk({ now: WED, lock: UNLOCKED(WED), glance: LOOKS_MANY })),
  },
  'desk-look-card-server': {
    note: 'A server that is off (before 0.122): no reason known, Open backup-box under Ask Neo to look into it (DK-95)',
    ...HOSTS,
    desk: { overlay: { kind: 'look', key: BACKUP_BOX_DOWN.key } },
    timeline: one(desk({ now: WED, lock: UNLOCKED(WED), glance: LOOKS_MANY })),
  },
  'desk-look-card-locked': {
    note: 'Locked, A summary: the card shows too; Ask Neo to look into it asks for the PIN first (DK-95, DK-96)',
    ...HOSTS,
    desk: { overlay: { kind: 'look', key: HA_LOOK.key } },
    timeline: one(desk({ now: WED, view: 'summary', glance: trim(LOOKS_GLANCE, 'summary') })),
  },
  // Quieting a look (QN-20, CG-330…): the buttons by kind of line, the PIN first, what the card says after.
  'desk-look-quiet': {
    note: 'UniFi’s hallway AP, a problem: Ask Neo to look into it, Ignore “Until it’s back online.” and Not now (QN-20)',
    ...HOSTS,
    desk: { overlay: { kind: 'look', key: UNIFI_LOOK.key } },
    timeline: one(desk({ now: WED, lock: UNLOCKED(WED), glance: QUIET_GLANCE })),
  },
  'desk-look-quiet-server': {
    note: 'the-falcon hot, a problem on a server: Ask on its own row, then Ignore, Not now and Open the-falcon (QN-20)',
    ...HOSTS,
    desk: { overlay: { kind: 'look', key: DRAGON_QUIET.key } },
    timeline: one(desk({ now: WED, lock: UNLOCKED(WED), glance: QUIET_GLANCE })),
  },
  'desk-look-quiet-you': {
    note: 'Google to connect again, only John can: Ignore and Not now, no Ask (QN-02, QN-20)',
    ...HOSTS,
    desk: { overlay: { kind: 'look', key: GOOGLE_LOOK.key } },
    timeline: one(desk({ now: WED, lock: UNLOCKED(WED), glance: QUIET_GLANCE })),
  },
  'desk-look-quiet-you-server': {
    note: 'nas’s failing disk, only John can replace it: Ignore, Not now and Open nas (QN-20)',
    ...HOSTS,
    desk: { overlay: { kind: 'look', key: NAS_DISK.key } },
    timeline: one(desk({ now: WED, lock: UNLOCKED(WED), glance: QUIET_GLANCE })),
  },
  'desk-look-quiet-locked': {
    note: 'Locked, Ignore touched: the PIN pad beside the card; once unlocked it is ignored (PIN 123456; QN-20)',
    ...HOSTS,
    desk: { overlay: { kind: 'look', key: UNIFI_LOOK.key, pin: 'ignore' } },
    unlockedGlance: QUIET_GLANCE,
    timeline: one(desk({ now: WED, view: 'summary', glance: trim(QUIET_GLANCE, 'summary') })),
  },
  'desk-look-quiet-ignored': {
    note: 'Ignored: “Ignored. You’ll hear if it changes.”, then the card closes (QN-20)',
    ...HOSTS,
    desk: { overlay: { kind: 'look', key: UNIFI_LOOK.key }, lookDone: 'ignore' },
    timeline: one(desk({ now: WED, lock: UNLOCKED(WED), glance: QUIET_GLANCE })),
  },
  'desk-look-quiet-snoozed': {
    note: 'Not now: “I’ll remind you tomorrow.”, then the card closes (QN-12, QN-20)',
    ...HOSTS,
    desk: { overlay: { kind: 'look', key: GOOGLE_LOOK.key }, lookDone: 'snooze' },
    timeline: one(desk({ now: WED, lock: UNLOCKED(WED), glance: QUIET_GLANCE })),
  },
  'desk-look-quiet-not-allowed': {
    note: 'Ignore by someone who doesn’t manage UniFi: Whombat refuses, the card says so in plain words (not_allowed)',
    ...HOSTS,
    quietRefused: 'not_allowed',
    desk: { overlay: { kind: 'look', key: UNIFI_LOOK.key } },
    timeline: one(desk({ now: WED, lock: UNLOCKED(WED), glance: QUIET_GLANCE })),
  },
  'desk-looks-you': {
    note: 'Only Google needs John: the line names it and says only he can sort it out, no offer to look into it (QN-02)',
    ...HOSTS,
    timeline: one(desk({ now: WED, view: 'summary', glance: trim(YOU_GLANCE, 'summary') })),
  },
  'desk-looks-quiet-live': {
    note: 'Unlocked, four to look at: touch one and Ignore or Not now it, and it leaves Needs you (the demo answers)',
    ...HOSTS,
    timeline: one(desk({ now: WED, lock: UNLOCKED(WED), glance: QUIET_GLANCE })),
  },
  'desk-looks-idle': {
    note: 'Nobody there for 12 minutes: the same glance, dimmed (DK-97)',
    ...HOSTS,
    idleMs: 12 * 60_000,
    timeline: one(desk({ now: WED, view: 'summary', glance: trim(LOOKS_GLANCE, 'summary') })),
  },
  'desk-servers': {
    note: 'Frame 1: This Whombat and five servers three to a row, “+2 more”, the tiles (A summary, locked)',
    ...HOSTS,
    timeline: one(desk({ now: WED, view: 'summary', glance: trim(SERVERS_GLANCE, 'summary') })),
  },
  'desk-servers-unlocked': {
    note: 'Frame 1 unlocked: Working on and Done today take the room, This Whombat and two servers, “+5 more”',
    ...HOSTS,
    timeline: one(desk({ now: WED, lock: UNLOCKED(WED), glance: SERVERS_GLANCE })),
  },
  'desk-servers-one': {
    note: 'One server: its card a third wide, This Whombat the panel below',
    ...HOSTS,
    timeline: one(
      desk({
        now: WED,
        view: 'summary',
        glance: trim({ ...WITH_SELF, ...NOTHING_TO_DO, ...fleet(FLEET.slice(0, 1)), tiles: [] }, 'summary'),
      }),
    ),
  },
  'desk-servers-two': {
    note: 'Two servers and four tiles: This Whombat’s card and the two in a row, the tiles',
    ...HOSTS,
    timeline: one(
      desk({
        now: WED,
        view: 'summary',
        glance: trim({ ...WITH_SELF, ...NOTHING_TO_DO, ...fleet(FLEET.slice(0, 2)) }, 'summary'),
      }),
    ),
  },
  'desk-servers-five': {
    note: 'Five servers, no tiles: two rows of three, This Whombat’s card first',
    ...HOSTS,
    timeline: one(
      desk({
        now: WED,
        view: 'summary',
        glance: trim({ ...WITH_SELF, ...NOTHING_TO_DO, ...fleet(FLEET.slice(0, 5)), tiles: [] }, 'summary'),
      }),
    ),
  },
  'desk-servers-eight': {
    note: 'Eight servers, nothing waiting, no tiles: This Whombat’s card and the eight fill three rows (DK-82)',
    ...HOSTS,
    timeline: one(
      desk({
        now: WED,
        view: 'summary',
        glance: trim(
          { ...WITH_SELF, ...NOTHING_TO_DO, ...fleet(FLEET_12.slice(0, 8)), tiles: [] },
          'summary',
        ),
      }),
    ),
  },
  'desk-servers-eight-tiles': {
    note: 'Eight servers and eight tiles: This Whombat and two servers, “+6 more”, two rows of tiles (fewest left out)',
    ...HOSTS,
    timeline: one(
      desk({
        now: WED,
        view: 'summary',
        glance: trim({ ...WITH_SELF, ...fleet(FLEET_12.slice(0, 8)), ...EIGHT_TILES }, 'summary'),
      }),
    ),
  },
  'desk-servers-battery': {
    note: 'On battery with Working on and Done today: one row of cards, the battery line',
    ...HOSTS,
    timeline: one(
      desk({
        now: WED,
        view: 'everything',
        power: { ...POWER_CUT, since: at(WED, -27) },
        glance: trim(SERVERS_GLANCE, 'everything'),
      }),
    ),
  },
  'desk-servers-before': {
    note: 'A runtime before 0.115 (DK-88): no ids, no disk: the cards don’t open, DISK shows “–”, “+2 more” is words',
    timeline: one(
      desk({
        now: WED,
        view: 'summary',
        glance: trim(
          {
            ...SERVERS_GLANCE,
            servers: SERVERS_GLANCE.servers.map(before),
            extraServers: SERVERS_GLANCE.extraServers?.map(before),
          },
          'summary',
        ),
      }),
    ),
  },
  'desk-servers-list': {
    note: 'Every server (DK-86): twelve cards three to a row, scrolling',
    ...HOSTS,
    desk: { page: { kind: 'servers' } },
    timeline: one(desk({ now: WED, view: 'summary', glance: trim(SERVERS_GLANCE, 'summary') })),
  },
  'desk-servers-list-more': {
    note: 'Every server with more than 24: the rest counted in the app',
    ...HOSTS,
    servers: { servers: FLEET_12, more: 31 },
    desk: { page: { kind: 'servers' } },
    timeline: one(desk({ now: WED, view: 'summary', glance: trim(SERVERS_GLANCE, 'summary') })),
  },
  'desk-server': {
    note: 'Frame 2: pve-01’s own screen, locked (A summary): figures, the day’s chart, storage, guests, Ask',
    ...HOSTS,
    desk: opened('pve-01'),
    timeline: one(desk({ now: WED, view: 'summary', glance: trim(SERVERS_GLANCE, 'summary') })),
  },
  'desk-server-unlocked': {
    note: 'pve-01’s screen unlocked: the lock chip with its minutes',
    ...HOSTS,
    desk: opened('pve-01'),
    timeline: one(desk({ now: WED, lock: UNLOCKED(WED), glance: SERVERS_GLANCE })),
  },
  'desk-server-1h': {
    note: 'pve-01 over the last hour',
    ...HOSTS,
    desk: { ...opened('pve-01'), range: '1h' },
    timeline: one(desk({ now: WED, view: 'summary', glance: trim(SERVERS_GLANCE, 'summary') })),
  },
  'desk-server-7d': {
    note: 'pve-01 over the last 7 days',
    ...HOSTS,
    desk: { ...opened('pve-01'), range: '7d' },
    timeline: one(desk({ now: WED, view: 'summary', glance: trim(SERVERS_GLANCE, 'summary') })),
  },
  'desk-server-linux': {
    note: 'A Linux server without guests: storage alone beside the chart',
    ...HOSTS,
    desk: opened('pi-hole'),
    timeline: one(desk({ now: WED, view: 'summary', glance: trim(SERVERS_GLANCE, 'summary') })),
  },
  'desk-server-off': {
    note: 'An off server: the figures “–”, “backup-box is off.” in the chart’s place',
    ...HOSTS,
    desk: opened('backup-box'),
    timeline: one(desk({ now: WED, view: 'summary', glance: trim(SERVERS_GLANCE, 'summary') })),
  },
  'desk-server-alerts': {
    note: 'Two things to look at, unlocked: their titles over the chart, the state amber',
    ...HOSTS,
    desk: opened('the-falcon'),
    timeline: one(desk({ now: WED, lock: UNLOCKED(WED), glance: SERVERS_GLANCE })),
  },
  'desk-server-alerts-locked': {
    note: 'The same locked in A summary: counted in the header, no titles (DK-84)',
    ...HOSTS,
    desk: opened('the-falcon'),
    timeline: one(desk({ now: WED, view: 'summary', glance: trim(SERVERS_GLANCE, 'summary') })),
  },
  'desk-server-unavailable': {
    note: 'The hosts service doesn’t answer: the card’s figures, “I can’t reach your servers right now.”',
    ...HOSTS,
    hostsAwayAfter: 0,
    desk: opened('nas'),
    timeline: one(desk({ now: WED, view: 'summary', glance: trim(SERVERS_GLANCE, 'summary') })),
  },
  'desk-server-ask-locked': {
    note: 'Ask about pve-01 on a locked screen: the PIN pad over its screen, then Talk about it',
    ...HOSTS,
    unlockedGlance: SERVERS_GLANCE,
    desk: { ...opened('pve-01'), overlay: { kind: 'unlock', next: 'talk' } },
    timeline: one(desk({ now: WED, view: 'summary', glance: trim(SERVERS_GLANCE, 'summary') })),
  },
  'desk-self': {
    note: 'This Whombat’s own screen (DK-87): its panel at full size',
    ...HOSTS,
    desk: { page: { kind: 'self' } },
    timeline: one(desk({ now: WED, view: 'summary', glance: trim(SERVERS_GLANCE, 'summary') })),
  },
};

export const DESK_FIXTURES: Record<string, Fixture> = {
  ...DESK_FOUND_FIXTURES,
  ...DESK_SERVER_FIXTURES,
  // Glance (mockup 1)
  'desk-glance': {
    note: 'Glance, locked, “Everything” (mockup 1)',
    timeline: one(desk({ view: 'everything' })),
  },
  'desk-glance-summary': {
    note: 'Glance, locked, “A summary” (the default): counts, no titles',
    unlockedGlance: FULL,
    timeline: one(desk({ view: 'summary' })),
  },
  'desk-glance-time': {
    note: 'Locked, “Only the time”',
    unlockedGlance: FULL,
    timeline: one(desk({ view: 'time' })),
  },
  'desk-glance-unlocked': {
    note: 'Glance, unlocked: Talk to Neo, locks in 2 min',
    timeline: one(desk({ lock: UNLOCKED(DAY) })),
  },
  'desk-glance-here': {
    note: 'Glance, unlocked, the camera on and seeing John: the camera mark, stays unlocked while you’re here (DK-28)',
    timeline: one(desk({ lock: HERE(DAY) })),
  },
  'desk-glance-looking': {
    note: 'Glance, unlocked, the camera on but nobody seen yet: the camera mark, locks in 2 min (DK-28, DK-30)',
    timeline: one(desk({ lock: LOOKING(DAY) })),
  },
  'desk-glance-calm': {
    note: 'Nothing needs you, a server down, one off, more servers, two tiles',
    timeline: one(desk({ glance: CALM })),
  },
  'desk-glance-alert': {
    note: 'A new ask just arrived: the amber edge (DK-08)',
    idleMs: 60_000,
    desk: { alertAgo: 4000 },
    timeline: one(desk({ view: 'everything' })),
  },
  'desk-glance-battery': {
    note: 'Glance on battery: the chip and the one-line banner',
    timeline: one(desk({ view: 'everything', power: { ...POWER_CUT, since: at(DAY, -27) } })),
  },
  'desk-glance-charging': {
    note: 'Glance, summary, plugged in and charging',
    timeline: one(desk({ view: 'summary', power: { ...PLUGGED, percent: 64, charging: true } })),
  },
  'desk-glance-camera': {
    note: 'Glance, locked, the camera on to see when you’re here and seeing John: its mark on the lock chip (DK-73)',
    idleMs: 12 * 60_000,
    timeline: one(desk({ view: 'summary', presence: SEEN })),
  },
  'desk-stays': {
    note: 'Glance, unlocked until Lock: “Unlocked as John”, no minutes (DK-74)',
    timeline: one(desk({ lock: STAYS(DAY) })),
  },
  'desk-stays-talk': {
    note: 'Talk on a screen that stays unlocked: the same chip beside Back',
    desk: { talkOpen: true },
    timeline: one(desk({ lock: STAYS(DAY), presence: SEEN })),
  },

  // Nobody there: the glance, dimmed (DK-97; before, only the clock: DK-70, DK-71)
  'desk-idle': {
    note: 'Untouched for 12 minutes, nothing needs you: the glance, dimmed (DK-97)',
    idleMs: 12 * 60_000,
    timeline: one(desk({ view: 'summary', glance: trim(CALM_NIGHT(), 'summary') })),
  },
  'desk-idle-needs': {
    note: 'Dimmed, something needs you: Needs you shows it',
    idleMs: 12 * 60_000,
    timeline: one(desk({ view: 'summary' })),
  },
  'desk-idle-camera': {
    note: 'The camera on, nobody seen for two minutes: dimmed, the camera’s mark on the lock chip (DK-71, DK-73)',
    idleMs: 2 * 60_000,
    timeline: one(desk({ view: 'summary', glance: trim(CALM_NIGHT(), 'summary'), presence: NOBODY })),
  },
  'desk-idle-battery': {
    note: 'Dimmed on battery: the one-line banner at the bottom (DK-10)',
    idleMs: 12 * 60_000,
    timeline: one(desk({ view: 'summary', power: { ...POWER_CUT, since: at(DAY, -27) } })),
  },
  'desk-idle-unlocked': {
    note: 'Unlocked until Lock, untouched for 12 minutes: dimmed too (it stays unlocked)',
    idleMs: 12 * 60_000,
    timeline: one(desk({ lock: STAYS(DAY), glance: CALM_NIGHT() })),
  },
  'desk-idle-time': {
    note: '“Only the time” locked, untouched for 12 minutes: the clock with its line, dimmed',
    idleMs: 12 * 60_000,
    timeline: one(desk({ view: 'time' })),
  },
  'desk-glance-no-battery': {
    note: 'A machine without a battery: no power chip',
    timeline: one(desk({ view: 'everything', power: null })),
  },
  'desk-glance-no-tiles': {
    note: 'Glance, locked, “Everything”, no home tiles',
    timeline: one(desk({ glance: { ...trim(FULL, 'everything'), tiles: [] } })),
  },
  'desk-glance-no-servers': {
    note: 'Glance, locked, “A summary”, no servers (only home tiles)',
    timeline: one(desk({ glance: { ...trim(FULL, 'summary'), servers: [] } })),
  },
  'desk-glance-bare': {
    note: 'Glance, locked, “A summary”, no servers and no tiles',
    timeline: one(desk({ glance: { ...trim(FULL, 'summary'), servers: [], tiles: [] } })),
  },
  'desk-glance-summary-battery': {
    note: 'Glance, locked, “A summary”, on battery',
    timeline: one(desk({ view: 'summary', power: { ...POWER_CUT, since: at(DAY, -27) } })),
  },
  'desk-glance-many-asks': {
    note: 'Glance, unlocked, five asks: two rows and “and 3 more”',
    timeline: one(
      desk({
        lock: UNLOCKED(DAY),
        glance: {
          ...FULL,
          needsYou: {
            count: 5,
            items: [
              PLEX,
              TRACKER,
              QUESTION,
              { ...PLEX, number: 43, title: 'Update pve-01 now?' },
              { ...PLEX, number: 44 },
            ],
          },
        },
      }),
    ),
  },
  // A new box: This Whombat until there are servers or tiles (DK-22, DK-23; mockup new-box.html)
  'desk-box': {
    note: 'A new box, locked, “A summary” (the default): This Whombat and the calm Needs you (new-box.html)',
    unlockedGlance: NEW_BOX,
    timeline: one(desk({ view: 'summary', glance: trim(NEW_BOX, 'summary') })),
  },
  'desk-box-everything': {
    note: 'A new box, locked, “Everything”: Done today takes a row, the panel keeps its figures without the chart',
    unlockedGlance: NEW_BOX_WORKING,
    timeline: one(
      desk({ view: 'everything', glance: trim({ ...NEW_BOX, done: NEW_BOX_WORKING.done }, 'everything') }),
    ),
  },
  'desk-box-unlocked': {
    note: 'A new box, unlocked: Talk to Neo, locks in 2 min',
    timeline: one(desk({ lock: UNLOCKED(DAY), glance: NEW_BOX })),
  },
  'desk-box-working': {
    note: 'A new box, unlocked, Working on and Done today: the panel takes what is left, figures in one row',
    timeline: one(desk({ lock: UNLOCKED(DAY), glance: NEW_BOX_WORKING })),
  },
  'desk-box-vm': {
    note: 'A VM: no temperature (no sensor), no battery; storage has the column',
    timeline: one(
      desk({ view: 'summary', power: null, glance: trim({ ...NEW_BOX, box: VM_BOX }, 'summary') }),
    ),
  },
  'desk-box-no-network': {
    note: 'The network and the uptime not known: the line keeps the hint',
    timeline: one(
      desk({
        view: 'summary',
        glance: trim({ ...NEW_BOX, box: { ...BOX, network: null, up: '' } }, 'summary'),
      }),
    ),
  },
  'desk-box-busy': {
    note: 'Busy, full and hot: the tones, a 100 % scale, storage without parts',
    timeline: one(desk({ view: 'summary', glance: trim({ ...NEW_BOX, box: BUSY_BOX }, 'summary') })),
  },
  'desk-box-short': {
    note: 'Up for twelve minutes with a gap: the line starts late and breaks, a 50 % scale',
    timeline: one(desk({ view: 'summary', glance: trim({ ...NEW_BOX, box: SHORT_BOX }, 'summary') })),
  },
  'desk-box-asks': {
    note: 'A new box with something to decide: Needs you as always, the panel below',
    unlockedGlance: { ...NEW_BOX, status: FULL.status, needsYou: { count: 1, items: [PLEX] } },
    timeline: one(
      desk({
        view: 'summary',
        glance: trim({ ...NEW_BOX, status: FULL.status, needsYou: { count: 1, items: [PLEX] } }, 'summary'),
      }),
    ),
  },
  'desk-box-battery': {
    note: 'A new box on battery: the banner under the panel',
    timeline: one(
      desk({
        view: 'summary',
        power: { ...POWER_CUT, since: at(DAY, -27) },
        glance: trim(NEW_BOX, 'summary'),
      }),
    ),
  },
  'desk-box-no-pin': {
    note: 'The screen paired itself, no PIN yet: Unlock as John with only Confirm on your phone (DK-18)',
    desk: { overlay: { kind: 'unlock', next: null } },
    unlockedGlance: NEW_BOX,
    timeline: one(
      desk({
        view: 'summary',
        paired: paired({ lockedView: 'summary', hasPin: false }),
        glance: trim(NEW_BOX, 'summary'),
      }),
    ),
  },
  'desk-box-no-pin-phone': {
    note: 'No PIN yet, Confirm on your phone pressed: Check your phone',
    desk: { overlay: { kind: 'unlock', next: null } },
    timeline: one(
      desk({
        view: 'summary',
        paired: paired({ lockedView: 'summary', hasPin: false }),
        glance: trim(NEW_BOX, 'summary'),
        lock: { ...LOCKED, state: 'phone', expiresAt: new Date(Date.parse(DAY) + 102_000).toISOString() },
      }),
    ),
  },
  // One glance that fits what there is (DK-37…DK-42, CG-135…): This Whombat beside servers and tiles, up to eight each
  'desk-fit-two': {
    note: 'Two servers and nothing else: two wide cards, This Whombat the panel below (DK-39, DK-40)',
    timeline: one(
      desk({
        view: 'summary',
        glance: trim({ ...WITH_SELF, ...NOTHING_TO_DO, servers: SERVERS.slice(0, 2), tiles: [] }, 'summary'),
      }),
    ),
  },
  'desk-fit-mockup': {
    note: 'Four servers, four tiles, Working on and Done today: This Whombat a card first, one server counted (layouts mockup 1)',
    timeline: one(desk({ view: 'everything', glance: trim(WITH_SELF, 'everything') })),
  },
  'desk-fit-summary': {
    note: 'The same world in “A summary”: room for the panel under four servers and four tiles',
    unlockedGlance: WITH_SELF,
    timeline: one(desk({ view: 'summary', glance: trim(WITH_SELF, 'summary') })),
  },
  'desk-fit-vm': {
    note: 'This Whombat’s card on a VM: storage instead of the temperature',
    timeline: one(
      desk({ view: 'everything', power: null, glance: trim({ ...WITH_SELF, self: VM_BOX }, 'everything') }),
    ),
  },
  'desk-fit-battery': {
    note: 'On battery with every row: the card and three servers, the tiles make way (DK-39)',
    timeline: one(
      desk({
        view: 'everything',
        power: { ...POWER_CUT, since: at(DAY, -27) },
        glance: trim(WITH_SELF, 'everything'),
      }),
    ),
  },
  'desk-fit-eight': {
    note: 'Eight servers sent, two more not sent, no tiles: the card and seven in two rows, “+3 more” (DK-41)',
    timeline: one(
      desk({
        view: 'summary',
        glance: trim({ ...WITH_SELF, ...NOTHING_TO_DO, ...EIGHT, moreServers: 6, tiles: [] }, 'summary'),
      }),
    ),
  },
  'desk-fit-full': {
    note: 'Eight servers and eight tiles: the card, seven servers, “+1 more”, two rows of tiles',
    timeline: one(
      desk({ view: 'summary', glance: trim({ ...WITH_SELF, ...EIGHT, ...EIGHT_TILES }, 'summary') }),
    ),
  },
  'desk-fit-tiles': {
    note: 'Five tiles and no servers: three over two, the panel below',
    timeline: one(
      desk({
        view: 'summary',
        glance: trim(
          { ...WITH_SELF, ...NOTHING_TO_DO, servers: [], ...EIGHT_TILES, extraTiles: MORE_TILES.slice(0, 1) },
          'summary',
        ),
      }),
    ),
  },
  'desk-fit-tiles-eight': {
    note: 'Eight tiles and no servers: two rows of four, the panel below',
    timeline: one(
      desk({
        view: 'summary',
        glance: trim({ ...WITH_SELF, ...NOTHING_TO_DO, servers: [], ...EIGHT_TILES }, 'summary'),
      }),
    ),
  },
  'desk-fit-before': {
    note: 'A runtime before 0.104 (no This Whombat beside servers): two servers and three tiles share their rows',
    timeline: one(
      desk({
        view: 'summary',
        glance: trim(
          { ...FULL, ...NOTHING_TO_DO, servers: SERVERS.slice(0, 2), tiles: FULL.tiles.slice(0, 3) },
          'summary',
        ),
      }),
    ),
  },
  'desk-restart': {
    note: 'Whombat restarts while an ask is open unlocked: the last desk, locked, and Reconnecting… after 10 s',
    desk: { overlay: { kind: 'ask', number: 41 } },
    timeline: [
      { at: 0, state: desk({ lock: UNLOCKED(DAY) }) },
      { at: 1500, state: { ...desk({ lock: UNLOCKED(DAY) }), desk: null } },
    ],
  },
  'desk-restart-night': {
    note: 'Whombat restarts in quiet hours: the night clock stays',
    idleMs: 5 * 60_000,
    timeline: [
      { at: 0, state: desk({ now: NIGHT, paired: paired({ quiet: true }), power: POWER_CUT }) },
      { at: 1500, state: { ...desk({ now: NIGHT, paired: paired({ quiet: true }) }), desk: null } },
    ],
  },
  'desk-live': {
    note: 'Locked glance; a new ask arrives after 3 s (wake, amber edge, chime)',
    timeline: [
      {
        at: 0,
        state: desk({
          glance: {
            ...trim(FULL, 'everything'),
            needsYou: { count: 1, items: [trim(FULL, 'everything').needsYou.items[1] as DeskAsk] },
          },
        }),
      },
      { at: 3000, state: desk({ view: 'everything' }) },
    ],
  },

  // Ask and unlock (mockup 2)
  'desk-ask-locked': {
    note: 'Ask + PIN pad, three digits typed (mockup 2; locked, only the title even when the page has more: CG-50)',
    desk: { overlay: { kind: 'ask', number: 41 }, digits: '123' },
    unlockedGlance: FULL,
    timeline: one(
      desk({
        glance: {
          ...FULL,
          needsYou: { count: 2, items: [PLEX, trim(FULL, 'everything').needsYou.items[1] as DeskAsk] },
        },
      }),
    ),
  },
  'desk-ask-locked-trimmed': {
    note: 'Ask + PIN pad as the runtime sends it while locked (no detail yet)',
    desk: { overlay: { kind: 'ask', number: 41 } },
    unlockedGlance: FULL,
    timeline: one(desk({ view: 'everything' })),
  },
  'desk-ask': {
    note: 'Ask, unlocked: Restart Plex · Not now · Ask',
    desk: { overlay: { kind: 'ask', number: 41 } },
    timeline: one(desk({ lock: UNLOCKED(DAY) })),
  },
  'desk-ask-phone': {
    note: 'Ask that stays on the phone (a message to someone outside, DK-05)',
    desk: { overlay: { kind: 'ask', number: 40 } },
    timeline: one(desk({ lock: UNLOCKED(DAY) })),
  },
  'desk-ask-question': {
    note: 'A question Neo asked: Answer opens Talk',
    desk: { overlay: { kind: 'ask', number: 42 } },
    timeline: one(
      desk({
        lock: UNLOCKED(DAY),
        glance: { ...FULL, needsYou: { count: 3, items: [QUESTION, PLEX, TRACKER] } },
      }),
    ),
  },
  'desk-ask-gone': {
    note: 'The ask was answered on the phone while the sheet was open',
    desk: { overlay: { kind: 'ask', number: 41 } },
    timeline: [
      { at: 0, state: desk({ lock: UNLOCKED(DAY) }) },
      {
        at: 1200,
        state: desk({ lock: UNLOCKED(DAY), glance: { ...FULL, needsYou: { count: 1, items: [TRACKER] } } }),
      },
    ],
  },
  'desk-ask-relock': {
    note: 'An ask open unlocked, then Whombat locks the screen: the sheet closes, the glance as locked (CG-50)',
    desk: { overlay: { kind: 'ask', number: 41 } },
    timeline: [
      { at: 0, state: desk({ view: 'summary', lock: UNLOCKED(DAY) }) },
      { at: 1500, state: desk({ view: 'summary' }) },
    ],
  },
  'desk-away-unlocked': {
    note: 'An ask open unlocked, then the console server stops answering: locked and trimmed at once (CG-51)',
    desk: { overlay: { kind: 'ask', number: 41 } },
    awayAfter: 1500,
    timeline: one(desk({ view: 'summary', lock: UNLOCKED(DAY) })),
  },
  'desk-unlock': {
    note: 'PIN pad alone (touched the locked glance); the demo PIN is 123456',
    desk: { overlay: { kind: 'unlock', next: null } },
    unlockedGlance: FULL,
    timeline: one(desk({ view: 'summary' })),
  },
  'desk-unlock-four': {
    note: 'PIN pad of a 4-digit PIN, two digits typed (DK-26); the demo PIN is 2580',
    desk: { overlay: { kind: 'unlock', next: null }, digits: '25' },
    unlockedGlance: FULL,
    camera: 'present',
    timeline: one(desk({ view: 'summary', paired: paired({ lockedView: 'summary', pinDigits: 4 }) })),
  },
  'desk-unlock-four-typed': {
    note: 'The 4-digit PIN typed: unlocked at the fourth digit, the camera on and seeing John',
    desk: { overlay: { kind: 'unlock', next: null } },
    unlockedGlance: FULL,
    camera: 'present',
    timeline: one(desk({ view: 'summary', paired: paired({ lockedView: 'summary', pinDigits: 4 }) })),
  },
  'desk-unlock-wrong': {
    note: 'A wrong PIN: 4 tries left',
    desk: { overlay: { kind: 'unlock', next: null } },
    timeline: one(desk({ view: 'summary' })),
  },
  'desk-unlock-backoff': {
    note: 'Five wrong PINs: wait (DK-04)',
    desk: { overlay: { kind: 'unlock', next: null } },
    timeline: one(desk({ view: 'summary', lock: { ...LOCKED, state: 'backoff', retryAt: at(DAY, 1.5) } })),
  },
  'desk-unlock-phone': {
    note: 'Confirm on your phone: Check your phone, 1:42 left',
    desk: { overlay: { kind: 'unlock', next: null } },
    timeline: one(
      desk({
        view: 'summary',
        lock: { ...LOCKED, state: 'phone', expiresAt: new Date(Date.parse(DAY) + 102_000).toISOString() },
      }),
    ),
  },

  // Asks that come to you (DK-60…DK-62)
  'desk-popup': {
    note: 'A new ask opened by itself, unlocked: Restart Plex · Deny · Not now · Ask, “1 of 2” (DK-60, DK-61)',
    desk: { overlay: { kind: 'ask', number: 41 }, queue: [41, 45] },
    timeline: one(desk({ lock: UNLOCKED(DAY), glance: ASKS_GLANCE })),
  },
  'desk-popup-live': {
    note: 'Unlocked glance; a new ask arrives after 2 s and its card opens by itself (DK-60)',
    timeline: [
      {
        at: 0,
        state: desk({ lock: UNLOCKED(DAY), glance: { ...FULL, needsYou: { count: 1, items: [TRACKER_D] } } }),
      },
      { at: 2000, state: desk({ lock: UNLOCKED(DAY), glance: ASKS_GLANCE }) },
    ],
  },
  'desk-popup-locked': {
    note: 'A new ask on a locked screen, “Everything”: the card without its words beside the PIN pad (DK-60)',
    desk: { overlay: { kind: 'ask', number: 41 }, queue: [41] },
    unlockedGlance: ASKS_GLANCE,
    timeline: one(desk({ view: 'everything', glance: trim(ASKS_GLANCE, 'everything') })),
  },
  'desk-popup-locked-summary': {
    note: 'A new ask on a locked screen, “A summary”: the pad alone, “Neo needs your answer.” (DK-60)',
    desk: { overlay: { kind: 'unlock', next: 'ask', reason: true } },
    unlockedGlance: ASKS_GLANCE,
    timeline: one(desk({ view: 'summary', glance: trim(ASKS_GLANCE, 'summary') })),
  },
  'desk-popup-talk': {
    note: 'Neo asks while you talk: the card over Talk, asked in the conversation (DK-60, DK-63)',
    desk: { talkOpen: true, overlay: { kind: 'ask', number: 41 }, queue: [41] },
    session: CONVO_ASKING,
    timeline: one(
      desk({
        lock: UNLOCKED(DAY),
        glance: { ...FULL, needsYou: { count: 1, items: [{ ...PLEX_D, at: at(DAY, -0.2), inTalk: true }] } },
      }),
    ),
  },
  'desk-ask-risky': {
    note: 'A risky ask (it deploys): Approve asks for the PIN, Deny and Not now don’t (DK-62)',
    desk: { overlay: { kind: 'ask', number: 45 } },
    timeline: one(desk({ lock: UNLOCKED(DAY), glance: ASKS_GLANCE })),
  },
  'desk-ask-risky-pin': {
    note: 'A risky ask’s Approve: the PIN pad beside the card; the demo PIN is 123456 (DK-62)',
    desk: { overlay: { kind: 'ask', number: 45 }, approvePin: 45 },
    timeline: one(desk({ lock: UNLOCKED(DAY), glance: ASKS_GLANCE })),
  },
  'desk-ask-risky-no-pin': {
    note: 'A risky ask on a screen without a PIN: approve it on the phone; Deny and Not now here (DK-62)',
    desk: { overlay: { kind: 'ask', number: 45 } },
    timeline: one(
      desk({
        lock: UNLOCKED(DAY),
        paired: paired({ hasPin: false }),
        glance: { ...FULL, needsYou: { count: 1, items: [{ ...DEPLOY, approveWithPin: false }] } },
      }),
    ),
  },

  // Talk as a conversation (DK-63, DK-64)
  'desk-talk-convo': {
    note: 'Talk as a conversation: questions, answers, an ask approved, blackbox’s card, Close conversation (DK-63)',
    desk: { talkOpen: true },
    session: CONVO,
    timeline: one(desk({ lock: UNLOCKED(DAY) })),
  },
  'desk-talk-convo-top': {
    note: 'Scrolled up in a long conversation: earlier ones in Chat, “New message” (DK-63)',
    desk: { talkOpen: true, convoTop: true },
    session: CONVO_LONG,
    timeline: one(desk({ lock: UNLOCKED(DAY) })),
  },
  'desk-talk-convo-thinking': {
    note: 'A question asked in the conversation, its answer on the way (DK-63)',
    desk: { talkOpen: true, talk: { phase: 'waiting', id: 'talk-0103', typed: 'Is blackbox okay now?' } },
    session: CONVO,
    timeline: one(
      desk({
        lock: UNLOCKED(DAY),
        talk: {
          ...ANSWER,
          id: 'talk-0103',
          state: 'thinking',
          question: null,
          answer: null,
          thing: null,
          audio: false,
        },
      }),
    ),
  },
  // Task feedback (TF-14…TF-18, CG-280…)
  'desk-ask-choice': {
    note: 'Neo asks; the web’s “Don’t ask again on Home Assistant” right after Approve, with its lock (TF-14)',
    desk: { overlay: { kind: 'ask', number: 47 } },
    timeline: one(desk({ lock: UNLOCKED(DAY), glance: CHOICE_GLANCE })),
  },
  'desk-ask-choice-two': {
    note: 'Banjo asks (TF-15): both wider choices, for this task and always (TF-14)',
    desk: { overlay: { kind: 'ask', number: 48 } },
    timeline: one(desk({ lock: UNLOCKED(DAY), glance: CHOICE_GLANCE })),
  },
  'desk-ask-choice-pin': {
    note: 'A wider choice needs the PIN: the pad beside the card says which (TF-14); the demo PIN is 123456',
    desk: { overlay: { kind: 'ask', number: 47 }, approvePin: 47, approveChoice: 'agent' },
    timeline: one(desk({ lock: UNLOCKED(DAY), glance: CHOICE_GLANCE })),
  },
  'desk-ask-choice-risky': {
    note: 'A risky ask approved with the PIN, “Always allow Banjo to deploy” after it (DK-62, TF-14)',
    desk: { overlay: { kind: 'ask', number: 49 } },
    timeline: one(desk({ lock: UNLOCKED(DAY), glance: CHOICE_GLANCE })),
  },
  'desk-ask-choice-not-offered': {
    note: 'The choice went meanwhile: “That choice isn’t available here any more.” after the PIN (not_offered, TF-14)',
    desk: { overlay: { kind: 'ask', number: 47 }, approvePin: 47, approveChoice: 'agent' },
    notOffered: true,
    timeline: one(desk({ lock: UNLOCKED(DAY), glance: CHOICE_GLANCE })),
  },
  'desk-ask-choice-locked': {
    note: 'The same ask on a locked screen: no choices, “Neo asks” beside the PIN pad (CG-50)',
    desk: { overlay: { kind: 'ask', number: 47 } },
    unlockedGlance: CHOICE_GLANCE,
    timeline: one(desk({ view: 'everything', glance: trim(CHOICE_GLANCE, 'everything') })),
  },
  'desk-talk-working': {
    note: 'Past 90 s the talk is working: “Neo is working on it…”, followed until the answer (TF-16)',
    desk: { talkOpen: true, talk: { phase: 'waiting', id: 'talk-0104', typed: 'Is blackbox okay now?' } },
    session: CONVO,
    timeline: one(
      desk({
        lock: UNLOCKED(DAY),
        talk: {
          ...ANSWER,
          id: 'talk-0104',
          state: 'working',
          question: null,
          answer: null,
          thing: null,
          audio: false,
        },
      }),
    ),
  },
  'desk-talk-tasks': {
    note: 'Updating Home Assistant: an earlier task done, the ask approved, the task running (its time ticks), Neo working (TF-17)',
    desk: { talkOpen: true },
    session: CONVO_WORK,
    timeline: one(desk({ lock: UNLOCKED(DAY) })),
  },
  'desk-talk-tasks-done': {
    note: 'The task ended: how it went and how long it took, Neo’s words after it; one that didn’t work (TF-17)',
    desk: { talkOpen: true },
    session: CONVO_DONE,
    timeline: one(desk({ lock: UNLOCKED(DAY) })),
  },
  'desk-talk-relock': {
    note: 'Talk after a task ended, then the screen locks: no words while locked; unlock (123456) and Talk is back (TF-18)',
    desk: { talkOpen: true },
    session: { ...CONVO_DONE, earlier: 4, messages: [...CONVO.messages, ...CONVO_DONE.messages] },
    unlockedGlance: FULL,
    timeline: [
      { at: 0, state: desk({ lock: UNLOCKED(DAY) }) },
      { at: 1500, state: desk({ view: 'everything' }) },
    ],
  },
  'desk-talk-idle': {
    note: 'Nobody there for 12 minutes with Talk open: the dimmed glance; a touch and the conversation is back (TF-18)',
    desk: { talkOpen: true },
    session: CONVO_DONE,
    idleMs: 12 * 60_000,
    timeline: one(desk({ lock: STAYS(DAY) })),
  },
  'desk-talk-closed': {
    note: 'Talk after Close conversation (or 30 minutes): empty, the opening line (DK-64)',
    desk: { talkOpen: true },
    session: { open: false, messages: [], earlier: 0, until: null },
    talkAnswer: ANSWER,
    timeline: one(desk({ lock: UNLOCKED(DAY) })),
  },

  // Talk (mockup 3)
  'desk-talk': {
    note: 'Talk: the answer with pve-02 (mockup 3)',
    desk: { talkOpen: true, talk: { phase: 'done', id: 'talk-0001', typed: null } },
    timeline: one(desk({ lock: UNLOCKED(DAY), talk: ANSWER })),
  },
  'desk-talk-here': {
    note: 'Talk with the camera on and seeing John: the lock chip beside Back',
    desk: { talkOpen: true, talk: { phase: 'done', id: 'talk-0001', typed: null } },
    timeline: one(desk({ lock: HERE(DAY), talk: ANSWER })),
  },
  'desk-talk-ready': {
    note: 'Talk, nothing asked yet',
    desk: { talkOpen: true },
    talkAnswer: ANSWER,
    timeline: one(desk({ lock: UNLOCKED(DAY) })),
  },
  // Talk's mic is voice typing (CG-359…CG-363): the recording bar, the words in the box, a failure on the mic's line.
  'desk-talk-recording': {
    note: 'The mic tapped: Cancel · the live bars · Recording 0:12 · Done',
    desk: {
      talkOpen: true,
      // The page's clock: twelve seconds in when the fixture loads.
      dictation: { phase: 'recording', since: Date.now() - 12_400 },
      levels: [0.1, 0.3, 0.6, 0.45, 0.8, 0.5, 0.95, 0.4, 0.7, 0.3, 0.55, 0.2, 0.4, 0.15],
    },
    talkAnswer: ANSWER,
    timeline: one(desk({ lock: UNLOCKED(DAY) })),
  },
  'desk-talk-transcribing': {
    note: 'Done: Turning speech into text…, the bars resting',
    desk: { talkOpen: true, dictation: { phase: 'transcribing' } },
    talkAnswer: ANSWER,
    timeline: one(desk({ lock: UNLOCKED(DAY) })),
  },
  'desk-talk-heard': {
    note: 'The words the mic heard wait in the box, to change on the keyboard or Send',
    desk: {
      talkOpen: true,
      draft:
        'Can you check whether the nightly backup on blackbox finished, and if pve-02 still has enough room on its disk for next week’s snapshots?',
    },
    talkAnswer: ANSWER,
    timeline: one(desk({ lock: UNLOCKED(DAY) })),
  },
  'desk-talk-mic-failed': {
    note: 'The mic heard nothing: its line says so for five seconds',
    // Its five seconds count from a minute after the fixture loads, so a shot still sees it.
    desk: { talkOpen: true, dictation: { phase: 'idle', error: 'nothing', at: Date.now() + 60_000 } },
    talkAnswer: ANSWER,
    timeline: one(desk({ lock: UNLOCKED(DAY) })),
  },
  'desk-talk-thinking': {
    note: 'Heard, thinking',
    desk: { talkOpen: true, talk: { phase: 'waiting', id: 'talk-0002', typed: null } },
    timeline: one(
      desk({
        lock: UNLOCKED(DAY),
        talk: { ...ANSWER, id: 'talk-0002', state: 'thinking', answer: null, thing: null, audio: false },
      }),
    ),
  },
  'desk-talk-typing': {
    note: 'Typing a question on the keyboard cover',
    desk: { talkOpen: true, draft: 'Did the backup on blackbox finish' },
    talkAnswer: ANSWER,
    timeline: one(desk({ lock: UNLOCKED(DAY) })),
  },
  'desk-talk-not-heard': {
    note: 'I didn’t catch that',
    desk: { talkOpen: true, talk: { phase: 'done', id: 'talk-0003', typed: null } },
    timeline: one(
      desk({
        lock: UNLOCKED(DAY),
        talk: {
          ...ANSWER,
          id: 'talk-0003',
          state: 'failed',
          question: null,
          answer: null,
          thing: null,
          audio: false,
          reason: 'not_heard',
        },
      }),
    ),
  },
  'desk-talk-slow': {
    note: 'Too slow: the answer will be in Chat',
    desk: { talkOpen: true, talk: { phase: 'done', id: 'talk-0004', typed: null } },
    timeline: one(
      desk({
        lock: UNLOCKED(DAY),
        talk: {
          ...ANSWER,
          id: 'talk-0004',
          state: 'failed',
          answer: null,
          thing: null,
          audio: false,
          reason: 'slow',
        },
      }),
    ),
  },
  'desk-talk-no-voice': {
    note: 'Talk with Talk’s voice off (no microphone): typing still asks (DK-T12, CG-53)',
    desk: { talkOpen: true },
    talkAnswer: { ...ANSWER, audio: false },
    timeline: one(desk({ lock: UNLOCKED(DAY), paired: paired({ voice: false }) })),
  },
  'desk-talk-microphone': {
    note: 'The microphone couldn’t be opened: the mic’s line says to type instead',
    // Its five seconds count from a minute after the fixture loads, so a shot still sees it.
    desk: { talkOpen: true, dictation: { phase: 'idle', error: 'microphone', at: Date.now() + 60_000 } },
    timeline: one(desk({ lock: UNLOCKED(DAY) })),
  },

  // Night (mockup 4)
  'desk-night': {
    note: 'Quiet hours with a power cut (mockup 4)',
    idleMs: 5 * 60_000,
    timeline: one(
      desk({
        now: NIGHT,
        paired: paired({ quiet: true }),
        glance: trim(CALM_NIGHT(), 'summary'),
        power: POWER_CUT,
      }),
    ),
  },
  'desk-night-calm': {
    note: 'Quiet hours, plugged in',
    idleMs: 5 * 60_000,
    timeline: one(
      desk({ now: NIGHT, paired: paired({ quiet: true }), glance: trim(CALM_NIGHT(), 'summary') }),
    ),
  },
  'desk-night-asks': {
    note: 'Quiet hours, something needs you (no wake, no sound)',
    idleMs: 5 * 60_000,
    timeline: one(desk({ now: NIGHT, paired: paired({ quiet: true }), view: 'summary' })),
  },
  'desk-night-black': {
    note: 'Quiet hours, “Black”',
    idleMs: 5 * 60_000,
    timeline: one(desk({ now: NIGHT, paired: paired({ quiet: true, night: 'black' }) })),
  },
  'desk-night-touched': {
    note: 'Quiet hours, touched: the glance for a minute',
    timeline: one(
      desk({ now: NIGHT, paired: paired({ quiet: true, lockedView: 'summary' }), power: POWER_CUT }),
    ),
  },

  // A device waiting to sign in at the screen (BX-06, CG-150): the panel over every scene
  'desk-signin': {
    note: 'The sign-in panel over the locked glance (“A summary”)',
    unlockedGlance: FULL,
    timeline: one(signingIn(desk({ view: 'summary' }))),
  },
  'desk-signin-unlocked': {
    note: 'The sign-in panel over the unlocked glance',
    timeline: one(signingIn(desk({ lock: UNLOCKED(DAY) }))),
  },
  'desk-signin-time': {
    note: 'The sign-in panel over “Only the time”',
    unlockedGlance: FULL,
    timeline: one(signingIn(desk({ view: 'time' }))),
  },
  'desk-signin-pin': {
    note: 'The sign-in panel over the PIN pad, two digits typed (they stay for after)',
    desk: { overlay: { kind: 'unlock', next: null }, digits: '12' },
    unlockedGlance: FULL,
    timeline: one(signingIn(desk({ view: 'summary' }))),
  },
  'desk-signin-dimmed': {
    note: 'The sign-in panel on a glance untouched for 12 minutes: it wakes it, the glance and not the clock',
    idleMs: 12 * 60_000,
    timeline: one(signingIn(desk({ view: 'summary' }))),
  },
  'desk-signin-night': {
    note: 'The sign-in panel in quiet hours: it wakes the screen as a touch does (the glance behind it)',
    idleMs: 5 * 60_000,
    timeline: one(
      signingIn(desk({ now: NIGHT, paired: paired({ quiet: true }), glance: trim(CALM_NIGHT(), 'summary') })),
    ),
  },
  'desk-signin-black': {
    note: 'The sign-in panel in quiet hours set to “Black”: awake, the glance behind it',
    idleMs: 5 * 60_000,
    timeline: one(signingIn(desk({ now: NIGHT, paired: paired({ quiet: true, night: 'black' }) }))),
  },

  // Pairing (DK-02) and the claim code winning
  'desk-pairing': {
    note: 'Pairing: the four letters while Settings pairs',
    timeline: one(desk({ paired: null, pairing: { code: 'HBRT', expiresAt: at(DAY, 9.2) } })),
  },
  'desk-claimable-wins': {
    note: 'A paired desk on a box that shows a claim code: the code wins',
    timeline: one({
      ...desk({ view: 'everything' }),
      claim: {
        state: 'claimable',
        code: 'KXQM',
        claimUrl: 'app.whombat.com/claim',
        appUrl: 'app.whombat.com',
        retryAt: null,
        burrows: null,
      },
    }),
  },
};

/** The night: all servers fine, nothing asked. */
function CALM_NIGHT(): DeskGlance {
  return { ...FULL, needsYou: { count: 0, items: [] }, working: null };
}
