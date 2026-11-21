/**
 * Contracts 0.101.0, a desk screen that works at once (Whombat desk-display.md DK-16…DK-25; CT-538, CT-539, CT-546,
 * CT-547): what the screen is, the switch, a screen without a PIN, a new box's status line, This Whombat and its
 * formats.
 */
import { describe, expect, it } from 'vitest';
import { HOST_DISK_ALERT_LEVELS } from '../text/host.js';
import {
  DESK_BOX_TONES,
  DESK_WORDS,
  type DeskBoxInput,
  type DeskBoxPoint,
  DeskDisplay,
  DeskScreen,
  deskBox,
  deskBoxFigure,
  deskMemoryFigure,
  deskMemoryTotal,
  deskStatusLine,
  fillDeskWords,
  formatDeskRate,
  formatDeskUptime,
} from './desk.js';

const screen = {
  paired: {
    personId: 'prn_john0001',
    name: 'John Doe',
    pairedAt: '2026-10-20T12:00:00Z',
    hasPin: true,
    self: false,
  },
  settings: {
    lockedView: 'summary',
    quietHours: { enabled: true, start: '23:00', end: '07:00' },
    night: 'dim',
    voice: true,
  },
  pairing: null,
  unlockRequest: null,
  hasDisplay: true,
  hasMicrophone: true,
  hasSpeaker: true,
  hasBattery: true,
  voiceAvailable: true,
  display: { connected: true, real: true, builtIn: false, name: 'DELL U2720Q' },
  on: true,
  onChosen: false,
  presenceAvailable: false,
  lockAgain: ['idle', 'never'],
  cameraWakeAvailable: false,
};

describe('what the screen is, and the switch (CT-538, CT-539)', () => {
  it('reads a real monitor, a built-in panel and a VM’s display', () => {
    const monitor = { connected: true, real: true, builtIn: false, name: 'DELL U2720Q' };
    expect(DeskDisplay.parse(monitor)).toEqual(monitor);
    expect(DeskDisplay.safeParse({ ...monitor, name: null, builtIn: true }).success).toBe(true);
    expect(DeskDisplay.safeParse({ ...monitor, name: '' }).success).toBe(false);
    expect(DeskDisplay.safeParse({ ...monitor, name: 'x'.repeat(61) }).success).toBe(false);
    const vm = { connected: true, real: false, builtIn: false, name: 'QEMU Monitor' };
    const s = DeskScreen.parse({ ...screen, display: vm, on: false, onChosen: false });
    expect(s.display).toEqual(vm);
    expect(s.on).toBe(false);
  });

  it('says a screen that paired itself has no PIN yet', () => {
    const self = { ...screen.paired, hasPin: false, self: true };
    expect(DeskScreen.parse({ ...screen, paired: self }).paired).toEqual(self);
    const { display: _, ...withoutDisplay } = screen;
    expect(DeskScreen.safeParse(withoutDisplay).success).toBe(false);
  });
});

describe('a new box’s status line (CT-547)', () => {
  it('says it is ready, with the hint to connect something, unless the counts say otherwise', () => {
    const fresh = { needsYou: 0, worst: null, fresh: true };
    for (const view of ['summary', 'everything'] as const)
      expect(deskStatusLine({ ...fresh, view })).toEqual({
        text: DESK_WORDS.status.ready,
        more: DESK_WORDS.status.connectHint,
      });
    expect(deskStatusLine({ ...fresh, view: 'time' })).toEqual({ text: DESK_WORDS.status.allFine });
    expect(deskStatusLine({ ...fresh, view: 'summary', needsYou: 1 }).text).toBe('1 thing needs you.');
    expect(deskStatusLine({ needsYou: 0, view: 'summary' }).text).toBe('Everything’s fine.');
  });

  it('has the new words, a no-break space before %', () => {
    expect(DESK_WORDS.status.ready).toContain('ready when you are');
    expect(fillDeskWords(DESK_WORDS.box.used, { n: 13 })).toBe('13 % used');
    expect(fillDeskWords(DESK_WORDS.box.network, { down: '2.4 MB/s', up: '310 kB/s' })).toBe(
      'Network ↓ 2.4 MB/s · ↑ 310 kB/s',
    );
    expect(fillDeskWords(DESK_WORDS.settings.pairedItself, { name: 'John' })).toContain('John');
    expect(DESK_WORDS.settings.selfPaired).toContain('Settings → Screen');
    expect(Object.keys(DESK_WORDS.errors)).toEqual(expect.arrayContaining(['no_screen', 'no_pin']));
  });
});

