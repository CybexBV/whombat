/**
 * The desk and voice sockets (0.100, CT-528…CT-532; 0.101, CT-543…CT-545; 0.103, CT-595, CT-596; 0.104, CT-601,
 * CT-602; 0.115, CT-860…CT-866; 0.116, CT-890…CT-896; 0.118, CT-970…CT-972; 0.122, CT-1065; 3.3, Talk's voice typing).
 */
import {
  DESK_BOX_POINTS,
  DESK_BOX_TONES,
  type DeskBoxInput,
  deskBox,
  deskText,
  TASK_CARD_STATES,
  taskCardLine,
  VOICE_TYPING_MAX_SECONDS,
} from '@whombat/core/domain';
import { utf8ByteLength } from '@whombat/protocol';
import { describe, expect, it } from 'vitest';
import {
  DESK_ASK_CHOICES,
  DESK_AUDIO_BASE64_MAX,
  DESK_AUDIO_MAX_BYTES,
  DESK_CHOICE_SCOPES,
  DESK_DECIDE_SCOPES,
  DESK_FOUND_ITEMS,
  DESK_HEAR_BASE64_MAX,
  DESK_HEAR_REQUEST_MAX_BYTES,
  DESK_LOOK_KINDS,
  DESK_LOOK_QUIET_HOWS,
  DESK_LOOK_STATES,
  DESK_LOOKS_MAX,
  DESK_PATHS,
  DESK_QUESTION_MAX,
  DESK_REQUEST_MAX_BYTES,
  DESK_SERVER_ALERTS,
  DESK_SERVER_GUESTS,
  DESK_SERVER_MAX_BYTES,
  DESK_SERVER_POINTS,
  DESK_SERVER_RANGES,
  DESK_SERVER_VOLUMES,
  DESK_SERVERS,
  DESK_SESSION_MAX_BYTES,
  DESK_SESSION_MESSAGES,
  DESK_SOCKET_DEFAULT,
  DESK_SOCKET_ERRORS,
  DESK_STATE_MAX_BYTES,
  DESK_TALK_REQUEST_MAX_BYTES,
  DESK_TALK_STATES,
  DESK_TALK_TEXT_MAX,
  DESK_TASK_STATES,
  DESK_TEXT_RES,
  DeskAsk,
  DeskBox,
  DeskDecideRequest,
  DeskFound,
  DeskGlance,
  DeskHeard,
  DeskHearRequest,
  DeskLook,
  DeskLookQuietRequest,
  DeskNeedsYou,
  DeskServer,
  DeskServerId,
  DeskServerPage,
  DeskServerRequest,
  DeskServersAnswer,
  DeskSessionMessage,
  DeskState,
  DeskTalk,
  DeskTalkRequest,
  DeskTalkSession,
  DeskUnlockRequest,
  deskDecideNeedsPin,
  deskDecideRequestValid,
  deskFoundValid,
  deskServerPageValid,
  deskStateValid,
  deskTalkRequestValid,
  deskTalkSessionValid,
  deskTalkValid,
  deskTextSchema,
} from './desk.js';
import { VOICE_PATHS, VOICE_SOCKET_DEFAULT, VoiceSttAnswer } from './voice.js';

const state = {
  v: 1,
  now: '2026-10-20T12:34:00Z',
  paired: {
    person: { name: 'John', initial: 'J', tone: 2 },
    assistant: { name: 'Neo', face: 'neo' },
    timeZone: 'Europe/Amsterdam',
    lockedView: 'summary',
    night: 'dim',
    quiet: false,
    voice: true,
    hasPin: true,
  },
  pairing: null,
  lock: { state: 'locked' },
  glance: {
    status: { text: '1 thing needs you.' },
    needsYou: {
      count: 1,
      items: [
        {
          number: 12,
          kind: 'approval',
          title: 'Restart Plex on blackbox?',
          at: '2026-10-20T12:31:00Z',
          onDesk: true,
        },
      ],
    },
    working: null,
    done: [],
    servers: [],
    moreServers: 0,
    tiles: [],
  },
  power: null,
  talk: null,
} as const;

const metrics: DeskBoxInput = {
  now: {
    cpuPermille: 70,
    cores: 16,
    memoryTotalBytes: 64_000_000_000,
    memoryUsedBytes: 11_200_000_000,
    cpuTempC: 46,
    uptimeS: 8_040,
  },
  disks: {
    data: {
      totalBytes: 1_870_000_000_000,
      usedBytes: 1_000_000_000_000,
      freeBytes: 870_000_000_000,
      parts: [
        { key: 'computers', bytes: 999_000_000_000 },
        { key: 'database', bytes: 1_000_000 },
      ],
    },
  },
  series: {
    stepS: 10,
    points: Array.from({ length: 400 }, (_, i) =>
      i % 7 === 3
        ? null
        : { cpuPermille: 1_000, memoryUsedBytes: 64_000_000_000, inBytes: 9e12, outBytes: 123_456 },
    ),
  },
};

