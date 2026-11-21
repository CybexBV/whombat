/** Hand-written schema conformance cases: a valid base value per schema and targeted mutations. */

/** `output`: what a valid value parses to when it differs from `value` (unknown members stripped, CT-14). */
type Case = { schema: string; name: string; valid: boolean; value: unknown; output?: unknown };

const now = 1_790_000_000;
/** The 2026-09-28 production failure as a structured detail (CT-137). */
const failureDetail = {
  stage: 'Staged',
  code: 'schema_incompatible',
  reasons: ['candidate_cannot_read_schema'],
  release: 'pve-20260928.5',
  schema: { database: 48, target: null, candidateWrites: 49, candidateReads: { min: 49, max: 49 } },
  failedChecks: [],
  at: now,
};
const set = (v: Record<string, unknown>, patch: Record<string, unknown>) => ({ ...v, ...patch });
const without = (v: Record<string, unknown>, key: string) => {
  const { [key]: _drop, ...rest } = v;
  return rest;
};

function cases(
  schema: string,
  base: Record<string, unknown>,
  variants: ([string, unknown, boolean] | [string, unknown, boolean, unknown])[],
): Case[] {
  return [
    { schema, name: 'base', valid: true, value: base },
    ...variants.map(([name, value, valid, output]) => ({
      schema,
      name,
      valid,
      value,
      ...(output === undefined ? {} : { output }),
    })),
  ];
}

/** A claimed console file with a screen sign-in showing (0.106, CT-626), with `signIn` members replaced. */
const signedIn = (signIn: Record<string, unknown> = {}) => ({
  v: 1,
  state: 'claimed',
  url: 'https://a.b/claim',
  signIn: {
    code: 'KXQMTR',
    name: 'Mara Jansen',
    device: 'Pixel 9',
    expiresAt: '2026-10-20T12:05:00Z',
    ...signIn,
  },
});

const ticket = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
const licenceJwk = {
  kty: 'OKP',
  crv: 'Ed25519',
  kid: 'lic-test-1',
  x: 'A'.repeat(43),
  alg: 'EdDSA',
  use: 'sig',
};
const licenceKeySet = { v: 1, env: 'test', keys: [licenceJwk] };
const feedbackSite = 'fbs_Q3v9xLpA0dZkT7mW2bNcYe12';
const feedbackSig = `${'A'.repeat(85)}Q`;
const feedbackCard = {
  card: { purpose: 'whombat-feedback-site-card', site: feedbackSite },
  sig: feedbackSig,
};
const feedbackDrop = {
  dropId: 'fdr_q3Vx9LpA0dZkT7mW2bNcYe',
  site: feedbackSite,
  receivedAt: now,
  origin: 'https://embed.whombat.com',
  bytes: 4658,
  envelope: 'AAECAwQF',
};
const feedbackDropReporter = {
  id: 'fbr_Zk2mQ9vX4pL7tB0nW3cY8d',
  emailDigest: '2d59d9c037930488db3c5d57661b1e3a1b828d7907a877be35a87d3cf3277e6b',
};
const feedbackReporterUpdate = {
  site: feedbackSite,
  reporterId: feedbackDropReporter.id,
  reference: 'FB-7K3Q-9M2X',
  type: 'bug',
  status: 'needs_info',
  receivedAt: now - 3_600,
  updatedAt: now,
};
const hostPoint = {
  cpuPermille: 125,
  cpuPeakPermille: 610,
  memoryUsedBytes: 1_800_000_000,
  inBytes: 5_400_000,
  outBytes: 120_000,
};
const hostDisk = {
  totalBytes: 93_000_000_000,
  usedBytes: 43_000_000_000,
  freeBytes: 49_000_000_000,
  parts: [
    { key: 'containers', bytes: 24_600_000_000 },
    { key: 'work', bytes: 8_000_000_000 },
  ],
};
const hostMetrics = {
  now: {
    at: '2026-10-11T09:20:10Z',
    cpuPermille: 40,
    cores: 4,
    memoryTotalBytes: 16_700_000_000,
    memoryUsedBytes: 1_800_000_000,
    containersMemoryBytes: 600_000_000,
    uplink: ['enp5s0'],
  },
  disks: {
    data: hostDisk,
    system: { totalBytes: 42_000_000_000, usedBytes: 5_800_000_000, freeBytes: 34_000_000_000 },
    backup: null,
  },
  series: { range: 'day', start: '2026-10-10T09:20:00Z', stepS: 300, points: [hostPoint] },
  days: [
    {
      date: '2026-10-11',
      inBytes: 2_240_000_000,
      outBytes: 40_700_000,
    },
  ],
  timeZone: 'Europe/Amsterdam',
  measuringSince: '2026-10-11T08:00:00Z',
};
const hostPower = {
  source: 'battery',
  percent: 72,
  charging: false,
  minutesLeft: 190,
  chargeLimit: 80,
  since: '2026-10-20T00:14:00Z',
};
// The desk display (0.100, CT-528…CT-532): mockups 1–4 of Whombat desk-display.md.
const deskAt = '2026-10-20T12:34:00Z';
const deskServer = {
  name: 'pve-02',
  mark: 'proxmox',
  state: 'ok',
  note: 'up 41 d',
  cpu: { value: 12, tone: 'ok' },
  memory: { value: 61, tone: 'ok' },
  temp: { value: 49, tone: 'ok' },
};
const deskAsk = {
  number: 12,
  kind: 'approval',
  title: 'Restart Plex on blackbox?',
  at: '2026-10-20T12:31:00Z',
  where: 'blackbox',
  onDesk: true,
};
const deskAskWords = {
  ...deskAsk,
  detail: 'Plex stopped answering at 14:31. A restart usually fixes it and takes about a minute.',
  facts: ['docker restart plex', 'blackbox · Unraid'],
  approveLabel: 'Restart Plex',
};
const deskPaired = {
  person: { name: 'John', initial: 'J', tone: 2 },
  assistant: { name: 'Neo', face: 'neo' },
  timeZone: 'Europe/Amsterdam',
  lockedView: 'summary',
  night: 'dim',
  quiet: false,
  voice: true,
  hasPin: true,
};
const deskGlance = {
  status: {
    text: 'Everything’s fine. I’m updating your server agents, two of four are done.',
    more: 'Plex on blackbox needs a decision.',
  },
  needsYou: { count: 2, items: [deskAsk] },
  working: {
    title: 'Update the server agents',
    steps: [
      { label: 'pve-01', state: 'done' },
      { label: 'pve-02', state: 'done' },
      { label: 'the-falcon', state: 'now' },
      { label: 'blackbox', state: 'next' },
    ],
  },
  done: [{ text: 'Renewed the certificate on pve-01', at: '2026-10-20T07:12:00Z' }],
  servers: [deskServer, { name: 'the-falcon', mark: 'linux', state: 'warn', note: 'updating' }],
  moreServers: 0,
  tiles: [
    { icon: 'temperature', value: '21.4 °C', label: 'Living room' },
    { icon: 'lock', value: 'Locked', label: 'Front door', tone: 'ok' },
  ],
};
const deskPower = {
  source: 'ac',
  percent: 80,
  charging: false,
  minutesLeft: null,
  chargeLimit: 80,
  since: null,
};
const deskState = {
  v: 1,
  now: deskAt,
  paired: deskPaired,
  pairing: null,
  lock: { state: 'locked' },
  glance: deskGlance,
  power: deskPower,
  talk: null,
};
const deskSession = {
  v: 1,
  open: true,
  messages: [
    {
      id: 'msg_Hq2v8LkP0aXz',
      from: 'you',
      at: '2026-10-20T12:30:00Z',
      paragraphs: ['Plex isn’t working, can you restart it?'],
      talk: 'tlk_q3Vx9LpA0dZk',
    },
    {
      id: 'msg_Jt5c1MnQ7bWy',
      from: 'assistant',
      at: '2026-10-20T12:30:20Z',
      paragraphs: [
        'Plex on blackbox stopped answering at 14:31.',
        '• It usually comes back after a restart.',
      ],
      more: true,
      talk: 'tlk_q3Vx9LpA0dZk',
      audio: true,
      thing: deskServer,
    },
    {
      id: 'msg_Kr4d2NpS9cVx',
      from: 'assistant',
      at: '2026-10-20T12:30:21Z',
      paragraphs: ['Restart Plex on blackbox?'],
      ask: { number: 12, state: 'waiting' },
    },
  ],
  earlier: 0,
  until: '2026-10-20T13:00:21Z',
};
// 0.116 (CT-894, CT-895; Whombat task-feedback.md TF-17): the assistant working, and a server task as a row.
const deskTaskRunning = {
  title: 'Installing 23 updates on Home Assistant',
  state: 'running',
  startedAt: '2026-10-20T12:31:10Z',
};
const deskTaskDone = {
  ...deskTaskRunning,
  state: 'ok',
  endedAt: '2026-10-20T12:35:12Z',
  result: 'Home Assistant is up to date: 23 updates installed. It needs a restart for the new kernel.',
};
const deskTaskMessage = (task: Record<string, unknown>) => ({
  id: 'msg_Lp7e3QrT1dYw',
  from: 'assistant',
  at: '2026-10-20T12:31:10Z',
  paragraphs: ['Installing 23 updates on Home Assistant'],
  task,
});
const deskSessionWorking = {
  ...deskSession,
  messages: [...deskSession.messages, deskTaskMessage(deskTaskRunning)],
  working: { since: '2026-10-20T12:31:00Z', doing: 'Installing updates on Home Assistant' },
};
const deskTalk = {
  id: 'tlk_q3Vx9LpA0dZk',
  state: 'answered',
  question: 'Is pve-02 okay, and did last night’s backup run?',
  answer: 'Yes, pve-02 is fine. The backup ran at 03:00 and finished in 14 minutes.',
  thing: deskServer,
  audio: true,
};
/** A 44-byte WAV header of 16 kHz mono 16-bit PCM without samples. */
const deskWav = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';
// Needs you's looks (0.118, CT-970; Whombat desk-display.md DK-93): a server down, a connection to look at.
const deskLooks = [
  {
    key: 'server:pve-02',
    kind: 'server',
    name: 'pve-02',
    state: 'down',
    reason: 'Not answering',
    server: 'pve-02',
  },
  {
    key: 'connection:con_7Hq2v8LkP0aX',
    kind: 'connection',
    name: 'Home Assistant',
    state: 'look',
    reason: '2 integrations not loading',
  },
];
// Looks that can be quieted (0.122, CT-1065; Whombat quiet-notices.md QN-20): an access point off, a sign-in only
// the person can do.
/** What the assistant found out about a look (3.5). */
const deskLooking = { key: 'server:pve-02', state: 'looking', at: '2026-10-27T10:12:00Z' };
const deskResearchedLook = {
  key: 'connection:con_hass0000Zigb',
  kind: 'connection',
  name: 'Home Assistant',
  state: 'look',
  reason: '2 integrations not loading',
  research: {
    key: 'connection:con_hass0000Zigb',
    state: 'found',
    title: 'Zigbee stopped working in Home Assistant',
    summary:
      'After this morning’s update, Zigbee didn’t start again, so the hallway lights and the motion sensors don’t respond. Restarting it usually fixes this.',
    fix: 'Restart Zigbee',
    conversationId: 'cnv_7Hq2v8LkP0aX',
    threadRootId: 'msg_7Hq2v8LkP0aX',
    at: '2026-10-27T10:13:30Z',
  },
};

