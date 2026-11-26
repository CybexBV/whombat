/**
 * The screen of widgets' fixtures (Whombat desk-display.md “Screens of widgets”, mockups `docs/design/desk-widgets/`):
 * the calm glance's fixtures with the box's grid laid over them (`glance.grid`), and a monitor beside the Z13
 * (`glance.outputs` and the kiosk's outputs). The world is `@whombat/screen`'s fixtures (the mockups'): three pages, a
 * server, Home Assistant, UniFi, Plex, SABnzbd, Seerr, the backups, the outage and the question, pages by time of day
 * and the doorbell taking over the screen. `desk-grid-*`.
 */
import type { DeskGrid, DeskWidget } from '@whombat/screen';
import {
  FIXTURE_BOX_GRID,
  FIXTURE_BOX_GRID_WRONG,
  FIXTURE_DOORBELL_GRID,
  FIXTURE_DOORBELL_GRID_LOCKED,
  FIXTURE_MONITOR_GRID,
} from '@whombat/screen/fixtures';
import { lockedGrid } from '../lib/grid';
import type { KioskOutput } from '../lib/outputs';
import { calmOver, FINE, NAS_LOOK, NOW, PVE02_DOWN, WELCOME, WRONG } from './calmFixtures';
import type { Fixture } from './fixtures';

const w = (
  id: string,
  type: DeskWidget['type'],
  x: number,
  y: number,
  ww: number,
  h: number,
): DeskWidget => ({
  id,
  type,
  opts: {},
  x,
  y,
  w: ww,
  h,
});

/** A screen nobody arranged: the calm glance as widgets (core's `deskDefaultLayout`). */
const DEFAULT: DeskGrid = {
  screen: 'box',
  layout: {
    pages: [
      {
        id: 'p_first',
        name: 'Overview',
        layouts: {
          '8x5': [
            w('w_clock', 'clock', 0, 0, 4, 2),
            w('w_status', 'status', 4, 0, 4, 2),
            w('w_now', 'now', 0, 2, 8, 2),
            w('w_strip', 'strip', 0, 4, 8, 1),
          ],
        },
        last: '8x5',
      },
    ],
    turn: 'touch',
    size: 'normal',
  },
  views: [],
  attention: { items: [], more: 0 },
  popups: 'all',
};

/** The Z13 with a 24″ monitor to its right, as the kiosk names them. */
const Z13_AND_MONITOR: KioskOutput[] = [
  { name: 'eDP-1', model: null, x: 0, y: 0, width: 2560, height: 1600, mmWidth: 286, mmHeight: 179 },
  {
    name: 'HDMI-A-2',
    model: 'DELL U2422H',
    x: 2560,
    y: 0,
    width: 1920,
    height: 1080,
    mmWidth: 527,
    mmHeight: 296,
  },
];

/** A calm fixture with the box's grid, and the monitors' (`outputs`), in its glance. */
function gridOver(
  f: Fixture,
  box: DeskGrid,
  outputs: { key: string; name: string; grid: DeskGrid }[] = [],
): Fixture {
  return {
    ...f,
    timeline: f.timeline.map(({ at, state }) => ({
      at,
      state:
        state.mode === 'console' && state.desk?.glance
          ? { ...state, desk: { ...state.desk, glance: { ...state.desk.glance, grid: box, outputs } } }
          : state,
    })),
  };
}

const MONITOR = [{ key: 'hdmi-a-2', name: 'DELL U2422H', grid: FIXTURE_MONITOR_GRID }];

/**
 * The box's grid with one question in the modal: the desk fixtures' Plex restart (number 41), as the runtime names it —
 * its title unlocked, “Dusty has a question” locked (DK-151, CG-397).
 */
const questionGrid = (title: string): DeskGrid => ({
  ...FIXTURE_BOX_GRID,
  attention: {
    items: [
      {
        key: 'ask:41',
        kind: 'ask',
        tone: 'bad',
        pops: true,
        title,
        name: 'Dusty',
        since: '2026-10-27T13:33:00Z',
        ask: 41,
      },
    ],
    more: 0,
    tone: 'bad',
  },
});

/**
 * The box's three pages with times, at the calm fixtures' Wednesday 14:34 in Amsterdam: Media only on Wednesday
 * afternoons (open now, so the screen starts there), House only at night (closed, so the top bar leaves it out).
 */
const TIMED: DeskGrid = {
  ...FIXTURE_BOX_GRID,
  layout: {
    ...FIXTURE_BOX_GRID.layout,
    pages: FIXTURE_BOX_GRID.layout.pages.map((p) =>
      p.id === 'p_media'
        ? { ...p, show: { from: '14:00', to: '16:00', days: ['wed'] } }
        : p.id === 'p_house'
          ? { ...p, show: { from: '22:00', to: '07:00' } }
          : p,
    ),
  },
};

/** The doorbell's moment, 40 seconds of its minute left at the calm fixtures' now. */
const ringing = (g: DeskGrid): DeskGrid =>
  g.spotlight
    ? { ...g, spotlight: { ...g.spotlight, until: new Date(Date.parse(NOW) + 40_000).toISOString() } }
    : g;

/** Unlocked for two more minutes at the calm fixtures' now. */
const UNLOCKED = {
  lock: {
    state: 'unlocked' as const,
    until: new Date(Date.parse(NOW) + 120_000).toISOString(),
    retryAt: null,
    expiresAt: null,
  },
};