describe('the desk socket (CT-528)', () => {
  it('lives in the console directory, its paths under /v1/desk', () => {
    expect(DESK_SOCKET_DEFAULT).toBe('/run/whombat/console/desk.sock');
    for (const path of Object.values(DESK_PATHS)) expect(path).toMatch(/^\/v1\/desk\//);
    expect(VOICE_SOCKET_DEFAULT).toBe('/run/whombat-voice/voice.sock');
    for (const path of Object.values(VOICE_PATHS)) expect(path).toMatch(/^\/v1\/voice\//);
  });

  it('fits 30 s of 16 kHz mono audio, in base64, in a talk request', () => {
    expect(DESK_AUDIO_MAX_BYTES).toBe(960_044);
    expect(DESK_AUDIO_BASE64_MAX).toBe(1_280_060);
    expect(DESK_AUDIO_BASE64_MAX + 1_024).toBeLessThan(DESK_TALK_REQUEST_MAX_BYTES);
  });
});

describe('display text (CT-529)', () => {
  it('takes any script on one line, counted in code points', () => {
    const t = deskTextSchema(40);
    expect(t.safeParse('pve-02 · “Plex” läuft 日本語 🎉').success).toBe(true);
    expect(t.safeParse('🎉'.repeat(40)).success).toBe(true);
    expect(t.safeParse('🎉'.repeat(41)).success).toBe(false);
    for (const bad of ['', 'a\nb', 'a\tb', 'a\u200bb', 'a\u202eb', 'a\u00a0b', 'a\u2028b'])
      expect(t.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(deskTextSchema(40, 0).safeParse('').success).toBe(true);
    expect(() => deskTextSchema(39)).toThrow();
    expect(new Set(DESK_TEXT_RES.map((r) => r.source)).size).toBe(DESK_TEXT_RES.length);
  });

  it('accepts whatever core’s deskText made of a string', () => {
    const made = deskText('  Plex\u00a0stopped\nanswering\u200b at 14:31  ', 40);
    expect(deskTextSchema(40).safeParse(made).success).toBe(true);
    expect(
      VoiceSttAnswer.safeParse({ v: 1, text: deskText(' is pve two\nokay ', 500), seconds: 2 }).success,
    ).toBe(true);
  });
});

describe('what may show (CT-530)', () => {
  it('a locked glance without an ask’s words', () => {
    const s = DeskState.parse(state);
    expect(deskStateValid(s)).toBe(true);
    const item = { ...state.glance.needsYou.items[0], detail: 'Plex stopped answering at 14:31.' };
    const words = DeskState.parse({
      ...state,
      glance: { ...state.glance, needsYou: { count: 1, items: [item] } },
    });
    expect(deskStateValid(words)).toBe(false);
    expect(deskStateValid({ ...words, lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z' } })).toBe(
      true,
    );
  });

  it('a talk is typed or spoken, not both', () => {
    const typed = DeskTalkRequest.parse({ v: 1, text: 'Is pve-02 okay?', continue: false });
    expect(deskTalkRequestValid(typed)).toBe(true);
    expect(deskTalkRequestValid({})).toBe(false);
  });
});

describe('Talk’s voice typing (3.3)', () => {
  it('hears voice typing’s five minutes, and the body carries them', () => {
    const wav = 44 + VOICE_TYPING_MAX_SECONDS * 16_000 * 2;
    const base64 = 'A'.repeat(4 * Math.ceil(wav / 3));
    expect(DESK_HEAR_BASE64_MAX).toBe(base64.length);
    expect(DeskHearRequest.safeParse({ v: 1, audioWav: base64 }).success).toBe(true);
    expect(DeskHearRequest.safeParse({ v: 1, audioWav: `${base64}AAAA` }).success).toBe(false);
    expect(JSON.stringify({ v: 1, audioWav: base64 }).length).toBeLessThanOrEqual(
      DESK_HEAR_REQUEST_MAX_BYTES,
    );
    expect(DESK_PATHS.hear).toBe('/v1/desk/hear');
  });

  it('answers one line, empty when nothing was heard', () => {
    expect(DeskHeard.safeParse({ v: 1, text: '' }).success).toBe(true);
    expect(DeskHeard.safeParse({ v: 1, text: 'x'.repeat(DESK_TALK_TEXT_MAX) }).success).toBe(true);
    expect(DeskHeard.safeParse({ v: 1, text: 'two\nlines' }).success).toBe(false);
  });

  it('sends what was heard as a question that says it came by voice', () => {
    const heard = { v: 1, text: 'x'.repeat(DESK_TALK_TEXT_MAX), continue: true, spoken: true };
    expect(DeskTalkRequest.safeParse(heard).success).toBe(true);
    expect(DeskTalkRequest.safeParse({ ...heard, text: `${heard.text}x` }).success).toBe(false);
    expect(DESK_TALK_TEXT_MAX).toBeGreaterThan(DESK_QUESTION_MAX);
  });
});

describe('This Whombat and a screen without a PIN (0.101, CT-543…CT-545)', () => {
  const fresh = (box: DeskBox, patch: object = {}) => {
    const s = DeskState.parse(state);
    return {
      ...s,
      glance: { ...(s.glance as NonNullable<DeskState['glance']>), servers: [], tiles: [], box },
      ...patch,
    } as DeskState;
  };

  it('takes what core’s deskBox builds, at its widest', () => {
    const box: DeskBox = deskBox(metrics);
    expect(DeskBox.parse(box)).toEqual(box);
    expect(box.history.cpu).toHaveLength(DESK_BOX_POINTS);
    expect(box.network).toEqual({ down: '900 GB/s', up: '12.3 kB/s' });
    const empty: DeskBox = deskBox({ ...metrics, series: { stepS: 10, points: [] } });
    expect(DeskBox.parse(empty)).toEqual(empty);
  });

  it('shows the box only without servers and tiles, not locked in Only the time', () => {
    const box = deskBox(metrics);
    expect(deskStateValid(fresh(box))).toBe(true);
    const s = fresh(box);
    const paired = s.paired as NonNullable<DeskState['paired']>;
    expect(deskStateValid({ ...s, paired: { ...paired, lockedView: 'time' } })).toBe(false);
    expect(
      deskStateValid({
        ...s,
        paired: { ...paired, lockedView: 'time' },
        lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z' },
      }),
    ).toBe(true);
    const g = s.glance as NonNullable<DeskState['glance']>;
    expect(
      deskStateValid({
        ...s,
        glance: { ...g, tiles: [{ icon: 'lock', value: 'Locked', label: 'Front door' }] },
      }),
    ).toBe(false);
    expect(
      deskStateValid({ ...s, glance: { ...g, box: { ...box, history: { ...box.history, cpu: [1] } } } }),
    ).toBe(false);
  });

  it('says whether the pad may take a PIN, and refuses one where there is none', () => {
    const s = DeskState.parse(state);
    const paired = s.paired as NonNullable<DeskState['paired']>;
    expect(DeskState.parse({ ...s, paired: { ...paired, hasPin: false } }).paired?.hasPin).toBe(false);
    expect(s.paired?.hasPin).toBe(true);
    expect(DESK_SOCKET_ERRORS).toContain('no_pin');
  });
});

describe('a four-digit PIN and the camera on the desk socket (0.103, CT-595, CT-596)', () => {
  const unlocked = { state: 'unlocked', until: '2026-10-20T12:34:30Z' } as const;
  const withLock = (lock: object) => ({ ...DeskState.parse(state), lock }) as DeskState;

  it('says the PIN’s length, 4 to 6, absent from an older runtime', () => {
    const s = DeskState.parse(state);
    const paired = s.paired as NonNullable<DeskState['paired']>;
    expect(DeskState.parse({ ...s, paired: { ...paired, pinDigits: 4 } }).paired?.pinDigits).toBe(4);
    expect(s.paired?.pinDigits).toBeUndefined();
    for (const n of [3, 7, 5.5])
      expect(DeskState.safeParse({ ...s, paired: { ...paired, pinDigits: n } }).success, String(n)).toBe(
        false,
      );
  });

  it('takes an unlock of 4 to 6 ASCII digits', () => {
    for (const pin of ['2580', '13970', '048213'])
      expect(DeskUnlockRequest.safeParse({ v: 1, pin }).success, pin).toBe(true);
    for (const pin of ['258', '0482130', '٢٥٨٠'])
      expect(DeskUnlockRequest.safeParse({ v: 1, pin }).success, pin).toBe(false);
  });

  it('shows the camera and someone there only while unlocked, someone only with the camera', () => {
    expect(deskStateValid(withLock({ ...unlocked, camera: true, present: true }))).toBe(true);
    expect(deskStateValid(withLock({ ...unlocked, camera: true }))).toBe(true);
    expect(deskStateValid(withLock({ ...unlocked, present: true }))).toBe(false);
    expect(deskStateValid(withLock({ ...unlocked, camera: false, present: true }))).toBe(false);
    expect(deskStateValid(withLock({ state: 'locked', camera: true }))).toBe(false);
    expect(deskStateValid(withLock({ state: 'phone', expiresAt: unlocked.until, present: true }))).toBe(
      false,
    );
    // False says nothing, wherever it is.
    expect(deskStateValid(withLock({ state: 'locked', camera: false, present: false }))).toBe(true);
  });
});

describe('only the clock when nobody’s there, and staying unlocked (0.107, CT-646…CT-648)', () => {
  const unlocked = { state: 'unlocked', until: '2026-10-20T12:36:00Z' } as const;
  const parsed = () => DeskState.parse(state);

  it('stays unlocked only while unlocked; false says nothing', () => {
    const withLock = (lock: object) => ({ ...parsed(), lock }) as DeskState;
    expect(deskStateValid(withLock({ ...unlocked, stays: true }))).toBe(true);
    expect(deskStateValid(withLock({ state: 'locked', stays: true }))).toBe(false);
    expect(deskStateValid(withLock({ state: 'phone', expiresAt: unlocked.until, stays: true }))).toBe(false);
    expect(deskStateValid(withLock({ state: 'locked', stays: false }))).toBe(true);
    expect(DeskState.parse(state).lock.stays).toBeUndefined();
  });

  it('says what the camera sees, only on a paired screen, absent from an older runtime', () => {
    const presence = { camera: true, watching: true, here: true };
    expect(DeskState.parse({ ...state, presence }).presence).toEqual(presence);
    expect(parsed().presence).toBeUndefined();
    expect(deskStateValid({ ...parsed(), presence })).toBe(true);
    const nobody = { ...parsed(), paired: null, glance: null, talk: null } as DeskState;
    expect(deskStateValid(nobody)).toBe(true);
    expect(deskStateValid({ ...nobody, presence })).toBe(false);
    expect(DeskState.safeParse({ ...state, presence: { camera: true, here: true } }).success).toBe(false);
  });
});

describe('one glance that fits what there is (0.104, CT-601, CT-602)', () => {
  const box = deskBox(metrics);
  const server = { name: 'pve-02', mark: 'proxmox', state: 'ok', note: 'up 41 d' } as const;
  const tile = { icon: 'lock', value: 'Locked', label: 'Front door' } as const;
  const four = <T>(x: T) => [x, x, x, x];
  type Glance = NonNullable<DeskState['glance']>;
  const glanceOf = (patch: Partial<Glance>, other: Partial<DeskState> = {}) => {
    const s = DeskState.parse(state);
    return { ...s, glance: { ...(s.glance as Glance), ...patch }, ...other } as DeskState;
  };
  const paired = DeskState.parse(state).paired as NonNullable<DeskState['paired']>;
  const timeOnly = { paired: { ...paired, lockedView: 'time' as const } };

  it('keeps the new members optional: a glance without them is valid as before', () => {
    const s = DeskState.parse(state);
    expect(s.glance?.self).toBeUndefined();
    expect(s.glance?.extraServers).toBeUndefined();
    expect(s.glance?.extraTiles).toBeUndefined();
    expect(deskStateValid(s)).toBe(true);
    expect(deskStateValid(glanceOf({ servers: four(server), moreServers: 4, tiles: four(tile) }))).toBe(true);
    expect(deskStateValid(glanceOf({ box }))).toBe(true);
  });

  it('leaves an older console a glance it takes as before once it strips them (DK-42)', () => {
    const older = DeskState.extend({
      glance: DeskGlance.omit({ self: true, extraServers: true, extraTiles: true }).nullable(),
    });
    const full = glanceOf({
      servers: four(server),
      extraServers: four(server),
      moreServers: 6,
      tiles: four(tile),
      extraTiles: four(tile),
      self: box,
    });
    expect(deskStateValid(full)).toBe(true);
    const seen = older.parse(full);
    expect(Object.keys(seen.glance ?? {})).not.toContain('self');
    expect(seen.glance?.box).toBeUndefined();
    expect(seen.glance?.moreServers).toBe(6);
    expect(deskStateValid(seen as DeskState)).toBe(true);
  });

  it('shows This Whombat beside servers or tiles, never with the box, not locked in Only the time', () => {
    expect(deskStateValid(glanceOf({ servers: [server], self: box }))).toBe(true);
    expect(deskStateValid(glanceOf({ tiles: [tile], self: box }))).toBe(true);
    expect(deskStateValid(glanceOf({ self: box }))).toBe(false);
    expect(deskStateValid(glanceOf({ servers: [server], self: box, box }))).toBe(false);
    expect(deskStateValid(glanceOf({ self: box, box }))).toBe(false);
    expect(deskStateValid(glanceOf({ servers: [server], self: box }, timeOnly))).toBe(false);
    const unlocked = { lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z' } as const };
    expect(deskStateValid(glanceOf({ servers: [server], self: box }, { ...timeOnly, ...unlocked }))).toBe(
      true,
    );
    const uneven = { ...box, history: { ...box.history, memory: [1] } };
    expect(deskStateValid(glanceOf({ servers: [server], self: uneven }))).toBe(false);
  });

  it('gives servers and tiles five to eight only beside four, the extra servers counted in moreServers', () => {
    const servers = four(server);
    expect(deskStateValid(glanceOf({ servers, extraServers: [server], moreServers: 1 }))).toBe(true);
    expect(deskStateValid(glanceOf({ servers, extraServers: servers, moreServers: 9 }))).toBe(true);
    expect(deskStateValid(glanceOf({ servers, extraServers: servers, moreServers: 3 }))).toBe(false);
    expect(
      deskStateValid(glanceOf({ servers: servers.slice(1), extraServers: [server], moreServers: 1 })),
    ).toBe(false);
    expect(deskStateValid(glanceOf({ tiles: four(tile), extraTiles: [tile, tile] }))).toBe(true);
    expect(deskStateValid(glanceOf({ tiles: [tile], extraTiles: [tile] }))).toBe(false);
    // An empty list says nothing, wherever it is.
    expect(deskStateValid(glanceOf({ servers: [server], extraServers: [], extraTiles: [] }))).toBe(true);
    for (const n of [5, 6]) {
      expect(DeskGlance.shape.extraServers.safeParse(Array(n).fill(server)).success).toBe(false);
      expect(DeskGlance.shape.extraTiles.safeParse(Array(n).fill(tile)).success).toBe(false);
    }
  });

  it('fits the widest glance in a state the console server reads', () => {
    const e = (n: number) => '🎉'.repeat(n);
    const at = '2026-10-20T12:31:00Z';
    const meter = { value: 1_000, tone: 'bad' } as const;
    const mark = 'x'.repeat(32);
    const wide = {
      name: e(40),
      mark,
      state: 'warn',
      note: e(40),
      cpu: meter,
      memory: meter,
      temp: meter,
      // 0.115 (CT-860).
      id: `p${'x'.repeat(127)}`,
      disk: meter,
    };
    const wideTile = { icon: 'temperature', mark, value: e(24), label: e(48), tone: 'warn' };
    const ask = {
      number: 1_000_000_000,
      kind: 'approval',
      title: e(120),
      at,
      where: e(40),
      detail: e(400),
      facts: [e(80), e(80), e(80)],
      approveLabel: e(40),
      onDesk: false,
      phoneReason: 'release',
      // 0.108 (CT-660) and 0.116 (CT-890, CT-892).
      deny: true,
      approveWithPin: true,
      inTalk: true,
      choices: [
        { scope: 'task', label: e(120) },
        { scope: 'agent', label: e(120) },
      ],
      from: e(40),
    };
    // 0.118 (CT-970) and 0.122 (CT-1065).
    const look = {
      key: e(120),
      kind: 'connection',
      name: e(40),
      state: 'bad',
      reason: e(120),
      server: `p${'x'.repeat(127)}`,
      notice: { check: `a.${'b'.repeat(78)}`, subject: e(160) },
      nature: 'you',
      ignoreWords: e(60),
      question: e(300),
      // 3.5 (Whombat look-research.md): what the assistant found, on each of the five.
      research: {
        key: e(120),
        state: 'found',
        title: e(80),
        summary: e(240),
        fix: e(32),
        conversationId: `cnv_${'x'.repeat(64)}`,
        threadRootId: `msg_${'x'.repeat(64)}`,
        at,
      },
    };
    const figure = { value: e(8), unit: e(8) };
    const self = {
      up: e(40),
      cpu: { percent: 100, cores: 4096, tone: 'bad' },
      memory: { percent: 100, used: figure, total: e(16), tone: 'bad' },
      history: {
        stepS: 3600,
        cpu: Array(DESK_BOX_POINTS).fill(100),
        memory: Array(DESK_BOX_POINTS).fill(100),
      },
      storage: {
        percent: 100,
        free: figure,
        total: e(16),
        tone: 'bad',
        parts: [
          { key: 'whombat', value: e(16), percent: 100 },
          { key: 'agent', value: e(16), percent: 100 },
        ],
      },
      temp: meter,
      network: { down: e(16), up: e(16) },
    };
    const widest = DeskState.parse({
      ...state,
      paired: {
        ...state.paired,
        person: { name: e(40), initial: e(2), tone: 5 },
        assistant: { name: e(40), face: 'neo' },
        lockedView: 'everything',
        pinDigits: 6,
      },
      pairing: { code: 'KXQM', expiresAt: at },
      lock: { state: 'unlocked', until: at, camera: true, present: true, stays: true },
      presence: { camera: true, watching: true, here: true },
      glance: {
        status: { text: e(200), more: e(200) },
        needsYou: { count: 1_000_000, items: Array(5).fill(ask), looks: Array(5).fill(look) },
        working: { title: e(120), steps: Array(6).fill({ label: e(40), state: 'now' }) },
        done: Array(3).fill({ text: e(120), at }),
        servers: four(wide),
        moreServers: 1_000_000,
        tiles: four(wideTile),
        self,
        extraServers: four(wide),
        extraTiles: four(wideTile),
        found: {
          scanning: true,
          progress: null,
          items: Array(DESK_FOUND_ITEMS).fill({
            catalogId: `x${'y'.repeat(30)}`,
            name: e(60),
            tagline: e(40),
            address: e(120),
          }),
          count: 1_000_000,
          finishedAt: at,
        },
      },
      power: {
        source: 'battery',
        percent: 100,
        charging: true,
        minutesLeft: 100_000,
        chargeLimit: 100,
        since: at,
      },
      talk: {
        id: 'x'.repeat(64),
        state: 'answered',
        question: e(500),
        answer: e(600),
        thing: wide,
        audio: true,
      },
    });
    expect(deskStateValid(widest)).toBe(true);
    expect(utf8ByteLength(JSON.stringify(widest))).toBeLessThan(DESK_STATE_MAX_BYTES);
  });
});

describe('found on your network (0.110, CT-700, CT-701)', () => {
  type Glance = NonNullable<DeskState['glance']>;
  const glanceOf = (patch: Partial<Glance>, other: Partial<DeskState> = {}) => {
    const s = DeskState.parse(state);
    return { ...s, glance: { ...(s.glance as Glance), ...patch }, ...other } as DeskState;
  };
  const item = {
    catalogId: 'homeassistant',
    name: 'Home Assistant',
    tagline: 'Lights, heating and sensors',
    address: '10.100.0.5',
  };
  const done = DeskFound.parse({
    scanning: false,
    progress: null,
    items: [item, { ...item, catalogId: 'proxmox', name: 'Proxmox VE', address: '10.100.0.10' }],
    count: 2,
    finishedAt: '2026-10-20T12:30:00Z',
  });
  const looking = { ...done, scanning: true, progress: { done: 412, total: 1_022 }, finishedAt: null };
  const paired = DeskState.parse(state).paired as NonNullable<DeskState['paired']>;

  it('dismisses on its own path', () => {
    expect(DESK_PATHS.foundDismiss).toBe('/v1/desk/found/dismiss');
  });

  it('is optional: an older runtime sends none, an older console strips it', () => {
    expect(DeskState.parse(state).glance?.found).toBeUndefined();
    const older = DeskState.extend({ glance: DeskGlance.omit({ found: true }).nullable() });
    const seen = older.parse(glanceOf({ found: done }));
    expect(Object.keys(seen.glance ?? {})).not.toContain('found');
    expect(deskStateValid(seen as DeskState)).toBe(true);
  });

  it('names at most eight, with an entry’s id, a name, a tagline and an address', () => {
    expect(
      DeskFound.safeParse({ ...done, items: Array(DESK_FOUND_ITEMS).fill(item), count: 12 }).success,
    ).toBe(true);
    expect(DeskFound.safeParse({ ...done, items: Array(9).fill(item), count: 12 }).success).toBe(false);
    // A newer runtime's entry parses; the console draws its first letter (DF-12).
    expect(DeskFound.safeParse({ ...done, items: [{ ...item, catalogId: 'qnap' }] }).success).toBe(true);
    expect(DeskFound.safeParse({ ...done, items: [{ ...item, catalogId: 'Home Assistant' }] }).success).toBe(
      false,
    );
    expect(DeskFound.safeParse({ ...done, items: [{ ...item, tagline: 'x'.repeat(41) }] }).success).toBe(
      false,
    );
  });

  it('looks with progress only during the first scan, and keeps the last result during a later one', () => {
    expect(deskFoundValid(done)).toBe(true);
    expect(deskFoundValid(looking)).toBe(true);
    expect(deskFoundValid({ ...looking, items: [], count: 0, progress: null })).toBe(true);
    expect(deskFoundValid({ ...done, scanning: true })).toBe(true);
    expect(deskFoundValid({ ...done, finishedAt: null })).toBe(false);
    expect(deskFoundValid({ ...done, scanning: true, progress: { done: 1, total: 2 } })).toBe(false);
    expect(deskFoundValid({ ...looking, progress: { done: 3, total: 2 } })).toBe(false);
  });

  it('counts every new one, and isn’t there when nothing new is left', () => {
    expect(deskFoundValid({ ...done, count: 1 })).toBe(false);
    expect(deskFoundValid({ ...done, count: 9 })).toBe(true);
    expect(deskFoundValid({ ...done, items: [], count: 0 })).toBe(false);
    expect(deskFoundValid({ ...done, scanning: true, items: [], count: 0 })).toBe(false);
  });

  it('shows as a panel or beside servers and tiles, also locked, never in Only the time locked', () => {
    const box = deskBox(metrics);
    const server = { name: 'pve-02', mark: 'proxmox', state: 'ok', note: 'up 41 d' } as const;
    expect(deskStateValid(glanceOf({ found: done }))).toBe(true);
    expect(deskStateValid(glanceOf({ found: looking, box }))).toBe(true);
    expect(deskStateValid(glanceOf({ found: done, servers: [server] }))).toBe(true);
    const timeOnly = { paired: { ...paired, lockedView: 'time' as const } };
    expect(deskStateValid(glanceOf({ found: done }, timeOnly))).toBe(false);
    const unlocked = { lock: { state: 'unlocked', until: '2026-10-20T12:36:00Z' } as const };
    expect(deskStateValid(glanceOf({ found: done }, { ...timeOnly, ...unlocked }))).toBe(true);
    expect(deskStateValid(glanceOf({ found: { ...done, count: 1 } }))).toBe(false);
  });
});

describe('server cards three to a row, and a server’s own screen (0.115, CT-860…CT-866)', () => {
  const card = {
    name: 'pve-01',
    mark: 'proxmox',
    state: 'ok',
    note: 'up 41 d',
    cpu: { value: 18, tone: 'ok' },
    memory: { value: 54, tone: 'ok' },
    temp: { value: 46, tone: 'ok' },
    id: 'pve-01',
    disk: { value: 33, tone: 'ok' },
  } as const;
  const points = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? null : 10 + (i % 5)));
  const page = DeskServerPage.parse({
    v: 1,
    now: '2026-10-21T12:34:00Z',
    server: card,
    os: 'Proxmox VE 9.0.10',
    up: 'up 41 d',
    cpu: { percent: 18, cores: 16, load: '2.9', tone: 'ok' },
    memory: { percent: 54, used: { value: '69', unit: 'GB' }, total: '128 GB', tone: 'ok' },
    disk: { percent: 33, used: '1.2', total: '3.6 TB', tone: 'ok' },
    temp: { value: 46, limit: 85, tone: 'ok' },
    history: {
      range: '24h',
      stepS: 900,
      cpu: points(DESK_SERVER_POINTS),
      memory: points(DESK_SERVER_POINTS),
      cpuPeak: { percent: 61, at: '2026-10-21T01:10:00Z' },
      memoryAvg: 52,
    },
    volumes: [
      { name: 'local-zfs', note: 'nvme mirror', percent: 41, used: '0.8 TB', total: '1.9 TB', tone: 'ok' },
    ],
    guests: {
      running: 4,
      off: 1,
      items: [
        { name: 'plex', kind: 'vm', state: 'running', cpu: 22, memory: '6.1 GB' },
        { name: 'win11-test', kind: 'vm', state: 'stopped', cpu: null, memory: '' },
      ],
    },
    network: { down: '24 MB/s', up: '3.1 MB/s' },
    alerts: { count: 0, items: [] },
  });
  const alert = { tone: 'warn', title: 'Backup of plex didn’t run last night' } as const;

  it('opens a server on two new paths', () => {
    expect(DESK_PATHS.servers).toBe('/v1/desk/servers');
    expect(DESK_PATHS.server).toBe('/v1/desk/server');
    expect(DESK_SERVER_RANGES).toEqual(['1h', '24h', '7d']);
  });

  it('gives a card its id and disk; an older runtime sends neither, an older console strips both', () => {
    expect(DeskServer.parse(card)).toEqual(card);
    const { id: _id, disk: _disk, ...older } = card;
    expect(DeskServer.parse(older)).toEqual(older);
    const olderConsole = DeskServer.omit({ id: true, disk: true });
    expect(Object.keys(olderConsole.parse(card))).not.toContain('id');
    expect(DESK_BOX_TONES.storage).toEqual({ warn: 85, bad: 95 });
  });

  it('takes the hosts service’s ids, short ones too, and nothing that could be a path', () => {
    for (const id of ['pve-01', 'nas', 'a', 'pve01.home.lan', `p${'x'.repeat(127)}`])
      expect(DeskServerId.safeParse(id).success, id).toBe(true);
    for (const id of [
      '',
      '.nas',
      '..',
      '-nas',
      'pve/01',
      '../nas',
      'pve 01',
      'pve-01\n',
      `p${'x'.repeat(128)}`,
    ])
      expect(DeskServerId.safeParse(id).success, id).toBe(false);
  });

  it('lists every server as cards, at most 24, the rest counted', () => {
    expect(DESK_SERVERS).toBe(24);
    expect(DeskServersAnswer.safeParse({ v: 1, servers: Array(24).fill(card), more: 3 }).success).toBe(true);
    expect(DeskServersAnswer.safeParse({ v: 1, servers: Array(25).fill(card), more: 0 }).success).toBe(false);
  });

  it('asks for one server and a range, nothing else', () => {
    expect(DeskServerRequest.safeParse({ v: 1, id: 'nas', range: '24h' }).success).toBe(true);
    expect(DeskServerRequest.safeParse({ v: 1, id: 'nas', range: '30d' }).success).toBe(false);
    expect(DeskServerRequest.safeParse({ v: 1, id: 'nas', range: '24h', restart: true }).success).toBe(false);
  });

  it('asks about a server in a talk; an older runtime refuses the member', () => {
    const ask = { v: 1, text: 'Why is it busy?', continue: false, server: 'pve-01' };
    expect(DeskTalkRequest.safeParse(ask).success).toBe(true);
    expect(DeskTalkRequest.omit({ server: true }).safeParse(ask).success).toBe(false);
    expect(DeskTalkRequest.safeParse({ ...ask, server: 'pve/01' }).success).toBe(false);
  });

  it('keeps a page’s lists short and its words to their lengths', () => {
    const history = page.history;
    expect(DeskServerPage.safeParse({ ...page, history: { ...history, cpu: points(97) } }).success).toBe(
      false,
    );
    expect(DeskServerPage.safeParse({ ...page, history: { ...history, range: '30d' } }).success).toBe(false);
    const volumes = Array(DESK_SERVER_VOLUMES + 1).fill(page.volumes[0]);
    expect(DeskServerPage.safeParse({ ...page, volumes }).success).toBe(false);
    const guests = { running: 9, off: 0, items: Array(DESK_SERVER_GUESTS + 1).fill(page.guests?.items[0]) };
    expect(DeskServerPage.safeParse({ ...page, guests }).success).toBe(false);
    const alerts = { count: 9, items: Array(DESK_SERVER_ALERTS + 1).fill(alert) };
    expect(DeskServerPage.safeParse({ ...page, alerts }).success).toBe(false);
    expect(DeskServerPage.safeParse({ ...page, os: 'x'.repeat(61) }).success).toBe(false);
  });

  it('is consistent: its id, equal series, no more titles than alerts or guests than counted', () => {
    expect(deskServerPageValid(page)).toBe(true);
    const { id: _id, ...noId } = page.server;
    expect(deskServerPageValid({ ...page, server: noId })).toBe(false);
    expect(deskServerPageValid({ ...page, history: { ...page.history, memory: points(95) } })).toBe(false);
    expect(deskServerPageValid({ ...page, alerts: { count: 1, items: [alert] } })).toBe(true);
    expect(deskServerPageValid({ ...page, alerts: { count: 0, items: [alert] } })).toBe(false);
    const guests = page.guests as NonNullable<DeskServerPage['guests']>;
    expect(deskServerPageValid({ ...page, guests: { ...guests, running: 1, off: 0 } })).toBe(false);
    expect(deskServerPageValid({ ...page, guests: { ...guests, running: 1, off: 1 } })).toBe(true);
    expect(deskServerPageValid({ ...page, guests: null })).toBe(true);
  });

  it('shows an off server with nothing measured', () => {
    const off = DeskServerPage.parse({
      ...page,
      server: { name: 'pi-hole', mark: 'linux', state: 'off', note: '', id: 'pi-hole' },
      up: '',
      cpu: null,
      memory: null,
      disk: null,
      temp: null,
      history: { ...page.history, cpu: [], memory: [], cpuPeak: null, memoryAvg: null },
      volumes: [],
      guests: null,
      network: null,
    });
    expect(deskServerPageValid(off)).toBe(true);
  });

  it('fits the widest page in what the console server reads', () => {
    const e = (n: number) => '🎉'.repeat(n);
    const at = '2026-10-21T12:34:00.123456789+02:00';
    const meter = { value: 1_000, tone: 'bad' } as const;
    const widest = DeskServerPage.parse({
      v: 1,
      now: at,
      server: {
        ...card,
        name: e(40),
        mark: 'x'.repeat(32),
        note: e(40),
        id: `p${'x'.repeat(127)}`,
        disk: meter,
      },
      os: e(60),
      up: e(40),
      cpu: { percent: 100, cores: 4096, load: e(8), tone: 'bad' },
      memory: { percent: 100, used: { value: e(8), unit: e(8) }, total: e(16), tone: 'bad' },
      disk: { percent: 100, used: e(16), total: e(16), tone: 'bad' },
      temp: { value: -100, limit: -100, tone: 'bad' },
      history: {
        range: '24h',
        stepS: 86_400,
        cpu: Array(DESK_SERVER_POINTS).fill(100),
        memory: Array(DESK_SERVER_POINTS).fill(100),
        cpuPeak: { percent: 100, at },
        memoryAvg: 100,
      },
      volumes: Array(DESK_SERVER_VOLUMES).fill({
        name: e(40),
        note: e(40),
        percent: 100,
        used: e(16),
        total: e(16),
        tone: 'bad',
      }),
      guests: {
        running: 1_000_000,
        off: 1_000_000,
        items: Array(DESK_SERVER_GUESTS).fill({
          name: e(60),
          kind: 'container',
          state: 'unhealthy',
          cpu: 100,
          memory: e(16),
        }),
      },
      network: { down: e(16), up: e(16) },
      alerts: { count: 1_000_000, items: Array(DESK_SERVER_ALERTS).fill({ tone: 'bad', title: e(120) }) },
    });
    expect(deskServerPageValid(widest)).toBe(true);
    expect(utf8ByteLength(JSON.stringify(widest))).toBeLessThan(DESK_SERVER_MAX_BYTES);
  });
});

describe('task feedback on the desk (0.116, CT-890…CT-896)', () => {
  type Glance = NonNullable<DeskState['glance']>;
  const unlocked = { state: 'unlocked', until: '2026-10-21T14:06:00Z' } as const;
  const choice = { scope: 'agent', label: 'Don’t ask again on Home Assistant' } as const;
  const askWith = (patch: Record<string, unknown>, other: Record<string, unknown> = {}) => {
    const s = DeskState.parse(state);
    const g = s.glance as Glance;
    const ask = { ...(g.needsYou.items[0] as Glance['needsYou']['items'][number]), ...patch };
    return DeskState.parse({ ...s, glance: { ...g, needsYou: { count: 1, items: [ask] } }, ...other });
  };

  it('offers the web’s wider choices, after Approve, while unlocked, with a PIN, each scope once', () => {
    expect([...DESK_CHOICE_SCOPES]).toEqual(['task', 'agent']);
    expect(DESK_ASK_CHOICES).toBe(2);
    expect(deskStateValid(askWith({ choices: [choice] }, { lock: unlocked }))).toBe(true);
    expect(deskStateValid(askWith({ choices: [choice] }))).toBe(false);
    expect(
      deskStateValid(
        askWith(
          { choices: [choice], onDesk: false, phoneReason: 'release', approveWithPin: true },
          { lock: unlocked },
        ),
      ),
    ).toBe(true);
    expect(
      deskStateValid(
        askWith({ choices: [choice], onDesk: false, phoneReason: 'release' }, { lock: unlocked }),
      ),
    ).toBe(false);
    const paired = DeskState.parse(state).paired as NonNullable<DeskState['paired']>;
    expect(
      deskStateValid(
        askWith({ choices: [choice] }, { lock: unlocked, paired: { ...paired, hasPin: false } }),
      ),
    ).toBe(false);
    expect(deskStateValid(askWith({ choices: [choice, choice] }, { lock: unlocked }))).toBe(false);
    expect(
      DeskAsk.safeParse({
        ...askWith({}).glance?.needsYou.items[0],
        choices: [{ scope: 'once', label: 'Approve' }],
      }).success,
    ).toBe(false);
  });

  it('names who asks; an older console strips both members', () => {
    const s = askWith({ choices: [choice], from: 'Banjo' }, { lock: unlocked });
    expect(s.glance?.needsYou.items[0]?.from).toBe('Banjo');
    const older = DeskAsk.omit({ choices: true, from: true });
    const seen = older.parse(s.glance?.needsYou.items[0]);
    expect(Object.keys(seen)).not.toContain('choices');
    expect(Object.keys(seen)).not.toContain('from');
  });

  it('decides with a scope only on approve, and asks for the PIN for any wider one', () => {
    expect([...DESK_DECIDE_SCOPES]).toEqual(['once', 'task', 'agent']);
    expect(DESK_SOCKET_ERRORS).toContain('not_offered');
    expect(DESK_SOCKET_ERRORS).toContain('on_phone');
    const approve = DeskDecideRequest.parse({
      v: 1,
      number: 12,
      decision: 'approve',
      scope: 'agent',
      pin: '2580',
    });
    expect(deskDecideRequestValid(approve)).toBe(true);
    expect(deskDecideRequestValid({ decision: 'deny', scope: 'agent' })).toBe(false);
    expect(deskDecideRequestValid({ decision: 'deny' })).toBe(true);
    expect(DeskDecideRequest.safeParse({ ...approve, scope: 'forever' }).success).toBe(false);
    expect(deskDecideNeedsPin({}, approve)).toBe(true);
    expect(deskDecideNeedsPin({}, { decision: 'approve', scope: 'task' })).toBe(true);
    expect(deskDecideNeedsPin({}, { decision: 'approve', scope: 'once' })).toBe(false);
    expect(deskDecideNeedsPin({}, { decision: 'approve' })).toBe(false);
    expect(deskDecideNeedsPin({ approveWithPin: true }, { decision: 'approve' })).toBe(true);
    expect(deskDecideNeedsPin({ approveWithPin: true }, { decision: 'deny' })).toBe(false);
  });

  it('keeps a talk working, without an answer or a reason, until the turn ends', () => {
    expect(DESK_TALK_STATES).toContain('working');
    const talk = DeskTalk.parse({
      id: 'tlk_q3Vx9LpA0dZk',
      state: 'working',
      question: 'Update it',
      thing: null,
      audio: false,
    });
    expect(deskTalkValid(talk)).toBe(true);
    expect(deskTalkValid({ ...talk, answer: 'Done.' })).toBe(false);
    expect(deskTalkValid({ ...talk, reason: 'slow' })).toBe(false);
    expect(deskStateValid({ ...DeskState.parse(state), talk })).toBe(true);
  });

  const task = {
    title: 'Installing 23 updates on Home Assistant',
    state: 'running',
    startedAt: '2026-10-21T14:02:00Z',
  } as const;
  const message = (t: Record<string, unknown>) =>
    DeskSessionMessage.parse({
      id: 'msg_Lp7e3QrT1dYw',
      from: 'assistant',
      at: '2026-10-21T14:02:00Z',
      paragraphs: [t.title],
      task: t,
    });
  const session = (messages: DeskSessionMessage[], extra: Record<string, unknown> = {}) =>
    DeskTalkSession.parse({
      v: 1,
      open: true,
      messages,
      earlier: 0,
      until: '2026-10-21T14:32:00Z',
      ...extra,
    });

  it('shows the assistant working, only in an open conversation', () => {
    const working = { since: '2026-10-21T14:01:50Z', doing: 'Installing updates on Home Assistant' };
    expect(deskTalkSessionValid(session([], { working }))).toBe(true);
    expect(deskTalkSessionValid(session([], { working: { since: working.since } }))).toBe(true);
    expect(deskTalkSessionValid({ open: false, messages: [], earlier: 0, working })).toBe(false);
    expect(
      DeskTalkSession.safeParse({ ...session([]), working: { since: working.since, doing: 'x'.repeat(121) } })
        .success,
    ).toBe(false);
  });

  it('shows a task as a live row that ends with its result, never beside an ask', () => {
    expect([...DESK_TASK_STATES]).toEqual([...TASK_CARD_STATES]);
    const done = {
      ...task,
      state: 'ok',
      endedAt: '2026-10-21T14:06:12Z',
      result: 'Home Assistant is up to date.',
    };
    expect(deskTalkSessionValid(session([message(task), message(done)]))).toBe(true);
    expect(deskTalkSessionValid(session([message({ ...task, endedAt: done.endedAt })]))).toBe(false);
    expect(deskTalkSessionValid(session([message({ ...task, result: done.result })]))).toBe(false);
    expect(deskTalkSessionValid(session([message({ ...done, endedAt: undefined })]))).toBe(false);
    const both = { ...message(task), ask: { number: 12, state: 'waiting' as const } };
    expect(deskTalkSessionValid(session([both]))).toBe(false);
    // The page draws it with core's line; an older console strips the row and shows the paragraph.
    expect(taskCardLine({ ...done, state: 'ok' }, done.endedAt)).toContain('4 min');
    const older = DeskSessionMessage.omit({ task: true }).parse(message(done));
    expect(older.paragraphs).toEqual([task.title]);
  });

  it('keeps a task row small, so a conversation of rows fits what the console server reads', () => {
    const e = (n: number) => '🎉'.repeat(n);
    const wide = message({
      title: e(120),
      state: 'error',
      startedAt: task.startedAt,
      endedAt: task.startedAt,
      result: e(600),
    });
    const row = { ...wide, paragraphs: [e(120)] };
    expect(utf8ByteLength(JSON.stringify(row))).toBeLessThan(4_096);
    const full = session(Array(DESK_SESSION_MESSAGES).fill(row), {
      working: { since: task.startedAt, doing: e(120) },
    });
    expect(deskTalkSessionValid(full)).toBe(true);
    expect(utf8ByteLength(JSON.stringify(full))).toBeLessThan(DESK_SESSION_MAX_BYTES);
  });
});

describe('what needs a look, in Needs you (0.118, CT-970…CT-972)', () => {
  type Glance = NonNullable<DeskState['glance']>;
  const looks = [
    {
      key: 'server:pve-02',
      kind: 'server',
      name: 'pve-02',
      state: 'down',
      reason: 'Not answering',
      server: 'pve-02',
    },
    { key: 'connection:con_7Hq2v8LkP0aX', kind: 'connection', name: 'Home Assistant', state: 'look' },
  ] as const;
  const withLooks = (other: Record<string, unknown> = {}, list: readonly unknown[] = looks) => {
    const s = DeskState.parse(state);
    const g = s.glance as Glance;
    return DeskState.parse({ ...s, glance: { ...g, needsYou: { ...g.needsYou, looks: list } }, ...other });
  };

  it('lists servers, connections and devices, worst first, at most five', () => {
    expect([...DESK_LOOK_KINDS]).toEqual(['server', 'connection', 'device']);
    expect([...DESK_LOOK_STATES]).toEqual(['down', 'bad', 'look']);
    expect(DESK_LOOKS_MAX).toBe(5);
    expect(deskStateValid(withLooks())).toBe(true);
    expect(DeskNeedsYou.safeParse({ count: 0, items: [], looks: Array(6).fill(looks[1]) }).success).toBe(
      false,
    );
    expect(DeskNeedsYou.safeParse({ count: 0, items: [], looks: [] }).success).toBe(false);
    expect(DeskLook.safeParse({ ...looks[0], server: 'pve/02' }).success).toBe(false);
  });

  it('shows locked in a summary, never in Only the time', () => {
    const paired = DeskState.parse(state).paired as NonNullable<DeskState['paired']>;
    expect(deskStateValid(withLooks({ paired: { ...paired, lockedView: 'summary' } }))).toBe(true);
    const time = withLooks({ paired: { ...paired, lockedView: 'time' } });
    expect(deskStateValid({ ...time, glance: { ...(time.glance as Glance), servers: [], tiles: [] } })).toBe(
      false,
    );
  });

  it('is stripped by an older console', () => {
    const older = DeskNeedsYou.omit({ looks: true });
    expect(Object.keys(older.parse(withLooks().glance?.needsYou))).not.toContain('looks');
  });
});

describe('quieting a look (0.122, CT-1065)', () => {
  const look = {
    key: 'connection:con_unifi0000Ap',
    kind: 'connection',
    name: 'UniFi',
    state: 'look',
    reason: 'Hallway AP is offline',
    notice: { check: 'unifi.device_offline', subject: 'device:64a1c3f00e2b' },
    nature: 'problem',
    ignoreWords: 'Until it’s back online.',
    question: 'Why is Hallway AP offline in UniFi?',
  } as const;

  it('says the look’s line, kind, Ignore’s words and question; an older look parses as before', () => {
    expect(DeskLook.parse(look)).toEqual(look);
    expect(DeskLook.safeParse({ ...look, nature: 'you', question: undefined }).success).toBe(true);
    expect(DeskLook.safeParse({ ...look, notice: { check: 'offline' } }).success).toBe(false);
    expect(DeskLook.safeParse({ ...look, ignoreWords: 'x'.repeat(61) }).success).toBe(false);
    expect(DeskLook.safeParse({ ...look, question: 'Why\nnow?' }).success).toBe(false);
    const older = DeskLook.omit({ notice: true, nature: true, ignoreWords: true, question: true });
    expect(Object.keys(older.parse(look))).toEqual(['key', 'kind', 'name', 'state', 'reason']);
  });

  it('ignores or puts off a look, strictly, unlocked only', () => {
    expect(DESK_PATHS.lookQuiet).toBe('/v1/desk/look/quiet');
    expect([...DESK_LOOK_QUIET_HOWS]).toEqual(['ignore', 'snooze']);
    expect(DESK_SOCKET_ERRORS).toContain('not_allowed');
    const req = { v: 1, key: look.key, notice: look.notice, how: 'ignore' };
    expect(DeskLookQuietRequest.safeParse(req).success).toBe(true);
    expect(DeskLookQuietRequest.safeParse({ ...req, how: 'undo' }).success).toBe(false);
    expect(DeskLookQuietRequest.safeParse({ ...req, pin: '1234' }).success).toBe(false);
    expect(
      DeskLookQuietRequest.safeParse({ ...req, notice: { ...look.notice, name: 'Hallway AP' } }).success,
    ).toBe(false);
  });

  it('fits the widest request in a request the socket reads', () => {
    const e = (n: number) => '🎉'.repeat(n);
    const widest = DeskLookQuietRequest.parse({
      v: 1,
      key: e(120),
      notice: { check: `a.${'b'.repeat(78)}`, subject: e(160) },
      how: 'snooze',
    });
    expect(utf8ByteLength(JSON.stringify(widest))).toBeLessThan(DESK_REQUEST_MAX_BYTES);
  });
});