describe('the box’s formats (CT-546)', () => {
  it('writes sizes as “How it’s doing”, split for the screen', () => {
    expect(deskBoxFigure(11_200_000_000)).toEqual({ value: '11.2', unit: 'GB' });
    expect(deskBoxFigure(812_000_000_000)).toEqual({ value: '812', unit: 'GB' });
    expect(deskBoxFigure(1_600_000_000_000)).toEqual({ value: '1.6', unit: 'TB' });
    expect(deskBoxFigure(0)).toEqual({ value: '0', unit: 'B' });
  });

  it('writes rates with one decimal under 100', () => {
    expect(formatDeskRate(2_400_000)).toBe('2.4 MB/s');
    expect(formatDeskRate(310_000)).toBe('310 kB/s');
    expect(formatDeskRate(850)).toBe('850 B/s');
    expect(formatDeskRate(0)).toBe('0 B/s');
    expect(formatDeskRate(999_700)).toBe('1 MB/s');
    expect(formatDeskRate(45_340)).toBe('45.3 kB/s');
    expect(formatDeskRate(Number.NaN)).toBe('0 B/s');
  });

  it('writes the uptime as the server cards do', () => {
    expect(formatDeskUptime(2 * 3_600 + 14 * 60 + 30)).toBe('up 2 h 14 min');
    expect(formatDeskUptime(5 * 3_600)).toBe('up 5 h');
    expect(formatDeskUptime(30)).toBe('up 1 min');
    expect(formatDeskUptime(41 * 86_400 + 7 * 3_600)).toBe('up 41 d');
  });
});

describe('memory as machines count it (DK-22)', () => {
  it('writes GiB as GB and the total as the size it was sold as', () => {
    expect(deskMemoryFigure(12_025_908_429)).toEqual({ value: '11.2', unit: 'GB' });
    expect(deskMemoryFigure(512 * 1_048_576)).toEqual({ value: '512', unit: 'MB' });
    expect(deskMemoryTotal(67_200_000_000)).toBe('64 GB');
    expect(deskMemoryTotal(16_000_000_000)).toBe('16 GB');
    expect(deskMemoryTotal(128 * 1_073_741_824)).toBe('128 GB');
    // Well under any size (a VM given 10 GiB): as it is.
    expect(deskMemoryTotal(10 * 1_073_741_824)).toBe('10 GB');
  });
});

