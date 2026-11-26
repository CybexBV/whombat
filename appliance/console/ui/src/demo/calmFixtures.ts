/**
 * The calm glance's fixtures (CG-350…; Whombat DK-101…DK-124, mockups `docs/design/desk-calm/`): the glance as the
 * runtime sends it with `calm`, on top of the desk's own fixtures (their paired person, lock, power and Home), so only
 * the calm part and what the top bar reads differ. `desk-calm-*`.
 */

import type { DeskInitial } from '../desk/Desk';
import type { ServerState } from '../lib/api';
import { type CalmServer, DEFAULT_BAR, type DeskCalm } from '../lib/calm';
import type { AgentFace, DeskLook, DeskState, LookResearch } from '../lib/desk';
import type { RemoteHelp } from '../lib/remoteHelp';
import { DESK_FIXTURES } from './deskFixtures';
import type { Fixture } from './fixtures';
import { CALM_WIFI } from './wifiFixtures';

/** The calm fixtures' clock: a Wednesday, 14:34 in the paired person's zone (Europe/Amsterdam). */
export const NOW = '2026-10-21T12:34:20Z';
const ago = (minutes: number) =>
  new Date(Date.parse(NOW) - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const spark = (seed: number, base = 14) =>
  Array.from({ length: 30 }, (_, i) =>
    Math.max(1, Math.round(base + 7 * Math.sin((i + seed) / 3) + ((i * seed) % 6))),
  );
const server = (id: string, mark: string, seed: number, more: Partial<CalmServer> = {}): CalmServer => ({
  id,
  name: id,
  mark,
  state: 'ok',
  say: null,
  spark: spark(seed),
  work: null,
  progress: null,
  ...more,
});

const STRIP: CalmServer[] = [
  server('pve-01', 'proxmox', 1),
  server('pve-02', 'proxmox', 2),
  server('blackbox', 'unraid', 3),
  server('the-falcon', 'linux', 4, { spark: spark(4, 40) }),
  server('nas', 'synology', 5),
  server('media', 'ubuntu', 6),
];

export const FINE: DeskCalm = {
  headline: {
    tone: 'ok',
    text: 'All fine',
    more: '8 servers and 14 services are running. Nothing needs you.',
  },
  clock: 'big',
  hero: null,
  also: [],
  moreNeeds: 0,
  moments: [
    {
      key: 'connection:con_plex',
      kind: 'activity',
      name: 'Plex',
      mark: 'plex',
      value: '2 watching',
      detail: 'Dune: Part Two · The Bear',
      progress: null,
      pinned: false,
    },
    {
      key: 'connection:con_sab',
      kind: 'activity',
      name: 'Downloads',
      mark: 'sabnzbd',
      value: '3 left · 20 min',
      detail: null,
      progress: 62,
      pinned: false,
    },
    {
      key: 'widget:wdg_living',
      kind: 'figure',
      name: 'Living room',
      mark: 'homeassistant',
      value: '21.4 °C',
      detail: 'From Home Assistant',
      progress: null,
      pinned: true,
    },
  ],
  strip: STRIP,
  moreStrip: 0,
  bar: DEFAULT_BAR,
  doneCount: 3,
  digest: null,
  update: null,
  sample: null,
};

export const PVE02_DOWN: DeskLook = {
  key: 'server:pve-02',
  kind: 'server',
  name: 'pve-02',
  state: 'down',
  reason: null,
  server: 'pve-02',
  notice: { check: 'server.offline' },
  nature: 'problem',
};
export const NAS_LOOK: DeskLook = {
  key: 'server:nas',
  kind: 'server',
  name: 'nas',
  state: 'look',
  reason: 'Filling up',
  server: 'nas',
  notice: { check: 'server.disk' },
  nature: 'problem',
};

export const WRONG: DeskCalm = {
  ...FINE,
  headline: { tone: 'bad', text: '1 thing is wrong', more: null },
  clock: 'small',
  hero: {
    kind: 'look',
    tone: 'bad',
    title: 'pve-02 isn’t answering',
    detail: 'Plex, Home Assistant and 2 more run on it, so they’re down too.',
    since: ago(4),
    ask: null,
    look: 'server:pve-02',
    server: 'pve-02',
    research: null,
    fix: null,
  },
  also: [
    {
      tone: 'warn',
      name: 'nas',
      text: 'disk is 88 % full; at this rate it’s full in about 12 days',
      ask: null,
      look: 'server:nas',
      server: 'nas',
    },
  ],
  moments: [],
  strip: [
    server('pve-02', 'proxmox', 2, { state: 'bad', say: 'not answering', spark: [] }),
    server('nas', 'synology', 5, { state: 'warn', say: 'disk 88 %', spark: [] }),
    ...STRIP.filter((s) => s.id !== 'pve-02' && s.id !== 'nas'),
  ],
};

const ASK: DeskCalm = {
  ...FINE,
  headline: { tone: 'bad', text: 'Neo has a question', more: null },
  clock: 'small',
  hero: {
    kind: 'ask',
    tone: 'bad',
    title: 'Restart Plex on blackbox?',
    detail: null,
    since: null,
    ask: 412,
    look: null,
    server: null,
    research: null,
    fix: null,
  },
  moments: [],
};

const BUSY: DeskCalm = {
  ...FINE,
  headline: { tone: 'busy', text: 'Neo is busy', more: 'Updating your servers. 2 of 4 done.' },
  moments: [
    {
      key: 'work',
      kind: 'work',
      name: 'Neo',
      mark: null,
      value: 'Updating your servers',
      detail: 'Installing on the-falcon',
      progress: 50,
      pinned: false,
    },
    FINE.moments[0] as DeskCalm['moments'][number],
  ],
  strip: [
    server('pve-01', 'proxmox', 1, { work: 'done', say: null }),
    server('pve-02', 'proxmox', 2, { work: 'done' }),
    server('the-falcon', 'linux', 4, { work: 'now', progress: 60, say: 'updating', spark: [] }),
    server('blackbox', 'unraid', 3, { work: 'next' }),
    server('nas', 'synology', 5),
    server('media', 'ubuntu', 6),
  ],
};

export const WELCOME: DeskCalm = {
  ...FINE,
  digest: {
    id: 'dig_20261021a',
    awayS: 7_800,
    items: [
      {
        icon: 'ask',
        text: 'Neo asks: send the reply to an Acme Desk customer?',
        at: null,
        ask: 413,
        look: null,
        server: null,
      },
      {
        icon: 'done',
        text: 'Neo renewed the certificate on pve-01',
        at: ago(112),
        ask: null,
        look: null,
        server: null,
      },
      {
        icon: 'done',
        text: 'the-falcon installed its updates and restarted',
        at: ago(89),
        ask: null,
        look: null,
        server: null,
      },
      {
        icon: 'look',
        text: 'nas’s disk went from 86 % to 88 %',
        at: null,
        ask: null,
        look: 'server:nas',
        server: 'nas',
      },
    ],
  },
};

const NOTHING: DeskCalm = { ...FINE, moments: [], doneCount: null };
const MANY: DeskCalm = {
  ...FINE,
  strip: [
    ...STRIP,
    server('pi-hole', 'raspberrypi', 7),
    server('backup-box', 'debian', 8, { state: 'off', say: 'off', spark: [] }),
  ],
  moreStrip: 4,
};

/**
 * A desk fixture's states with the calm glance (and the top bar's world) laid over them; `initial` the page's own state
 * at the start in place of the base fixture's, `assistant` another paired assistant.
 */
export function calmOver(
  base: string,
  note: string,
  calm: DeskCalm,
  more: {
    looks?: DeskLook[];
    desk?: Partial<DeskState>;
    online?: boolean;
    cable?: boolean;
    help?: RemoteHelp;
    initial?: DeskInitial;
    assistant?: { name: string; face: AgentFace };
  } & Partial<Omit<Fixture, 'desk'>> = {},
): Fixture {
  const f = DESK_FIXTURES[base];
  if (!f) throw new Error(`no desk fixture ${base}`);
  const { looks, desk, online, cable, help, initial, assistant, ...fixture } = more;
  return {
    ...f,
    wifi: CALM_WIFI(online ?? true, cable ?? false),
    ...fixture,
    ...(initial ? { desk: initial } : {}),
    note,
    timeline: f.timeline.map(({ at, state }) => ({
      at,
      state: (state.mode === 'console' && state.desk?.glance
        ? {
            ...state,
            now: NOW,
            desk: {
              ...state.desk,
              now: NOW,
              name: 'Home',
              ...(help ? { remoteHelp: help } : {}),
              ...(assistant && state.desk.paired ? { paired: { ...state.desk.paired, assistant } } : {}),
              ...desk,
              glance: {
                ...state.desk.glance,
                needsYou: { ...state.desk.glance.needsYou, ...(looks ? { looks } : {}) },
                done: [
                  { text: 'Renewed the certificate on pve-01', at: ago(150) },
                  { text: 'Cleaned 14 GB of old backups on blackbox', at: ago(300) },
                  { text: 'Answered 3 Acme Desk reports', at: ago(80) },
                ],
                calm,
              },
            },
          }
        : state) as ServerState,
    })),
  };
}

/* What the assistant found out (3.5, CG-372…CG-377; Whombat look-research.md, the mock's cards) ---------------- */

const HA_REASON = '2 integrations stopped loading';
const ZIGBEE: LookResearch = {
  state: 'found',
  title: 'Zigbee stopped working in Home Assistant',
  summary:
    'After this morning’s update, Zigbee didn’t start again, so the hallway lights and the motion sensors don’t respond. Restarting it usually fixes this.',
  fix: 'Restart Zigbee',
};
const ZIGBEE_FIXED: LookResearch = {
  state: 'fixed',
  title: 'Zigbee works again',
  summary: 'I restarted Zigbee; the hallway lights and sensors answer again.',
};
const haLook = (research: LookResearch, reason = HA_REASON): DeskLook => ({
  key: 'connection:con_ha',
  kind: 'connection',
  name: 'Home Assistant',
  state: 'look',
  reason,
  notice: { check: 'homeassistant.integration_failed', subject: 'zha' },
  nature: 'problem',
  ignoreWords: 'Until it changes.',
  research,
});
const HUE: LookResearch = {
  state: 'found',
  title: 'Home Assistant can’t reach the Hue bridge',
  summary:
    'The Hue bridge doesn’t answer, not to Home Assistant and not on the network, so the living-room and kitchen lights don’t respond. It probably lost power or its cable; check that it’s plugged in.',
};
const PLEX_SCAN: LookResearch = {
  state: 'found',
  title: 'A stuck Plex scan keeps the-falcon hot',
  summary:
    'Plex has been scanning the same folder since last night, so the-falcon’s processor stays at 95 % and it runs hot. Restarting Plex stops the scan.',
  fix: 'Restart Plex',
};
const DRAGON_LOOK: DeskLook = {
  key: 'server:the-falcon',
  kind: 'server',
  name: 'the-falcon',
  state: 'bad',
  reason: 'Running hot',
  server: 'the-falcon',
  notice: { check: 'server.temperature' },
  nature: 'problem',
  research: PLEX_SCAN,
};

/** The calm glance with a look's hero as the runtime sends it: the research's words as title and detail (cut to 200). */
function researched(look: DeskLook, since: number, more: Partial<DeskCalm> = {}): DeskCalm {
  const r = look.research;
  const stage = r?.state ?? 'looking';
  const found = stage !== 'looking' && r?.title;
  const detail =
    stage === 'looking'
      ? `I’m looking into it. So far: ${look.reason}.`
      : stage === 'fixing'
        ? 'I’m on it.'
        : (r?.summary?.slice(0, 200) ?? null);
  return {
    ...FINE,
    headline:
      stage === 'fixed'
        ? { tone: 'ok', text: 'All fine', more: null }
        : { tone: look.state === 'look' ? 'warn' : 'bad', text: '1 thing needs a look', more: null },
    clock: 'small',
    hero: {
      kind: 'look',
      tone: look.state === 'look' ? 'warn' : 'bad',
      title: found ? (r?.title ?? '') : `${look.name} needs a look`,
      detail,
      since: ago(since),
      ask: null,
      look: look.key,
      server: look.server ?? null,
      research: stage,
      fix: stage === 'found' ? (r?.fix ?? null) : null,
    },
    moments: [],
    ...more,
  };
}

const DRAGON_STRIP = {
  strip: [
    server('the-falcon', 'linux', 4, { state: 'warn', say: 'hot', spark: [] }),
    ...STRIP.filter((x) => x.id !== 'the-falcon'),
  ],
} satisfies Partial<DeskCalm>;
const DUSTY = { name: 'Dusty', face: 'dusty' } as const;
const LOOKING = haLook({ state: 'looking' });
const FOUND = haLook(ZIGBEE);
const FOUND_YOU = haLook(HUE, 'Hue bridge not answering');
const FIXING = haLook({ ...ZIGBEE, state: 'fixing', fix: undefined });
const FIXED = haLook(ZIGBEE_FIXED);
const NO_CARD: DeskInitial = {};
const card = (look: DeskLook, pin?: 'fix'): DeskInitial => ({
  overlay: { kind: 'look', key: look.key, ...(pin ? { pin } : {}) },
});

const RESEARCH_FIXTURES: Record<string, Fixture> = {
  'desk-calm-look-looking': calmOver(
    'desk-look-card',
    'Dusty looks first: the usual title, “I’m looking into it. So far: …” beside its face, Ignore (LR-09, LR-10)',
    researched(LOOKING, 3),
    { looks: [LOOKING], assistant: DUSTY, initial: NO_CARD },
  ),
  'desk-calm-look-found': calmOver(
    'desk-look-card',
    'Dusty can fix it: its title and summary, Restart Zigbee first, then Ignore (LR-07, LR-09)',
    researched(FOUND, 9),
    { looks: [FOUND], assistant: DUSTY, initial: NO_CARD },
  ),
  'desk-calm-look-found-server': calmOver(
    'desk-look-card',
    'A server Dusty can help: Restart Plex, Ignore, Open the-falcon (LR-09)',
    researched(DRAGON_LOOK, 22, DRAGON_STRIP),
    { looks: [DRAGON_LOOK], assistant: DUSTY, initial: NO_CARD },
  ),
  'desk-calm-look-found-you': calmOver(
    'desk-look-card',
    'Only you can fix it: no step, the summary says what to do, Ignore (LR-07)',
    researched(FOUND_YOU, 41),
    { looks: [FOUND_YOU], assistant: DUSTY, initial: NO_CARD },
  ),
  'desk-calm-look-fixing': calmOver(
    'desk-look-card',
    'After Restart Zigbee: “I’m on it.” while Dusty takes the step (LR-08, LR-09)',
    researched(FIXING, 10),
    { looks: [FIXING], assistant: DUSTY, initial: NO_CARD },
  ),
  'desk-calm-look-fixed': calmOver(
    'desk-look-card',
    'Fixed: Dusty’s title and summary in green, no buttons, until the look goes (LR-09)',
    researched(FIXED, 11),
    { looks: [FIXED], assistant: DUSTY, initial: NO_CARD },
  ),
  'desk-calm-look-locked': calmOver(
    'desk-looks-nothing',
    'Locked, Restart Zigbee touched: the PIN pad beside the look’s card; once unlocked Dusty takes it (PIN 123456)',
    researched(FOUND, 9),
    {
      looks: [FOUND],
      assistant: DUSTY,
      initial: card(FOUND, 'fix'),
      stepFixed: ZIGBEE_FIXED,
    },
  ),
  'desk-calm-look-live': calmOver(
    'desk-look-card',
    'Unlocked: press Restart Zigbee and the demo answers, “I’m on it.”, then fixed after 4 s (CG-376)',
    researched(FOUND, 9),
    { looks: [FOUND], assistant: DUSTY, initial: NO_CARD, stepFixed: ZIGBEE_FIXED },
  ),
  'desk-look-research-looking': calmOver(
    'desk-look-card',
    'The look’s card while Dusty looks: “I’m looking into it. So far: …”, Ignore and Not now (CG-375)',
    researched(LOOKING, 3),
    { looks: [LOOKING], assistant: DUSTY, initial: card(LOOKING) },
  ),
  'desk-look-research-found': calmOver(
    'desk-look-card',
    'The look’s card once Dusty found it: Restart Zigbee on its own row, then Ignore, Not now, Ask Dusty (CG-375)',
    researched(FOUND, 9),
    { looks: [FOUND], assistant: DUSTY, initial: card(FOUND), stepFixed: ZIGBEE_FIXED },
  ),
  'desk-look-research-found-server': calmOver(
    'desk-look-card',
    'A server’s card: Restart Plex, then Ignore, Not now, Ask Dusty and Open the-falcon (CG-375)',
    researched(DRAGON_LOOK, 22, DRAGON_STRIP),
    { looks: [DRAGON_LOOK], assistant: DUSTY, initial: card(DRAGON_LOOK) },
  ),
  'desk-look-research-found-you': calmOver(
    'desk-look-card',
    'Only you can fix it: no step; Ignore, Not now and Ask Dusty (CG-375)',
    researched(FOUND_YOU, 41),
    { looks: [FOUND_YOU], assistant: DUSTY, initial: card(FOUND_YOU) },
  ),
  'desk-look-research-fixing': calmOver(
    'desk-look-card',
    'The card while Dusty takes the step: “I’m on it.” and Close (CG-375)',
    researched(FIXING, 10),
    { looks: [FIXING], assistant: DUSTY, initial: card(FIXING) },
  ),
  'desk-look-research-fixed': calmOver(
    'desk-look-card',
    'The card once fixed: Dusty’s title, a green check and its summary, Close (CG-375)',
    researched(FIXED, 11),
    { looks: [FIXED], assistant: DUSTY, initial: card(FIXED) },
  ),
  'desk-look-research-not-allowed': calmOver(
    'desk-look-card',
    'Restart Zigbee by someone who doesn’t manage Home Assistant: the card says so in plain words (not_allowed)',
    researched(FOUND, 9),
    { looks: [FOUND], assistant: DUSTY, initial: card(FOUND), stepRefused: 'not_allowed' },
  ),
};

const HELP_ON: RemoteHelp = { level: 'look', until: null, connected: null } as RemoteHelp;
const HELP_LIVE: RemoteHelp = { level: 'look', until: null, connected: 'Whombat support' } as RemoteHelp;

export const CALM_FIXTURES: Record<string, Fixture> = {
  'desk-calm': calmOver(
    'desk-looks-nothing',
    'The calm glance: all fine, three things going on, the strip (DK-112, DK-115, DK-116)',
    FINE,
  ),
  'desk-calm-nothing': calmOver(
    'desk-looks-nothing',
    'All fine and nothing going on: the middle stays empty (DK-115)',
    NOTHING,
  ),
  'desk-calm-wrong': calmOver(
    'desk-looks-nothing',
    'Something wrong: pve-02 takes the middle, nas waits on a line, the edge (DK-113, DK-114); support connected (DK-111)',
    WRONG,
    { looks: [PVE02_DOWN, NAS_LOOK], help: HELP_LIVE },
  ),
  'desk-calm-wrong-unlocked': calmOver(
    'desk-look-card',
    'Unlocked: Ask Neo to fix it, Open pve-02, Not now on the hero (DK-113)',
    WRONG,
    { looks: [PVE02_DOWN, NAS_LOOK], desk: {} },
  ),
  'desk-calm-ask': calmOver('desk-looks-nothing', 'A question waits: the hero with Answer (DK-113)', ASK),
  'desk-calm-busy': calmOver(
    'desk-looks-nothing',
    'Neo at work: its card and the strip saying done, now, next (DK-115, DK-117)',
    BUSY,
    {
      help: HELP_ON,
    },
  ),
  'desk-calm-welcome': calmOver(
    'desk-looks-nothing',
    'Welcome back after 2 h 10 min: a question first, then what happened (DK-120)',
    WELCOME,
  ),
  'desk-calm-many': calmOver(
    'desk-looks-nothing',
    'Eight servers in the strip, an off one dimmed, “+4” (DK-116)',
    MANY,
  ),
  'desk-calm-offline': calmOver('desk-looks-nothing', 'No internet: the chip in amber (DK-110)', FINE, {
    online: false,
  }),
  'desk-calm-updating': calmOver(
    'desk-looks-nothing',
    'Whombat updating itself: the chip says so (DK-118)',
    { ...FINE, update: 'installing' },
    { cable: true },
  ),
  'desk-calm-battery': calmOver(
    'desk-looks-nothing',
    'A power cut: the battery chip in amber and the banner (DK-110)',
    FINE,
    {
      desk: {
        power: {
          source: 'battery',
          percent: 64,
          charging: false,
          minutesLeft: 160,
          chargeLimit: 80,
          since: ago(12),
        },
      },
    },
  ),
  'desk-calm-sample': calmOver(
    'desk-looks-nothing',
    'Try it on the screen: Something’s wrong with the banner (DK-124)',
    { ...WRONG, sample: { scenario: 'wrong', until: new Date(Date.parse(NOW) + 42_000).toISOString() } },
    { looks: [PVE02_DOWN, NAS_LOOK] },
  ),
  'desk-calm-found': calmOver(
    'desk-found-strip',
    'Found on your network beside the servers: its strip above theirs (DF-06)',
    { ...FINE, moments: FINE.moments.slice(0, 2) },
  ),
  'desk-calm-idle': calmOver('desk-looks-idle', 'Nobody there: the calm glance dimmed (DK-97)', FINE),
  ...RESEARCH_FIXTURES,
};
