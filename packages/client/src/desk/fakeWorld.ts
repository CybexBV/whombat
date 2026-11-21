/**
 * What a fake box has to show on its screen (3.2; Whombat desk-display.md DK-106, DK-123): the mockups' world — eight
 * servers, a few connections with something going on, a Home widget — for Settings → Screen's lists and preview in the
 * web's fixture mode, the managed fake world, the phone's demo world and tests. The preview is core's own planner
 * (`deskCalmFor`), so the fake decides as the box does; *Something’s wrong* shows the down server as one the assistant
 * looked into, with the step it offers (look-research.md LR-09; app look-research-web.md AP-5907), until the planner's
 * own preview does.
 */
import {
  DESK_CALM_WORDS,
  type DeskCalm,
  type DeskCalmInput,
  type DeskPreview,
  type DeskPreviewScenario,
  type DeskShow,
  type DeskShowOption,
  deskCalmFor,
  deskPreviewInput,
} from './contract';

export interface FakeDeskWorld {
  /** The org's name: the top bar's name until the app gives the Whombat's (`desk.setName`). */
  burrow: string;
  assistant: string;
  timeZone: string;
  servers: (DeskCalmInput['servers'][number] & { id: string; line: string })[];
  connections: (DeskCalmInput['activities'][number] & { line: string })[];
  widgets: DeskCalmInput['figures'];
  coming: DeskCalmInput['coming'];
  services: number;
  doneCount: number;
}

const spark = (seed: number) =>
  Array.from({ length: 30 }, (_, i) => Math.round(12 + 8 * Math.sin((i + seed) / 3) + ((i * seed) % 5)));

/** The mockups' world (`docs/design/desk-calm/` in the appliance). */
export function defaultFakeDeskWorld(): FakeDeskWorld {
  const server = (id: string, mark: string, line: string, seed: number, more = {}) => ({
    id,
    name: id,
    mark,
    state: 'ok' as const,
    line,
    cpu: 10 + seed,
    memory: 40 + seed,
    disk: 30 + seed,
    spark: spark(seed),
    ...more,
  });
  return {
    burrow: 'Lumio BV',
    assistant: 'Neo',
    timeZone: 'Europe/Amsterdam',
    servers: [
      server('pve-01', 'proxmox', 'Proxmox · 16 cores', 1),
      server('pve-02', 'proxmox', 'Proxmox · 8 cores', 2),
      server('blackbox', 'synology', 'Synology DS1821+', 3),
      server('the-falcon', 'linux', 'Linux · 24 cores', 4),
      server('nas', 'synology', 'Synology DS923+', 5),
      server('media', 'ubuntu', 'Ubuntu · 8 cores', 6),
      server('pi-hole', 'raspberrypi', 'Raspberry Pi', 7),
      server('backup-box', 'debian', 'Debian · usually off', 8, { state: 'off', spark: undefined }),
    ],
    connections: [
      {
        key: 'connection:con_plex',
        name: 'Plex',
        mark: 'plex',
        line: 'Who’s watching',
        value: '2 watching',
        detail: 'Dune: Part Two · The Bear',
        active: true,
      },
      {
        key: 'connection:con_sab',
        name: 'Downloads',
        mark: 'sabnzbd',
        line: 'The queue and time left',
        value: '3 left · 20 min',
        progress: 62,
        active: true,
      },
      {
        key: 'connection:con_seerr',
        name: 'Seerr',
        mark: 'overseerr',
        line: 'New requests',
        value: 'No new requests',
        active: false,
      },
    ],
    widgets: [
      {
        key: 'widget:wdg_living',
        name: 'Living room',
        mark: 'homeassistant',
        value: '21.4 °C',
        active: false,
      },
    ],
    coming: [],
    services: 14,
    doneCount: 3,
  };
}

/** Settings → Screen's lists (`DeskScreen.showOptions`, DK-106): the servers in the strip's order. */
export function fakeDeskShowOptions(world: FakeDeskWorld, show: DeskShow): DeskShowOption[] {
  const place = new Map(show.order.map((id, i) => [id, i]));
  const servers = world.servers
    .map((s, i) => ({ s, i }))
    .sort(
      (a, b) =>
        (place.get(a.s.id) ?? Number.MAX_SAFE_INTEGER) - (place.get(b.s.id) ?? Number.MAX_SAFE_INTEGER) ||
        a.i - b.i,
    )
    .map(({ s }) => s);
  return [
    { key: 'work', group: 'assistant', name: `${world.assistant}’s work`, line: '', activity: true },
    { key: 'coming', group: 'assistant', name: 'Coming up', line: '', activity: true },
    ...world.connections.map((c) => ({
      key: c.key,
      group: 'connection' as const,
      name: c.name,
      line: c.line,
      ...(c.mark ? { mark: c.mark } : {}),
      activity: true,
    })),
    ...world.widgets.map((w) => ({
      key: w.key,
      group: 'widget' as const,
      name: w.name,
      line: w.value,
      ...(w.mark ? { mark: w.mark } : {}),
      activity: false,
    })),
    ...servers.map((s) => ({
      key: `server:${s.id}`,
      group: 'server' as const,
      name: s.name,
      line: s.line,
      mark: s.mark,
      activity: false,
    })),
    { key: 'box', group: 'box', name: 'This Whombat', line: '', activity: false },
  ];
}

/** What the fake box's calm planner reads for `scenario` at `now` (the preview's, a screen's widgets'). */
export function fakeDeskCalmInput(
  world: FakeDeskWorld,
  show: DeskShow,
  scenario: DeskPreviewScenario,
  now: Date,
): DeskCalmInput {
  const input: DeskCalmInput = {
    assistant: world.assistant,
    now,
    timeZone: world.timeZone,
    asks: [],
    askCount: 0,
    looks: [],
    work: null,
    servers: world.servers,
    activities: world.connections,
    figures: world.widgets,
    coming: world.coming,
    services: world.services,
    doneCount: world.doneCount,
  };
  return deskPreviewInput(input, show, scenario, DESK_CALM_WORDS);
}

/** Settings' preview of the fake world (DK-123): unlocked, at `now`. */
export function fakeDeskPreview(
  world: FakeDeskWorld,
  show: DeskShow,
  scenario: DeskPreviewScenario,
  name: string | null,
  now: Date,
): DeskPreview {
  const calm = deskCalmFor(fakeDeskCalmInput(world, show, scenario, now), show, 'everything');
  return { name: name ?? world.burrow, calm: scenario === 'wrong' ? researched(calm) : calm };
}

/** The calm glance as the fake box's screens show it: the down server researched, as the preview's. */
export function fakeDeskCalm(
  world: FakeDeskWorld,
  show: DeskShow,
  scenario: DeskPreviewScenario,
  now: Date,
): DeskCalm {
  const calm = deskCalmFor(fakeDeskCalmInput(world, show, scenario, now), show, 'everything');
  return scenario === 'wrong' ? researched(calm) : calm;
}

/** The down server's hero as the assistant reports it once it found out, with the one step it offers. */
function researched(calm: DeskCalm): DeskCalm {
  const hero = calm.hero;
  if (hero?.kind !== 'look' || hero.research) return calm;
  const name = (hero.server ? calm.strip.find((s) => s.id === hero.server)?.name : undefined) ?? 'It';
  return {
    ...calm,
    hero: {
      ...hero,
      title: `${name} froze during its update`,
      detail:
        'It stopped answering while it installed this morning’s updates, so what runs on it is down too. Starting it again usually fixes this.',
      research: 'found',
      fix: `Restart ${name}`.slice(0, 32),
    },
  };
}