const deskQuietLooks = [
  {
    key: 'connection:con_unifi0000Ap',
    kind: 'connection',
    name: 'UniFi',
    state: 'look',
    reason: 'Hallway AP is offline',
    notice: { check: 'unifi.device_offline', subject: 'device:64a1c3f00e2b' },
    nature: 'problem',
    ignoreWords: 'Until it’s back online.',
    question: 'Why is Hallway AP offline in UniFi?',
  },
  {
    key: 'connection:con_7Hq2v8LkP0aX',
    kind: 'connection',
    name: 'Home Assistant',
    state: 'look',
    reason: 'Needs to be connected again',
    notice: { check: 'conn.signin' },
    nature: 'you',
    ignoreWords: 'Until it’s connected again.',
  },
];
const deskGlanceWith = (patch: Record<string, unknown>) => ({
  ...deskState,
  glance: { ...deskGlance, ...patch },
});
// This Whombat on a new box (0.101, CT-544): mockup new-box.html of Whombat desk-display.md DK-22.
const deskBox = {
  up: 'up 2 h 14 min',
  cpu: { percent: 7, cores: 16, tone: 'ok' },
  memory: { percent: 18, used: { value: '11.2', unit: 'GB' }, total: '64 GB', tone: 'ok' },
  history: { stepS: 60, cpu: [null, 9, 7], memory: [null, 17, 18] },
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
const deskNewBox = {
  ...deskState,
  glance: {
    status: {
      text: 'All fine. I’m ready when you are.',
      more: 'Connect a server or your home, and I’ll keep an eye on it here.',
    },
    needsYou: { count: 0, items: [] },
    working: null,
    done: [],
    servers: [],
    moreServers: 0,
    tiles: [],
    box: deskBox,
  },
};
const deskNewBoxWith = (patch: Record<string, unknown>) => ({
  ...deskNewBox,
  glance: { ...deskNewBox.glance, box: { ...deskBox, ...patch } },
});
// Found on your network (0.110, CT-700): mockup frames 1–3 of Whombat desk-found.md DF-01…DF-12.
const deskFoundItems = [
  {
    catalogId: 'homeassistant',
    name: 'Home Assistant',
    tagline: 'Lights, heating and sensors',
    address: '10.100.0.5',
  },
  {
    catalogId: 'proxmox',
    name: 'Proxmox VE',
    tagline: 'Virtual machines and backups',
    address: '10.100.0.10',
  },
  { catalogId: 'unraid', name: 'Unraid', tagline: 'Storage, Docker and VMs', address: '10.100.0.12' },
  {
    catalogId: 'synology',
    name: 'Synology DSM',
    tagline: 'Storage, shares and backups',
    address: '10.100.0.14:5001',
  },
  { catalogId: 'plex', name: 'Plex', tagline: 'Films, series and music', address: '10.100.0.20:32400' },
  { catalogId: 'pihole', name: 'Pi-hole', tagline: 'Ad blocking for the house', address: '10.100.0.53' },
  {
    catalogId: 'unifi_network',
    name: 'UniFi Network',
    tagline: 'Wi-Fi and everything on it',
    address: '10.100.0.1',
  },
  {
    catalogId: 'device',
    name: 'Modbus device',
    tagline: 'A device Whombat can read',
    address: '10.100.0.60:502',
  },
];
const deskFoundDone = {
  scanning: false,
  progress: null,
  items: deskFoundItems,
  count: 9,
  finishedAt: '2026-10-20T12:30:00Z',
};
const deskFoundLooking = {
  scanning: true,
  progress: { done: 412, total: 1022 },
  items: deskFoundItems.slice(0, 2),
  count: 2,
  finishedAt: null,
};
const deskFoundWith = (patch: Record<string, unknown>) => ({
  ...deskNewBox,
  glance: { ...deskNewBox.glance, found: { ...deskFoundDone, ...patch } },
});
// A server's own screen (0.115, CT-860…CT-866): mockup frames 1 and 2 of Whombat desk-display.md DK-80…DK-89.
const deskServerOpen = {
  name: 'pve-01',
  mark: 'proxmox',
  state: 'ok',
  note: 'up 41 d',
  cpu: { value: 18, tone: 'ok' },
  memory: { value: 54, tone: 'ok' },
  temp: { value: 46, tone: 'ok' },
  id: 'pve-01',
  disk: { value: 33, tone: 'ok' },
};
/** 24 hours in quarters of an hour, oldest first, the first one unmeasured. */
const deskServerSeries = (base: number, points = 96) =>
  Array.from({ length: points }, (_, i) => (i === 0 ? null : base + (i % 7)));
const deskServerPage = {
  v: 1,
  now: deskAt,
  server: deskServerOpen,
  os: 'Proxmox VE 9.0.10',
  up: 'up 41 d',
  cpu: { percent: 18, cores: 16, load: '2.9', tone: 'ok' },
  memory: { percent: 54, used: { value: '69', unit: 'GB' }, total: '128 GB', tone: 'ok' },
  disk: { percent: 33, used: '1.2', total: '3.6 TB', tone: 'ok' },
  temp: { value: 46, limit: 85, tone: 'ok' },
  history: {
    range: '24h',
    stepS: 900,
    cpu: deskServerSeries(14),
    memory: deskServerSeries(50),
    cpuPeak: { percent: 61, at: '2026-10-20T01:10:00Z' },
    memoryAvg: 52,
  },
  volumes: [
    { name: 'local-zfs', note: 'nvme mirror', percent: 41, used: '0.8 TB', total: '1.9 TB', tone: 'ok' },
    { name: 'nas-backup', note: 'on nas', percent: 72, used: '5.8 TB', total: '8 TB', tone: 'ok' },
    { name: 'local', note: 'boot disk', percent: 18, used: '17 GB', total: '94 GB', tone: 'ok' },
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
  alerts: { count: 0, items: [] },
};
const deskServerOff = {
  v: 1,
  now: deskAt,
  server: { name: 'pi-hole', mark: 'linux', state: 'off', note: '', id: 'pi-hole' },
  os: '',
  up: '',
  cpu: null,
  memory: null,
  disk: null,
  temp: null,
  history: { range: '24h', stepS: 900, cpu: [], memory: [], cpuPeak: null, memoryAvg: null },
  volumes: [],
  guests: null,
  network: null,
  alerts: { count: 0, items: [] },
};
const deskServerAlerts = {
  count: 2,
  items: [
    { tone: 'bad', title: 'Disk local-zfs is 96 % full' },
    { tone: 'warn', title: 'Backup of plex didn’t run last night' },
  ],
};
const deskServerPageWith = (patch: Record<string, unknown>) => ({ ...deskServerPage, ...patch });
const deskServerHistoryWith = (patch: Record<string, unknown>) =>
  deskServerPageWith({ history: { ...deskServerPage.history, ...patch } });
// One glance that fits what there is (0.104, CT-601, CT-602): Whombat desk-display.md DK-37…DK-42.
const deskFourServers = [deskServer, deskServer, deskServer, deskServer];
const deskFourTiles = [...deskGlance.tiles, ...deskGlance.tiles];

/* Remote help (0.120, CT-930…CT-944) */
const rhAt = '2026-10-21T14:00:00Z';
const rhHostKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINW5nEYpnLC/ggxoMZMtKIrMTB3zH3cpPnngDIgx6CrR';
const rhOwner = { accountId: 'acc_mara0001', name: 'Mara Jansen' };
const rhGrant = {
  level: 'fix',
  since: rhAt,
  until: '2026-10-22T14:00:00Z',
  grantedBy: rhOwner,
  helpCode: null,
  wrongCodes: 0,
};
const rhConnected = { visitId: '12345', who: 'Claude', since: '2026-10-21T14:05:00Z' };
const supportState = {
  v: 1,
  available: true,
  foreverAllowed: true,
  helpCodeRequired: false,
  environment: 'local',
  hostKey: rhHostKey,
  grant: rhGrant,
  connected: [rhConnected],
};
const supportStateOff = { ...supportState, grant: null, connected: [] };
const supportStateProd = {
  ...supportState,
  foreverAllowed: false,
  helpCodeRequired: true,
  environment: 'prod',
  grant: { ...rhGrant, level: 'look', helpCode: 'KQ72MX', wrongCodes: 2 },
};
const rhSteps = [
  { at: '2026-10-21T14:05:00Z', kind: 'connected' },
  { at: '2026-10-21T14:05:02Z', kind: 'look', command: 'status' },
  {
    at: '2026-10-21T14:05:09Z',
    kind: 'look',
    command: 'logs',
    units: ['whombat-voice.service', 'whombat-server.service'],
  },
  { at: '2026-10-21T14:06:00Z', kind: 'exec', line: 'systemctl status whombat-voice' },
  { at: '2026-10-21T14:09:00Z', kind: 'shell', seconds: 185 },
  { at: '2026-10-21T14:10:00Z', kind: 'restart', units: ['whombat-voice.service'] },
  { at: '2026-10-21T14:11:00Z', kind: 'forward', target: '127.0.0.1:8123', bytes: 48_213 },
  { at: '2026-10-21T14:12:00Z', kind: 'refused', reason: 'level', command: 'report' },
  { at: '2026-10-21T14:12:30Z', kind: 'wrong_code' },
  { at: '2026-10-21T14:20:00Z', kind: 'left' },
];
const rhVisit = {
  id: '12345',
  who: 'Claude',
  level: 'fix',
  startedAt: '2026-10-21T14:05:00Z',
  endedAt: '2026-10-21T14:35:00Z',
  steps: rhSteps,
  truncated: false,
  transcriptBytes: 18_204,
};
const supportEvents = [
  { seq: 1, at: rhAt, kind: 'grant', level: 'fix', duration: 'day', by: rhOwner },
  { seq: 2, at: '2026-10-21T14:05:00Z', kind: 'visit_start', visitId: '12345', who: 'Claude', level: 'fix' },
  {
    seq: 3,
    at: '2026-10-21T14:35:00Z',
    kind: 'visit_end',
    visitId: '12345',
    who: 'Claude',
    level: 'fix',
    startedAt: '2026-10-21T14:05:00Z',
    steps: 10,
  },
  { seq: 4, at: '2026-10-21T15:00:00Z', kind: 'stop', reason: 'desk' },
  { seq: 5, at: '2026-10-21T15:01:00Z', kind: 'stop', reason: 'owner', by: rhOwner },
  { seq: 6, at: '2026-10-22T14:00:00Z', kind: 'expired' },
  { seq: 7, at: '2026-10-22T14:00:00Z', kind: 'locked_out' },
];
// The box's hardware and network (0.102, CT-561…CT-574): a Flow Z13-like machine online through a USB Ethernet adapter.
const hwAt = '2026-10-20T15:00:00Z';
const hwWifi = {
  kind: 'wifi',
  name: 'MT7925 802.11be 160MHz 2x2 PCIe Wireless Network Adapter [Filogic 360]',
  vendor: 'MEDIATEK Corp.',
  bus: 'pci',
  id: '14c3:7925',
  driver: 'mt7925e',
  status: 'ok',
  interface: 'wlp194s0',
  link: 'down',
};
const hostHardware = {
  collectedAt: hwAt,
  kernel: '6.18.53',
  machine: {
    vendor: 'ASUSTeK COMPUTER INC.',
    model: 'ROG Flow Z13 GZ302EA_GZ302EA',
    family: 'ROG Flow Z13',
    firmware: 'GZ302EA.308',
    virtual: false,
  },
  cpu: { model: 'AMD RYZEN AI MAX+ 395 w/ Radeon 8060S', cores: 16, threads: 32 },
  memoryBytes: 133_143_986_176,
  devices: [
    hwWifi,
    {
      kind: 'wired',
      name: 'RTL8153 Gigabit Ethernet Adapter',
      vendor: 'Realtek Semiconductor Corp.',
      bus: 'usb',
      id: '0bda:8153',
      driver: 'r8152',
      status: 'ok',
      interface: 'enx00e04c680001',
      link: 'up',
      speedMbps: 1000,
    },
    {
      kind: 'sound',
      name: 'Family 17h/19h/1ah HD Audio Controller',
      vendor: 'Advanced Micro Devices, Inc. [AMD]',
      bus: 'pci',
      id: '1022:15e3',
      driver: 'snd_hda_intel',
      status: 'ok',
      card: 'Generic_1',
      capture: 1,
      playback: 1,
    },
    {
      kind: 'sound',
      name: 'acp-pdm-mic',
      bus: 'platform',
      driver: 'acp_pdm_mach',
      status: 'ok',
      card: 'acppdmmach',
      capture: 1,
      playback: 0,
    },
    {
      kind: 'graphics',
      name: 'Strix Halo [Radeon Graphics / Radeon 8050S / 8060S Graphics]',
      vendor: 'Advanced Micro Devices, Inc. [AMD/ATI]',
      bus: 'pci',
      id: '1002:1586',
      driver: 'amdgpu',
      status: 'ok',
    },
    { kind: 'display', name: 'eDP-1', bus: 'platform', driver: 'amdgpu', status: 'ok', connected: true },
    {
      kind: 'storage',
      name: 'WD PC SN5000S SDEPNSJ-1T00-1002',
      bus: 'pci',
      id: '15b7:5030',
      driver: 'nvme',
      status: 'ok',
      sizeBytes: 1_024_209_543_168,
    },
    { kind: 'battery', name: 'BAT0', bus: 'platform', driver: 'battery', status: 'ok' },
    {
      kind: 'bluetooth',
      name: 'Wireless_Device',
      vendor: 'MediaTek Inc.',
      bus: 'usb',
      id: '0489:e118',
      driver: 'btusb',
      status: 'no_firmware',
    },
  ],
  log: [
    'Bluetooth: hci0: Direct firmware load for mediatek/mt7925/BT_RAM_CODE_MT7925_1_1_hdr.bin failed with error -2',
  ],
};
const networkChange = {
  id: 'c-k3q9xv2m',
  kind: 'join',
  ssid: 'Home',
  phase: 'confirming',
  deadline: '2026-10-20T15:02:00Z',
  previous: 'Office',
};
const hostWifi = {
  interface: 'wlp194s0',
  state: 'connected',
  ssid: 'Home',
  signal: 3,
  address: '10.100.1.57',
  saved: [
    { ssid: 'Home', security: 'psk' },
    { ssid: 'Office', security: 'psk' },
  ],
};
const hostNetwork = {
  online: true,
  checkedAt: '2026-10-20T14:59:40Z',
  wired: [{ interface: 'enx00e04c680001', connected: true, address: '10.100.1.42' }],
  wifi: hostWifi,
  change: networkChange,
};
const cableOnly = {
  online: true,
  checkedAt: '2026-10-20T14:59:40Z',
  wired: [{ interface: 'enp1s0', connected: true, address: '2001:db8::42' }],
  wifi: null,
  wifiMissing: 'no_adapter',
  change: null,
};
const wifiScan = {
  networks: [
    { ssid: 'Home', security: 'psk', signal: 3, saved: true, connected: true },
    { ssid: 'Café Zonneveld', security: 'open', signal: 2, saved: false, connected: false },
    { ssid: 'Lumio Corp', security: 'enterprise', signal: 1, saved: false, connected: false },
  ],
  scannedAt: hwAt,
};
const withNetwork = (patch: Record<string, unknown>) => ({ v: 1, network: { ...hostNetwork, ...patch } });
const withWifi = (patch: Record<string, unknown>) => withNetwork({ wifi: { ...hostWifi, ...patch } });
const withChange = (patch: Record<string, unknown>) =>
  withNetwork({ change: { ...networkChange, ...patch } });
const withHardware = (patch: Record<string, unknown>) => ({ v: 1, hardware: { ...hostHardware, ...patch } });
const withDevice = (patch: Record<string, unknown>) => withHardware({ devices: [{ ...hwWifi, ...patch }] });
const joinRequest = { v: 1, ssid: 'Home', passphrase: 'correct horse battery', confirmTimeoutSec: 120 };
// Wi-Fi only (3.13, CT-1639…CT-1644).
const cableChange = {
  id: 'c-w7m2p9qa',
  use: 'wifi',
  by: 'person',
  phase: 'confirming',
  deadline: '2026-11-03T16:02:00Z',
};
const wifiOnlyNetwork = {
  ...hostNetwork,
  wired: [
    {
      interface: 'enp198s0f3u1u1',
      connected: false,
      plugged: true,
      mac: '02:00:00:68:02:2c',
    },
  ],
  wifi: { ...hostWifi, mac: 'ae:00:00:16:47:58', prefixLength: 23 },
  change: null,
  wifiOnly: true,
  cableChange: { ...cableChange, phase: 'committed' },
};
// The box's Bluetooth (0.109, CT-670…CT-684).
const btKeyboard = {
  address: 'DC:2C:26:01:02:03',
  name: 'Keychron K3',
  kind: 'keyboard',
  connected: true,
  battery: 80,
};
const btHeadphones = {
  address: '88:C9:E8:11:22:33',
  name: 'WH-1000XM5',
  kind: 'headphones',
  connected: false,
};
const btMouse = {
  address: 'F0:1D:BC:44:55:66',
  name: 'MX Master 3S',
  kind: 'mouse',
  connected: false,
  signal: 4,
};
const btScan = {
  until: '2026-10-20T21:01:00Z',
  devices: [
    btMouse,
    { address: '00:1E:52:77:88:99', name: 'Magic Keyboard', kind: 'keyboard', connected: false, signal: 3 },
    { address: '7C:96:D2:AA:BB:CC', name: 'JBL Flip 6', kind: 'speaker', connected: false, signal: 2 },
  ],
};
const btPairing = {
  id: 'p-k3q9xv2m',
  address: '00:1E:52:77:88:99',
  name: 'Magic Keyboard',
  kind: 'keyboard',
  phase: 'code',
  deadline: '2026-10-20T21:01:30Z',
  code: '123456',
  typed: 2,
};
const btState = {
  adapter: { name: 'wb-7tq3-k2pd-m418', powered: true },
  devices: [btKeyboard, btHeadphones],
  scan: btScan,
  pairing: null,
};
const btNone = { adapter: null, missing: 'no_adapter', devices: [], scan: null, pairing: null };
const withBt = (patch: Record<string, unknown>) => ({ v: 1, bluetooth: { ...btState, ...patch } });
const withBtDevice = (patch: Record<string, unknown>) => withBt({ devices: [{ ...btKeyboard, ...patch }] });
const withBtPairing = (patch: Record<string, unknown>) =>
  withBt({ scan: null, pairing: { ...btPairing, ...patch } });
const localLicence = {
  state: 'grace',
  reason: 'not_renewed',
  plan: 'team',
  expiresAt: '2026-10-10T12:00:00Z',
  graceEndsAt: '2026-11-09T12:00:00Z',
  effectiveAt: '2026-10-11T08:00:00Z',
};
const hello = { t: 'hello', v: 1, ticket, class: 'interactive' };
const welcome = { t: 'welcome', v: 1, conn: 'conn_abcdefgh', heartbeatMs: 20_000, maxMessage: 262_144 };
const claims = {
  iss: 'https://api.dev.whombat.com',
  aud: 'whombat-relay:dev',
  rol: 'client',
  apl: 'apl_7Hq2mX',
  sub: 'acc_91xzQ',
  org: 'org_42',
  wrk: 'relay-eu-1',
  chn: 'app',
  iat: now,
  nbf: now,
  exp: now + 120,
  jti: 'vYt9-2mQx_7LkP0aZbW3cA',
};
const jwk = { kty: 'OKP', crv: 'Ed25519', kid: 'adm-1', x: 'A'.repeat(43), alg: 'EdDSA', use: 'sig' };
const status = {
  release: 'rt-2026.09.25-1',
  managerVersion: '0.1.0',
  uptimeS: 86_400,
  update: { state: 'Healthy', candidate: null, attempt: 0, failure: null },
  health: { runtime: 'ok', database: 'ok', runner: 'ok', sessionEndpoint: 'ok', relay: 'ok', backup: 'ok' },
  storage: { persistUsedPct: 41, persistFreeBytes: 512_000_000_000 },
  sessionsActive: 3,
  recoveryKit: 'confirmed',
  lastBackupAt: null,
  clockSynced: true,
};
const clientBundle = {
  provider: 'claude',
  version: '2.1.290',
  os: 'linux',
  arch: 'x86_64',
  publishedAt: now - 86_400,
  testedAt: now - 3_600,
  fixturesDigest: `sha256:${'f'.repeat(64)}`,
  adapter: { min: 1, max: 2 },
  artifact: {
    target: 'clients/claude/2.1.290/linux-x86_64.tar.gz',
    sha256: 'a'.repeat(64),
    size: 80_000_000,
    path: 'claude',
  },
  source: {
    url: 'https://storage.googleapis.com/claude-code-dist/claude-code-releases/2.1.290/linux-x64/claude',
    sha256: 'b'.repeat(64),
    size: 200_000_000,
    format: 'binary',
    path: null,
  },
  executable: { sha256: 'e'.repeat(64), size: 190_000_000 },
};
const localClient = {
  provider: 'claude',
  state: 'installed',
  installed: {
    version: '2.1.290',
    installedAt: '2026-09-26T10:00:00Z',
    executable: { path: '/persist/whombat/clients/claude/2.1.290/claude', sha256: 'e'.repeat(64) },
    fixturesDigest: `sha256:${'f'.repeat(64)}`,
  },
  latest: { version: '2.1.290', publishedAt: '2026-09-25T18:00:00Z' },
  progress: null,
  error: null,
};
const updateFacts = {
  state: 'Healthy',
  current: 'rt-2026.10.04-1',
  candidate: null,
  lastCheckedAt: '2026-10-04T12:00:00Z',
  deferredReason: null,
  failure: null,
};
const floor = { web: 2026100401, android: 140, ios: 88, desktop: 0, cli: 0 };
const push = {
  kind: 'approval',
  ref: 'q3Vx9LpA0dZkT7mW2bNcYe',
  handles: ['hNd1e_0123456789abcdefgh'],
  ttlS: 600,
};
const component = (c: string, name: string) => ({
  version: '1.0.0',
  storePath: `/nix/store/${c.repeat(32)}-${name}`,
  narHash: `sha256:${c.repeat(64)}`,
});
const tuple = {
  releaseId: 'rt-2026.10.01-1',
  runtime: {
    ...component('a', 'whombat-runtime'),
    schemaReads: { min: 12, max: 14 },
    schemaWrites: 14,
    protocol: { min: 1000, max: 1000 },
    hostAbi: { min: 1, max: 1 },
  },
  providers: [{ ...component('b', 'codex'), provider: 'codex' }],
  host: { ...component('c', 'nixos-system'), abi: 1 },
  manager: component('d', 'whombat-manager'),
};

const ticketResponse = {
  ticket,
  expiresAt: now + 120,
  relay: { worker: 'relay-eu-1', url: 'wss://relay.dev.whombat.com/v1/connect', reassignAfter: now + 3600 },
  channel: 'app',
};

const health = {
  v: 1,
  status: 'ok',
  releaseId: 'rt-2026.09.25-1',
  version: '2026.09.25-1',
  checks: {
    db: { ok: true },
    migrations: { ok: true, compatible: true, access: 'read-write', schemaVersion: 28 },
    sessionEndpoint: { ok: true },
  },
  external: { relay: 'ok', control: 'degraded' },
  draining: false,
};
const drain = {
  v: 1,
  requestId: 'upd-7',
  reason: 'update',
  scope: 'all',
  releaseId: 'rt-2026.10.01-1',
  leaseMs: 60_000,
};
const drainStatus = {
  v: 1,
  requestId: 'upd-7',
  draining: true,
  safe: false,
  blockers: [
    {
      kind: 'turn',
      id: 'run_42',
      description: 'Codex is answering in "billing"',
      since: '2026-09-25T12:00:00Z',
      estimatedMs: 30_000,
    },
  ],
  estimatedMs: 30_000,
};
const backupStatus = {
  kind: 'whombat.backup-status/1',
  state: 'protected',
  protected: true,
  destination: {
    configured: true,
    kind: 'restic-rest',
    display: 'backup.example.com/whombat',
    appendOnly: 'verified',
    repositoryId: 'a1b2c3d4',
  },
  lastSuccess: {
    id: 'chk_20260925T0300',
    at: '2026-09-25T03:00:12.123456789Z',
    ageSeconds: 32_400,
    snapshotId: '4f9c2e1a',
    method: 'fsfreeze',
    quiesceHeldMs: 850,
    durationMs: 92_000,
    bytesAdded: 12_345_678,
    totalBytes: 9_876_543_210,
    files: 40_211,
    schemaVersion: 28,
  },
  lastFailure: null,
  lastAttemptOk: true,
  coverage: [
    { id: 'database', title: 'Database', covered: true },
    { id: 'provider-sessions', title: 'Provider session state', covered: true, relogin: true },
    { id: 'identity', title: 'Appliance identities', covered: false },
  ],
  recoverability: {
    lastDrill: {
      at: '2026-09-24T04:00:00+02:00',
      ok: true,
      checkpointId: 'chk_20260924T0300',
      rtoSeconds: 412,
      backupAgeSeconds: 3_600,
    },
  },
  kitGeneration: 2,
  running: null,
  updatedAt: '2026-09-25T12:00:00Z',
};

const webPush = {
  platform: 'webpush',
  subscription: {
    endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABm-example',
    keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) },
    expirationTime: null,
  },
};

/* Whombat Link (4.4; Whombat whombat-link.md) ------------------------------------------------------------------- */

const linkRegistration = {
  env: 'dev',
  hardwareSerial: 'SELF-0001',
  model: 'self-installed',
  managementPublicKey: 'a'.repeat(64),
  contentPeerId: '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH',
  contentPublicKey: 'b'.repeat(64),
  provisionedAt: now - 86_400,
  proof: 'c'.repeat(128),
  contentProof: 'd'.repeat(128),
};
const linkPending = { code: 'KXQM-TRVW', url: 'https://app.whombat.com/link', expiresAt: now + 900 };
const linkStarting = { state: 'starting', since: now, pending: linkPending };
const linkOn = {
  state: 'on',
  since: now,
  trialEndsAt: now + 30 * 86_400,
  label: 'maple-otter-river',
  email: 'mara@example.com',
};
const linkGrace = { state: 'grace', since: now, graceEndsAt: now + 7 * 86_400, label: 'maple-otter-river' };
const localLinkStarting = {
  state: 'starting',
  since: '2026-11-18T12:00:00Z',
  pending: { code: 'KXQM-TRVW', url: 'https://app.whombat.com/link', expiresAt: '2026-11-18T12:15:00Z' },
};
const pushToken = { platform: 'apns', token: 'f'.repeat(64), appId: 'com.whombat.mobile' };
const supportOff = { state: 'off', untilS: null, connected: 0, helpCode: false, hostKey: null };

