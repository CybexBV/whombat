/**
 * A thing held quiet as a whole (monitoring.md MON-04, MON-07): which window holds when, a cause the job stopped
 * keeping current, and `applyQuiet` with either — every line quiet, nothing counted, the counts forgotten — and the
 * words a page and a cause's item say.
 */
import { describe, expect, it } from 'vitest';
import { applyQuiet, type QuietRow, type StateRow } from './apply';
import {
  activeWindow,
  CAUSE_FRESH_MS,
  type CauseLike,
  holdOf,
  isHeldRow,
  keptQuiet,
  keptWords,
  takenFrom,
  takenWords,
  thingCause,
  type WindowLike,
} from './windows';

const now = new Date('2026-11-24T20:00:00Z');
const min = (n: number) => new Date(now.getTime() + n * 60_000);

const window = (over: Partial<WindowLike> = {}): WindowLike => ({
  id: 'qw_1',
  startsAt: min(-10),
  endsAt: min(180),
  endedAt: null,
  note: null,
  byId: 'prn_mara',
  work: null,
  guestId: null,
  ...over,
});

const cause = (over: Partial<CauseLike> = {}): CauseLike => ({
  causeThing: 'server:pve-02',
  causeName: 'pve-02',
  words: 'while pve-02 is down',
  since: min(-5),
  checkedAt: min(-1),
  ...over,
});

const down = {
  check: 'conn.answers',
  tone: 'bad' as const,
  title: 'It doesn’t answer',
  nature: 'problem' as const,
};
const disk = {
  check: 'machine.disk',
  tone: 'warn' as const,
  title: 'Disk 91 % full',
  nature: 'problem' as const,
  confirm: 2 as const,
};
const seen = (check: string, passes: number): StateRow => ({
  checkId: check,
  subject: '',
  firstSeen: min(-30),
  lastSeen: min(-5),
  seenPasses: passes,
  tone: 'bad',
});

describe('which window holds', () => {
  it('holds from its start until its end, not once ended early, not one over a single machine', () => {
    expect(activeWindow([window()], now)?.id).toBe('qw_1');
    expect(activeWindow([window({ startsAt: min(5) })], now)).toBeNull();
    expect(activeWindow([window({ endsAt: now })], now)).toBeNull();
    expect(activeWindow([window({ endedAt: min(-1) })], now)).toBeNull();
    expect(activeWindow([window({ guestId: 'pve:131' })], now)).toBeNull();
    expect(activeWindow([window(), window({ id: 'qw_2', endsAt: min(600) })], now)?.id).toBe('qw_2');
  });

  it('a window comes before a cause; a cause the job stopped keeping current ends by itself', () => {
    expect(holdOf({ windows: [window()], cause: cause() }, now)?.kind).toBe('window');
    expect(holdOf({ cause: cause() }, now)).toMatchObject({ kind: 'cause', words: 'while pve-02 is down' });
    const stale = cause({ checkedAt: new Date(now.getTime() - CAUSE_FRESH_MS - 1) });
    expect(holdOf({ cause: stale }, now)).toBeNull();
    expect(holdOf({}, now)).toBeNull();
  });
});

