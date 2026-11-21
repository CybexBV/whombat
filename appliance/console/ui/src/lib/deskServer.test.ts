import { describe, expect, it } from 'vitest';
import type { DeskServer, DeskServerPage } from './desk';
import { DESK_WORDS, fill } from './deskCopy';
import {
  chartFoot,
  figuresOf,
  guestCpu,
  guestTone,
  hasPoints,
  headState,
  isSwipe,
  legend,
  SWIPE_PX,
  subLine,
  swipeTo,
  TEMP_BAR_MAX,
  volumeNote,
} from './deskServer';

const W = DESK_WORDS.server;
const TZ = 'Europe/Amsterdam';
/** 14:34:20 on Wednesday 21 October in Amsterdam. */
const NOW = Date.parse('2026-10-21T12:34:20Z');

const card = (p: Partial<DeskServer> = {}): DeskServer => ({
  id: 'pve-01',
  name: 'pve-01',
  mark: 'proxmox',
  state: 'ok',
  note: 'up 41 d',
  cpu: { value: 18, tone: 'ok' },
  memory: { value: 54, tone: 'ok' },
  temp: { value: 46, tone: 'ok' },
  disk: { value: 33, tone: 'ok' },
  ...p,
});

const page = (p: Partial<DeskServerPage> = {}): DeskServerPage => ({
  now: '2026-10-21T12:34:20Z',
  server: { ...card(), id: 'pve-01' },
  os: 'Proxmox VE 9.0.10',
  up: 'up 41 d',
  cpu: { percent: 18, cores: 16, load: '2.9', tone: 'ok' },
  memory: { percent: 54, used: { value: '69', unit: 'GB' }, total: '128 GB', tone: 'ok' },
  disk: { percent: 33, used: '1.2', total: '3.6 TB', tone: 'ok' },
  temp: { value: 46, limit: 85, tone: 'ok' },
  history: {
    range: '24h',
    stepS: 900,
    cpu: [10, null, 61],
    memory: [50, 52, 54],
    cpuPeak: { percent: 61, at: '2026-10-21T01:10:00Z' },
    memoryAvg: 52,
  },
  volumes: [],
  guests: null,
  network: null,
  alerts: { count: 0, items: [] },
  ...p,
});

describe('swiping through the servers (DK-83)', () => {
  it('goes to the next to the left and the previous to the right, more across than down and past 60 px', () => {
    expect(swipeTo(1, 3, -(SWIPE_PX + 1), 0)).toBe(2);
    expect(swipeTo(1, 3, SWIPE_PX + 1, 10)).toBe(0);
    expect(swipeTo(1, 3, -SWIPE_PX, 0)).toBeNull();
    expect(swipeTo(1, 3, -90, 120)).toBeNull();
  });

  it('tells a swipe from a touch, past either end too', () => {
    expect(isSwipe(-(SWIPE_PX + 1), 0)).toBe(true);
    expect(isSwipe(SWIPE_PX, 0)).toBe(false);
    expect(isSwipe(80, -90)).toBe(false);
  });

  it('stops at either end', () => {
    expect(swipeTo(0, 3, 200, 0)).toBeNull();
    expect(swipeTo(2, 3, -200, 0)).toBeNull();
    expect(swipeTo(0, 1, -200, 0)).toBeNull();
  });
});

describe('the header (DK-83)', () => {
  it('says all fine, the alerts counted in their worst tone, or the card’s note in its tone', () => {
    expect(headState(card(), null)).toEqual({ text: W.allFine, tone: 'ok' });
    expect(headState(card(), { count: 1, items: [] })).toEqual({ text: W.alertsOne, tone: 'warn' });
    expect(headState(card(), { count: 3, items: [{ tone: 'bad', title: 'Down' }] })).toEqual({
      text: fill(W.alertsMany, { n: 3 }),
      tone: 'bad',
    });
    // Locked without titles: a down server's alerts are red all the same.
    expect(headState(card({ state: 'bad' }), { count: 2, items: [] })?.tone).toBe('bad');
    expect(headState(card({ state: 'warn', note: 'hot · 84°' }), null)).toEqual({
      text: 'hot · 84°',
      tone: 'warn',
    });
    expect(headState(card({ state: 'off', note: 'off' }), null)).toEqual({ text: 'off', tone: 'off' });
    expect(headState(card({ state: 'warn', note: '' }), null)).toBeNull();
  });

  it('writes the OS, its cores and the uptime under the name, what is known of them', () => {
    expect(subLine(page())).toBe('Proxmox VE 9.0.10 · 16 cores · up 41 d');
    expect(subLine(page({ cpu: { percent: 2, cores: 1, load: '', tone: 'ok' } }))).toContain(W.coresOne);
    expect(subLine(page({ os: '', up: '', cpu: null }))).toBe('');
    expect(subLine(null)).toBe('');
  });
});

