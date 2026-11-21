import { describe, expect, it } from 'vitest';
import type { ConsoleState } from './api';
import type { DeskAsk, DeskGlance, DeskState } from './desk';
import { DESK_WORDS } from './deskCopy';
import {
  DESK_HOLD_MS,
  heldDesk,
  holdDesk,
  lockedDesk,
  NO_HOLD,
  shownDesk,
  trimGlance,
  unlockLapsed,
} from './deskHold';

const ask: DeskAsk = {
  number: 41,
  kind: 'approval',
  title: 'Restart Plex on blackbox?',
  at: '2026-10-20T12:31:00Z',
  where: 'blackbox',
  detail: 'Plex stopped answering.',
  facts: ['docker restart plex'],
  approveLabel: 'Restart Plex',
  onDesk: true,
  phoneReason: null,
};

const glance: DeskGlance = {
  status: {
    text: 'Everything’s fine. I’m updating your server agents.',
    more: 'Plex on blackbox needs a decision.',
  },
  needsYou: { count: 2, items: [ask, { ...ask, number: 42 }] },
  working: { title: 'Update the server agents', steps: [] },
  done: [{ text: 'Renewed the certificate', at: '2026-10-20T07:12:00Z' }],
  servers: [{ name: 'pve-02', mark: 'proxmox', state: 'bad', note: '', cpu: null, memory: null, temp: null }],
  moreServers: 0,
  tiles: [{ icon: 'temperature', mark: null, value: '21 °C', label: 'Office', tone: null }],
  box: null,
};

const desk = (
  p: Partial<DeskState> = {},
  lockedView: 'time' | 'summary' | 'everything' = 'summary',
): DeskState => ({
  now: '2026-10-20T12:34:00Z',
  paired: {
    person: { name: 'John', initial: 'J', tone: 3 },
    hasPin: true,
    assistant: { name: 'Neo', face: 'neo' },
    burrow: null,
    timeZone: 'UTC',
    lockedView,
    night: 'dim',
    quiet: false,
    voice: true,
  },
  pairing: null,
  lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z', retryAt: null, expiresAt: null },
  glance,
  power: null,
  talk: {
    id: 'talk-0001',
    state: 'thinking',
    question: 'Is pve-02 okay?',
    answer: null,
    thing: null,
    audio: false,
    reason: null,
  },
  ...p,
});

const state = (d: DeskState | null, claim: 'claimed' | 'claimable' = 'claimed'): ConsoleState => ({
  mode: 'console',
  now: '',
  footer: '',
  claim: {
    state: claim,
    code: '',
    claimUrl: '',
    appUrl: '',
    retryAt: null,
    burrows: { first: 'Lumio BV', more: 0 },
  },
  desk: d,
});

/** Polls `states` at `times` (page ms) and returns what each one shows. */
function run(steps: [number, ConsoleState][]) {
  let h = NO_HOLD;
  return steps.map(([t, s]) => {
    h = holdDesk(h, s, t);
    return shownDesk(h, s, t);
  });
}