describe('applyQuiet while the thing is held', () => {
  it('a window keeps every line quiet, colours nothing and forgets what the pass counted', () => {
    const r = applyQuiet({
      lines: [down, disk],
      quiets: [] as QuietRow[],
      offs: [],
      states: [seen('conn.answers', 3), seen('machine.disk', 1)],
      now,
      pass: true,
      windows: [window()],
    });
    expect(r.active).toEqual([]);
    expect(r.status).toBe('ok');
    expect(r.worst).toBeNull();
    expect(r.quiet.map((q) => q.line.check)).toEqual(['conn.answers', 'machine.disk']);
    expect(r.quiet.map((q) => [isHeldRow(q.row), q.row.state, q.row.until])).toEqual([
      [true, 'snoozed', min(180)],
      [true, 'snoozed', min(180)],
    ]);
    expect(r.states).toEqual([]);
    expect(r.gone.map((g) => g.checkId).sort()).toEqual(['conn.answers', 'machine.disk']);
    expect(r.held?.kind).toBe('window');
  });

  it('a cause keeps them quiet as ignored with its words', () => {
    const r = applyQuiet({
      lines: [down],
      quiets: [],
      offs: [],
      states: [],
      now,
      pass: false,
      cause: cause(),
    });
    expect(r.status).toBe('ok');
    expect(r.quiet[0]?.row).toMatchObject({ state: 'ignored', words: 'while pve-02 is down', held: 'cause' });
  });

  it('once it ends, what is still wrong counts again from the start', () => {
    const over = window({ endsAt: min(-1) });
    const first = applyQuiet({
      lines: [down, disk],
      quiets: [],
      offs: [],
      states: [],
      now,
      pass: true,
      windows: [over],
    });
    expect(first.held).toBeNull();
    expect(first.status).toBe('bad');
    // The disk line waits for its second pass, as a new line does.
    expect(first.asking.map((l) => l.check)).toEqual(['conn.answers']);
    expect(first.states.map((s) => [s.checkId, s.seenPasses])).toEqual([
      ['conn.answers', 1],
      ['machine.disk', 1],
    ]);
  });

  it('a line ignored on its own keeps its own row under a window', () => {
    const row = {
      checkId: 'conn.answers',
      subject: '',
      state: 'ignored' as const,
      lifts: 'fixed' as const,
      episode: null,
      tone: 'bad' as const,
      band: null,
      until: null,
      clearPasses: 0,
      title: 'It doesn’t answer',
      subjectName: null,
      words: 'Until it’s back online.',
      byId: 'prn_mara',
      at: min(-60),
    };
    const r = applyQuiet({
      lines: [down],
      quiets: [row],
      offs: [],
      states: [],
      now,
      pass: false,
      windows: [window()],
    });
    expect(isHeldRow(r.quiet[0]?.row ?? {})).toBe(false);
  });
});

describe('the words', () => {
  it('says a window with its time and note, and who', () => {
    const w = window({ endsAt: new Date('2026-11-24T22:00:00Z'), note: 'Moving the NAS' });
    expect(keptWords(w, now, 'Europe/Amsterdam')).toBe('Quiet until 23:00 · Moving the NAS');
    const kept = keptQuiet(w, {
      now,
      timeZone: 'Europe/Amsterdam',
      names: new Map([['prn_mara', 'Mara']]),
      canEnd: true,
    });
    expect(kept).toMatchObject({ id: 'qw_1', note: 'Moving the NAS', by: { name: 'Mara' }, canEnd: true });
    expect(kept.whombat).toBeUndefined();
    expect(
      keptQuiet(window({ work: 'update:pve-02/pkg:1', byId: null }), {
        now,
        timeZone: 'UTC',
        names: new Map(),
        canEnd: false,
      }).whombat,
    ).toBe(true);
  });

  it('says a cause as the page says it', () => {
    expect(thingCause(cause(), '/things/server%3Apve-02')).toEqual({
      thing: 'server:pve-02',
      name: 'pve-02',
      words: 'Not answering while pve-02 is down',
      href: '/things/server%3Apve-02',
    });
  });

  it('names what a cause takes with it', () => {
    expect(takenWords([])).toBeNull();
    expect(takenWords(['Plex'])).toBe('Plex is down with it');
    expect(takenWords(['Plex', 'Sonarr'])).toBe('Plex and Sonarr are down with it');
    expect(takenWords(['Plex', 'Radarr', 'Sonarr', 'Tautulli', 'Overseerr'])).toBe(
      'Plex and 4 more are down with it',
    );
    const taken = takenFrom([
      { name: 'Sonarr', causedBy: { thing: 'server:pve-02' } },
      { name: 'Home Assistant', causedBy: { thing: 'server:pve-02/guest/pve%3A131' } },
      { name: 'GitHub', causedBy: { thing: 'box:network' } },
      { name: 'Grafana' },
    ]);
    expect(taken.get('server:pve-02')).toEqual(['Home Assistant', 'Sonarr']);
    expect(taken.get('box:network')).toEqual(['GitHub']);
  });
});