export const SCHEMA_CASES: Case[] = [
  ...cases('RelayHello', hello, [
    ['bulk with session', set(hello, { class: 'bulk', session: 'ses_12345678' }), true],
    ['version 2', set(hello, { v: 2 }), false],
    ['version as string', set(hello, { v: '1' }), false],
    ['unknown class', set(hello, { class: 'video' }), false],
    [
      'unknown member from a newer minor is stripped',
      set(hello, { token: 'x', resume: { n: 1 } }),
      true,
      hello,
    ],
    ['missing ticket', without(hello, 'ticket'), false],
    ['ticket with two segments', set(hello, { ticket: 'abc.def' }), false],
    ['ticket of 4097 bytes', set(hello, { ticket: `${'a'.repeat(4093)}.b.c` }), false],
    ['ticket of 4096 bytes', set(hello, { ticket: `${'a'.repeat(4092)}.b.c` }), true],
    ['session of 7 characters', set(hello, { session: 'ses_123' }), false],
    ['session of 64 characters', set(hello, { session: 's'.repeat(64) }), true],
    ['session of 65 characters', set(hello, { session: 's'.repeat(65) }), false],
    ['session with a space', set(hello, { session: 'ses 12345678' }), false],
    ['session null', set(hello, { session: null }), false],
    ['not an object', [hello], false],
  ]),
  ...cases('RelayWelcome', welcome, [
    ['unknown member is stripped', set(welcome, { region: 'eu-1' }), true, welcome],
    [
      'case variant of a known member is stripped, not merged',
      set(welcome, { CONN: 'evil_conn_1' }),
      true,
      welcome,
    ],
    ['heartbeat below 1 s', set(welcome, { heartbeatMs: 999 }), false],
    ['fractional heartbeat', set(welcome, { heartbeatMs: 20_000.5 }), false],
    // The lease (4.5; Whombat whombat-link.md LNK-34).
    ['control connection with a lease', set(welcome, { lease: { renewWithinS: 330 } }), true],
    ['lease of -1 s', set(welcome, { lease: { renewWithinS: -1 } }), false],
    ['lease without renewWithinS', set(welcome, { lease: {} }), false],
  ]),
  ...cases('RelayLease', { renewWithinS: 330 }, [
    ['0 s', { renewWithinS: 0 }, true],
    ['an hour', { renewWithinS: 3_600 }, true],
    ['above an hour', { renewWithinS: 3_601 }, false],
    ['negative', { renewWithinS: -1 }, false],
    ['fractional', { renewWithinS: 1.5 }, false],
    ['as a string', { renewWithinS: '330' }, false],
  ]),
  ...cases('RelayRenew', { t: 'renew', ticket }, [
    ['without a ticket', { t: 'renew' }, false],
    ['ticket too short', { t: 'renew', ticket: 'a.b.c' }, false],
    ['ticket with two segments', { t: 'renew', ticket: 'abcdefgh.ijklmnop' }, false],
    ['unknown member is stripped', { t: 'renew', ticket, lbl: 'x' }, true, { t: 'renew', ticket }],
  ]),
  ...cases('RelayRenewed', { t: 'renewed', lease: { renewWithinS: 330 } }, [
    ['lease of 0 s', { t: 'renewed', lease: { renewWithinS: 0 } }, true],
    ['lease of an hour', { t: 'renewed', lease: { renewWithinS: 3_600 } }, true],
    ['without a lease', { t: 'renewed' }, false],
    ['lease above an hour', { t: 'renewed', lease: { renewWithinS: 3_601 } }, false],
  ]),
  ...cases('RelayRenewRefused', { t: 'renew_refused', reason: 'stale', lease: { renewWithinS: 95 } }, [
    ...[
      'malformed',
      'bad_header',
      'unknown_kid',
      'bad_signature',
      'bad_claims',
      'wrong_audience',
      'wrong_issuer',
      'wrong_role',
      'wrong_worker',
      'bad_lifetime',
      'not_yet_valid',
      'expired',
      'replayed',
      'replay_cache_full',
      'appliance_mismatch',
      'rate',
    ].map((reason): [string, unknown, boolean] => [
      `reason ${reason}`,
      { t: 'renew_refused', reason, lease: { renewWithinS: 95 } },
      true,
    ]),
    ['unknown reason', { t: 'renew_refused', reason: 'teleport', lease: { renewWithinS: 95 } }, false],
    ['without a lease', { t: 'renew_refused', reason: 'stale' }, false],
    ['without a reason', { t: 'renew_refused', lease: { renewWithinS: 95 } }, false],
  ]),
  ...cases('RelayDrain', { t: 'drain', retryAfterMs: 5_000 }, [
    ['negative delay', { t: 'drain', retryAfterMs: -1 }, false],
    ['delay above an hour', { t: 'drain', retryAfterMs: 3_600_001 }, false],
  ]),
  ...cases('RelayUpstreamMessage', hello, [
    ['refuse', { t: 'refuse', session: 'ses_12345678' }, true],
    ['ready is downstream only', { t: 'ready' }, false],
    ['renew', { t: 'renew', ticket }, true],
    ['renewed is downstream only', { t: 'renewed', lease: { renewWithinS: 330 } }, false],
    ['unknown t', { t: 'teleport' }, false],
  ]),
  ...cases('RelayDownstreamMessage', { t: 'ready' }, [
    ['incoming', { t: 'incoming', session: 'ses_12345678', class: 'bulk' }, true],
    ['ready with an unknown member', { t: 'ready', x: 1 }, true, { t: 'ready' }],
    ['hello is upstream only', hello, false],
    ['renewed', { t: 'renewed', lease: { renewWithinS: 330 } }, true],
    ['renew_refused', { t: 'renew_refused', reason: 'rate', lease: { renewWithinS: 12 } }, true],
    ['renew is upstream only', { t: 'renew', ticket }, false],
    ['welcome with a lease', set(welcome, { lease: { renewWithinS: 330 } }), true],
  ]),
  // The box's direct listener (HE-50, CT-1250).
  ...cases('DirectHello', { t: 'hello', v: 1, class: 'interactive' }, [
    ['bulk', { t: 'hello', v: 1, class: 'bulk' }, true],
    [
      'a ticket is no member: stripped',
      { t: 'hello', v: 1, class: 'bulk', ticket: 'a.b.c' },
      true,
      { t: 'hello', v: 1, class: 'bulk' },
    ],
    ['version 2', { t: 'hello', v: 2, class: 'bulk' }, false],
    ['without class', { t: 'hello', v: 1 }, false],
  ]),
  ...cases('DirectWelcome', { t: 'welcome', v: 1, heartbeatMs: 20_000, maxMessage: 262_144 }, [
    ['heartbeat below 1 s', { t: 'welcome', v: 1, heartbeatMs: 999, maxMessage: 262_144 }, false],
    ['message below 1 KiB', { t: 'welcome', v: 1, heartbeatMs: 20_000, maxMessage: 1_023 }, false],
  ]),
  ...cases('DirectUpstreamMessage', { t: 'hello', v: 1, class: 'interactive' }, [
    ["the relay's refuse is no direct message", { t: 'refuse', session: 'ses_12345678' }, false],
  ]),
  ...cases('DirectDownstreamMessage', { t: 'welcome', v: 1, heartbeatMs: 20_000, maxMessage: 262_144 }, [
    ["ready is the relay's", { t: 'ready' }, false],
  ]),
  // Which box answers, and its edition (1.1, CT-1300, CT-1301).
  ...cases(
    'DirectIdentity',
    {
      v: 1,
      appliance: '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH',
      edition: 'community',
      claimed: false,
    },
    [
      [
        'a 1.0 box: no edition, no claimed',
        { v: 1, appliance: '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH' },
        true,
      ],
      [
        'commercial, claimed',
        {
          v: 1,
          appliance: '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH',
          edition: 'commercial',
          claimed: true,
        },
        true,
      ],
      [
        'an edition there is none of',
        { v: 1, appliance: '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH', edition: 'enterprise' },
        false,
      ],
      ['not a PeerId', { v: 1, appliance: 'QmNotAPeerId' }, false],
    ],
  ),
  // The tailnet's other devices on the manager socket (3.11, CT-1635).
  ...cases(
    'TailscalePeersResponse',
    {
      v: 1,
      peers: [
        {
          name: 'ha.tail1234.ts.net',
          addresses: ['100.64.12.10', 'fd7a:115c:a1e0::1'],
          os: 'linux',
          online: true,
          lastSeen: null,
          routes: [],
          exitNode: false,
        },
        {
          name: 'blackbox.tail1234.ts.net',
          addresses: ['100.64.12.11'],
          os: 'linux',
          online: false,
          lastSeen: '2026-10-30T15:21:30Z',
          routes: ['10.100.0.0/23', 'fd00:1::/64'],
          exitNode: true,
        },
      ],
    },
    [
      ['no devices', { v: 1, peers: [] }, true],
      [
        'a device without a name the contract takes',
        {
          v: 1,
          peers: [
            {
              name: null,
              addresses: [],
              os: null,
              online: false,
              lastSeen: null,
              routes: [],
              exitNode: false,
            },
          ],
        },
        true,
      ],
      [
        'a name with a trailing dot',
        {
          v: 1,
          peers: [
            {
              name: 'ha.tail1234.ts.net.',
              addresses: [],
              os: null,
              online: true,
              lastSeen: null,
              routes: [],
              exitNode: false,
            },
          ],
        },
        false,
      ],
      [
        'a route that is no CIDR',
        {
          v: 1,
          peers: [
            {
              name: null,
              addresses: [],
              os: null,
              online: true,
              lastSeen: null,
              routes: ['10.100.0.0'],
              exitNode: false,
            },
          ],
        },
        false,
      ],
      [
        'five addresses',
        {
          v: 1,
          peers: [
            {
              name: null,
              addresses: ['100.64.0.1', '100.64.0.2', '100.64.0.3', '100.64.0.4', '100.64.0.5'],
              os: null,
              online: true,
              lastSeen: null,
              routes: [],
              exitNode: false,
            },
          ],
        },
        false,
      ],
    ],
  ),
  // Tailscale's own login server on the manager socket (1.1, CT-1306).
  ...cases('TailscaleOnRequest', { v: 1, loginServer: 'https://headscale.example.org' }, [
    ['Tailscale’s own (absent)', { v: 1 }, true],
    [
      'http on the local network, with a port and a path',
      { v: 1, loginServer: 'http://10.0.0.5:8080/hs' },
      true,
    ],
    ['an IPv6 address in brackets', { v: 1, loginServer: 'https://[fd00::5]:8443' }, true],
    ['a user and password', { v: 1, loginServer: 'https://u:p@hs.example.org' }, false],
    ['a query', { v: 1, loginServer: 'https://hs.example.org/?x=1' }, false],
    ['a space for a command line to split', { v: 1, loginServer: 'https://hs.example.org/a b' }, false],
    ['upper case (not normalized)', { v: 1, loginServer: 'https://HS.example.org' }, false],
    ['a trailing slash (not normalized)', { v: 1, loginServer: 'https://hs.example.org/' }, false],
    ['ftp', { v: 1, loginServer: 'ftp://hs.example.org' }, false],
    ['null is not absent here', { v: 1, loginServer: null }, false],
  ]),
  ...cases('AdmissionClaims', claims, [
    ['appliance on the enrollment channel', set(claims, { rol: 'appliance', chn: 'enroll' }), true],
    [
      'unclaimed appliance without org',
      without(set(claims, { rol: 'appliance', chn: 'enroll' }), 'org'),
      true,
    ],
    ['unknown claim (tokens stay strict)', set(claims, { adm: true }), false],
    ['audience without env', set(claims, { aud: 'whombat-relay:' }), false],
    ['audience with uppercase env', set(claims, { aud: 'whombat-relay:Dev' }), false],
    ['issuer with a space', set(claims, { iss: 'https://api.dev whombat.com' }), false],
    ['issuer with non-ASCII', set(claims, { iss: 'https://api.dév.whombat.com' }), false],
    ['issuer ftp', set(claims, { iss: 'ftp://api.dev.whombat.com' }), false],
    ['exp beyond 2100', set(claims, { exp: 4_102_444_801 }), false],
    ['negative iat', set(claims, { iat: -1 }), false],
    ['org of 65 characters', set(claims, { org: 'o'.repeat(65) }), false],
    ['empty sub', set(claims, { sub: '' }), false],
    ['jti of 21 characters', set(claims, { jti: 'j'.repeat(21) }), false],
    ['jti of 64 characters', set(claims, { jti: 'j'.repeat(64) }), true],
    ['missing wrk', without(claims, 'wrk'), false],
  ]),
  ...cases('AdmissionJwks', { keys: [jwk] }, [
    ['without optional alg and use', { keys: [without(without(jwk, 'alg'), 'use')] }, true],
    ['private d member', { keys: [set(jwk, { d: 'A'.repeat(43) })] }, false],
    ['empty set', { keys: [] }, false],
    ['17 keys', { keys: Array.from({ length: 17 }, (_, i) => set(jwk, { kid: `k${i}` })) }, false],
    ['x of 42 characters', { keys: [set(jwk, { x: 'A'.repeat(42) })] }, false],
    ['RSA key', { keys: [set(jwk, { kty: 'RSA' })] }, false],
  ]),
  ...cases('StatusReportRequest', status, [
    ['free-text note', set(status, { note: 'disk almost full' }), false],
    // Remote help (0.120, CT-944): metadata only.
    [
      'remote help on (CT-944)',
      set(status, {
        support: { state: 'fix', untilS: 86_000, connected: 1, helpCode: false, hostKey: rhHostKey },
      }),
      true,
    ],
    [
      'remote help on forever',
      set(status, {
        support: { state: 'look', untilS: null, connected: 0, helpCode: true, hostKey: rhHostKey },
      }),
      true,
    ],
    [
      'remote help off without a host key yet',
      set(status, { support: { state: 'off', untilS: null, connected: 0, helpCode: false, hostKey: null } }),
      true,
    ],
    [
      'remote help with its help code (never reported)',
      set(status, {
        support: {
          state: 'fix',
          untilS: 60,
          connected: 0,
          helpCode: true,
          hostKey: rhHostKey,
          code: 'KQ72MX',
        },
      }),
      false,
    ],
    [
      'remote help with nine connected',
      set(status, {
        support: { state: 'fix', untilS: 60, connected: 9, helpCode: false, hostKey: rhHostKey },
      }),
      false,
    ],
    [
      'remote help longer than a week',
      set(status, {
        support: { state: 'fix', untilS: 604_801, connected: 0, helpCode: false, hostKey: rhHostKey },
      }),
      false,
    ],
    [
      'remote help with an RSA host key',
      set(status, {
        support: {
          state: 'fix',
          untilS: 60,
          connected: 0,
          helpCode: false,
          hostKey: `ssh-rsa AAAAB3NzaC1yc2E${'A'.repeat(60)}`,
        },
      }),
      false,
    ],
    [
      'remote help with a host key and a comment',
      set(status, {
        support: {
          state: 'fix',
          untilS: 60,
          connected: 0,
          helpCode: false,
          hostKey: `${rhHostKey} root@box`,
        },
      }),
      false,
    ],
    [
      'failure detail and runtime version (CT-137)',
      set(status, {
        runtimeVersion: '0.2.0-20260928190000.abcdef1',
        update: {
          state: 'Quarantined',
          candidate: 'pve-20260928.5',
          attempt: 3,
          failure: 'schema_incompatible',
          failureDetail,
        },
      }),
      true,
    ],
    [
      'failure detail with a message (strict)',
      set(status, {
        update: {
          state: 'Failed',
          candidate: null,
          attempt: 1,
          failure: 'unhealthy',
          failureDetail: { ...failureDetail, message: 'candidate failed local health' },
        },
      }),
      false,
    ],
    [
      'failure detail with nine reasons',
      set(status, {
        update: {
          state: 'Failed',
          candidate: null,
          attempt: 1,
          failure: 'schema_incompatible',
          failureDetail: { ...failureDetail, reasons: Array.from({ length: 9 }, (_, i) => `r${i}`) },
        },
      }),
      false,
    ],
    [
      'waiting for a checkpoint (CT-147)',
      set(status, {
        update: {
          state: 'WaitingForSafeBoundary',
          candidate: 'pve-20260928.5',
          attempt: 0,
          failure: null,
          waiting: { reason: 'checkpoint', since: now },
        },
      }),
      true,
    ],
    [
      'waiting with its blockers (not in a report)',
      set(status, {
        update: {
          state: 'WaitingForSafeBoundary',
          candidate: 'pve-20260928.5',
          attempt: 0,
          failure: null,
          waiting: { reason: 'boundary', since: now, blockers: [{ kind: 'run', count: 2 }] },
        },
      }),
      false,
    ],
    [
      'null failure detail (absent means none)',
      set(status, {
        update: { state: 'Healthy', candidate: null, attempt: 0, failure: null, failureDetail: null },
      }),
      false,
    ],
    ['used 101 %', set(status, { storage: { persistUsedPct: 101, persistFreeBytes: 0 } }), false],
    [
      'unknown journal state',
      set(status, { update: { state: 'Rebooting', candidate: null, attempt: 0, failure: null } }),
      false,
    ],
    [
      'candidate missing (nullable, not optional)',
      set(status, { update: { state: 'Healthy', attempt: 0, failure: null } }),
      false,
    ],
    [
      'candidate set',
      set(status, { update: { state: 'Staged', candidate: 'rt-2026.10.01-1', attempt: 1, failure: null } }),
      true,
    ],
    [
      'free bytes 2^53',
      set(status, { storage: { persistUsedPct: 1, persistFreeBytes: 9_007_199_254_740_992 } }),
      false,
    ],
    [
      'free bytes 2^53 − 1',
      set(status, { storage: { persistUsedPct: 1, persistFreeBytes: 9_007_199_254_740_991 } }),
      true,
    ],
  ]),
  ...cases('PushSendRequest', push, [
    ['no handles', set(push, { handles: [] }), false],
    [
      '51 handles',
      set(push, { handles: Array.from({ length: 51 }, () => 'hNd1e_0123456789abcdefgh') }),
      false,
    ],
    ['with collapse key', set(push, { collapseKey: 'thread-1' }), true],
    ['content in ref', set(push, { ref: 'Your PR was merged!' }), false],
    ['an id as ref (too short to be random or a keyed hash)', set(push, { ref: 'ntf_7Qa' }), false],
    ['a full HMAC-SHA256 (43 characters)', set(push, { ref: 'A'.repeat(43) }), true],
    ['longer than a SHA-256', set(push, { ref: 'A'.repeat(44) }), false],
    ['unknown kind', set(push, { kind: 'marketing' }), false],
    ['ttl above a day', set(push, { ttlS: 86_401 }), false],
  ]),
  ...cases('TicketIssueResponse', ticketResponse, [
    [
      'unknown members from a newer control are stripped',
      { ...ticketResponse, hint: 'x', relay: { ...ticketResponse.relay, region: 'eu' } },
      true,
      ticketResponse,
    ],
    [
      'relay url with a space',
      { ...ticketResponse, relay: { ...ticketResponse.relay, url: 'wss://a b' } },
      false,
    ],
  ]),
  ...cases('TicketIssueRequest', { class: 'bulk' }, [
    ['unknown member in a command input', { class: 'bulk', priority: 1 }, false],
  ]),
  // Remote help (0.120, CT-945): the support route's ticket.
  ...cases('SupportTicketRequest', {}, [['a class (always interactive)', { class: 'bulk' }, false]]),
  ...cases('SupportTicketResponse', ticketResponse, [
    ['without a relay', without(ticketResponse, 'relay'), false],
  ]),
  // The support socket (0.120, CT-938…CT-941).
  ...cases('SupportState', supportState, [
    ['off', supportStateOff, true],
    ['prod, with a help code and two wrong ones', supportStateProd, true],
    ['forever', { ...supportState, grant: { ...rhGrant, until: null } }, true],
    ['no host key yet', { ...supportStateOff, hostKey: null }, true],
    ['not available', { ...supportStateOff, available: false }, true],
    ['a newer member', { ...supportState, port: 22 }, true, supportState],
    ['an unknown environment', { ...supportState, environment: 'staging' }, false],
    [
      'a help code with an O',
      { ...supportStateProd, grant: { ...supportStateProd.grant, helpCode: 'KQ7OMX' } },
      false,
    ],
    [
      'a help code as shown',
      { ...supportStateProd, grant: { ...supportStateProd.grant, helpCode: 'KQ7·2MX' } },
      false,
    ],
    ['nine connected', { ...supportState, connected: Array.from({ length: 9 }, () => rhConnected) }, false],
    ['who with an id', { ...supportState, connected: [{ ...rhConnected, who: 'x'.repeat(41) }] }, false],
    ['a visit id with a slash', { ...supportState, connected: [{ ...rhConnected, visitId: '../x' }] }, false],
    [
      'the owner without an account',
      { ...supportState, grant: { ...rhGrant, grantedBy: { name: 'Mara' } } },
      false,
    ],
    ['wrong codes missing', { ...supportState, grant: without(rhGrant, 'wrongCodes') }, false],
  ]),
  ...cases('SupportGrantRequest', { v: 1, level: 'look', duration: 'hour', grantedBy: rhOwner }, [
    ['forever (the service decides)', { v: 1, level: 'fix', duration: 'forever', grantedBy: rhOwner }, true],
    ['seconds instead of a duration', { v: 1, level: 'fix', durationS: 3_600, grantedBy: rhOwner }, false],
    ['a month', { v: 1, level: 'fix', duration: 'month', grantedBy: rhOwner }, false],
    ['root', { v: 1, level: 'root', duration: 'hour', grantedBy: rhOwner }, false],
    [
      'a help code chosen by the caller',
      { v: 1, level: 'look', duration: 'hour', grantedBy: rhOwner, helpCode: 'KQ72MX' },
      false,
    ],
    ['version 2', { v: 2, level: 'look', duration: 'hour', grantedBy: rhOwner }, false],
  ]),
  ...cases('SupportStopRequest', { v: 1, reason: 'owner', by: rhOwner }, [
    ['at the desk', { v: 1, reason: 'desk' }, true],
    ['expired (the service’s own)', { v: 1, reason: 'expired' }, false],
    ['a newer member (command input)', { v: 1, reason: 'desk', quiet: true }, false],
  ]),
  ...cases('SupportVisitsAnswer', { v: 1, visits: [rhVisit] }, [
    ['none', { v: 1, visits: [] }, true],
    ['going on', { v: 1, visits: [{ ...rhVisit, endedAt: null }] }, true],
    [
      'a newer step kind (tolerant readers drop the step)',
      { v: 1, visits: [{ ...rhVisit, steps: [{ at: rhAt, kind: 'upload' }] }] },
      false,
    ],
    [
      'a command line on two lines',
      { v: 1, visits: [{ ...rhVisit, steps: [{ at: rhAt, kind: 'exec', line: 'ls\nrm' }] }] },
      false,
    ],
    [
      'a command line of 501 characters',
      { v: 1, visits: [{ ...rhVisit, steps: [{ at: rhAt, kind: 'exec', line: 'x'.repeat(501) }] }] },
      false,
    ],
    [
      'a unit with a space',
      { v: 1, visits: [{ ...rhVisit, steps: [{ at: rhAt, kind: 'restart', units: ['whombat voice'] }] }] },
      false,
    ],
    [
      'nine units',
      {
        v: 1,
        visits: [
          {
            ...rhVisit,
            steps: [{ at: rhAt, kind: 'look', command: 'logs', units: Array(9).fill('a.service') }],
          },
        ],
      },
      false,
    ],
    ['201 steps', { v: 1, visits: [{ ...rhVisit, steps: Array(201).fill(rhSteps[0]) }] }, false],
    ['21 visits', { v: 1, visits: Array(21).fill(rhVisit) }, false],
  ]),
  ...cases('SupportEventsAnswer', { v: 1, events: supportEvents, next: 7 }, [
    ['nothing new', { v: 1, events: [], next: 7 }, true],
    ['before the first event', { v: 1, events: [], next: 0 }, true],
    ['seq 0', { v: 1, events: [{ seq: 0, at: rhAt, kind: 'expired' }], next: 0 }, false],
    ['an unknown kind', { v: 1, events: [{ seq: 8, at: rhAt, kind: 'reboot' }], next: 8 }, false],
    ['seconds as the duration', { v: 1, events: [{ ...supportEvents[0], duration: 3_600 }], next: 1 }, false],
    ['101 events', { v: 1, events: Array(101).fill(supportEvents[5]), next: 7 }, false],
  ]),
  // Client bundles (CT-74).
  ...cases('ClientBundle', clientBundle, [
    [
      'codex from a tar.gz',
      set(clientBundle, {
        provider: 'codex',
        version: '0.158.0',
        artifact: {
          ...clientBundle.artifact,
          target: 'clients/codex/0.158.0/linux-x86_64.tar.gz',
          path: 'codex',
        },
        source: {
          url: 'https://github.com/openai/codex/releases/download/rust-v0.158.0/codex-x86_64-unknown-linux-musl.tar.gz',
          sha256: 'c'.repeat(64),
          size: 30_000_000,
          format: 'tar.gz',
          path: 'codex-x86_64-unknown-linux-musl',
        },
      }),
      true,
    ],
    [
      'an http source',
      set(clientBundle, { source: { ...clientBundle.source, url: 'http://example.com/claude' } }),
      false,
    ],
    [
      'a target outside clients/',
      set(clientBundle, {
        artifact: { ...clientBundle.artifact, target: 'runtime/claude/2.1.290/linux-x86_64.tar.gz' },
      }),
      false,
    ],
    [
      'an absolute path inside the archive',
      set(clientBundle, { artifact: { ...clientBundle.artifact, path: '/usr/bin/claude' } }),
      false,
    ],
    ['windows', set(clientBundle, { os: 'windows' }), false],
    ['a fixtures digest without sha256:', set(clientBundle, { fixturesDigest: 'f'.repeat(64) }), false],
    ['unknown member (strict)', set(clientBundle, { note: 'x' }), false],
  ]),
  ...cases('ReleaseTuple', tuple, [
    ['unknown member (hashed documents stay strict)', set(tuple, { notes: 'x' }), false],
    ['no providers', set(tuple, { providers: [] }), true],
    [
      'store path outside /nix/store',
      set(tuple, { manager: { ...component('d', 'x'), storePath: '/opt/whombat' } }),
      false,
    ],
    [
      'store path with invalid hash letter e',
      set(tuple, { manager: { ...component('d', 'x'), storePath: `/nix/store/${'e'.repeat(32)}-x` } }),
      false,
    ],
    [
      'narHash without prefix',
      set(tuple, { manager: { ...component('d', 'x'), narHash: 'd'.repeat(64) } }),
      false,
    ],
    ['uppercase release id', set(tuple, { releaseId: 'RT-1' }), false],
    [
      'client security floor (CT-53)',
      set(tuple, { clientFloor: { web: 2026100401, android: 140, ios: 88, desktop: 0, cli: 0 } }),
      true,
    ],
    [
      'client floor without a platform',
      set(tuple, { clientFloor: { web: 1, android: 140, ios: 88, desktop: 0 } }),
      false,
    ],
    [
      'client floor with an unknown platform (strict)',
      set(tuple, { clientFloor: { web: 1, android: 1, ios: 1, desktop: 0, cli: 0, watch: 1 } }),
      false,
    ],
    [
      'client floor as a version string',
      set(tuple, { clientFloor: { web: '1.4.0', android: 1, ios: 1, desktop: 0, cli: 0 } }),
      false,
    ],
    ['null client floor (absent means none)', set(tuple, { clientFloor: null }), false],
  ]),
  ...cases(
    'UpdateProgressRequest',
    {
      sequence: 7,
      state: 'RolledBack',
      current: 'rt-2026.09.25-1',
      candidate: 'rt-2026.10.01-1',
      attempt: 1,
      failure: 'health_timeout',
      failedChecks: ['session_endpoint'],
      at: now,
    },
    [
      [
        'unknown check',
        {
          sequence: 7,
          state: 'RolledBack',
          current: 'rt-2026.09.25-1',
          candidate: null,
          attempt: 1,
          failure: null,
          failedChecks: ['disk'],
          at: now,
        },
        false,
      ],
    ],
  ),
  ...cases('RuntimeHealth', health, [
    ['unknown member from a newer runtime is stripped', set(health, { uptimeS: 3 }), true, health],
    [
      'unknown access',
      set(health, {
        checks: { ...health.checks, migrations: { ...health.checks.migrations, access: 'write-only' } },
      }),
      false,
    ],
    ['missing draining', without(health, 'draining'), false],
  ]),
  ...cases('DrainRequest', drain, [
    ['backup write barrier', set(drain, { reason: 'backup', scope: 'writes', releaseId: undefined }), true],
    ['unknown member in a command', set(drain, { force: true }), false],
    ['lease below 1 s', set(drain, { leaseMs: 999 }), false],
    ['unknown reason', set(drain, { reason: 'reboot' }), false],
  ]),
  ...cases('DrainStatus', drainStatus, [
    [
      'non-ASCII description (fold typographic quotes first)',
      set(drainStatus, {
        blockers: [{ ...drainStatus.blockers[0], description: 'Codex is answering in “billing”' }],
      }),
      false,
    ],
    [
      'time without a zone',
      set(drainStatus, { blockers: [{ ...drainStatus.blockers[0], since: '2026-09-25T12:00:00' }] }),
      false,
    ],
  ]),
  ...cases('BackupServiceStatus', backupStatus, [
    [
      'fractional RTO seconds (integers only)',
      set(backupStatus, {
        recoverability: { lastDrill: { ...backupStatus.recoverability.lastDrill, rtoSeconds: 412.5 } },
      }),
      false,
    ],
    [
      'unprotected, nothing yet',
      set(backupStatus, {
        state: 'unprotected',
        protected: false,
        destination: { configured: false },
        lastSuccess: null,
        lastAttemptOk: null,
        recoverability: { lastDrill: null },
      }),
      true,
    ],
    ['other kind', set(backupStatus, { kind: 'whombat.backup-status/2' }), false],
  ]),
  ...cases('FactsRequest', { v: 1, backup: backupStatus, update: null }, [
    ['no backup service', { v: 1, backup: null, update: null }, true],
    [
      'update facts with the running tuple’s client floor (CT-53)',
      { v: 1, backup: null, update: { ...updateFacts, clientFloor: floor } },
      true,
    ],
    ['update facts without a client floor', { v: 1, backup: null, update: updateFacts }, true],
    [
      'update facts with failure detail, waiting and the last update (CT-138)',
      {
        v: 1,
        backup: null,
        update: {
          ...updateFacts,
          failureDetail,
          waiting: {
            reason: 'checkpoint',
            since: '2026-09-29T08:00:00Z',
            blockers: [{ kind: 'no_destination', count: 1 }],
          },
          lastUpdate: { release: 'pve-20260928.6', from: null, at: '2026-09-28T20:00:00Z' },
        },
      },
      true,
    ],
    [
      'an update waiting for the owner, who asked to approve each one (4.2)',
      {
        v: 1,
        backup: null,
        update: {
          ...updateFacts,
          askFirst: true,
          waiting: { reason: 'owner', since: '2026-09-29T08:00:00Z', blockers: [] },
        },
      },
      true,
    ],
    [
      'ask before updating that isn’t a yes or no',
      { v: 1, backup: null, update: { ...updateFacts, askFirst: 'yes' } },
      false,
    ],
    [
      'a newer manager’s failure detail member is stripped (tolerant facts)',
      { v: 1, backup: null, update: { ...updateFacts, failureDetail: { ...failureDetail, stepId: 'x' } } },
      true,
      { v: 1, backup: null, update: { ...updateFacts, failureDetail } },
    ],
    [
      'an unknown waiting reason',
      {
        v: 1,
        backup: null,
        update: {
          ...updateFacts,
          waiting: { reason: 'tea_break', since: '2026-09-29T08:00:00Z', blockers: [] },
        },
      },
      false,
    ],
    [
      'client floor with a negative build',
      { v: 1, backup: null, update: { ...updateFacts, clientFloor: { ...floor, ios: -1 } } },
      false,
    ],
    ['unknown member in a command', { v: 1, backup: null, update: null, extra: 1 }, false],
  ]),
  ...cases(
    'RuntimeRevocationRequest',
    { peerId: '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH', revokedAt: '2026-09-25T12:00:00Z' },
    [['not a PeerId', { peerId: 'dev_1', revokedAt: '2026-09-25T12:00:00Z' }, false]],
  ),
  ...cases('ClaimClaimedRequest', { claimId: 'clm_8Hq2mXk3pZ', claimedAt: now }, [
    ['0.4 shape without claimId', { claimedAt: now }, false],
    ['0.3 shape with claim and org', { claim: 'clm_12345678', org: 'org_42', claimedAt: now }, false],
  ]),
  ...cases('UpdateAssignmentResponse', { result: 'unchanged', assignment: null, nextCheckS: 3600 }, [
    ['none', { result: 'none', assignment: null, nextCheckS: 3600 }, true],
    ['0.4 shape without result', { assignment: null, nextCheckS: 3600 }, false],
  ]),
  ...cases('ClaimLookupRequest', {}, [['with a member', { lookup: '4821' }, false]]),
  ...cases('ClaimLookupResponse', { lookup: '4821', expiresAt: now + 600, renewAfterS: 300 }, [
    ['six digits', { lookup: '048211', expiresAt: now + 600, renewAfterS: 300 }, true],
    ['three digits', { lookup: '482', expiresAt: now + 600, renewAfterS: 300 }, false],
    ['seven digits', { lookup: '4821123', expiresAt: now + 600, renewAfterS: 300 }, false],
    ['a number', { lookup: 4821, expiresAt: now + 600, renewAfterS: 300 }, false],
    ['renewal too fast', { lookup: '4821', expiresAt: now + 600, renewAfterS: 5 }, false],
  ]),
  ...cases('ClaimLookupLeaseRequest', { v: 1, lookup: '4821', expiresAt: '2026-09-26T12:10:00Z' }, [
    ['no lease', { v: 1, lookup: null }, true],
    ['lookup missing', { v: 1, expiresAt: '2026-09-26T12:10:00Z' }, false],
    ['letters in the lookup', { v: 1, lookup: 'KX48', expiresAt: '2026-09-26T12:10:00Z' }, false],
    ['epoch time', { v: 1, lookup: '4821', expiresAt: now }, false],
    ['extra member', { v: 1, lookup: null, letters: 'KXQM' }, false],
  ]),
  ...cases('ConsoleState', { v: 1, state: 'claimable', code: 'KXQM', url: 'https://app.whombat.com/claim' }, [
    ['waiting', { v: 1, state: 'waiting', url: 'https://app.whombat.com/claim' }, true],
    [
      'backoff',
      { v: 1, state: 'backoff', url: 'https://app.whombat.com/claim', retryAt: '2026-09-26T12:04:00Z' },
      true,
    ],
    [
      'unknown member stripped',
      { v: 1, state: 'claimed', url: 'https://dev.whombat.com/claim', note: 'x' },
      true,
      { v: 1, state: 'claimed', url: 'https://dev.whombat.com/claim' },
    ],
    [
      'code outside the alphabet',
      { v: 1, state: 'claimable', code: 'KO-4821-QM', url: 'https://a.b/claim' },
      false,
    ],
    ['letters only (CT-67)', { v: 1, state: 'claimable', code: 'KXQM', url: 'https://a.b/claim' }, true],
    [
      'the full code (before CT-67)',
      { v: 1, state: 'claimable', code: 'KX-4821-QM', url: 'https://a.b/claim' },
      false,
    ],
    [
      'a letter outside the alphabet',
      { v: 1, state: 'claimable', code: 'KXQO', url: 'https://a.b/claim' },
      false,
    ],
    ['escape sequence in the url', { v: 1, state: 'claimed', url: 'https://a.b/\u001b[2J' }, false],
    ['space in the url', { v: 1, state: 'claimed', url: 'https://a.b/ claim' }, false],
    ['no scheme', { v: 1, state: 'claimed', url: 'app.whombat.com/claim' }, false],
    ['unknown state', { v: 1, state: 'locked', url: 'https://a.b/claim' }, false],
    ['version 2', { v: 2, state: 'claimed', url: 'https://a.b/claim' }, false],
    // Burrow names (CT-116): any script, one line, nothing invisible.
    [
      'burrows',
      {
        v: 1,
        state: 'claimed',
        url: 'https://a.b/claim',
        burrows: { first: 'Banjo\u2019s Burrow', more: 2 },
      },
      true,
    ],
    [
      'burrows: CJK and emoji',
      {
        v: 1,
        state: 'claimed',
        url: 'https://a.b/claim',
        burrows: { first: '\u5DE3\u7A74 \u{1F43B}', more: 0 },
      },
      true,
    ],
    [
      'burrows: RTL script',
      {
        v: 1,
        state: 'claimed',
        url: 'https://a.b/claim',
        burrows: { first: '\u05DE\u05D7\u05D9\u05DC\u05D4', more: 0 },
      },
      true,
    ],
    [
      'burrows: 64 code points',
      {
        v: 1,
        state: 'claimed',
        url: 'https://a.b/claim',
        burrows: { first: '\u{1F43B}'.repeat(64), more: 9999 },
      },
      true,
    ],
    [
      'burrows: 65 code points',
      {
        v: 1,
        state: 'claimed',
        url: 'https://a.b/claim',
        burrows: { first: '\u{1F43B}'.repeat(65), more: 0 },
      },
      false,
    ],
    [
      'burrows: one character',
      { v: 1, state: 'claimed', url: 'https://a.b/claim', burrows: { first: 'B', more: 0 } },
      true,
    ],
    [
      'burrows: empty name',
      { v: 1, state: 'claimed', url: 'https://a.b/claim', burrows: { first: '', more: 0 } },
      false,
    ],
    [
      'burrows: escape sequence',
      { v: 1, state: 'claimed', url: 'https://a.b/claim', burrows: { first: 'Banjo\u001b[2J', more: 0 } },
      false,
    ],
    [
      'burrows: tab',
      { v: 1, state: 'claimed', url: 'https://a.b/claim', burrows: { first: 'Banjo\tBurrow', more: 0 } },
      false,
    ],
    [
      'burrows: line break',
      { v: 1, state: 'claimed', url: 'https://a.b/claim', burrows: { first: 'Banjo\nBurrow', more: 0 } },
      false,
    ],
    [
      'burrows: NEL (C1 control)',
      { v: 1, state: 'claimed', url: 'https://a.b/claim', burrows: { first: 'Banjo\u0085Burrow', more: 0 } },
      false,
    ],
    [
      'burrows: bidi override U+202E',
      { v: 1, state: 'claimed', url: 'https://a.b/claim', burrows: { first: 'Banjo\u202EworruB', more: 0 } },
      false,
    ],
    [
      'burrows: zero-width space U+200B',
      { v: 1, state: 'claimed', url: 'https://a.b/claim', burrows: { first: 'Banjo\u200BBurrow', more: 0 } },
      false,
    ],
    [
      'burrows: BOM U+FEFF',
      { v: 1, state: 'claimed', url: 'https://a.b/claim', burrows: { first: '\uFEFFBanjo', more: 0 } },
      false,
    ],
    [
      'burrows: line separator U+2028',
      { v: 1, state: 'claimed', url: 'https://a.b/claim', burrows: { first: 'Banjo\u2028Burrow', more: 0 } },
      false,
    ],
    [
      'burrows: no-break space',
      { v: 1, state: 'claimed', url: 'https://a.b/claim', burrows: { first: 'Banjo\u00A0Burrow', more: 0 } },
      false,
    ],
    [
      'burrows: ideographic space',
      { v: 1, state: 'claimed', url: 'https://a.b/claim', burrows: { first: 'Banjo\u3000Burrow', more: 0 } },
      false,
    ],
    [
      'burrows: leading space',
      { v: 1, state: 'claimed', url: 'https://a.b/claim', burrows: { first: ' Banjo', more: 0 } },
      false,
    ],
    [
      'burrows: trailing space',
      { v: 1, state: 'claimed', url: 'https://a.b/claim', burrows: { first: 'Banjo ', more: 0 } },
      false,
    ],
    [
      'burrows: two inner spaces',
      { v: 1, state: 'claimed', url: 'https://a.b/claim', burrows: { first: 'Banjo  Burrow', more: 0 } },
      true,
    ],
    [
      'burrows: more than 9999',
      { v: 1, state: 'claimed', url: 'https://a.b/claim', burrows: { first: 'Banjo', more: 10000 } },
      false,
    ],
    [
      'burrows: negative',
      { v: 1, state: 'claimed', url: 'https://a.b/claim', burrows: { first: 'Banjo', more: -1 } },
      false,
    ],
    [
      'burrows: fractional',
      { v: 1, state: 'claimed', url: 'https://a.b/claim', burrows: { first: 'Banjo', more: 1.5 } },
      false,
    ],
    [
      'burrows: first missing',
      { v: 1, state: 'claimed', url: 'https://a.b/claim', burrows: { more: 0 } },
      false,
    ],
    // A screen sign-in (0.106, CT-626): six letters, the requester's name and device as display text.
    ['signIn', signedIn(), true],
    ['signIn: an email as the name', signedIn({ name: 'mara@example.com' }), true],
    ['signIn: a name in another script', signedIn({ name: '\u05DE\u05D7\u05D9\u05DC\u05D4' }), true],
    ['signIn: four letters', signedIn({ code: 'KXQM' }), false],
    ['signIn: a letter outside the alphabet', signedIn({ code: 'KXQMTO' }), false],
    ['signIn: lower case', signedIn({ code: 'kxqmtr' }), false],
    ['signIn: grouped as shown', signedIn({ code: 'KXQ MTR' }), false],
    ['signIn: escape sequence in the device', signedIn({ device: 'Pixel\u001b[2J' }), false],
    ['signIn: bidi override in the name', signedIn({ name: 'Mara\u202Eevil' }), false],
    ['signIn: line break in the device', signedIn({ device: 'Pixel\n9' }), false],
    ['signIn: 65 code points', signedIn({ name: 'm'.repeat(65) }), false],
    ['signIn: epoch expiry', signedIn({ expiresAt: 1760961900 }), false],
    [
      'signIn: without expiresAt',
      {
        v: 1,
        state: 'claimed',
        url: 'https://a.b/claim',
        signIn: { code: 'KXQMTR', name: 'Mara', device: 'Pixel 9' },
      },
      false,
    ],
  ]),
  // AI clients on the manager socket (CT-73).
  ...cases('LocalClient', localClient, [
    ['not installed', { ...localClient, state: 'not_installed', installed: null, latest: null }, true],
    [
      'failed with an error',
      { ...localClient, state: 'failed', error: { code: 'digest_mismatch', message: 'sha256 differs' } },
      true,
    ],
    [
      'a relative executable path',
      set(localClient, {
        installed: {
          ...localClient.installed,
          executable: { ...localClient.installed.executable, path: 'claude' },
        },
      }),
      false,
    ],
    [
      'a dot-dot segment',
      set(localClient, {
        installed: {
          ...localClient.installed,
          executable: { ...localClient.installed.executable, path: '/persist/../bin/sh' },
        },
      }),
      false,
    ],
    ['progress above 100', set(localClient, { progress: 101 }), false],
    ['a provider the manager does not install', set(localClient, { provider: 'github' }), false],
    ['unknown member stripped', set(localClient, { note: 'x' }), true, localClient],
  ]),
  ...cases(
    'LocalClientsStatus',
    { v: 1, clients: [localClient], channel: { sequence: 12, checkedAt: '2026-09-26T12:00:00Z' } },
    [['no channel yet', { v: 1, clients: [], channel: null }, true]],
  ),
  ...cases('ClientsPushRequest', { v: 1, clients: [localClient], channel: null }, [
    ['extra member', { v: 1, clients: [], channel: null, note: 'x' }, false],
  ]),
  // The appliance licence (0.10, CT-76, CT-77).
  ...cases('LicenceKeySet', licenceKeySet, [
    ['a private key member', { ...licenceKeySet, keys: [{ ...licenceJwk, d: 'A'.repeat(43) }] }, false],
    ['no keys', { ...licenceKeySet, keys: [] }, false],
    ['nine keys', { ...licenceKeySet, keys: Array(9).fill(licenceJwk) }, false],
    ['v 2', { ...licenceKeySet, v: 2 }, false],
    ['environment in upper case', { ...licenceKeySet, env: 'Prod' }, false],
    ['extra member', { ...licenceKeySet, url: 'https://x.invalid' }, false],
  ]),
  ...cases('LicenceLimits', { devices: 1, connectors: 0 }, [
    ['devices unlimited', { devices: null, connectors: null }, false],
    ['negative', { devices: 1, connectors: -1 }, false],
    ['an agent count (one agent, OA-02)', { devices: 1, agents: 3, connectors: 0 }, false],
    ['a member count (one person, CT-1562)', { devices: 1, members: 5, connectors: 0 }, false],
  ]),
  ...cases('LicenceRenewRequest', {}, [['with a member', { force: true }, false]]),
  ...cases('LicenceRenewResponse', { token: ticket, expiresAt: now + 1_209_600, renewAfterS: 86_400, now }, [
    ['renew after 59 s', { token: ticket, expiresAt: now, renewAfterS: 59, now }, false],
    ['not a JWS', { token: 'abc', expiresAt: now, renewAfterS: 3_600, now }, false],
  ]),
  // Feedback drop delivery (CT-91): the card is opaque here, the rest strictly shaped.
  ...cases('FeedbackCardsSyncRequest', { seq: 18, cards: [feedbackCard] }, [
    ['empty set (everything withdrawn)', { seq: 19, cards: [] }, true],
    [
      'card with any members',
      { seq: 18, cards: [{ card: { anything: ['goes', 1] }, sig: feedbackSig }] },
      true,
    ],
    ['card not an object', { seq: 18, cards: [{ card: 'x', sig: feedbackSig }] }, false],
    ['short signature', { seq: 18, cards: [{ card: {}, sig: 'A'.repeat(85) }] }, false],
    ['extra card member', { seq: 18, cards: [{ ...feedbackCard, kid: 'x' }] }, false],
    ['seq 0', { seq: 0, cards: [] }, false],
    ['201 cards', { seq: 18, cards: Array(201).fill(feedbackCard) }, false],
    ['extra member', { seq: 18, cards: [], force: true }, false],
  ]),
  ...cases(
    'FeedbackCardsSyncResponse',
    {
      accepted: [feedbackSite],
      refused: [
        { index: 1, site: feedbackSite, code: 'stale_seq', seq: 40 },
        { index: 2, site: null, code: 'bad_card' },
      ],
    },
    [
      ['nothing', { accepted: [], refused: [] }, true],
      ['unknown code', { accepted: [], refused: [{ index: 0, site: null, code: 'nope' }] }, false],
      ['index 200', { accepted: [], refused: [{ index: 200, site: null, code: 'bad_card' }] }, false],
      ['bad site', { accepted: ['fbs_x'], refused: [] }, false],
    ],
  ),
  ...cases('FeedbackDropsPullRequest', { max: 10, maxBytes: 16 * 1024 * 1024 }, [
    ['21 drops', { max: 21, maxBytes: 16 * 1024 * 1024 }, false],
    ['below 1 MiB', { max: 10, maxBytes: 1024 * 1024 - 1 }, false],
    ['above 47 MiB', { max: 10, maxBytes: 47 * 1024 * 1024 + 1 }, false],
    ['extra member', { max: 10, maxBytes: 16 * 1024 * 1024, wait: true }, false],
  ]),
  ...cases(
    'FeedbackDropsPullResponse',
    { drops: [feedbackDrop], pending: 3, expired: [{ site: feedbackSite, count: 2 }], nextPullS: 2 },
    [
      ['idle', { drops: [], pending: 0, expired: [], nextPullS: 30 }, true],
      [
        'newer member stripped',
        { drops: [], pending: 0, expired: [], nextPullS: 30, hint: 1 },
        true,
        { drops: [], pending: 0, expired: [], nextPullS: 30 },
      ],
      ['next pull 1 s', { drops: [], pending: 0, expired: [], nextPullS: 1 }, false],
      [
        'envelope not base64url',
        { drops: [{ ...feedbackDrop, envelope: 'AA==' }], pending: 0, expired: [], nextPullS: 2 },
        false,
      ],
      [
        'origin not http(s)',
        { drops: [{ ...feedbackDrop, origin: 'null' }], pending: 0, expired: [], nextPullS: 2 },
        false,
      ],
      [
        'bad drop id',
        { drops: [{ ...feedbackDrop, dropId: 'fdr_x' }], pending: 0, expired: [], nextPullS: 2 },
        false,
      ],
      [
        'zero expired',
        { drops: [], pending: 0, expired: [{ site: feedbackSite, count: 0 }], nextPullS: 2 },
        false,
      ],
      [
        'a signed-in drop',
        {
          drops: [{ ...feedbackDrop, reporter: feedbackDropReporter }],
          pending: 0,
          expired: [],
          nextPullS: 30,
        },
        true,
      ],
      [
        'reporter id malformed',
        {
          drops: [{ ...feedbackDrop, reporter: { ...feedbackDropReporter, id: 'fbr_x' } }],
          pending: 0,
          expired: [],
          nextPullS: 30,
        },
        false,
      ],
      [
        'email digest in upper case',
        {
          drops: [{ ...feedbackDrop, reporter: { ...feedbackDropReporter, emailDigest: 'AB'.repeat(32) } }],
          pending: 0,
          expired: [],
          nextPullS: 30,
        },
        false,
      ],
      [
        'newer reporter member stripped',
        {
          drops: [{ ...feedbackDrop, reporter: { ...feedbackDropReporter, name: 'x' } }],
          pending: 0,
          expired: [],
          nextPullS: 30,
        },
        true,
        {
          drops: [{ ...feedbackDrop, reporter: feedbackDropReporter }],
          pending: 0,
          expired: [],
          nextPullS: 30,
        },
      ],
    ],
  ),
  ...cases('FeedbackDropsAckRequest', { dropIds: [feedbackDrop.dropId] }, [
    ['none', { dropIds: [] }, false],
    ['101', { dropIds: Array(101).fill(feedbackDrop.dropId) }, false],
    ['bad id', { dropIds: ['drop-1'] }, false],
  ]),
  ...cases('FeedbackDropsAckResponse', { ok: true }, [['false', { ok: false }, false]]),
  ...cases('RuntimeFeedbackPullRequest', { max: 10, maxBytes: 16 * 1024 * 1024 }, [
    ['no max', { maxBytes: 16 * 1024 * 1024 }, false],
  ]),
  // Reporter sign-in (CT-164): control's attestation on a drop, and the reporters' statuses.
  ...cases(
    'FeedbackReportersPublishRequest',
    { updates: [feedbackReporterUpdate], removals: [{ site: feedbackSite, reference: 'FB-7K3Q-9M2Y' }] },
    [
      ['nothing', { updates: [], removals: [] }, true],
      [
        'every status',
        {
          updates: ['received', 'reviewing', 'needs_info', 'confirmed', 'in_progress', 'fixed', 'closed'].map(
            (status) => ({ ...feedbackReporterUpdate, status }),
          ),
          removals: [],
        },
        true,
      ],
      ['101 updates', { updates: Array(101).fill(feedbackReporterUpdate), removals: [] }, false],
      [
        '101 removals',
        { updates: [], removals: Array(101).fill({ site: feedbackSite, reference: 'FB-7K3Q-9M2Y' }) },
        false,
      ],
      [
        'internal status',
        { updates: [{ ...feedbackReporterUpdate, status: 'triaged' }], removals: [] },
        false,
      ],
      ['unknown type', { updates: [{ ...feedbackReporterUpdate, type: 'question' }], removals: [] }, false],
      [
        'reference with I',
        { updates: [{ ...feedbackReporterUpdate, reference: 'FB-7K3Q-9M2I' }], removals: [] },
        false,
      ],
      ['report text', { updates: [{ ...feedbackReporterUpdate, summary: 'x' }], removals: [] }, false],
      [
        'RFC 3339 time',
        { updates: [{ ...feedbackReporterUpdate, updatedAt: '2026-09-30T08:00:00Z' }], removals: [] },
        false,
      ],
      ['no removals', { updates: [] }, false],
      ['extra member', { updates: [], removals: [], all: true }, false],
    ],
  ),
  ...cases('FeedbackReportersPublishResponse', { ok: true }, [['false', { ok: false }, false]]),
  ...cases('RuntimeFeedbackReportersRequest', { updates: [feedbackReporterUpdate], removals: [] }, [
    [
      'extra update member',
      { updates: [{ ...feedbackReporterUpdate, email: 'a@b.example' }], removals: [] },
      false,
    ],
  ]),
  ...cases('LicencePushRequest', { v: 1, token: ticket, highWater: '2026-09-26T12:00:00Z' }, [
    ['no token yet', { v: 1, token: null, highWater: '2026-09-26T12:00:00Z' }, true],
    ['without highWater', { v: 1, token: ticket }, false],
    ['epoch highWater', { v: 1, token: ticket, highWater: now }, false],
    ['extra member', { v: 1, token: null, highWater: '2026-09-26T12:00:00Z', iat: now }, false],
  ]),
  ...cases('LicencePushResponse', { v: 1, licence: localLicence }, [
    ['unclaimed', { v: 1, licence: null }, true],
    ['unknown state', { v: 1, licence: { ...localLicence, state: 'suspended' } }, false],
    [
      'newer member stripped',
      { v: 1, licence: { ...localLicence, x: 1 } },
      true,
      { v: 1, licence: localLicence },
    ],
  ]),
  ...cases('HostMetricsRequest', { v: 1, range: 'day', timeZone: 'Europe/Amsterdam' }, [
    ['since', { v: 1, range: 'hour', since: '2026-10-11T09:00:00Z', timeZone: 'UTC' }, true],
    ['unknown range', { v: 1, range: 'year', timeZone: 'UTC' }, false],
    ['without a time zone', { v: 1, range: 'day' }, false],
  ]),
  ...cases('HostMetricsResponse', { v: 1, metrics: hostMetrics }, [
    [
      'a gap',
      { v: 1, metrics: { ...hostMetrics, series: { ...hostMetrics.series, points: [null, hostPoint] } } },
      true,
    ],
    [
      'no disk parts',
      {
        v: 1,
        metrics: { ...hostMetrics, disks: { ...hostMetrics.disks, data: { ...hostDisk, parts: null } } },
      },
      true,
    ],
    [
      'on battery (0.100)',
      { v: 1, metrics: { ...hostMetrics, now: { ...hostMetrics.now, power: hostPower } } },
      true,
    ],
    [
      'plugged in, charging',
      {
        v: 1,
        metrics: {
          ...hostMetrics,
          now: {
            ...hostMetrics.now,
            power: { ...hostPower, source: 'ac', charging: true, minutesLeft: null, since: null },
          },
        },
      },
      true,
    ],
    [
      'a battery above 100',
      {
        v: 1,
        metrics: { ...hostMetrics, now: { ...hostMetrics.now, power: { ...hostPower, percent: 101 } } },
      },
      false,
    ],
    [
      'busier than all cores',
      { v: 1, metrics: { ...hostMetrics, now: { ...hostMetrics.now, cpuPermille: 1001 } } },
      false,
    ],
    [
      'the processor’s temperature and the uptime (0.101)',
      { v: 1, metrics: { ...hostMetrics, now: { ...hostMetrics.now, cpuTempC: 46, uptimeS: 8_040 } } },
      true,
    ],
    [
      'a temperature with a fraction',
      { v: 1, metrics: { ...hostMetrics, now: { ...hostMetrics.now, cpuTempC: 46.5 } } },
      false,
    ],
    [
      'a temperature above 150',
      { v: 1, metrics: { ...hostMetrics, now: { ...hostMetrics.now, cpuTempC: 151 } } },
      false,
    ],
    [
      'a negative uptime',
      { v: 1, metrics: { ...hostMetrics, now: { ...hostMetrics.now, uptimeS: -1 } } },
      false,
    ],
    [
      'an unknown disk part',
      {
        v: 1,
        metrics: {
          ...hostMetrics,
          disks: { ...hostMetrics.disks, data: { ...hostDisk, parts: [{ key: 'swap', bytes: 1 }] } },
        },
      },
      false,
    ],
  ]),
  ...cases('DeskState', deskState, [
    // Remote help on the glance (0.120, CT-943).
    [
      'remote help on, someone connected',
      {
        ...deskState,
        remoteHelp: { level: 'fix', until: '2026-10-22T14:00:00Z', connected: 'Claude' },
      },
      true,
    ],
    [
      'remote help on forever, nobody connected',
      { ...deskState, remoteHelp: { level: 'look', until: null, connected: null } },
      true,
    ],
    [
      'remote help at an unknown level',
      { ...deskState, remoteHelp: { level: 'root', until: null, connected: null } },
      false,
    ],
    [
      'remote help naming someone on two lines',
      { ...deskState, remoteHelp: { level: 'fix', until: null, connected: 'Claude\nfrom support' } },
      false,
    ],
    [
      'remote help naming someone in more than 40 characters',
      { ...deskState, remoteHelp: { level: 'fix', until: null, connected: 'x'.repeat(41) } },
      false,
    ],
    [
      'nobody paired',
      {
        v: 1,
        now: deskAt,
        paired: null,
        pairing: null,
        lock: { state: 'locked' },
        glance: null,
        power: null,
        talk: null,
      },
      true,
    ],
    ['pairing letters', { ...deskState, pairing: { code: 'KXQM', expiresAt: '2026-10-20T12:44:00Z' } }, true],
    [
      'pairing letters outside the alphabet',
      { ...deskState, pairing: { code: 'KXQO', expiresAt: deskAt } },
      false,
    ],
    [
      'unlocked, with an ask’s words',
      {
        ...deskGlanceWith({ needsYou: { count: 1, items: [deskAskWords] } }),
        lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z' },
      },
      true,
    ],
    [
      'an ask that stays on the phone',
      deskGlanceWith({
        needsYou: {
          count: 1,
          items: [{ ...deskAsk, title: 'Deploy main to production?', onDesk: false, phoneReason: 'release' }],
        },
      }),
      true,
    ],
    [
      'a risky ask approved with the PIN, deny, asked in the conversation (0.108)',
      {
        ...deskGlanceWith({
          needsYou: {
            count: 1,
            items: [
              {
                ...deskAskWords,
                title: 'Deploy main to production?',
                onDesk: false,
                phoneReason: 'release',
                deny: true,
                approveWithPin: true,
                inTalk: true,
              },
            ],
          },
        }),
        lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z' },
      },
      true,
    ],
    [
      'an ask with the web’s wider choices and who asks (0.116)',
      {
        ...deskGlanceWith({
          needsYou: {
            count: 1,
            items: [
              {
                ...deskAskWords,
                title: 'Install 23 updates on Home Assistant',
                deny: true,
                choices: [{ scope: 'agent', label: 'Don’t ask again on Home Assistant' }],
                from: 'Banjo',
              },
            ],
          },
        }),
        lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z' },
      },
      true,
    ],
    [
      'a wider choice for once',
      {
        ...deskGlanceWith({
          needsYou: { count: 1, items: [{ ...deskAsk, choices: [{ scope: 'once', label: 'Approve' }] }] },
        }),
        lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z' },
      },
      false,
    ],
    [
      'three wider choices',
      {
        ...deskGlanceWith({
          needsYou: {
            count: 1,
            items: [
              {
                ...deskAsk,
                choices: [
                  { scope: 'task', label: 'Allow for this task' },
                  { scope: 'agent', label: 'Always allow' },
                  { scope: 'agent', label: 'Always allow' },
                ],
              },
            ],
          },
        }),
        lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z' },
      },
      false,
    ],
    [
      'no wider choices',
      deskGlanceWith({ needsYou: { count: 1, items: [{ ...deskAsk, choices: [] }] } }),
      false,
    ],
    [
      'a choice label of 121 characters',
      {
        ...deskGlanceWith({
          needsYou: {
            count: 1,
            items: [{ ...deskAsk, choices: [{ scope: 'agent', label: 'x'.repeat(121) }] }],
          },
        }),
        lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z' },
      },
      false,
    ],
    [
      'who asks, 41 characters',
      deskGlanceWith({ needsYou: { count: 1, items: [{ ...deskAsk, from: 'x'.repeat(41) }] } }),
      false,
    ],
    ['who asks, empty', deskGlanceWith({ needsYou: { count: 1, items: [{ ...deskAsk, from: '' }] } }), false],
    [
      'an unknown phone reason',
      deskGlanceWith({
        needsYou: { count: 1, items: [{ ...deskAsk, onDesk: false, phoneReason: 'scary' }] },
      }),
      false,
    ],
    ['phone unlock', { ...deskState, lock: { state: 'phone', expiresAt: '2026-10-20T12:36:00Z' } }, true],
    ['backoff', { ...deskState, lock: { state: 'backoff', retryAt: '2026-10-20T12:35:00Z' } }, true],
    ['an unknown lock state', { ...deskState, lock: { state: 'open' } }, false],
    ['on battery', { ...deskState, power: hostPower }, true],
    ['battery above 100', { ...deskState, power: { ...hostPower, percent: 101 } }, false],
    ['a talk', { ...deskState, talk: deskTalk }, true],
    [
      'quiet hours, black',
      { ...deskState, paired: { ...deskPaired, quiet: true, night: 'black', lockedView: 'time' } },
      true,
    ],
    [
      'newer members stripped',
      { ...deskGlanceWith({ weather: 'sunny' }), paired: { ...deskPaired, wakeWord: false } },
      true,
      deskState,
    ],
    ['six asks', deskGlanceWith({ needsYou: { count: 6, items: Array(6).fill(deskAsk) } }), false],
    ['five servers', deskGlanceWith({ servers: Array(5).fill(deskServer) }), false],
    ['a line break in the status', deskGlanceWith({ status: { text: 'All fine.\nReally.' } }), false],
    [
      'a zero-width space in a server name',
      deskGlanceWith({ servers: [{ ...deskServer, name: 'pve\u200b-02' }] }),
      false,
    ],
    [
      'a no-break space in a tile',
      deskGlanceWith({ tiles: [{ icon: 'temperature', value: '21.4\u00a0°C', label: 'Living room' }] }),
      false,
    ],
    [
      'any script and emoji',
      deskGlanceWith({ status: { text: 'Alles goed 🎉 — “Plex” läuft, 日本語' } }),
      true,
    ],
    [
      'a title of 120 emoji',
      deskGlanceWith({ needsYou: { count: 1, items: [{ ...deskAsk, title: '🎉'.repeat(120) }] } }),
      true,
    ],
    [
      'a title of 121 characters',
      deskGlanceWith({ needsYou: { count: 1, items: [{ ...deskAsk, title: 'x'.repeat(121) }] } }),
      false,
    ],
    ['an empty note', deskGlanceWith({ servers: [{ ...deskServer, note: '' }] }), true],
    [
      'a fraction on a meter',
      deskGlanceWith({ servers: [{ ...deskServer, cpu: { value: 12.5, tone: 'ok' } }] }),
      false,
    ],
    ['a mark with capitals', deskGlanceWith({ servers: [{ ...deskServer, mark: 'Proxmox' }] }), false],
    ['an unknown tile icon', deskGlanceWith({ tiles: [{ icon: 'rocket', value: '1', label: 'x' }] }), false],
    [
      'an unknown face',
      { ...deskState, paired: { ...deskPaired, assistant: { name: 'Neo', face: 'wizard' } } },
      false,
    ],
    [
      'tone 6',
      { ...deskState, paired: { ...deskPaired, person: { name: 'John', initial: 'J', tone: 6 } } },
      false,
    ],
    [
      'initials of three',
      { ...deskState, paired: { ...deskPaired, person: { name: 'John', initial: 'JPX', tone: 1 } } },
      false,
    ],
    ['epoch time', { ...deskState, now: now }, false],
    ['version 2', { ...deskState, v: 2 }, false],
    ['a new box (0.101)', deskNewBox, true],
    [
      'a new box, unlocked',
      { ...deskNewBox, lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z' } },
      true,
    ],
    [
      'a new box in a VM: no temperature, no network',
      deskNewBoxWith({ temp: undefined, network: null }),
      true,
    ],
    ['a new box, the manager without an uptime', deskNewBoxWith({ up: '' }), true],
    [
      'a new box, its parts not measured',
      deskNewBoxWith({ storage: { ...deskBox.storage, parts: [] } }),
      true,
    ],
    [
      'a new box, unlocked in Only the time',
      {
        ...deskNewBox,
        paired: { ...deskPaired, lockedView: 'time' },
        lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z' },
      },
      true,
    ],
    ['no PIN yet (0.101)', { ...deskState, paired: { ...deskPaired, hasPin: false } }, true],
    ['a four-digit PIN (0.103)', { ...deskState, paired: { ...deskPaired, pinDigits: 4 } }, true],
    ['a PIN of three digits', { ...deskState, paired: { ...deskPaired, pinDigits: 3 } }, false],
    ['a PIN of seven digits', { ...deskState, paired: { ...deskPaired, pinDigits: 7 } }, false],
    ['a PIN length as text', { ...deskState, paired: { ...deskPaired, pinDigits: '4' } }, false],
    [
      'unlocked, the camera on, someone there (0.103)',
      {
        ...deskState,
        lock: { state: 'unlocked', until: '2026-10-20T12:34:30Z', camera: true, present: true },
      },
      true,
    ],
    [
      'unlocked, the camera on, nobody seen yet',
      {
        ...deskState,
        lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z', camera: true, present: false },
      },
      true,
    ],
    [
      'the camera as a word',
      { ...deskState, lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z', camera: 'on' } },
      false,
    ],
    [
      'unlocked until Lock (0.107)',
      { ...deskState, lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z', stays: true } },
      true,
    ],
    [
      'the camera looking, someone there (0.107)',
      { ...deskState, presence: { camera: true, watching: true, here: true } },
      true,
    ],
    [
      'the camera looking, too dark to tell',
      { ...deskState, presence: { camera: true, watching: false, here: false } },
      true,
    ],
    [
      'the camera looking without saying whether it watches',
      { ...deskState, presence: { camera: true, here: true } },
      false,
    ],
    [
      'stays as a word',
      { ...deskState, lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z', stays: 'yes' } },
      false,
    ],
    [
      'a figure with a no-break space',
      deskNewBoxWith({ memory: { ...deskBox.memory, total: '64\u00a0GB' } }),
      false,
    ],
    [
      'a figure of nine characters',
      deskNewBoxWith({ memory: { ...deskBox.memory, used: { value: '123456789', unit: 'GB' } } }),
      false,
    ],
    [
      'an hour of 61 points',
      deskNewBoxWith({ history: { stepS: 60, cpu: Array(61).fill(1), memory: Array(61).fill(1) } }),
      false,
    ],
    ['a percent above 100', deskNewBoxWith({ cpu: { ...deskBox.cpu, percent: 101 } }), false],
    ['a percent with a fraction', deskNewBoxWith({ cpu: { ...deskBox.cpu, percent: 7.5 } }), false],
    ['no cores', deskNewBoxWith({ cpu: { ...deskBox.cpu, cores: 0 } }), false],
    [
      'an unknown storage part',
      deskNewBoxWith({
        storage: { ...deskBox.storage, parts: [{ key: 'swap', value: '2 GB', percent: 1 }] },
      }),
      false,
    ],
    [
      'three storage parts',
      deskNewBoxWith({
        storage: { ...deskBox.storage, parts: [...deskBox.storage.parts, deskBox.storage.parts[0]] },
      }),
      false,
    ],
    ['a step of two hours', deskNewBoxWith({ history: { ...deskBox.history, stepS: 7_200 } }), false],
    ['This Whombat beside servers (0.104)', deskGlanceWith({ tiles: [], self: deskBox }), true],
    ['This Whombat beside tiles (0.104)', deskGlanceWith({ servers: [], self: deskBox }), true],
    [
      'eight servers (0.104)',
      deskGlanceWith({ servers: deskFourServers, extraServers: deskFourServers, moreServers: 7 }),
      true,
    ],
    ['eight tiles (0.104)', deskGlanceWith({ tiles: deskFourTiles, extraTiles: deskFourTiles }), true],
    [
      'eight of each and This Whombat (0.104)',
      deskGlanceWith({
        servers: deskFourServers,
        extraServers: deskFourServers,
        moreServers: 4,
        tiles: deskFourTiles,
        extraTiles: deskFourTiles,
        self: deskBox,
      }),
      true,
    ],
    [
      'nine servers',
      deskGlanceWith({
        servers: deskFourServers,
        extraServers: [...deskFourServers, deskServer],
        moreServers: 5,
      }),
      false,
    ],
    [
      'nine tiles',
      deskGlanceWith({ tiles: deskFourTiles, extraTiles: [...deskFourTiles, deskGlance.tiles[0]] }),
      false,
    ],
    [
      'This Whombat beside, a percent above 100',
      deskGlanceWith({ self: { ...deskBox, cpu: { ...deskBox.cpu, percent: 101 } } }),
      false,
    ],
    ['This Whombat beside as a word', deskGlanceWith({ self: 'This Whombat' }), false],
    ['found on your network, the panel (0.110)', deskFoundWith({}), true],
    ['found, the first scan looking (0.110)', deskFoundWith(deskFoundLooking), true],
    [
      'found, the first scan before anything (0.110)',
      deskFoundWith({ ...deskFoundLooking, items: [], count: 0, progress: { done: 0, total: 1022 } }),
      true,
    ],
    ['found, the strip beside servers (0.110)', deskGlanceWith({ found: deskFoundDone }), true],
    ['found, nine named', deskFoundWith({ items: [...deskFoundItems, deskFoundItems[0]] }), false],
    [
      'found, a name as the id',
      deskFoundWith({ items: [{ ...deskFoundItems[0], catalogId: 'Home Assistant' }] }),
      false,
    ],
    [
      'found, a tagline of 41 characters',
      deskFoundWith({ items: [{ ...deskFoundItems[0], tagline: 'x'.repeat(41) }] }),
      false,
    ],
    [
      'found, a name of 61 characters',
      deskFoundWith({ items: [{ ...deskFoundItems[0], name: 'x'.repeat(61) }] }),
      false,
    ],
    [
      'found, an address with a line break',
      deskFoundWith({ items: [{ ...deskFoundItems[0], address: '10.100.0.5\n' }] }),
      false,
    ],
    ['found, progress without a total', deskFoundWith({ ...deskFoundLooking, progress: { done: 3 } }), false],
    ['found, a finish time that isn’t one', deskFoundWith({ finishedAt: 'yesterday' }), false],
    ['found without saying whether it scans', deskFoundWith({ scanning: undefined }), false],
    [
      'server cards with their id and disk beside an older one (0.115)',
      deskGlanceWith({
        servers: [deskServerOpen, deskServer, { ...deskServerOpen, id: 'nas', name: 'nas' }],
      }),
      true,
    ],
    [
      'a server card with a slash in its id',
      deskGlanceWith({ servers: [{ ...deskServerOpen, id: 'pve/01' }] }),
      false,
    ],
    [
      'a server card with its disk as a fraction',
      deskGlanceWith({ servers: [{ ...deskServerOpen, disk: { value: 33.5, tone: 'ok' } }] }),
      false,
    ],
    [
      'Needs you with what needs a look (0.118)',
      deskGlanceWith({ needsYou: { ...deskGlance.needsYou, looks: deskLooks } }),
      true,
    ],
    [
      'a look without a reason or a server',
      deskGlanceWith({
        needsYou: { ...deskGlance.needsYou, looks: [{ ...deskLooks[1], reason: undefined }] },
      }),
      true,
    ],
    [
      'six looks',
      deskGlanceWith({
        needsYou: { ...deskGlance.needsYou, looks: [...deskLooks, ...deskLooks, ...deskLooks] },
      }),
      false,
    ],
    ['an empty list of looks', deskGlanceWith({ needsYou: { ...deskGlance.needsYou, looks: [] } }), false],
    [
      'a look that is “broken”',
      deskGlanceWith({ needsYou: { ...deskGlance.needsYou, looks: [{ ...deskLooks[0], state: 'broken' }] } }),
      false,
    ],
    [
      'a look named in 41 characters',
      deskGlanceWith({
        needsYou: { ...deskGlance.needsYou, looks: [{ ...deskLooks[0], name: 'x'.repeat(41) }] },
      }),
      false,
    ],
    [
      'a look at a server with a slash in its id',
      deskGlanceWith({
        needsYou: { ...deskGlance.needsYou, looks: [{ ...deskLooks[0], server: 'pve/02' }] },
      }),
      false,
    ],
    [
      'looks with their lines, kinds, Ignore’s words and questions (0.122)',
      deskGlanceWith({ needsYou: { ...deskGlance.needsYou, looks: [...deskQuietLooks, deskLooks[0]] } }),
      true,
    ],
    [
      'looks with what the assistant found out, looking and with a step (3.5)',
      deskGlanceWith({
        needsYou: {
          ...deskGlance.needsYou,
          looks: [deskResearchedLook, { ...deskLooks[0], research: deskLooking }],
        },
      }),
      true,
    ],
    [
      'a look whose research is in a state this version doesn’t know',
      deskGlanceWith({
        needsYou: {
          ...deskGlance.needsYou,
          looks: [{ ...deskResearchedLook, research: { ...deskResearchedLook.research, state: 'guessing' } }],
        },
      }),
      false,
    ],
    [
      'a step’s button of 33 characters',
      deskGlanceWith({
        needsYou: {
          ...deskGlance.needsYou,
          looks: [
            { ...deskResearchedLook, research: { ...deskResearchedLook.research, fix: 'x'.repeat(33) } },
          ],
        },
      }),
      false,
    ],
    [
      'a summary on two lines',
      deskGlanceWith({
        needsYou: {
          ...deskGlance.needsYou,
          looks: [
            {
              ...deskResearchedLook,
              research: { ...deskResearchedLook.research, summary: 'Zigbee stopped.\nRestart it.' },
            },
          ],
        },
      }),
      false,
    ],
    [
      'a look whose check isn’t a check id',
      deskGlanceWith({
        needsYou: {
          ...deskGlance.needsYou,
          looks: [{ ...deskQuietLooks[0], notice: { check: 'UniFi offline' } }],
        },
      }),
      false,
    ],
    [
      'a look of a kind this version doesn’t know',
      deskGlanceWith({
        needsYou: { ...deskGlance.needsYou, looks: [{ ...deskQuietLooks[0], nature: 'maybe' }] },
      }),
      false,
    ],
    [
      'a look whose question has 301 characters',
      deskGlanceWith({
        needsYou: { ...deskGlance.needsYou, looks: [{ ...deskQuietLooks[0], question: 'x'.repeat(301) }] },
      }),
      false,
    ],
    [
      'a look whose item spans two lines',
      deskGlanceWith({
        needsYou: {
          ...deskGlance.needsYou,
          looks: [{ ...deskQuietLooks[0], notice: { check: 'unifi.device_offline', subject: 'a\nb' } }],
        },
      }),
      false,
    ],
  ]),
  ...cases('DeskTalk', deskTalk, [
    ['transcribing', { id: deskTalk.id, state: 'transcribing', thing: null, audio: false }, true],
    // 0.116 (CT-893): past 90 s, waiting for the turn.
    [
      'working (0.116)',
      { id: deskTalk.id, state: 'working', question: deskTalk.question, thing: null, audio: false },
      true,
    ],
    [
      'failed, not heard',
      { id: deskTalk.id, state: 'failed', thing: null, audio: false, reason: 'not_heard' },
      true,
    ],
    ['an answer of 601 characters', { ...deskTalk, answer: 'x'.repeat(601) }, false],
    ['an unknown reason', { ...deskTalk, state: 'failed', reason: 'bored' }, false],
    ['a short id', { ...deskTalk, id: 'tlk' }, false],
  ]),
  ...cases('DeskRequest', { v: 1 }, [['with a member (command input)', { v: 1, force: true }, false]]),
  ...cases('DeskAck', { v: 1 }, [['newer member stripped', { v: 1, ok: true }, true, { v: 1 }]]),
  ...cases('DeskUnlockRequest', { v: 1, pin: '048213' }, [
    // 4 to 6 digits since 0.103 (CT-590).
    ['four digits', { v: 1, pin: '2580' }, true],
    ['five digits', { v: 1, pin: '04821' }, true],
    ['three digits', { v: 1, pin: '258' }, false],
    ['seven digits', { v: 1, pin: '0482130' }, false],
    ['other digits', { v: 1, pin: '٠٤٨٢١٣' }, false],
    ['four other digits', { v: 1, pin: '٢٥٨٠' }, false],
    ['a number', { v: 1, pin: 48213 }, false],
    ['with a name', { v: 1, pin: '048213', name: 'John' }, false],
  ]),
  ...cases('DeskUnlockAnswer', { v: 1, result: 'wrong', triesLeft: 3 }, [
    ['unlocked', { v: 1, result: 'unlocked' }, true],
    ['backoff', { v: 1, result: 'backoff', retryAt: '2026-10-20T12:35:00Z' }, true],
    ['six tries', { v: 1, result: 'wrong', triesLeft: 6 }, false],
    ['an unknown result', { v: 1, result: 'maybe' }, false],
  ]),
  ...cases('DeskPhoneUnlockAnswer', { v: 1, expiresAt: '2026-10-20T12:36:00Z' }, [
    ['epoch time', { v: 1, expiresAt: now }, false],
  ]),
  ...cases('DeskTouchAnswer', { v: 1, until: '2026-10-20T12:36:00Z' }, [['without until', { v: 1 }, false]]),
  ...cases('DeskDecideRequest', { v: 1, number: 12, decision: 'approve' }, [
    ['decline', { v: 1, number: 12, decision: 'decline' }, true],
    // 0.108 (CT-662): deny, and the PIN to approve a risky ask.
    ['deny', { v: 1, number: 12, decision: 'deny' }, true],
    ['approve with the PIN', { v: 1, number: 12, decision: 'approve', pin: '2580' }, true],
    ['a PIN of three digits', { v: 1, number: 12, decision: 'approve', pin: '258' }, false],
    ['a PIN as a number', { v: 1, number: 12, decision: 'approve', pin: 2580 }, false],
    ['always (never on the screen)', { v: 1, number: 12, decision: 'always' }, false],
    // 0.116 (CT-891): one of the ask's wider choices, with the PIN.
    [
      'approve with a wider choice and the PIN (0.116)',
      { v: 1, number: 12, decision: 'approve', scope: 'agent', pin: '2580' },
      true,
    ],
    [
      'approve for the task (0.116)',
      { v: 1, number: 12, decision: 'approve', scope: 'task', pin: '2580' },
      true,
    ],
    ['approve once, said (0.116)', { v: 1, number: 12, decision: 'approve', scope: 'once' }, true],
    ['a wider choice without the PIN', { v: 1, number: 12, decision: 'approve', scope: 'agent' }, true],
    ['an unknown scope', { v: 1, number: 12, decision: 'approve', scope: 'forever', pin: '2580' }, false],
    ['number 0', { v: 1, number: 0, decision: 'approve' }, false],
  ]),
  ...cases('DeskTalkRequest', { v: 1, text: 'Is pve-02 okay?', continue: false }, [
    ['spoken', { v: 1, audioWav: deskWav, continue: true }, true],
    ['without continue', { v: 1, text: 'Is pve-02 okay?' }, false],
    ['a line break in the question', { v: 1, text: 'Is pve-02\nokay?', continue: false }, false],
    [
      'a space in the audio',
      { v: 1, audioWav: `${deskWav.slice(0, 40)} ${deskWav.slice(40)}`, continue: false },
      false,
    ],
    ['a short audio', { v: 1, audioWav: 'UklGRg==', continue: false }, false],
    ['about a server (0.115)', { v: 1, text: 'Why is it busy?', continue: false, server: 'pve-01' }, true],
    [
      'about a server with a short id (0.115)',
      { v: 1, text: 'Is it okay?', continue: false, server: 'nas' },
      true,
    ],
    ['about a server with a slash', { v: 1, text: 'Is it okay?', continue: false, server: '../nas' }, false],
    ['about an empty server', { v: 1, text: 'Is it okay?', continue: false, server: '' }, false],
    ['heard words, sent (3.3)', { v: 1, text: 'Is pve-02 okay?', continue: true, spoken: true }, true],
    ['a question of 1000 characters (3.3)', { v: 1, text: 'x'.repeat(1000), continue: false }, true],
    ['a question of 1001 characters', { v: 1, text: 'x'.repeat(1001), continue: false }, false],
    ['spoken as a word', { v: 1, text: 'Is pve-02 okay?', continue: false, spoken: 'yes' }, false],
  ]),
  ...cases('DeskTalkStarted', { v: 1, id: deskTalk.id }, [['without an id', { v: 1 }, false]]),
  // Talk's voice typing (3.3).
  ...cases('DeskHearRequest', { v: 1, audioWav: deskWav }, [
    ['without audio', { v: 1 }, false],
    ['with a question beside it', { v: 1, audioWav: deskWav, text: 'hi' }, false],
    ['a space in the audio', { v: 1, audioWav: `${deskWav.slice(0, 40)} ${deskWav.slice(40)}` }, false],
    ['a short audio', { v: 1, audioWav: 'UklGRg==' }, false],
  ]),
  ...cases('DeskHeard', { v: 1, text: 'Is pve-02 okay?' }, [
    ['nothing heard', { v: 1, text: '' }, true],
    ['a minute of words', { v: 1, text: 'x'.repeat(1000) }, true],
    ['more than fits', { v: 1, text: 'x'.repeat(1001) }, false],
    ['a line break', { v: 1, text: 'Is pve-02\nokay?' }, false],
    ['without text', { v: 1 }, false],
  ]),
  // 0.108 (CT-663, CT-664).
  ...cases('DeskDecideAnswer', { v: 1, result: 'decided' }, [
    ['without a result', { v: 1 }, false],
    ['wrong', { v: 1, result: 'wrong', triesLeft: 3 }, true],
    ['backoff', { v: 1, result: 'backoff', retryAt: '2026-10-20T12:35:00Z' }, true],
    ['with the talk that follows', { v: 1, result: 'decided', talk: deskTalk.id }, true],
    ['an unknown result', { v: 1, result: 'maybe' }, false],
    ['six tries', { v: 1, result: 'wrong', triesLeft: 6 }, false],
  ]),
  ...cases('DeskTalkSession', deskSession, [
    ['closed', { v: 1, open: false, messages: [], earlier: 0 }, true],
    // 0.116 (CT-894, CT-895): the assistant working, and a server task's live row.
    ['working, with a task (0.116)', deskSessionWorking, true],
    ['working, nothing to say what', { ...deskSession, working: { since: '2026-10-20T12:31:00Z' } }, true],
    ['a task that ended (0.116)', { ...deskSession, messages: [deskTaskMessage(deskTaskDone)] }, true],
    [
      'an unknown task state',
      { ...deskSession, messages: [deskTaskMessage({ ...deskTaskRunning, state: 'paused' })] },
      false,
    ],
    [
      'a task title of 121 characters',
      { ...deskSession, messages: [deskTaskMessage({ ...deskTaskRunning, title: 'x'.repeat(121) })] },
      false,
    ],
    [
      'a task without its start',
      { ...deskSession, messages: [deskTaskMessage({ ...deskTaskRunning, startedAt: undefined })] },
      false,
    ],
    [
      'working, doing 121 characters',
      { ...deskSession, working: { since: '2026-10-20T12:31:00Z', doing: 'x'.repeat(121) } },
      false,
    ],
    ['working without since', { ...deskSession, working: { doing: 'Checking pve-02' } }, false],
    ['newer member stripped', { ...deskSession, title: 'Plex' }, true, deskSession],
    [
      'a message without paragraphs',
      { ...deskSession, messages: [{ ...deskSession.messages[0], paragraphs: [] }] },
      false,
    ],
    [
      'nine paragraphs',
      { ...deskSession, messages: [{ ...deskSession.messages[0], paragraphs: Array(9).fill('Yes.') }] },
      false,
    ],
    [
      'a paragraph of 601 characters',
      { ...deskSession, messages: [{ ...deskSession.messages[0], paragraphs: ['x'.repeat(601)] }] },
      false,
    ],
    [
      'a line break in a paragraph',
      { ...deskSession, messages: [{ ...deskSession.messages[0], paragraphs: ['Yes.\nIt is.'] }] },
      false,
    ],
    [
      'from someone else',
      { ...deskSession, messages: [{ ...deskSession.messages[0], from: 'someone' }] },
      false,
    ],
    [
      'an unknown ask state',
      { ...deskSession, messages: [{ ...deskSession.messages[2], ask: { number: 12, state: 'maybe' } }] },
      false,
    ],
    ['41 messages', { ...deskSession, messages: Array(41).fill(deskSession.messages[0]) }, false],
  ]),
  // A server's own screen (0.115, CT-863, CT-864).
  ...cases('DeskServersAnswer', { v: 1, servers: [deskServerOpen, deskServer], more: 0 }, [
    ['24 servers, the rest counted', { v: 1, servers: Array(24).fill(deskServerOpen), more: 3 }, true],
    ['none', { v: 1, servers: [], more: 0 }, true],
    ['25 servers', { v: 1, servers: Array(25).fill(deskServerOpen), more: 0 }, false],
    ['without the count', { v: 1, servers: [deskServerOpen] }, false],
    [
      'newer member stripped',
      { v: 1, servers: [], more: 0, order: 'worst' },
      true,
      { v: 1, servers: [], more: 0 },
    ],
  ]),
  ...cases('DeskServerRequest', { v: 1, id: 'pve-01', range: '24h' }, [
    ['a short id', { v: 1, id: 'nas', range: '1h' }, true],
    ['an older hub’s id with dots', { v: 1, id: 'pve01.home.lan', range: '7d' }, true],
    ['an id of 128 characters', { v: 1, id: `p${'x'.repeat(127)}`, range: '24h' }, true],
    ['an id of 129 characters', { v: 1, id: `p${'x'.repeat(128)}`, range: '24h' }, false],
    ['an empty id', { v: 1, id: '', range: '24h' }, false],
    ['an id starting with a dot', { v: 1, id: '.nas', range: '24h' }, false],
    ['dot-dot', { v: 1, id: '..', range: '24h' }, false],
    ['an id with a slash', { v: 1, id: 'pve/01', range: '24h' }, false],
    ['an id with a space', { v: 1, id: 'pve 01', range: '24h' }, false],
    ['an unknown range', { v: 1, id: 'pve-01', range: '30d' }, false],
    ['without a range', { v: 1, id: 'pve-01' }, false],
    ['with a member (command input)', { v: 1, id: 'pve-01', range: '24h', restart: true }, false],
  ]),
  // The step the assistant offers on a look (3.5).
  ...cases('DeskLookFixRequest', { v: 1, key: 'connection:con_hass0000Zigb' }, [
    ['a server’s look', { v: 1, key: 'server:pve-02' }, true],
    ['without a key', { v: 1 }, false],
    ['an empty key', { v: 1, key: '' }, false],
    ['a key of 121 characters', { v: 1, key: `server:${'x'.repeat(114)}` }, false],
    [
      'with the step’s words (only the runtime knows the step)',
      { v: 1, key: 'server:pve-02', step: 'rm -rf /' },
      false,
    ],
  ]),
  // Ignore and Not now on a look (0.122, CT-1065; QN-20).
  ...cases(
    'DeskLookQuietRequest',
    {
      v: 1,
      key: 'connection:con_unifi0000Ap',
      notice: { check: 'unifi.device_offline', subject: 'device:64a1c3f00e2b' },
      how: 'ignore',
    },
    [
      [
        'Not now on a look about the whole thing',
        { v: 1, key: 'connection:con_7Hq2v8LkP0aX', notice: { check: 'conn.signin' }, how: 'snooze' },
        true,
      ],
      [
        'a server’s look by its rule',
        {
          v: 1,
          key: 'server:pve-02',
          notice: { check: 'host.disk.space_high', subject: 'fs:/mnt/data' },
          how: 'ignore',
        },
        true,
      ],
      [
        'undo (only the runtime’s Undo takes it back)',
        { v: 1, key: 'server:pve-02', notice: { check: 'host.disk.space_high' }, how: 'undo' },
        false,
      ],
      ['without the line', { v: 1, key: 'server:pve-02', how: 'ignore' }, false],
      [
        'a check in capitals',
        { v: 1, key: 'server:pve-02', notice: { check: 'Host.disk' }, how: 'ignore' },
        false,
      ],
      [
        'a check of one part',
        { v: 1, key: 'server:pve-02', notice: { check: 'host' }, how: 'ignore' },
        false,
      ],
      [
        'an empty item',
        { v: 1, key: 'server:pve-02', notice: { check: 'host.oom', subject: '' }, how: 'ignore' },
        false,
      ],
      [
        'with a member in the line (command input)',
        { v: 1, key: 'server:pve-02', notice: { check: 'host.oom', until: 'later' }, how: 'ignore' },
        false,
      ],
      [
        'with a time (command input)',
        {
          v: 1,
          key: 'server:pve-02',
          notice: { check: 'host.oom' },
          how: 'snooze',
          until: '2026-10-23T09:00:00Z',
        },
        false,
      ],
    ],
  ),
  ...cases('DeskServerPage', deskServerPage, [
    ['off, nothing measured (0.115)', deskServerOff, true],
    ['alerts with their titles (0.115)', deskServerPageWith({ alerts: deskServerAlerts }), true],
    ['alerts counted without titles (0.115)', deskServerPageWith({ alerts: { count: 2, items: [] } }), true],
    [
      'the last hour, cores and load unknown, no guests (0.115)',
      deskServerPageWith({
        cpu: { percent: 3, cores: null, load: '', tone: 'ok' },
        guests: null,
        history: { ...deskServerPage.history, range: '1h', stepS: 60, cpu: [3, 4], memory: [20, 21] },
      }),
      true,
    ],
    ['seven days a point a day', deskServerHistoryWith({ range: '7d', stepS: 86_400 }), true],
    ['newer member stripped', deskServerPageWith({ swap: { percent: 3 } }), true, deskServerPage],
    ['a series of 97 points', deskServerHistoryWith({ cpu: deskServerSeries(14, 97) }), false],
    ['an unknown range', deskServerHistoryWith({ range: '30d' }), false],
    ['a step over a day', deskServerHistoryWith({ stepS: 86_401 }), false],
    ['a point over 100 %', deskServerHistoryWith({ cpu: [101], memory: [50] }), false],
    ['seven volumes', deskServerPageWith({ volumes: Array(7).fill(deskServerPage.volumes[0]) }), false],
    [
      'seven guests',
      deskServerPageWith({
        guests: { running: 7, off: 0, items: Array(7).fill(deskServerPage.guests.items[0]) },
      }),
      false,
    ],
    [
      'a guest of a kind it doesn’t know',
      deskServerPageWith({
        guests: { running: 1, off: 0, items: [{ ...deskServerPage.guests.items[0], kind: 'pod' }] },
      }),
      false,
    ],
    [
      'four alert titles',
      deskServerPageWith({ alerts: { count: 4, items: Array(4).fill(deskServerAlerts.items[0]) } }),
      false,
    ],
    [
      'an alert that is fine',
      deskServerPageWith({ alerts: { count: 1, items: [{ tone: 'ok', title: 'All good' }] } }),
      false,
    ],
    ['an OS of 61 characters', deskServerPageWith({ os: 'x'.repeat(61) }), false],
    [
      'a load of 9 characters',
      deskServerPageWith({ cpu: { ...deskServerPage.cpu, load: '123456789' } }),
      false,
    ],
    ['without alerts', deskServerPageWith({ alerts: undefined }), false],
    ['a server id with a slash', deskServerPageWith({ server: { ...deskServerOpen, id: 'pve/01' } }), false],
  ]),
  ...cases('DeskTalkRef', { v: 1, id: deskTalk.id }, [
    ['an id with a slash', { v: 1, id: 'tlk/../../x' }, false],
  ]),
  ...cases('VoiceHealth', { v: 1, stt: true, tts: true, microphone: true, speaker: false }, [
    [
      'newer member stripped',
      { v: 1, stt: true, tts: true, microphone: true, speaker: false, wakeWord: false },
      true,
      { v: 1, stt: true, tts: true, microphone: true, speaker: false },
    ],
    ['without a speaker', { v: 1, stt: true, tts: true, microphone: true }, false],
    [
      'with its voices (0.105)',
      { v: 1, stt: true, tts: true, microphone: true, speaker: true, voices: ['heart', 'bella', 'emma'] },
      true,
    ],
    [
      'a voice in capitals',
      { v: 1, stt: true, tts: true, microphone: true, speaker: true, voices: ['Heart'] },
      false,
    ],
    [
      'speaks Dutch too (3.4)',
      { v: 1, stt: true, tts: true, microphone: true, speaker: true, languages: ['en', 'nl'] },
      true,
    ],
    [
      'a language it can’t name',
      { v: 1, stt: true, tts: true, microphone: true, speaker: true, languages: ['de'] },
      false,
    ],
  ]),
  ...cases(
    'VoiceSttRequest',
    { v: 1, audioWav: deskWav, prompt: 'Neo, pve-01, pve-02, blackbox, the-falcon' },
    [
      ['without a prompt', { v: 1, audioWav: deskWav }, true],
      ['a prompt with a line break', { v: 1, audioWav: deskWav, prompt: 'Neo\npve-02' }, false],
      ['without audio', { v: 1, prompt: 'Neo' }, false],
    ],
  ),
  ...cases('VoiceSttAnswer', { v: 1, text: 'is pve two okay', seconds: 2 }, [
    ['nothing heard', { v: 1, text: '', seconds: 1 }, true],
    ['31 seconds', { v: 1, text: 'x', seconds: 31 }, false],
  ]),
  ...cases('VoiceTtsRequest', { v: 1, text: 'Yes, pve-02 is fine.' }, [
    ['nothing to say', { v: 1, text: '' }, false],
    ['601 characters', { v: 1, text: 'x'.repeat(601) }, false],
    ['a voice (0.105)', { v: 1, text: 'Yes, pve-02 is fine.', voice: 'emma' }, true],
    ['a voice with a space', { v: 1, text: 'Yes.', voice: 'af heart' }, false],
    ['a voice of 33 characters', { v: 1, text: 'Yes.', voice: `a${'b'.repeat(32)}` }, false],
    [
      'in Dutch (3.4)',
      { v: 1, text: 'Ja, P V E nul twee draait prima.', voice: 'heart', language: 'nl' },
      true,
    ],
    ['a language it can’t name', { v: 1, text: 'Ja.', language: 'de' }, false],
  ]),
  ...cases('VoiceTtsAnswer', { v: 1, audioWav: deskWav }, [
    ['not base64', { v: 1, audioWav: '%'.repeat(64) }, false],
  ]),
  // The presence socket (0.103, CT-597).
  ...cases('PresenceHealth', { v: 1, camera: true, detector: true }, [
    ['no camera', { v: 1, camera: false, detector: true }, true],
    [
      'newer member stripped',
      { v: 1, camera: true, detector: true, infrared: true },
      true,
      { v: 1, camera: true, detector: true },
    ],
    ['without the detector', { v: 1, camera: true }, false],
    ['version 2', { v: 2, camera: true, detector: true }, false],
  ]),
  ...cases('PresenceWatchRequest', { v: 1 }, [
    ['with a member (command input)', { v: 1, camera: '/dev/video0' }, false],
    ['version 2', { v: 2 }, false],
  ]),
  ...cases(
    'PresenceWatch',
    {
      v: 1,
      state: 'watching',
      face: true,
      seenAt: '2026-10-20T12:34:00Z',
      frameAt: '2026-10-20T12:34:00Z',
    },
    [
      ['starting', { v: 1, state: 'starting', face: false }, true],
      [
        'watching, the face gone',
        { v: 1, state: 'watching', face: false, seenAt: '2026-10-20T12:33:40Z', frameAt: deskAt },
        true,
      ],
      ['too dark', { v: 1, state: 'dark', face: false, frameAt: deskAt }, true],
      ['failed', { v: 1, state: 'failed', face: false }, true],
      ['no camera', { v: 1, state: 'no_camera', face: false }, true],
      ['an unknown state', { v: 1, state: 'asleep', face: false }, false],
      ['a score for the face', { v: 1, state: 'watching', face: 0.91 }, false],
      ['without face', { v: 1, state: 'watching' }, false],
      ['epoch time', { v: 1, state: 'watching', face: true, seenAt: now }, false],
      [
        'newer member stripped',
        { v: 1, state: 'watching', face: true, score: 91 },
        true,
        { v: 1, state: 'watching', face: true },
      ],
    ],
  ),
  ...cases('PresenceStopRequest', { v: 1 }, [['with a member (command input)', { v: 1, now: true }, false]]),
  ...cases('PresenceAck', { v: 1 }, [['newer member stripped', { v: 1, ok: true }, true, { v: 1 }]]),
  ...cases('HostHardwareRequest', { v: 1 }, [['with a member', { v: 1, full: true }, false]]),
  ...cases('HostHardwareResponse', { v: 1, hardware: hostHardware }, [
    [
      'a virtual machine',
      withHardware({
        machine: {
          vendor: 'QEMU',
          model: 'Standard PC (Q35 + ICH9, 2009)',
          virtual: true,
          hypervisor: 'kvm',
        },
        devices: [
          {
            kind: 'wired',
            name: 'Virtio network device',
            vendor: 'Red Hat, Inc.',
            bus: 'pci',
            id: '1af4:1000',
            driver: 'virtio_net',
            status: 'ok',
            interface: 'enp1s0',
            link: 'up',
          },
          {
            kind: 'storage',
            name: 'Virtio block device',
            bus: 'virtual',
            driver: 'virtio_blk',
            status: 'ok',
          },
        ],
        log: [],
      }),
      true,
    ],
    [
      'a Wi-Fi card without a driver',
      withDevice({
        name: 'Wi-Fi 6E(802.11ax) AX211 160MHz',
        vendor: 'Intel Corporation',
        id: '8086:51f0',
        driver: null,
        status: 'no_driver',
        interface: undefined,
        link: undefined,
      }),
      true,
    ],
    ['a Wi-Fi card switched off', withDevice({ status: 'disabled' }), true],
    [
      'a processor that doesn’t say its model',
      withHardware({ cpu: { model: '', cores: 4, threads: 8 } }),
      true,
    ],
    ['names in any script', withDevice({ name: 'Wi‑Fi “Kärtchen” 無線', vendor: 'Ünïcode Ltd.' }), true],
    [
      'newer member stripped (no serial reaches the app)',
      withHardware({ machine: { ...hostHardware.machine, serial: 'R9NRKD00123456A' } }),
      true,
      { v: 1, hardware: hostHardware },
    ],
    ['an unknown kind', withDevice({ kind: 'printer' }), false],
    ['an unknown status', withDevice({ status: 'broken' }), false],
    ['an upper-case id', withDevice({ id: '14C3:7925' }), false],
    ['an id without the vendor', withDevice({ id: '7925' }), false],
    ['a name with a line break', withDevice({ name: 'MT7925\nWi-Fi' }), false],
    ['an empty name', withDevice({ name: '' }), false],
    ['a name of 121 code points', withDevice({ name: 'ä'.repeat(121) }), false],
    ['without a driver member', withDevice({ driver: undefined }), false],
    ['65 capture devices', withDevice({ kind: 'sound', capture: 65 }), false],
    ['an interface name of 16 code points', withDevice({ interface: 'wlx00e04c6800011' }), false],
    ['41 kernel lines', withHardware({ log: Array.from({ length: 41 }, (_, i) => `line ${i}`) }), false],
    ['a kernel line of 241 code points', withHardware({ log: ['x'.repeat(241)] }), false],
    ['no cores', withHardware({ cpu: { model: 'x', cores: 0, threads: 0 } }), false],
  ]),
  ...cases('NetworkStateRequest', { v: 1 }, [['without v', {}, false]]),
  ...cases('NetworkStateResponse', { v: 1, network: hostNetwork }, [
    ['a cable and no Wi-Fi card', { v: 1, network: cableOnly }, true],
    ['a Wi-Fi card without a driver', { v: 1, network: { ...cableOnly, wifiMissing: 'no_driver' } }, true],
    [
      'before the first check, nothing connected',
      withNetwork({
        online: false,
        checkedAt: null,
        wired: [],
        wifi: { interface: 'wlp194s0', state: 'disconnected', saved: [] },
        change: null,
      }),
      true,
    ],
    ['connecting', withWifi({ state: 'connecting', signal: undefined, address: undefined }), true],
    ['a join undone', withChange({ phase: 'reverted', failure: 'no_internet' }), true],
    [
      'a wrong password',
      withChange({ phase: 'failed', failure: 'wrong_password', previous: undefined }),
      true,
    ],
    [
      'a forget',
      withChange({ kind: 'forget', ssid: 'Office', phase: 'committed', previous: undefined }),
      true,
    ],
    [
      'newer member stripped (no MAC address reaches the app)',
      withWifi({ bssid: '00:11:22:33:44:55' }),
      true,
      { v: 1, network: hostNetwork },
    ],
    ['an unknown phase', withChange({ phase: 'cancelled' }), false],
    ['an unknown failure', withChange({ phase: 'failed', failure: 'captive_portal' }), false],
    ['a change id without its prefix', withChange({ id: 'k3q9xv2m' }), false],
    ['a null previous network', withChange({ previous: null }), false],
    ['an SSID with a line break', withWifi({ ssid: 'Home\nOffice' }), false],
    ['an SSID with a zero-width space', withWifi({ ssid: 'Ho\u200bme' }), false],
    ['an SSID of 33 code points', withWifi({ ssid: 'x'.repeat(33) }), false],
    ['an empty SSID', withWifi({ ssid: '' }), false],
    ['five bars', withWifi({ signal: 5 }), false],
    ['an address with its prefix length', withWifi({ address: '10.100.1.57/24' }), false],
    [
      '33 saved networks',
      withWifi({ saved: Array.from({ length: 33 }, (_, i) => ({ ssid: `n${i}`, security: 'psk' })) }),
      false,
    ],
    [
      'nine cables',
      withNetwork({
        wired: Array.from({ length: 9 }, (_, i) => ({ interface: `eth${i}`, connected: false })),
      }),
      false,
    ],
    ['without a change member', withNetwork({ change: undefined }), false],
    ['an unknown reason for no Wi-Fi', { v: 1, network: { ...cableOnly, wifiMissing: 'unplugged' } }, false],
    ['Wi-Fi only, the cable switched off', { v: 1, network: wifiOnlyNetwork }, true],
    [
      'a cable with its hardware address and prefix',
      withNetwork({
        wired: [
          {
            interface: 'enp1s0',
            connected: true,
            address: '10.100.1.81',
            plugged: true,
            mac: '02:00:00:68:02:2c',
            prefixLength: 23,
          },
        ],
      }),
      true,
    ],
    ['a null cable change', withNetwork({ cableChange: null }), false],
    [
      'the cable back as the backup',
      withNetwork({ cableChange: { ...cableChange, use: 'cable', by: 'backup', phase: 'committed' } }),
      true,
    ],
    [
      'Wi-Fi only undone',
      withNetwork({ cableChange: { ...cableChange, phase: 'reverted', failure: 'no_internet' } }),
      true,
    ],
    ['an upper-case hardware address', withWifi({ mac: 'AE:00:00:16:47:58' }), false],
    ['a hardware address without colons', withWifi({ mac: 'a8e291164758' }), false],
    ['a prefix of 129', withWifi({ prefixLength: 129 }), false],
    ['an unknown use', withNetwork({ cableChange: { ...cableChange, use: 'both' } }), false],
    ['an unknown maker', withNetwork({ cableChange: { ...cableChange, by: 'agent' } }), false],
    ['wifiOnly as text', withNetwork({ wifiOnly: 'yes' }), false],
  ]),
  ...cases('WifiScanRequest', { v: 1 }, [['with a member', { v: 1, fresh: true }, false]]),
  ...cases('WifiScanResponse', { v: 1, scan: wifiScan }, [
    ['nothing around', { v: 1, scan: { networks: [], scannedAt: hwAt } }, true],
    [
      'WEP is “other”',
      { v: 1, scan: { ...wifiScan, networks: [{ ...wifiScan.networks[0], security: 'wep' }] } },
      false,
    ],
    [
      '65 networks',
      {
        v: 1,
        scan: {
          ...wifiScan,
          networks: Array.from({ length: 65 }, (_, i) => ({
            ssid: `n${i}`,
            security: 'open',
            signal: 1,
            saved: false,
            connected: false,
          })),
        },
      },
      false,
    ],
  ]),
  ...cases('WifiJoinRequest', joinRequest, [
    ['a saved or open network', without(joinRequest, 'passphrase'), true],
    ['a hidden network', { ...joinRequest, hidden: true }, true],
    ['the 64 hex digits of the key', { ...joinRequest, passphrase: 'aB'.repeat(32) }, true],
    ['a passphrase of 63 characters', { ...joinRequest, passphrase: 'x'.repeat(63) }, true],
    ['a passphrase of 7 characters', { ...joinRequest, passphrase: 'x'.repeat(7) }, false],
    ['64 characters that aren’t hex', { ...joinRequest, passphrase: 'x'.repeat(64) }, false],
    ['a passphrase with a line break', { ...joinRequest, passphrase: 'correct\nhorse' }, false],
    ['a passphrase that isn’t ASCII', { ...joinRequest, passphrase: 'pässwort-123' }, false],
    ['a confirm time below 30 s', { ...joinRequest, confirmTimeoutSec: 29 }, false],
    ['without a confirm time', without(joinRequest, 'confirmTimeoutSec'), false],
    ['with a member (command input)', { ...joinRequest, security: 'psk' }, false],
  ]),
  ...cases('WifiForgetRequest', { v: 1, ssid: 'Office' }, [
    ['an empty name', { v: 1, ssid: '' }, false],
    ['with a passphrase', { v: 1, ssid: 'Office', passphrase: 'correct horse battery' }, false],
  ]),
  ...cases('WifiChangeResponse', { v: 1, change: { ...networkChange, phase: 'applying' } }, [
    ['without a deadline', { v: 1, change: without(networkChange, 'deadline') }, false],
  ]),
  ...cases('UpdateAskRequest', { v: 1, askFirst: true }, [
    ['off again', { v: 1, askFirst: false }, true],
    ['without the setting', { v: 1 }, false],
    ['with a member', { v: 1, askFirst: true, by: 'owner' }, false],
  ]),
  ...cases('UpdateAskResponse', { v: 1, askFirst: false }, [['without the setting', { v: 1 }, false]]),
  ...cases('UpdateApproveRequest', { v: 1, release: 'pve-20260929.4' }, [
    ['without a release', { v: 1 }, false],
    ['a release that isn’t an id', { v: 1, release: 'the newest' }, false],
    ['with a member', { v: 1, release: 'pve-20260929.4', now: true }, false],
  ]),
  ...cases('UpdateApproveResponse', { v: 1, release: 'pve-20260929.4' }, [
    ['without a release', { v: 1 }, false],
  ]),
  ...cases('CableSetRequest', { v: 1, use: 'wifi', confirmTimeoutSec: 120 }, [
    ['the cable again', { v: 1, use: 'cable', confirmTimeoutSec: 120 }, true],
    ['without a confirm time', { v: 1, use: 'wifi' }, false],
    ['a confirm time above 600 s', { v: 1, use: 'wifi', confirmTimeoutSec: 601 }, false],
    ['an unknown use', { v: 1, use: 'none', confirmTimeoutSec: 120 }, false],
    ['with a member', { v: 1, use: 'wifi', confirmTimeoutSec: 120, by: 'person' }, false],
  ]),
  ...cases('CableChangeResponse', { v: 1, change: { ...cableChange, phase: 'applying' } }, [
    ['without who made it', { v: 1, change: without(cableChange, 'by') }, false],
  ]),
  ...cases('DeskNetworkAnswer', { v: 1, network: hostNetwork, mayChange: true }, [
    ['locked', { v: 1, network: hostNetwork, mayChange: false, why: 'locked' }, true],
    ['an unknown reason', { v: 1, network: hostNetwork, mayChange: false, why: 'tired' }, false],
    ['without mayChange', { v: 1, network: hostNetwork }, false],
  ]),
  ...cases('DeskWifiScanAnswer', { v: 1, scan: wifiScan }, [['without a scan', { v: 1 }, false]]),
  ...cases('DeskWifiJoinRequest', without(joinRequest, 'confirmTimeoutSec'), [
    ['a hidden network', { v: 1, ssid: 'Attic', hidden: true }, true],
    ['with a confirm time (the runtime adds it)', joinRequest, false],
    ['a passphrase of 7 characters', { v: 1, ssid: 'Home', passphrase: 'x'.repeat(7) }, false],
  ]),
  ...cases('DeskWifiForgetRequest', { v: 1, ssid: 'Office' }, [['without a name', { v: 1 }, false]]),
  ...cases('DeskWifiChangeAnswer', { v: 1, change: networkChange }, [
    ['an unknown kind', { v: 1, change: { ...networkChange, kind: 'switch' } }, false],
  ]),
  // The Bluetooth socket (0.109, CT-680, CT-681).
  ...cases('BluetoothStateAnswer', { v: 1, bluetooth: btState }, [
    ['no adapter', { v: 1, bluetooth: btNone }, true],
    ['an adapter without a driver', { v: 1, bluetooth: { ...btNone, missing: 'no_driver' } }, true],
    [
      'switched off',
      withBt({ adapter: { name: 'hci0', powered: false }, missing: 'disabled', scan: null }),
      true,
    ],
    ['not looking, nothing paired', withBt({ devices: [], scan: null }), true],
    [
      'pairing, asking the device',
      withBtPairing({ phase: 'pairing', code: undefined, typed: undefined }),
      true,
    ],
    ['pairing, a code to type', withBtPairing({}), true],
    ['pairing, a code before any digit', withBtPairing({ code: '0042', typed: undefined }), true],
    [
      'pairing, a number to compare',
      withBtPairing({ phase: 'confirm', code: '482913', typed: undefined }),
      true,
    ],
    ['pairing, connecting', withBtPairing({ phase: 'connecting', code: undefined, typed: undefined }), true],
    ['paired', withBtPairing({ phase: 'done', code: undefined, typed: undefined }), true],
    [
      'looking again after a pairing failed',
      withBt({
        pairing: { ...btPairing, phase: 'failed', code: undefined, typed: undefined, failure: 'rejected' },
      }),
      true,
    ],
    [
      'a pairing canceled',
      withBtPairing({ phase: 'failed', code: undefined, typed: undefined, failure: 'canceled' }),
      true,
    ],
    [
      'newer member stripped',
      { v: 1, bluetooth: { ...btState, discoverable: false } },
      true,
      { v: 1, bluetooth: btState },
    ],
    ['a lower-case address', withBtDevice({ address: 'dc:2c:26:01:02:03' }), false],
    ['an address with dashes', withBtDevice({ address: 'DC-2C-26-01-02-03' }), false],
    ['a short address', withBtDevice({ address: 'DC:2C:26:01:02' }), false],
    ['a phone', withBtDevice({ kind: 'phone' }), false],
    ['a name with a line break', withBtDevice({ name: 'Keychron\nK3' }), false],
    ['a name of 81 code points', withBtDevice({ name: 'x'.repeat(81) }), false],
    ['an empty name', withBtDevice({ name: '' }), false],
    ['a battery over 100', withBtDevice({ battery: 101 }), false],
    ['a battery in tenths', withBtDevice({ battery: 79.5 }), false],
    ['five bars', withBtDevice({ signal: 5 }), false],
    ['connected as a word', withBtDevice({ connected: 'yes' }), false],
    [
      '33 paired devices',
      withBt({
        devices: Array.from({ length: 33 }, (_, i) => ({
          ...btKeyboard,
          address: `DC:2C:26:01:02:${i.toString(16).padStart(2, '0').toUpperCase()}`,
        })),
      }),
      false,
    ],
    [
      '65 found',
      withBt({
        scan: {
          ...btScan,
          devices: Array.from({ length: 65 }, (_, i) => ({
            ...btMouse,
            address: `F0:1D:BC:44:55:${i.toString(16).padStart(2, '0').toUpperCase()}`,
          })),
        },
      }),
      false,
    ],
    ['looking until an epoch time', withBt({ scan: { ...btScan, until: now } }), false],
    ['an unknown phase', withBtPairing({ phase: 'waiting' }), false],
    ['an unknown failure', withBtPairing({ phase: 'failed', failure: 'wrong_code' }), false],
    ['a pairing id without its prefix', withBtPairing({ id: 'k3q9xv2m' }), false],
    ['a code of seven digits', withBtPairing({ code: '1234567' }), false],
    ['a code with letters', withBtPairing({ code: '12AB56' }), false],
    ['seven digits typed', withBtPairing({ typed: 7 }), false],
    ['without a pairing member', withBt({ pairing: undefined }), false],
    ['an unknown reason for no Bluetooth', { v: 1, bluetooth: { ...btNone, missing: 'unplugged' } }, false],
    [
      'an adapter name of 81 code points',
      withBt({ adapter: { name: 'x'.repeat(81), powered: true } }),
      false,
    ],
  ]),
  ...cases('BluetoothScanRequest', { v: 1 }, [
    ['with a member (command input)', { v: 1, seconds: 300 }, false],
    ['version 2', { v: 2 }, false],
  ]),
  ...cases('BluetoothScanAnswer', { v: 1, scan: btScan }, [
    ['nothing found yet', { v: 1, scan: { until: btScan.until, devices: [] } }, true],
    ['without a scan', { v: 1 }, false],
  ]),
  ...cases('BluetoothDeviceRequest', { v: 1, address: 'F0:1D:BC:44:55:66' }, [
    ['a lower-case address', { v: 1, address: 'f0:1d:bc:44:55:66' }, false],
    ['without an address', { v: 1 }, false],
    ['with a PIN (command input)', { v: 1, address: 'F0:1D:BC:44:55:66', pin: '0000' }, false],
  ]),
  ...cases('BluetoothConfirmRequest', { v: 1, pairingId: 'p-k3q9xv2m', accept: true }, [
    ['No', { v: 1, pairingId: 'p-k3q9xv2m', accept: false }, true],
    ['accept as a word', { v: 1, pairingId: 'p-k3q9xv2m', accept: 'yes' }, false],
    ['without accept', { v: 1, pairingId: 'p-k3q9xv2m' }, false],
    [
      'with the code (the box shows it, nobody types it)',
      { v: 1, pairingId: 'p-k3q9xv2m', accept: true, code: '482913' },
      false,
    ],
  ]),
  ...cases('BluetoothCancelRequest', { v: 1, pairingId: 'p-k3q9xv2m' }, [
    ['an id of 7 characters', { v: 1, pairingId: 'p-k3q9xv2' }, false],
    ['with a member (command input)', { v: 1, pairingId: 'p-k3q9xv2m', force: true }, false],
  ]),
  ...cases(
    'BluetoothPairingAnswer',
    { v: 1, pairing: { ...without(btPairing, 'code'), phase: 'pairing', typed: undefined } },
    [
      ['a code to type', { v: 1, pairing: btPairing }, true],
      ['without a deadline', { v: 1, pairing: without(btPairing, 'deadline') }, false],
    ],
  ),
  ...cases('BluetoothDeviceAnswer', { v: 1, device: btKeyboard }, [
    [
      'newer member stripped',
      { v: 1, device: { ...btKeyboard, rssi: -48 } },
      true,
      { v: 1, device: btKeyboard },
    ],
    ['without connected', { v: 1, device: without(btKeyboard, 'connected') }, false],
  ]),
  ...cases('BluetoothAck', { v: 1 }, [['newer member stripped', { v: 1, ok: true }, true, { v: 1 }]]),
  // Bluetooth on the desk socket (0.109, CT-684).
  ...cases('DeskBluetoothAnswer', { v: 1, bluetooth: btState, mayChange: true }, [
    ['locked', { v: 1, bluetooth: btState, mayChange: false, why: 'locked' }, true],
    ['no Bluetooth service', { v: 1, bluetooth: btNone, mayChange: true }, true],
    ['an unknown reason', { v: 1, bluetooth: btState, mayChange: false, why: 'away' }, false],
    ['without mayChange', { v: 1, bluetooth: btState }, false],
  ]),
  ...cases('DeskBluetoothScanAnswer', { v: 1, scan: btScan }, [['without a scan', { v: 1 }, false]]),
  ...cases('DeskBluetoothDeviceRequest', { v: 1, address: 'DC:2C:26:01:02:03' }, [
    ['a lower-case address', { v: 1, address: 'dc:2c:26:01:02:03' }, false],
    [
      'with where it came from (the runtime knows)',
      { v: 1, address: 'DC:2C:26:01:02:03', via: 'screen' },
      false,
    ],
  ]),
  ...cases('DeskBluetoothConfirmRequest', { v: 1, pairingId: 'p-k3q9xv2m', accept: false }, [
    ['without accept', { v: 1, pairingId: 'p-k3q9xv2m' }, false],
  ]),
  ...cases('DeskBluetoothCancelRequest', { v: 1, pairingId: 'p-k3q9xv2m' }, [
    ['without an id', { v: 1 }, false],
  ]),
  ...cases('DeskBluetoothPairingAnswer', { v: 1, pairing: btPairing }, [
    ['an unknown phase', { v: 1, pairing: { ...btPairing, phase: 'bonding' } }, false],
  ]),
  ...cases('DeskBluetoothDeviceAnswer', { v: 1, device: btHeadphones }, [
    ['a computer', { v: 1, device: { ...btHeadphones, kind: 'computer' } }, false],
  ]),
  ...cases('LicenceRenewNowRequest', { v: 1 }, [['with a member', { v: 1, reason: 'owner' }, false]]),
  ...cases('LicenceRenewNowResult', { v: 1, renewed: true }, [
    ['failed', { v: 1, renewed: false, error: 'unreachable' }, true],
    ['error with spaces', { v: 1, renewed: false, error: 'not reachable' }, false],
  ]),
  ...cases('ClientInstallRequest', { v: 1, provider: 'codex' }, [
    ['unknown provider', { v: 1, provider: 'acp' }, false],
    ['with a version (the manager selects it)', { v: 1, provider: 'codex', version: '0.158.0' }, false],
  ]),
  ...cases('ClientRemoveRequest', { v: 1, provider: 'claude' }, [
    ['without v', { provider: 'claude' }, false],
  ]),
  ...cases('RuntimeClaimedRequest', { claimId: 'clm_8Hq2mXk3pZ', claimedAt: '2026-09-25T12:00:00Z' }, [
    ['without claimId', { claimedAt: '2026-09-25T12:00:00Z' }, false],
  ]),
  ...cases(
    'RuntimeFacts',
    {
      v: 1,
      activeSessions: 3,
      claimed: true,
      claimReported: false,
      recovery: { enrolled: true, kitVerified: false },
      revocations: { pending: 1, applied: 4 },
      draining: false,
      quarantined: false,
      relay: 'connected',
      clientAdapters: { claude: 2 },
    },
    [
      [
        'without client adapter levels',
        {
          v: 1,
          activeSessions: 0,
          claimed: true,
          claimReported: true,
          recovery: { enrolled: true, kitVerified: true },
          revocations: { pending: 0, applied: 0 },
          draining: false,
          quarantined: false,
          relay: 'connected',
        },
        false,
      ],
      [
        'a Codex level from an older runtime is stripped (Claude only since 3.0, CT-1564)',
        {
          v: 1,
          activeSessions: 0,
          claimed: true,
          claimReported: true,
          recovery: { enrolled: true, kitVerified: true },
          revocations: { pending: 0, applied: 0 },
          draining: false,
          quarantined: false,
          relay: 'connected',
          clientAdapters: { claude: 2, codex: 1 },
        },
        true,
        {
          v: 1,
          activeSessions: 0,
          claimed: true,
          claimReported: true,
          recovery: { enrolled: true, kitVerified: true },
          revocations: { pending: 0, applied: 0 },
          draining: false,
          quarantined: false,
          relay: 'connected',
          clientAdapters: { claude: 2 },
        },
      ],
      [
        'missing quarantined',
        {
          v: 1,
          activeSessions: 0,
          claimed: false,
          claimReported: false,
          recovery: { enrolled: false, kitVerified: false },
          revocations: { pending: 0, applied: 0 },
          draining: false,
          relay: 'stopped',
        },
        false,
      ],
    ],
  ),
  ...cases(
    'CheckpointRequest',
    {
      reason: 'migration',
      releaseId: 'rt-2026.10.01-1',
      migrations: ['0029_add_index'],
      underDrain: 'upd-7',
    },
    [
      ['manual', { reason: 'manual' }, true],
      ['unknown member in a command', { reason: 'manual', force: true }, false],
    ],
  ),
  ...cases(
    'CheckpointResult',
    {
      ok: true,
      ref: 'chk_20260925T1200',
      verified: true,
      id: 'chk_20260925T1200',
      seq: 41,
      snapshotId: '4f9c2e1a',
      manifestSha256: 'ab'.repeat(32),
      createdAt: '2026-09-25T12:00:00Z',
      schemaVersion: 28,
    },
    [],
  ),
  ...cases(
    'UpdateStatusResponse',
    {
      state: 'ForwardRepairRequired',
      current: 'rt-2026.10.01-1',
      knownGood: 'rt-2026.09.25-1',
      failure: 'forward_repair_required',
      explanation: 'The update migrated the database; fix forward.',
      hold: false,
      readOnly: true,
    },
    [
      [
        '0.4 mapping state',
        { state: 'Repairing', current: 'rt-1', knownGood: 'rt-1', hold: false, readOnly: false },
        false,
      ],
    ],
  ),
  ...cases('MaintenanceLockRequest', { holder: 'backup', reason: 'checkpoint', ttlS: 3600 }, [
    ['ttl above 6 hours', { holder: 'backup', reason: 'checkpoint', ttlS: 21_601 }, false],
  ]),
  ...cases(
    'NetworkCandidate',
    {
      v: 1,
      id: 'n-office-static',
      interface: 'enp1s0',
      ipv4: { mode: 'static', address: '192.168.10.20/24', gateway: '192.168.10.1' },
      ipv6: { mode: 'auto' },
      dns: ['192.168.10.1', '2001:4860:4860::8888'],
      confirmTimeoutSec: 120,
    },
    [
      [
        'wifi interface',
        {
          v: 1,
          id: 'n-x',
          interface: 'wlan0',
          ipv4: { mode: 'dhcp' },
          ipv6: { mode: 'auto' },
          dns: [],
          confirmTimeoutSec: 120,
        },
        false,
      ],
      [
        'a wlp* Wi-Fi interface (Wi-Fi has its own shapes, CT-573)',
        {
          v: 1,
          id: 'n-x',
          interface: 'wlp194s0',
          ipv4: { mode: 'dhcp' },
          ipv6: { mode: 'auto' },
          dns: [],
          confirmTimeoutSec: 120,
        },
        false,
      ],
      [
        'five DNS servers',
        {
          v: 1,
          id: 'n-x',
          interface: 'eth0',
          ipv4: { mode: 'dhcp' },
          ipv6: { mode: 'disabled' },
          dns: ['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9'],
          confirmTimeoutSec: 120,
        },
        false,
      ],
    ],
  ),
  ...cases(
    'AssignmentKeys',
    {
      v: 1,
      env: 'dev',
      keys: [{ kid: 'asg-1', publicKey: 'ab'.repeat(32), state: 'active', notBefore: null, notAfter: null }],
    },
    [
      ['no keys', { v: 1, env: 'dev', keys: [] }, false],
      [
        '0.5.0 shape without notBefore',
        {
          v: 1,
          env: 'dev',
          keys: [{ kid: 'asg-1', publicKey: 'ab'.repeat(32), state: 'active', notAfter: null }],
        },
        false,
      ],
      [
        'unknown member (a pinned security document)',
        {
          v: 1,
          env: 'dev',
          keys: [
            {
              kid: 'asg-1',
              publicKey: 'ab'.repeat(32),
              state: 'active',
              notBefore: null,
              notAfter: null,
              alg: 'EdDSA',
            },
          ],
        },
        false,
      ],
    ],
  ),
  ...cases('WebPushRegistration', webPush, [
    [
      'expirationTime present',
      { ...webPush, subscription: { ...webPush.subscription, expirationTime: 1_790_000_000_000 } },
      true,
    ],
    [
      'http endpoint',
      { ...webPush, subscription: { ...webPush.subscription, endpoint: 'http://push.example/x' } },
      false,
    ],
    [
      'padded p256dh',
      {
        ...webPush,
        subscription: {
          ...webPush.subscription,
          keys: { p256dh: `${'B'.repeat(86)}=`, auth: 'A'.repeat(22) },
        },
      },
      false,
    ],
    [
      'auth of 23 characters',
      {
        ...webPush,
        subscription: { ...webPush.subscription, keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(23) } },
      },
      false,
    ],
    [
      'endpoint above 2048 characters',
      {
        ...webPush,
        subscription: { ...webPush.subscription, endpoint: `https://p.example/${'x'.repeat(2_040)}` },
      },
      false,
    ],
    ['unknown member (command input)', { ...webPush, userAgent: 'Firefox' }, false],
    ['apns platform with a subscription', { ...webPush, platform: 'apns' }, false],
  ]),
  ...cases(
    'NativePushRegistration',
    { platform: 'fcm', token: `fcm:${'x'.repeat(140)}`, appId: 'whombat-prod' },
    [['webpush is not a native platform', { platform: 'webpush', token: 'x'.repeat(20), appId: 'a' }, false]],
  ),
  ...cases('PushVapidKey', { publicKey: 'B'.repeat(87) }, [
    [
      'newer member stripped (response)',
      { publicKey: 'B'.repeat(87), rotatedAt: 1 },
      true,
      { publicKey: 'B'.repeat(87) },
    ],
    ['compressed key', { publicKey: 'A'.repeat(44) }, false],
  ]),
  // The own address (4.3; Whombat own-address.md).
  ...cases('RelayHello', set(hello, { accepts: ['acme', 'web'] }), [
    ['a control hello taking only acme', set(hello, { accepts: ['acme'] }), true],
    ['an unknown door class', set(hello, { accepts: ['ssh'] }), false],
    ['three door classes', set(hello, { accepts: ['web', 'acme', 'web'] }), false],
    ['a data connection for a door session', set(hello, { class: 'web', session: 'ses_12345678' }), true],
  ]),
  ...cases('RelayIncoming', { t: 'incoming', session: 'ses_12345678', class: 'web', src: '203.0.113.7' }, [
    ['an app session (no src)', { t: 'incoming', session: 'ses_12345678', class: 'interactive' }, true],
    ['acme', { t: 'incoming', session: 'ses_12345678', class: 'acme', src: '2001:db8::7' }, true],
    ['src 0.0.0.0', { t: 'incoming', session: 'ses_12345678', class: 'web', src: '0.0.0.0' }, true],
    [
      'src 255.255.255.255',
      { t: 'incoming', session: 'ses_12345678', class: 'web', src: '255.255.255.255' },
      true,
    ],
    ['src 256.0.0.1', { t: 'incoming', session: 'ses_12345678', class: 'web', src: '256.0.0.1' }, false],
    [
      'src with a leading zero',
      { t: 'incoming', session: 'ses_12345678', class: 'web', src: '010.0.0.1' },
      false,
    ],
    ['src ::', { t: 'incoming', session: 'ses_12345678', class: 'web', src: '::' }, true],
    ['src ::1', { t: 'incoming', session: 'ses_12345678', class: 'web', src: '::1' }, true],
    [
      'src full IPv6',
      {
        t: 'incoming',
        session: 'ses_12345678',
        class: 'web',
        src: '2001:0db8:0000:0000:0000:ff00:0042:8329',
      },
      true,
    ],
    [
      'src IPv4-mapped IPv6 (the relay unmaps it)',
      { t: 'incoming', session: 'ses_12345678', class: 'web', src: '::ffff:203.0.113.7' },
      false,
    ],
    ['src with a zone', { t: 'incoming', session: 'ses_12345678', class: 'web', src: 'fe80::1%eth0' }, false],
    [
      'src with a port',
      { t: 'incoming', session: 'ses_12345678', class: 'web', src: '203.0.113.7:443' },
      false,
    ],
    [
      'src in brackets',
      { t: 'incoming', session: 'ses_12345678', class: 'web', src: '[2001:db8::7]' },
      false,
    ],
    [
      'src in upper-case hex',
      { t: 'incoming', session: 'ses_12345678', class: 'web', src: '2001:DB8::7' },
      false,
    ],
    ['an unknown class', { t: 'incoming', session: 'ses_12345678', class: 'video' }, false],
  ]),
  ...cases('AdmissionClaims', set(claims, { rol: 'appliance', lbl: 'maple-otter-river' }), [
    ['a label of 3-letter words', set(claims, { rol: 'appliance', lbl: 'ant-bee-cod' }), true],
    ['a label of two words', set(claims, { rol: 'appliance', lbl: 'maple-otter' }), false],
    ['a label in upper case', set(claims, { rol: 'appliance', lbl: 'Maple-otter-river' }), false],
    ['a label with a dot', set(claims, { rol: 'appliance', lbl: 'maple.otter.river' }), false],
    [
      'an unknown claim is still refused',
      set(claims, { rol: 'appliance', lbl: 'maple-otter-river', zone: 'box' }),
      false,
    ],
  ]),
  ...cases('AddressRegisterRequest', { label: 'maple-otter-river' }, [
    ['four words', { label: 'maple-otter-river-stone' }, false],
    ['a word of 11 letters', { label: `maple-otter-${'r'.repeat(11)}` }, false],
    ['a word of 2 letters', { label: 'ma-otter-river' }, false],
    ['a digit', { label: 'maple-otter-river1' }, false],
    ['an unknown member (command input)', { label: 'maple-otter-river', zone: 'dev' }, false],
  ]),
  ...cases(
    'AddressRegisterResponse',
    { label: 'maple-otter-river', host: 'maple-otter-river.box.whombat.app', registeredAt: now },
    [
      [
        'DEV',
        { label: 'maple-otter-river', host: 'maple-otter-river.dev.whombat.app', registeredAt: now },
        true,
      ],
      [
        'another zone',
        { label: 'maple-otter-river', host: 'maple-otter-river.example.com', registeredAt: now },
        false,
      ],
      [
        'two labels under the zone',
        { label: 'maple-otter-river', host: 'www.maple-otter-river.box.whombat.app', registeredAt: now },
        false,
      ],
      [
        'a trailing dot',
        { label: 'maple-otter-river', host: 'maple-otter-river.box.whombat.app.', registeredAt: now },
        false,
      ],
    ],
  ),
  ...cases('AccountLinkLookupRequest', { code: 'KXQM-TRVW' }, [
    ['lower case', { code: 'kxqm-trvw' }, false],
    ['without the hyphen', { code: 'KXQMTRVW' }, false],
    ['a letter outside the alphabet', { code: 'KXQM-TRVO' }, false],
  ]),
  ...cases('AccountLinkLookupResponse', { email: 'mara@example.com', expiresAt: now + 600 }, [
    ['no @', { email: 'mara.example.com', expiresAt: now }, false],
    ['two @', { email: 'mara@x@example.com', expiresAt: now }, false],
    ['a space', { email: 'mara jansen@example.com', expiresAt: now }, false],
  ]),
  ...cases('AccountLinkRequest', { code: 'KXQM-TRVW' }, [
    ['with terms', { code: 'KXQM-TRVW', terms: {} }, false],
  ]),
  ...cases('AccountLinkResponse', { email: 'mara@example.com', linkedAt: now }, [
    [
      'newer member stripped',
      { email: 'mara@example.com', linkedAt: now, org: 'org_42' },
      true,
      { email: 'mara@example.com', linkedAt: now },
    ],
  ]),
  ...cases('KitCredentialsDeclareRequest', { credentialIds: ['cred-AAAA_1', 'cred-BBBB_2'] }, [
    ['the empty set', { credentialIds: [] }, true],
    ['65 ids', { credentialIds: Array.from({ length: 65 }, (_, i) => `cred${i}`) }, false],
    ['an id with a slash', { credentialIds: ['cred/1'] }, false],
  ]),
  ...cases('KitCredentialsDeclareResponse', { declared: 2 }, [['negative', { declared: -1 }, false]]),
  ...cases('KitEnvelopesPutResponse', { stored: 1, skipped: 1, skippedCredentialIds: ['cred-BBBB_2'] }, [
    ['from a control before 4.3', { stored: 1, skipped: 1 }, true],
    [
      '65 skipped ids',
      { stored: 0, skipped: 64, skippedCredentialIds: Array.from({ length: 65 }, (_, i) => `c${i}`) },
      false,
    ],
  ]),
  ...cases('OwnAddressStateRequest', { v: 1 }, [['a member', { v: 1, label: 'maple-otter-river' }, false]]),
  ...cases('OwnAddressRegisterRequest', { v: 1, label: 'maple-otter-river' }, [
    ['no label', { v: 1 }, false],
    ['a host for a label', { v: 1, label: 'maple-otter-river.box.whombat.app' }, false],
  ]),
  ...cases('OwnAddressCertRequest', { v: 1 }, [['version 2', { v: 2 }, false]]),
  ...cases('OwnAddressCtRequest', { v: 1 }, [['a member', { v: 1, since: now }, false]]),
  ...cases('OwnAddressStateResponse', { v: 1, enabled: false, acme: { state: 'idle' } }, [
    [
      'ordering, with a label',
      {
        v: 1,
        enabled: true,
        label: 'maple-otter-river',
        host: 'maple-otter-river.dev.whombat.app',
        acme: { state: 'ordering' },
      },
      true,
    ],
    [
      'valid, with its certificate',
      {
        v: 1,
        enabled: true,
        label: 'maple-otter-river',
        host: 'maple-otter-river.box.whombat.app',
        acme: { state: 'valid', nextAttemptAt: '2027-01-10T12:00:00Z' },
        cert: {
          serial: '04a1b2c3d4e5f6',
          spkiSha256: 'a'.repeat(64),
          notBefore: '2026-11-18T10:00:00Z',
          notAfter: '2027-02-16T10:00:00Z',
        },
      },
      true,
    ],
    [
      'failing with an error',
      {
        v: 1,
        enabled: true,
        acme: { state: 'failing', error: 'probe_failed', nextAttemptAt: '2026-11-18T11:00:00Z' },
      },
      true,
    ],
    ['an unknown acme state', { v: 1, enabled: true, acme: { state: 'sleeping' } }, false],
    [
      'a serial with colons',
      {
        v: 1,
        enabled: true,
        acme: { state: 'valid' },
        cert: {
          serial: '04:a1',
          spkiSha256: 'a'.repeat(64),
          notBefore: '2026-11-18T10:00:00Z',
          notAfter: '2027-02-16T10:00:00Z',
        },
      },
      false,
    ],
    [
      'an SPKI hash in upper case',
      {
        v: 1,
        enabled: true,
        acme: { state: 'valid' },
        cert: {
          serial: '04a1',
          spkiSha256: 'A'.repeat(64),
          notBefore: '2026-11-18T10:00:00Z',
          notAfter: '2027-02-16T10:00:00Z',
        },
      },
      false,
    ],
  ]),
  ...cases(
    'OwnAddressCertResponse',
    {
      v: 1,
      host: 'maple-otter-river.box.whombat.app',
      serial: '04a1b2c3d4e5f6',
      spkiSha256: 'a'.repeat(64),
      notBefore: '2026-11-18T10:00:00Z',
      notAfter: '2027-02-16T10:00:00Z',
      certPem: `-----BEGIN CERTIFICATE-----\n${'A'.repeat(64)}\n-----END CERTIFICATE-----\n`,
      keyPem: `-----BEGIN PRIVATE KEY-----\n${'B'.repeat(64)}\n-----END PRIVATE KEY-----\n`,
    },
    [
      [
        'no key',
        {
          v: 1,
          host: 'maple-otter-river.box.whombat.app',
          serial: '04',
          spkiSha256: 'a'.repeat(64),
          notBefore: '2026-11-18T10:00:00Z',
          notAfter: '2027-02-16T10:00:00Z',
          certPem: `-----BEGIN CERTIFICATE-----\n${'A'.repeat(64)}\n-----END CERTIFICATE-----\n`,
        },
        false,
      ],
    ],
  ),
  ...cases(
    'OwnAddressCtResponse',
    {
      v: 1,
      source: 'certspotter',
      checkingSince: '2026-11-18T10:00:00Z',
      lastFreshAt: '2026-11-18T16:00:00Z',
      missed: [{ from: '2026-11-19T00:00:00Z', to: '2026-11-19T14:00:00Z' }],
      certs: [
        {
          id: '12345678901',
          spkiSha256: 'b'.repeat(64),
          dnsNames: ['maple-otter-river.box.whombat.app', '*.box.whombat.app'],
          notBefore: '2026-11-18T10:00:00Z',
          notAfter: '2027-02-16T10:00:00Z',
          issuer: "C=US, O=Let's Encrypt, CN=E6",
        },
      ],
      ordered: [],
    },
    [
      [
        'never fresh',
        {
          v: 1,
          source: 'certspotter',
          checkingSince: '2026-11-18T10:00:00Z',
          lastFreshAt: null,
          missed: [],
          certs: [],
          ordered: [],
        },
        true,
      ],
      [
        'another source',
        {
          v: 1,
          source: 'crtsh',
          checkingSince: '2026-11-18T10:00:00Z',
          lastFreshAt: null,
          missed: [],
          certs: [],
          ordered: [],
        },
        false,
      ],
    ],
  ),
  ...cases(
    'ConsoleState',
    {
      v: 1,
      state: 'claimable',
      code: 'KXQM',
      url: 'https://maple-otter-river.box.whombat.app/c/kxqmtr',
      alert: { kind: 'own_address_foreign', since: '2026-11-18T12:00:00Z' },
    },
    [
      [
        'an alert while claimed',
        {
          v: 1,
          state: 'claimed',
          url: 'https://app.whombat.com/claim',
          alert: { kind: 'own_address_foreign', since: '2026-11-18T12:00:00Z' },
        },
        true,
      ],
      [
        'an unknown alert',
        {
          v: 1,
          state: 'claimed',
          url: 'https://app.whombat.com/claim',
          alert: { kind: 'disk_full', since: '2026-11-18T12:00:00Z' },
        },
        false,
      ],
    ],
  ),
  // Whombat Link (4.4; Whombat whombat-link.md): device ops, the Link state on tickets, the manager socket, the screen.
  ...cases('LinkBeginRequest', { registration: linkRegistration }, [
    ['with the box’s name', { registration: linkRegistration, name: 'Whombat in the study' }, true],
    ['a name in another script', { registration: linkRegistration, name: 'Вомбат дома' }, true],
    ['a name with a line break', { registration: linkRegistration, name: 'a\nb' }, false],
    ['no registration', {}, false],
    [
      'a registration without its content proof',
      { registration: without(linkRegistration, 'contentProof') },
      false,
    ],
    ['an unknown member', { registration: linkRegistration, label: 'maple-otter-river' }, false],
  ]),
  ...cases('LinkBeginResponse', { link: linkStarting }, [
    ['already on: no code', { link: linkOn }, true],
    ['waiting for an address', { link: { state: 'starting', since: now, waitingForAddress: true } }, true],
    [
      'a lower-case code',
      { link: { ...linkStarting, pending: { ...linkPending, code: 'kxqm-trvw' } } },
      false,
    ],
    [
      'a plain-http page',
      { link: { ...linkStarting, pending: { ...linkPending, url: 'http://a.b/link' } } },
      false,
    ],
    ['an unknown state', { link: { state: 'paused', since: now } }, false],
    ['a newer member stripped', { link: { ...linkOn, plan: 'yearly' } }, true, { link: linkOn }],
  ]),
  ...cases('LinkStatusRequest', {}, [['a member', { force: true }, false]]),
  ...cases('LinkStatusResponse', { link: linkGrace }, [
    ['ended', { link: { state: 'ended', since: now, label: 'maple-otter-river' } }, true],
    ['off', { link: { state: 'off', since: 0 } }, true],
    ['no since', { link: { state: 'off' } }, false],
    ['a host for a label', { link: { ...linkGrace, label: 'maple-otter-river.box.whombat.app' } }, false],
  ]),
  ...cases('LinkLeaveRequest', {}, [['a reason', { reason: 'moving' }, false]]),
  ...cases('LinkLeaveResponse', { link: { state: 'off', since: now, label: 'maple-otter-river' } }, []),
  ...cases('TicketIssueResponse', { ...ticketResponse, link: linkOn }, [
    ['Link in grace', { ...ticketResponse, link: linkGrace }, true],
    ['Link with an unknown state', { ...ticketResponse, link: { state: 'paused', since: now } }, false],
  ]),
  ...cases('PushRegisterRequest', { token: pushToken }, [
    ['FCM', { token: { ...pushToken, platform: 'fcm', appId: 'whombat-mobile' } }, true],
    ['Web Push is not through the box', { token: { ...pushToken, platform: 'webpush' } }, false],
    ['a short token', { token: { ...pushToken, token: 'abc' } }, false],
    ['a space in the token', { token: { ...pushToken, token: `${'f'.repeat(20)} x` } }, false],
    ['the token at the top level', pushToken, false],
  ]),
  ...cases('PushRegisterResponse', { handle: 'hNd1e_0123456789abcdefgh' }, [['no handle', {}, false]]),
  ...cases('PushUnregisterRequest', { handle: 'hNd1e_0123456789abcdefgh' }, [
    ['an unknown member', { handle: 'hNd1e_0123456789abcdefgh', all: true }, false],
  ]),
  ...cases('PushUnregisterResponse', { ok: true }, [['false', { ok: false }, false]]),
  ...cases('SupportHeartbeatRequest', { support: supportOff }, [
    [
      'on at fix',
      {
        support: { state: 'fix', untilS: 3_600, connected: 1, helpCode: true, hostKey: rhHostKey },
      },
      true,
    ],
    ['no support', {}, false],
    ['a whole status report', { support: supportOff, uptimeS: 10 }, false],
  ]),
  ...cases('SupportHeartbeatResponse', { ok: true, nextS: 300 }, [
    ['too often', { ok: true, nextS: 30 }, false],
    ['an hour', { ok: true, nextS: 3_600 }, true],
  ]),
  ...cases('LinkStateRequest', { v: 1 }, [['a member', { v: 1, refresh: true }, false]]),
  ...cases('LinkStateResponse', { v: 1, enabled: true, link: localLinkStarting }, [
    [
      'no Link in this image',
      { v: 1, enabled: false, link: { state: 'off', since: '2026-11-18T12:00:00Z' } },
      true,
    ],
    [
      'on, checked',
      {
        v: 1,
        enabled: true,
        link: {
          state: 'on',
          since: '2026-11-18T12:00:00Z',
          label: 'maple-otter-river',
          email: 'mara@example.com',
          checkedAt: '2026-11-18T12:05:00Z',
        },
      },
      true,
    ],
    ['epoch seconds', { v: 1, enabled: true, link: { state: 'on', since: now } }, false],
  ]),
  ...cases('LinkOnRequest', { v: 1, contentProof: 'd'.repeat(128) }, [
    ['with a name', { v: 1, contentProof: 'd'.repeat(128), name: 'Whombat in the study' }, true],
    ['no proof', { v: 1 }, false],
    ['an upper-case proof', { v: 1, contentProof: 'D'.repeat(128) }, false],
  ]),
  ...cases('LinkOffRequest', { v: 1 }, [['version 2', { v: 2 }, false]]),
  ...cases('UpdateChannelRequest', { v: 1 }, [['a channel', { v: 1, channel: 'production' }, false]]),
  ...cases('UpdateChannelSetRequest', { v: 1, channel: 'development' }, [
    ['production', { v: 1, channel: 'production' }, true],
    ['beta', { v: 1, channel: 'beta' }, false],
    ['no channel', { v: 1 }, false],
  ]),
  ...cases('UpdateChannelResponse', { v: 1, channel: 'production' }, [
    ['staying on a newer release', { v: 1, channel: 'production', staysOn: 'whombat-dev-20261118.4' }, true],
  ]),
  ...cases('RuntimePushRegisterRequest', { token: pushToken }, []),
  ...cases('RuntimePushRegisterResponse', { handle: 'hNd1e_0123456789abcdefgh' }, []),
  ...cases('RuntimePushUnregisterRequest', { handle: 'hNd1e_0123456789abcdefgh' }, []),
  ...cases('RuntimePushUnregisterResponse', { ok: true }, []),
  ...cases(
    'ConsoleState',
    {
      v: 1,
      state: 'waiting',
      url: 'https://app.whombat.com/claim',
      reach: {
        link: {
          state: 'starting',
          code: 'KXQM-TRVW',
          url: 'https://app.whombat.com/link',
          expiresAt: '2026-11-18T12:15:00Z',
        },
      },
    },
    [
      [
        'Tailscale needs a sign-in',
        {
          v: 1,
          state: 'waiting',
          url: 'https://app.whombat.com/claim',
          reach: { tailscale: { loginUrl: 'https://login.tailscale.com/a/1a2b3c4d' } },
        },
        true,
      ],
      [
        'Tailscale needs HTTPS',
        {
          v: 1,
          state: 'waiting',
          url: 'https://app.whombat.com/claim',
          reach: { tailscale: { needsHttps: true, name: 'whombat.tail1234.ts.net' } },
        },
        true,
      ],
      [
        'Link waiting for an address',
        {
          v: 1,
          state: 'waiting',
          url: 'https://app.whombat.com/claim',
          reach: { link: { state: 'starting', waitingForAddress: true } },
        },
        true,
      ],
      [
        'Link in grace, claimed',
        {
          v: 1,
          state: 'claimed',
          url: 'https://app.whombat.com/claim',
          reach: { link: { state: 'grace', graceEndsAt: '2026-11-25T12:00:00Z' } },
        },
        true,
      ],
      [
        'a code with a space',
        {
          v: 1,
          state: 'waiting',
          url: 'https://app.whombat.com/claim',
          reach: { link: { state: 'starting', code: 'KXQM TRVW' } },
        },
        false,
      ],
    ],
  ),
];