describe('This Whombat (CT-546)', () => {
  const point = (cpuPermille: number, memoryUsedBytes = 12_025_908_429): DeskBoxPoint => ({
    cpuPermille,
    memoryUsedBytes,
    inBytes: 24_000_000,
    outBytes: 3_100_000,
  });
  /** The manager's hour: 360 points of 10 s; the first 30 minutes before measuring began. */
  const metrics = (patch: Partial<DeskBoxInput['now']> = {}): DeskBoxInput => ({
    now: {
      cpuPermille: 70,
      cores: 16,
      // A 64 GB machine: the kernel and the firmware keep some of it.
      memoryTotalBytes: 67_200_000_000,
      memoryUsedBytes: 12_025_908_429,
      cpuTempC: 46,
      uptimeS: 8_040,
      ...patch,
    },
    disks: {
      data: {
        totalBytes: 937_000_000_000,
        usedBytes: 125_000_000_000,
        freeBytes: 812_000_000_000,
        parts: [
          { key: 'containers', bytes: 60_000_000_000 },
          { key: 'work', bytes: 24_000_000_000 },
          { key: 'whombat', bytes: 30_000_000_000 },
          { key: 'database', bytes: 11_000_000_000 },
        ],
      },
    },
    series: {
      stepS: 10,
      points: [
        ...Array(180).fill(null),
        ...Array.from({ length: 180 }, (_, i) => point(i % 6 === 0 ? 130 : 70)),
      ],
    },
  });

  it('draws mockup new-box’s figures', () => {
    const box = deskBox(metrics());
    expect(box.up).toBe('up 2 h 14 min');
    expect(box.cpu).toEqual({ percent: 7, cores: 16, tone: 'ok' });
    expect(box.memory).toEqual({
      percent: 18,
      used: { value: '11.2', unit: 'GB' },
      total: '64 GB',
      tone: 'ok',
    });
    expect(box.storage).toEqual({
      percent: 13,
      free: { value: '812', unit: 'GB' },
      total: '937 GB',
      tone: 'ok',
      parts: [
        { key: 'whombat', value: '41 GB', percent: 4 },
        { key: 'agent', value: '84 GB', percent: 9 },
      ],
    });
    expect(box.temp).toEqual({ value: 46, tone: 'ok' });
    expect(box.network).toEqual({ down: '2.4 MB/s', up: '310 kB/s' });
  });

  it('keeps the whole hour at one point a minute, averaged, with the gaps', () => {
    const { history } = deskBox(metrics());
    expect(history.stepS).toBe(60);
    expect(history.cpu).toHaveLength(60);
    expect(history.memory).toHaveLength(60);
    expect(history.cpu.slice(0, 30).every((p) => p === null)).toBe(true);
    // (13 % + 5 × 7 %) / 6 = 8 %.
    expect(history.cpu.slice(30).every((p) => p === 8)).toBe(true);
    expect(history.memory.at(-1)).toBe(18);
    const short = deskBox({ ...metrics(), series: { stepS: 10, points: [point(500)] } }).history;
    expect(short.cpu).toHaveLength(60);
    expect(short.cpu.at(-1)).toBe(50);
    const coarse = deskBox({ ...metrics(), series: { stepS: 300, points: Array(288).fill(point(70)) } });
    expect(coarse.history).toMatchObject({ stepS: 300 });
    expect(coarse.history.cpu).toHaveLength(12);
  });

  it('colours by the shown number: the processor and memory as server cards, storage, temperature', () => {
    expect(DESK_BOX_TONES.storage).toEqual({
      warn: HOST_DISK_ALERT_LEVELS[0],
      bad: HOST_DISK_ALERT_LEVELS[1],
    });
    expect(deskBox(metrics({ cpuPermille: 746 })).cpu.tone).toBe('warn');
    expect(deskBox(metrics({ cpuPermille: 900 })).cpu.tone).toBe('bad');
    expect(deskBox(metrics({ memoryUsedBytes: 54_000_000_000 })).memory.tone).toBe('warn');
    expect(deskBox(metrics({ cpuTempC: 80 })).temp).toEqual({ value: 80, tone: 'warn' });
    expect(deskBox(metrics({ cpuTempC: 93 })).temp).toEqual({ value: 93, tone: 'bad' });
    const full = metrics();
    full.disks.data = { ...full.disks.data, usedBytes: 890_000_000_000, freeBytes: 47_000_000_000 };
    expect(deskBox(full).storage).toMatchObject({ percent: 95, tone: 'bad' });
  });

  it('leaves out what the box can’t say: no sensor, no uptime, unmeasured parts, a gap now', () => {
    const vm = metrics({ cpuTempC: undefined, uptimeS: undefined });
    vm.disks.data = { ...vm.disks.data, parts: null };
    vm.series = { stepS: 10, points: [point(70), null] };
    const box = deskBox(vm);
    expect(box.temp).toBeUndefined();
    expect(box.up).toBe('');
    expect(box.storage.parts).toEqual([]);
    expect(box.network).toBeNull();
    const onlyContainers = metrics();
    onlyContainers.disks.data = {
      ...onlyContainers.disks.data,
      parts: [{ key: 'containers', bytes: 2_000_000_000 }],
    };
    expect(deskBox(onlyContainers).storage.parts).toEqual([{ key: 'agent', value: '2 GB', percent: 0 }]);
  });
});