describe('the desk through a runtime restart (CG-49)', () => {
  it('shows Whombat’s desk while it sends one', () => {
    const d = desk();
    expect(run([[0, state(d)]])[0]).toEqual({ desk: d, held: false, reconnecting: false });
  });

  it('keeps the last paired desk, locked, then says Reconnecting… after 10 s', () => {
    const [, soon, later] = run([
      [0, state(desk())],
      [1_000, state(null)],
      [12_000, state(null)],
    ]);
    expect(soon?.held).toBe(true);
    expect(soon?.desk?.lock.state).toBe('locked');
    expect(soon?.desk?.talk).toBeNull();
    expect(soon?.reconnecting).toBe(false);
    expect(later?.reconnecting).toBe(true);
  });

  it('falls back to today’s console after 10 minutes', () => {
    const out = run([
      [0, state(desk())],
      [1_000, state(null)],
      [1_000 + DESK_HOLD_MS - 1, state(null)],
      [1_000 + DESK_HOLD_MS, state(null)],
    ]);
    expect(out[2]?.held).toBe(true);
    expect(out[3]).toEqual({ desk: null, held: false, reconnecting: false });
  });

  it('falls back at once when the box isn’t claimed, or when Whombat says nobody is paired', () => {
    expect(
      run([
        [0, state(desk())],
        [1_000, state(null, 'claimable')],
      ])[1]?.desk,
    ).toBeNull();
    const unpaired = run([
      [0, state(desk())],
      [1_000, state(desk({ paired: null, glance: null, talk: null }))],
      [2_000, state(null)],
    ]);
    expect(unpaired[2]?.desk).toBeNull();
  });

  it('never holds a desk it never showed, and starts the 10 minutes again after Whombat is back', () => {
    expect(run([[0, state(null)]])[0]?.desk).toBeNull();
    const out = run([
      [0, state(desk())],
      [1_000, state(null)],
      [DESK_HOLD_MS - 1_000, state(desk())],
      [DESK_HOLD_MS, state(null)],
      [DESK_HOLD_MS + 5_000, state(null)],
    ]);
    expect(out[4]?.held).toBe(true);
  });

  it('shows no camera through a restart: Whombat runs it and isn’t there (CG-173)', () => {
    const presence = { camera: true, watching: true, here: true };
    const d = desk({ presence, lock: { ...desk().lock, stays: true } });
    const [, held] = run([
      [0, state(d)],
      [1_000, state(null)],
    ]);
    expect(held?.held).toBe(true);
    expect(held?.desk?.presence).toBeUndefined();
    expect(held?.desk?.lock).toMatchObject({ state: 'locked' });
    expect(held?.desk?.lock.stays).toBeUndefined();
    expect(heldDesk(d).presence).toBeUndefined();
    // Locked for an unlock that ran out between two polls, Whombat still there: the camera as it said (no flicker).
    expect(lockedDesk(d).presence).toEqual(presence);
  });
});