describe('the four figures (DK-83)', () => {
  it('draws the page’s figures with their notes, units and bars', () => {
    const f = figuresOf(card(), page());
    expect(f.cpu).toMatchObject({
      value: '18',
      unit: '%',
      note: fill(W.load, { n: '2.9' }),
      bar: { value: 18 },
    });
    expect(f.memory).toMatchObject({ value: '69', unit: 'GB', note: fill(W.memoryOf, { total: '128 GB' }) });
    expect(f.memory.bar?.value).toBe(54);
    expect(f.disk.note).toBe('1.2 of 3.6 TB');
    expect(f.temp).toMatchObject({ value: '46', unit: '°C', bar: { value: 46, max: TEMP_BAR_MAX } });
    expect(f.temp.note).toBe(fill(W.tempNote, { tone: DESK_WORDS.box.tones.ok, n: 85 }));
    // A limit over 90° fills the bar at the limit.
    expect(figuresOf(card(), page({ temp: { value: 95, limit: 100, tone: 'warn' } })).temp.bar?.max).toBe(
      100,
    );
  });

  it('shows the card’s figures while the first answer comes (no spinner), “–” for what it doesn’t have', () => {
    const f = figuresOf(card({ disk: undefined }), null);
    expect(f.cpu).toMatchObject({ value: '18', unit: '%', note: '' });
    expect(f.memory).toMatchObject({ value: '54', unit: '%' });
    expect(f.disk).toMatchObject({ value: DESK_WORDS.card.none, bar: null });
    expect(f.temp).toMatchObject({ value: '46', unit: '°C' });
  });

  it('shows “–” for an off server and figures the runtime didn’t send', () => {
    const off = figuresOf(card({ state: 'off' }), null);
    for (const f of Object.values(off)) expect(f.value).toBe(DESK_WORDS.card.none);
    expect(figuresOf(card(), page({ cpu: null, temp: null })).cpu.value).toBe(DESK_WORDS.card.none);
  });
});

describe('the chart (DK-83)', () => {
  it('has a legend with CPU’s peak and memory’s average, else the bare names', () => {
    expect(legend(page(), TZ)).toEqual({
      cpu: fill(W.cpuPeak, { n: 61, time: '03:10' }),
      memory: fill(W.memoryAvg, { n: 52 }),
    });
    const bare = page({
      history: { range: '24h', stepS: 900, cpu: [], memory: [], cpuPeak: null, memoryAvg: null },
    });
    expect(legend(bare, TZ)).toEqual({ cpu: W.cpu, memory: W.memory });
    expect(hasPoints(bare.history)).toBe(false);
    expect(hasPoints({ ...bare.history, cpu: [null], memory: [7] })).toBe(true);
  });

  it('writes the day’s times on the person’s clock, never touching the first and the last', () => {
    const f = chartFoot('24h', NOW, TZ);
    expect(f.start).toBe(fill(W.yesterday, { time: '14:34' }));
    expect(f.end).toBe(DESK_WORDS.box.now);
    // 18:00 is too near “yesterday 14:34”; midnight, 06:00 and noon fit, at their places in the day.
    expect(f.ticks.map((t) => t.label)).toEqual(['00:00', '06:00', '12:00']);
    expect(f.ticks[1]?.at).toBeCloseTo((24 - 8.572) / 24, 2);
  });

  it('writes the hour’s quarters and the week’s days', () => {
    expect(chartFoot('1h', NOW, TZ).ticks.map((t) => t.label)).toEqual(['13:45', '14:00', '14:15']);
    const week = chartFoot('7d', NOW, TZ);
    expect(week.start).toBe('Wed 14:34');
    // Thursday's midnight is too near “Wed 14:34”; this Wednesday's starts 14½ hours before now.
    expect(week.ticks.map((t) => t.label)).toEqual(['Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed']);
    // Ticks keep their order and never overlap.
    for (const f of [chartFoot('1h', NOW, TZ), week]) {
      const at = f.ticks.map((t) => t.at);
      expect(at).toEqual([...at].sort((a, b) => a - b));
    }
  });
});

describe('storage and guests (DK-83)', () => {
  it('writes a volume’s note or its use, and the percentage', () => {
    const v = {
      name: 'local-zfs',
      note: 'nvme mirror',
      percent: 41,
      used: '0.8',
      total: '1.9 TB',
      tone: 'ok',
    } as const;
    expect(volumeNote(v)).toBe('nvme mirror · 41 %');
    expect(volumeNote({ ...v, note: '' })).toBe('0.8 of 1.9 TB · 41 %');
  });

  it('dots a guest by its state and shows its processor or its state’s word', () => {
    const g = { name: 'plex', kind: 'vm', state: 'running', cpu: 22, memory: '6.1 GB' } as const;
    expect([guestTone(g), guestCpu(g)]).toEqual(['ok', '22 %']);
    expect(guestTone({ ...g, state: 'unhealthy' })).toBe('warn');
    expect([
      guestTone({ ...g, state: 'stopped', cpu: null }),
      guestCpu({ ...g, state: 'stopped', cpu: null }),
    ]).toEqual(['off', W.guestStates.stopped]);
    expect(guestCpu({ ...g, state: 'paused', cpu: null })).toBe(W.guestStates.paused);
  });
});