export const SCREEN_FIXTURES: Record<string, Fixture> = {
  'desk-grid': gridOver(
    calmOver('desk-looks-nothing', 'A screen nobody arranged: the calm glance as widgets (DK-127)', FINE),
    DEFAULT,
  ),
  'desk-grid-overview': gridOver(
    calmOver('desk-looks-nothing', 'The box’s three pages; the overview, locked (DK-126, DK-133)', FINE),
    FIXTURE_BOX_GRID,
  ),
  'desk-grid-media': gridOver(
    calmOver(
      'desk-looks-nothing',
      'The Media page, touched: now playing, the queue, requests, the backups',
      FINE,
    ),
    FIXTURE_BOX_GRID,
  ),
  'desk-grid-problem': gridOver(
    calmOver(
      'desk-looks-nothing',
      'pve-02 down and a question, locked: the modal says the PIN comes first (DK-135, DK-138)',
      WRONG,
      { looks: [PVE02_DOWN, NAS_LOOK] },
    ),
    FIXTURE_BOX_GRID_WRONG,
  ),
  'desk-grid-problem-unlocked': gridOver(
    calmOver(
      'desk-look-card',
      'Unlocked: Ask Dusty to fix it, Open pve-02, Not now; “1 of 2” (DK-135)',
      WRONG,
      { looks: [PVE02_DOWN, NAS_LOOK], initial: {}, assistant: { name: 'Dusty', face: 'dusty' } },
    ),
    FIXTURE_BOX_GRID_WRONG,
  ),
  'desk-grid-question': gridOver(
    calmOver(
      'desk-ask',
      'A question in the modal, unlocked: its words and its own answers — Restart Plex, Deny, Ask, Not now (DK-151)',
      FINE,
      {
        initial: {},
        assistant: { name: 'Dusty', face: 'dusty' },
        // Unlocked for two more minutes at the calm fixtures' now.
        desk: { lock: { state: 'unlocked', until: '2026-10-21T12:36:20Z', retryAt: null, expiresAt: null } },
      },
    ),
    questionGrid('Restart Plex on blackbox?'),
  ),
  'desk-grid-question-locked': gridOver(
    calmOver(
      'desk-ask-locked',
      'A question in the modal, locked: no words, no answers, only Unlock (DK-151, CG-50)',
      FINE,
      { initial: {}, assistant: { name: 'Dusty', face: 'dusty' } },
    ),
    questionGrid('Dusty has a question'),
  ),
  'desk-grid-summary': gridOver(
    calmOver(
      'desk-looks-nothing',
      'Whombat away with the screen unlocked a moment ago: A summary as the page shows it itself',
      FINE,
    ),
    lockedGrid(FIXTURE_BOX_GRID, 'summary', 'Dusty has a question') ?? FIXTURE_BOX_GRID,
  ),
  'desk-grid-times': gridOver(
    calmOver(
      'desk-looks-nothing',
      'Pages by time of day: Media’s window is open so the screen starts there; House waits for the night',
      FINE,
    ),
    TIMED,
  ),
  'desk-grid-doorbell': gridOver(
    calmOver(
      'desk-looks-nothing',
      'The doorbell rang: its camera big for a minute, with Back; 40 seconds left',
      FINE,
      { desk: UNLOCKED },
    ),
    ringing(FIXTURE_DOORBELL_GRID),
  ),
  'desk-grid-doorbell-locked': gridOver(
    calmOver(
      'desk-looks-nothing',
      'The doorbell rang on a locked screen: the moment shows, the camera’s picture doesn’t',
      FINE,
    ),
    ringing(FIXTURE_DOORBELL_GRID_LOCKED),
  ),
  'desk-grid-welcome': gridOver(
    calmOver(
      'desk-looks-nothing',
      'Welcome back over the grid, as the calm glance had it, until it was seen (DK-120)',
      WELCOME,
    ),
    FIXTURE_BOX_GRID,
  ),
  'desk-grid-found': gridOver(
    calmOver(
      'desk-found-strip',
      'Found on your network: its strip over the grid’s bottom, with Not now (DF-06)',
      FINE,
    ),
    FIXTURE_BOX_GRID,
  ),
  'desk-grid-monitor': {
    ...gridOver(
      calmOver('desk-looks-nothing', 'A 24″ monitor beside the Z13: its own screen at 12 × 7 (DK-147)', FINE),
      FIXTURE_BOX_GRID,
      MONITOR,
    ),
    outputs: Z13_AND_MONITOR,
  },
  'desk-grid-monitor-problem': {
    ...gridOver(
      calmOver(
        'desk-looks-nothing',
        'pve-02 down: the monitor’s modal says where to answer (DK-138, DK-147)',
        WRONG,
        {
          looks: [PVE02_DOWN, NAS_LOOK],
        },
      ),
      FIXTURE_BOX_GRID_WRONG,
      [
        {
          key: 'hdmi-a-2',
          name: 'DELL U2422H',
          grid: { ...FIXTURE_MONITOR_GRID, attention: FIXTURE_BOX_GRID_WRONG.attention },
        },
      ],
    ),
    outputs: Z13_AND_MONITOR,
  },
  'desk-grid-monitor-unknown': {
    ...gridOver(
      calmOver(
        'desk-looks-nothing',
        'A monitor the runtime doesn’t know yet: the time on it until it does',
        FINE,
      ),
      FIXTURE_BOX_GRID,
    ),
    outputs: Z13_AND_MONITOR,
  },
};