describe('lockedDesk', () => {
  it('trims a glance seen unlocked to the lock view, and keeps the night as it was', () => {
    const d = desk();
    const summary = lockedDesk(d.paired ? { ...d, paired: { ...d.paired, quiet: true } } : d);
    expect(summary.paired?.quiet).toBe(true);
    expect(summary.glance?.needsYou).toEqual({ count: 2, items: [] });
    expect(summary.glance?.working).toBeNull();
    expect(summary.glance?.done).toEqual([]);
    expect(summary.glance?.status.text).toContain('pve-02');
    expect(summary.glance?.status.text).toContain('2 things');
    expect(summary.glance?.status.more).toBeNull();
    expect(summary.glance?.servers).toHaveLength(1);
  });

  it('keeps titles but no ask words for “Everything”, only the line for “Only the time”', () => {
    const all = lockedDesk(desk({}, 'everything')).glance;
    expect(all?.needsYou.items[0]?.title).toBe(ask.title);
    expect(all?.needsYou.items[0]?.detail).toBeNull();
    expect(all?.needsYou.items[0]?.approveLabel).toBeNull();
    const time = lockedDesk(desk({}, 'time')).glance;
    expect(time?.servers).toEqual([]);
    expect(time?.tiles).toEqual([]);
    expect(time?.status.text).toBe('Something needs you.');
  });

  it('keeps a glance Whombat sent locked as it was', () => {
    const lockedGlance = trimGlance(glance, 'summary');
    const d = desk({
      lock: { state: 'locked', until: null, retryAt: null, expiresAt: null },
      glance: lockedGlance,
    });
    expect(lockedDesk(d).glance).toBe(lockedGlance);
  });

  it('keeps a new box’s figures and its ready line in “A summary”, not in “Only the time” (DK-22, DK-23)', () => {
    const box = {
      up: 'up 12 min',
      cpu: { percent: 7, cores: 16, tone: 'ok' },
      memory: { percent: 18, used: { value: '11.2', unit: 'GB' }, total: '64 GB', tone: 'ok' },
      history: { stepS: 60, cpu: [7], memory: [18] },
      storage: { percent: 13, free: { value: '812', unit: 'GB' }, total: '937 GB', tone: 'ok', parts: [] },
      temp: null,
      network: null,
    } as const;
    const fresh: DeskGlance = {
      ...glance,
      status: { text: 'All fine. I’m ready when you are.', more: null },
      needsYou: { count: 0, items: [] },
      working: null,
      servers: [],
      tiles: [],
      box: {
        ...box,
        history: { ...box.history, cpu: [7], memory: [18] },
        storage: { ...box.storage, parts: [] },
      },
    };
    const summary = trimGlance(fresh, 'summary');
    expect(summary.box?.up).toBe('up 12 min');
    expect(summary.status.text).toBe(DESK_WORDS.status.ready);
    expect(summary.status.more).toBe(DESK_WORDS.status.connectHint);
    const time = trimGlance(fresh, 'time');
    expect(time.box).toBeNull();
    expect(time.status).toEqual({ text: 'All fine.', more: null });
    // Something to work on: the line is the counts' again.
    expect(
      trimGlance({ ...fresh, working: { title: 'Connect pve-01', steps: [] } }, 'summary').status.more,
    ).toBeNull();
  });

  it('keeps This Whombat beside servers and the next four in “A summary”, none in “Only the time” (DK-39)', () => {
    const server = glance.servers[0];
    const tile = glance.tiles[0];
    if (!server || !tile) throw new Error('fixture');
    const four: DeskGlance = {
      ...glance,
      servers: [server, server, server, server],
      extraServers: [server],
      moreServers: 1,
      tiles: [tile, tile, tile, tile],
      extraTiles: [tile, tile],
      self: {
        up: 'up 2 h',
        cpu: { percent: 7, cores: 16, tone: 'ok' },
        memory: { percent: 18, used: { value: '11.2', unit: 'GB' }, total: '64 GB', tone: 'ok' },
        history: { stepS: 60, cpu: [], memory: [] },
        storage: { percent: 13, free: { value: '812', unit: 'GB' }, total: '937 GB', tone: 'ok', parts: [] },
        temp: null,
        network: null,
      },
    };
    const summary = trimGlance(four, 'summary');
    expect(summary.self?.up).toBe('up 2 h');
    expect(summary.extraServers).toHaveLength(1);
    expect(summary.extraTiles).toHaveLength(2);
    const time = trimGlance(four, 'time');
    expect(time.self ?? null).toBeNull();
    expect(time.extraServers ?? []).toEqual([]);
    expect(time.extraTiles ?? []).toEqual([]);
  });

  it('keeps Found on your network in “A summary” and “Everything”, never in “Only the time” (DF-06, DF-11)', () => {
    const found: DeskGlance = {
      ...glance,
      found: {
        scanning: false,
        progress: null,
        items: [
          { catalogId: 'plex', name: 'Plex', tagline: 'Films, series and music', address: '10.100.0.20' },
        ],
        count: 1,
        finishedAt: '2026-10-20T12:30:00Z',
      },
    };
    expect(trimGlance(found, 'summary').found?.items[0]?.name).toBe('Plex');
    expect(trimGlance(found, 'everything').found?.count).toBe(1);
    expect(trimGlance(found, 'time').found ?? null).toBeNull();
  });

  it('says everything is fine when nothing needs the person', () => {
    const calm = { ...glance, needsYou: { count: 0, items: [] }, servers: [] };
    expect(trimGlance(calm, 'summary').status.text).toBe('Everything’s fine.');
    expect(trimGlance(calm, 'time').status.text).toBe('All fine.');
  });
});

describe('an unlock the page can’t vouch for (CG-51)', () => {
  const sent = desk();
  const at = Date.parse('2026-10-20T12:34:00Z');

  it('is one the polls stopped confirming, or whose time ran out by Whombat’s clock', () => {
    expect(unlockLapsed(sent.lock, at, false)).toBe(false);
    expect(unlockLapsed(sent.lock, at, true)).toBe(true);
    expect(unlockLapsed(sent.lock, Date.parse('2026-10-20T12:36:00Z'), false)).toBe(true);
    expect(unlockLapsed({ ...sent.lock, until: null }, at, false)).toBe(true);
  });

  it('never touches a desk Whombat sent locked', () => {
    const locked = { state: 'locked', until: null, retryAt: null, expiresAt: null } as const;
    expect(unlockLapsed(locked, at, true)).toBe(false);
    expect(unlockLapsed({ ...locked, state: 'phone' }, at, true)).toBe(false);
  });

  it('is then shown as the locked screen shows it: no ask words, no talk', () => {
    const shown = lockedDesk(desk({}, 'summary'));
    expect(shown.lock.state).toBe('locked');
    expect(shown.talk).toBeNull();
    expect(shown.glance?.needsYou.items).toEqual([]);
    expect(JSON.stringify(shown)).not.toContain('Plex stopped answering');
  });
});
