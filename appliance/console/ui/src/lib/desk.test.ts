import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseState } from './api';
import { constList, deskSocketSource, deskWordsSource } from './contractsSource';
import {
  AGENT_FACES,
  ALERT_TONES,
  ASK_CHOICES,
  BOX_PARTS,
  CHOICE_SCOPES,
  DESK_LOCKED_VIEWS,
  DESK_SERVERS,
  deskErrorCode,
  GUEST_KINDS,
  GUEST_STATES,
  LOCK_STATES,
  PHONE_REASONS,
  parseDesk,
  parseServer,
  parseServerPage,
  parseServersAnswer,
  parseSession,
  parseTask,
  SERVER_ALERTS,
  SERVER_GUESTS,
  SERVER_ID_RE,
  SERVER_POINTS,
  SERVER_RANGES,
  SERVER_STATES,
  SERVER_VOLUMES,
  SESSION_ASK_STATES,
  SESSION_FROM,
  TALK_REASONS,
  TALK_STATES,
  TASK_STATES,
  TILE_ICONS,
  TONES,
  text,
} from './desk';

describe('the copied shapes', () => {
  it('know every value the contracts’ desk socket names', () => {
    expect(TILE_ICONS).toEqual(constList(deskSocketSource, 'DESK_TILE_ICONS'));
    expect(LOCK_STATES).toEqual(constList(deskSocketSource, 'DESK_LOCK_STATES'));
    expect(SERVER_STATES).toEqual(constList(deskSocketSource, 'DESK_SERVER_STATES'));
    expect(TONES).toEqual(constList(deskSocketSource, 'DESK_TONES'));
    expect(TALK_STATES).toEqual(constList(deskSocketSource, 'DESK_TALK_STATES'));
    expect(TALK_REASONS).toEqual(constList(deskSocketSource, 'DESK_TALK_REASONS'));
    expect(PHONE_REASONS).toEqual(constList(deskWordsSource, 'DESK_PHONE_REASONS'));
    expect(DESK_LOCKED_VIEWS).toEqual(constList(deskWordsSource, 'DESK_LOCKED_VIEWS'));
    expect(BOX_PARTS).toEqual(constList(deskWordsSource, 'DESK_BOX_PARTS'));
    expect(deskWordsSource).toContain('export const DESK_BOX_POINTS = 60;');
  });

  it('know the PIN’s lengths and the lock’s camera members (0.103, DK-26, DK-30)', () => {
    expect(deskWordsSource).toContain('export const DESK_PIN_MIN = 4;');
    expect(deskWordsSource).toContain('export const DESK_PIN_MAX = 6;');
    for (const member of ['pinDigits:', 'camera:', 'present:']) expect(deskSocketSource).toContain(member);
  });

  it('know This Whombat beside servers and the next four of each, four at most (0.104, DK-39, DK-41)', () => {
    expect(deskSocketSource).toContain('self: DeskBox.optional()');
    expect(deskSocketSource).toContain('extraServers: z.array(DeskServer).max(4).optional()');
    expect(deskSocketSource).toContain('extraTiles: z.array(DeskTile).max(4).optional()');
    expect(deskSocketSource).toContain('servers: z.array(DeskServer).max(4),');
  });

  it('know the agent by its face (0.123, OA-08, CG-337)', () => {
    expect(deskSocketSource).toContain('face: AgentFace');
    expect(deskSocketSource).not.toContain('look: AgentRole');
    expect(AGENT_FACES).toEqual(['dusty', 'banjo', 'neo', 'skipper', 'hazel']);
  });

  it('know the lock that stays and the camera looking for someone (0.107, DK-72, DK-74)', () => {
    expect(deskSocketSource).toContain('stays: z.boolean().optional()');
    expect(deskSocketSource).toContain('presence: DeskPresence.optional()');
    for (const member of ['camera: z.boolean()', 'watching: z.boolean()', 'here: z.boolean()'])
      expect(deskSocketSource).toContain(member);
  });
});

const base = {
  v: 1,
  now: '2026-10-20T12:34:00Z',
  paired: {
    person: { name: 'John', initial: 'J', tone: 3 },
    assistant: { name: 'Neo', face: 'neo' },
    timeZone: 'Europe/Amsterdam',
    lockedView: 'summary',
    night: 'dim',
    quiet: false,
    voice: true,
  },
  pairing: null,
  lock: { state: 'locked' },
  glance: {
    status: { text: '2 things need you.' },
    needsYou: { count: 2, items: [] },
    working: null,
    done: [],
    servers: [
      { name: 'pve-01', mark: 'proxmox', state: 'ok', note: 'up 41 d', cpu: { value: 18, tone: 'ok' } },
    ],
    moreServers: 0,
    tiles: [],
  },
  power: null,
  talk: null,
};

describe('asks and the conversation (0.108, DK-60…DK-64, CG-192, CG-196)', () => {
  it('know the values and members the contracts name', () => {
    expect(SESSION_FROM).toEqual(constList(deskSocketSource, 'DESK_SESSION_FROM'));
    expect(SESSION_ASK_STATES).toEqual(constList(deskSocketSource, 'DESK_SESSION_ASK_STATES'));
    expect(constList(deskSocketSource, 'DESK_DECISIONS')).toEqual(['approve', 'decline', 'deny']);
    for (const member of [
      'deny:',
      'approveWithPin:',
      'inTalk:',
      'talkSession:',
      'talkClose:',
      "'pin_needed'",
    ])
      expect(deskSocketSource).toContain(member);
  });

  it('reads Deny, the PIN to approve and the conversation’s ask only as Whombat said them', () => {
    const ask = { number: 7, kind: 'approval', title: 'Deploy?', at: '2026-10-20T12:31:00Z' };
    const d = parseDesk({
      ...base,
      glance: {
        ...base.glance,
        needsYou: {
          count: 3,
          items: [
            { ...ask, onDesk: false, phoneReason: 'release', deny: true, approveWithPin: true, inTalk: true },
            { ...ask, number: 8, onDesk: true, approveWithPin: true, deny: 'yes' },
            { ...ask, number: 9 },
          ],
        },
      },
    });
    expect(d?.glance?.needsYou.items.map((a) => [a.deny, a.approveWithPin, a.inTalk])).toEqual([
      [true, true, true],
      [false, false, false],
      [false, false, false],
    ]);
  });

  it('reads the conversation, drops what it doesn’t understand, and nothing of a closed one', () => {
    const m = {
      id: 'msg_Hq2v8LkP',
      from: 'you',
      at: '2026-10-20T12:30:00Z',
      paragraphs: ['Is pve-02 okay?'],
    };
    const s = parseSession({
      v: 1,
      open: true,
      earlier: 2,
      until: '2026-10-20T13:00:00Z',
      messages: [
        m,
        {
          ...m,
          id: 'msg_Jt5c1MnQ',
          from: 'assistant',
          ask: { number: 12, state: 'waiting' },
          talk: 'dtk_0001abcd',
          audio: true,
        },
        { ...m, id: 'msg_x', from: 'you' },
        { ...m, id: 'msg_Kr4d2NpS', from: 'someone' },
        { ...m, id: 'msg_Lw7f3QrT', paragraphs: [' ', 42] },
        { ...m, id: 'msg_Mz8g4SsU', ask: { number: 0, state: 'waiting' } },
      ],
    });
    expect(s?.messages.map((x) => x.id)).toEqual(['msg_Hq2v8LkP', 'msg_Jt5c1MnQ', 'msg_Mz8g4SsU']);
    expect(s?.messages[1]).toMatchObject({
      ask: { number: 12, state: 'waiting' },
      talk: 'dtk_0001abcd',
      audio: true,
    });
    expect(s?.messages[2]?.ask).toBeNull();
    expect(s?.earlier).toBe(2);
    expect(parseSession({ v: 1, open: false, messages: [m], earlier: 3 })).toEqual({
      open: false,
      messages: [],
      earlier: 0,
      until: null,
      working: null,
    });
    expect(parseSession({ v: 2, open: true, messages: [] })).toBeNull();
    expect(parseSession({ message: 'not_found' })).toBeNull();
  });
});

describe('task feedback (0.116, TF-14…TF-17, CG-280, CG-284)', () => {
  const ask = {
    number: 7,
    kind: 'approval',
    title: 'Install updates on Home Assistant?',
    at: '2026-10-20T12:31:00Z',
    onDesk: true,
  };
  const choices = [
    { scope: 'agent', label: 'Don’t ask again on Home Assistant' },
    { scope: 'task', label: 'Allow for this task' },
  ];
  const unlocked = { state: 'unlocked', until: '2026-10-20T12:36:00Z' };
  const withAsk = (a: object, more: object = {}) =>
    parseDesk({
      ...base,
      lock: unlocked,
      glance: { ...base.glance, needsYou: { count: 1, items: [{ ...ask, ...a }] } },
      ...more,
    })?.glance?.needsYou.items[0];

  it('know the values and members the contracts name', () => {
    expect(CHOICE_SCOPES).toEqual(constList(deskSocketSource, 'DESK_CHOICE_SCOPES'));
    expect(deskSocketSource).toContain('export const DESK_ASK_CHOICES = DESK_CHOICE_SCOPES.length;');
    expect(ASK_CHOICES).toBe(2);
    expect(deskSocketSource).toContain('export const DESK_TASK_STATES = TASK_CARD_STATES;');
    expect(TASK_STATES).toEqual(['running', 'ok', 'warning', 'error', 'lost']);
    for (const member of [
      'choices: z.array(DeskAskChoice)',
      'from: text(40).optional()',
      'label: text(120)',
      'working: DeskSessionWorking.optional()',
      'task: DeskSessionTask.optional()',
      'doing: text(120).optional()',
      'title: text(120),',
      "'not_offered'",
    ])
      expect(deskSocketSource).toContain(member);
  });

  it('reads an ask’s choices in their order, and who asks', () => {
    const a = withAsk({ choices, from: ' Banjo ' });
    expect(a?.choices).toEqual(choices);
    expect(a?.from).toBe('Banjo');
    expect(withAsk({})?.choices).toEqual([]);
    expect(withAsk({})?.from).toBeNull();
    // A risky ask approved with the PIN may have them too (DK-62).
    const risky = { onDesk: false, phoneReason: 'release', deny: true, approveWithPin: true, choices };
    expect(withAsk(risky)?.choices).toHaveLength(2);
  });

  it('leaves out choices the screen may not offer: locked, on the phone, a question, no PIN', () => {
    expect(withAsk({ choices }, { lock: { state: 'locked' } })?.choices).toEqual([]);
    expect(withAsk({ choices, onDesk: false, phoneReason: 'keys' })?.choices).toEqual([]);
    expect(withAsk({ choices, kind: 'question' })?.choices).toEqual([]);
    expect(withAsk({ choices }, { paired: { ...base.paired, hasPin: false } })?.choices).toEqual([]);
  });

  it('keeps each scope once, two at most, and only ones it knows with a label', () => {
    const odd = [
      { scope: 'agent', label: 'First' },
      { scope: 'agent', label: 'Again' },
      { scope: 'once', label: 'Once' },
      { scope: 'task', label: ' ' },
    ];
    expect(withAsk({ choices: odd })?.choices).toEqual([{ scope: 'agent', label: 'First' }]);
    expect(withAsk({ choices: [...choices, { scope: 'agent', label: 'Third' }] })?.choices).toEqual(choices);
    expect(withAsk({ choices: 'agent' })?.choices).toEqual([]);
  });

  const task = {
    title: 'Installing 23 updates on Home Assistant',
    state: 'running',
    startedAt: '2026-10-20T12:31:00Z',
  };

  it('reads a task’s row only as the contracts allow it', () => {
    expect(parseTask(task)).toEqual({ ...task, endedAt: null, result: null });
    const ended = { ...task, state: 'ok', endedAt: '2026-10-20T12:35:00Z', result: 'All 23 installed.' };
    expect(parseTask(ended)).toEqual(ended);
    expect(parseTask({ ...ended, result: undefined })?.result).toBeNull();
    expect(parseTask({ ...task, endedAt: '2026-10-20T12:35:00Z' })).toBeNull();
    expect(parseTask({ ...task, result: 'x' })).toBeNull();
    expect(parseTask({ ...task, state: 'ok' })).toBeNull();
    expect(parseTask({ ...task, state: 'failed' })).toBeNull();
    expect(parseTask({ ...task, title: ' ' })).toBeNull();
    expect(parseTask({ ...task, startedAt: 'now' })).toBeNull();
  });

  it('reads the conversation’s working row and task rows, never a task beside an ask', () => {
    const m = {
      id: 'msg_Tk1a2b3c',
      from: 'assistant',
      at: '2026-10-20T12:31:00Z',
      paragraphs: ['Installing · 2 s'],
    };
    const s = parseSession({
      v: 1,
      open: true,
      earlier: 0,
      until: '2026-10-20T13:00:00Z',
      working: { since: '2026-10-20T12:30:05Z', doing: ' Installing updates on Home Assistant ' },
      messages: [
        { ...m, task },
        { ...m, id: 'msg_Tk9z8y7x', task, ask: { number: 3, state: 'waiting' } },
        { ...m, id: 'msg_Tk5v4u3t', task: { ...task, state: 'nope' } },
      ],
    });
    expect(s?.working).toEqual({
      since: '2026-10-20T12:30:05Z',
      doing: 'Installing updates on Home Assistant',
    });
    expect(s?.messages[0]?.task?.title).toBe(task.title);
    expect(s?.messages[1]?.task).toBeNull();
    expect(s?.messages[1]?.ask?.number).toBe(3);
    // A task the page can't read shows as its paragraphs (the card's line).
    expect(s?.messages[2]?.task).toBeNull();
    expect(s?.messages[2]?.paragraphs).toEqual(['Installing · 2 s']);
    const noDoing = parseSession({ ...s, v: 1, working: { since: '2026-10-20T12:30:05Z' } });
    expect(noDoing?.working).toEqual({ since: '2026-10-20T12:30:05Z', doing: null });
    expect(parseSession({ ...s, v: 1, working: { doing: 'x' } })?.working).toBeNull();
  });
});

describe('parseDesk', () => {
  it('reads the desk the console server passes through', () => {
    const d = parseDesk(base);
    expect(d?.paired?.assistant).toEqual({ name: 'Neo', face: 'neo' });
    expect(d?.lock.state).toBe('locked');
    expect(d?.glance?.needsYou.count).toBe(2);
    expect(d?.glance?.servers[0]?.cpu).toEqual({ value: 18, tone: 'ok' });
    expect(d?.glance?.servers[0]?.memory).toBeNull();
  });

  it('is null for no desk, another version or a broken one (the console stays as it is)', () => {
    expect(parseDesk(null)).toBeNull();
    expect(parseDesk({ ...base, v: 2 })).toBeNull();
    expect(parseDesk({ ...base, now: 'yesterday' })).toBeNull();
    expect(parseDesk('desk')).toBeNull();
  });

  it('treats a lock it doesn’t know as locked and a missing view as the default summary', () => {
    const d = parseDesk({ ...base, lock: { state: 'open' }, paired: { ...base.paired, lockedView: 'all' } });
    expect(d?.lock.state).toBe('locked');
    expect(d?.paired?.lockedView).toBe('summary');
  });

  it('gives buttons only to asks Whombat marked for the desk', () => {
    const ask = { number: 7, kind: 'approval', title: 'Restart Plex?', at: '2026-10-20T12:31:00Z' };
    const d = parseDesk({
      ...base,
      glance: { ...base.glance, needsYou: { count: 1, items: [ask, { ...ask, number: 8, onDesk: true }] } },
    });
    expect(d?.glance?.needsYou.items.map((a) => a.onDesk)).toEqual([false, true]);
    expect(d?.glance?.needsYou.count).toBe(2);
  });

  it('drops pieces it doesn’t understand and cuts strings to their length', () => {
    const d = parseDesk({
      ...base,
      glance: {
        ...base.glance,
        servers: [{ name: '' }, { name: 'x'.repeat(60), mark: 'proxmox' }, 'nope'],
        tiles: [{ icon: 'rocket', value: '21 °C', label: 'Office' }],
      },
    });
    expect(d?.glance?.servers).toHaveLength(1);
    expect(d?.glance?.servers[0]?.name).toHaveLength(40);
    expect(d?.glance?.tiles[0]?.icon).toBe('generic');
  });

  it('falls back to UTC for a time zone it can’t use and to Dusty’s face for an unknown face', () => {
    const d = parseDesk({
      ...base,
      paired: { ...base.paired, timeZone: 'Mars/Olympus', assistant: { name: 'Neo', face: 'astronaut' } },
    });
    expect(d?.paired?.timeZone).toBe('UTC');
    expect(d?.paired?.assistant.face).toBe('dusty');
  });

  it('shows pairing letters only when they are four letters of the claim code alphabet', () => {
    const at = '2026-10-20T12:44:00Z';
    expect(parseDesk({ ...base, pairing: { code: 'HBRT', expiresAt: at } })?.pairing?.code).toBe('HBRT');
    expect(parseDesk({ ...base, pairing: { code: 'hb rt', expiresAt: at } })?.pairing).toBeNull();
    expect(parseDesk({ ...base, pairing: { code: 'HBIT', expiresAt: at } })?.pairing).toBeNull();
  });

  it('takes talks with an id it can put in a URL, marks it can draw, figures as whole numbers', () => {
    const talk = { id: 'talk-0001', state: 'thinking', thing: null, audio: false };
    expect(parseDesk({ ...base, talk })?.talk?.id).toBe('talk-0001');
    expect(parseDesk({ ...base, talk: { ...talk, id: '../x?y' } })?.talk).toBeNull();
    const s = parseDesk({
      ...base,
      glance: {
        ...base.glance,
        servers: [
          { name: 'a', mark: 'Proxmox!', state: 'ok', note: '', temp: { value: 71.6, tone: 'warn' } },
        ],
      },
    })?.glance?.servers[0];
    expect(s?.mark).toBeNull();
    expect(s?.temp).toEqual({ value: 72, tone: 'warn' });
  });

  it('rides along in the console state; an unknown desk keeps today’s console', () => {
    const s = parseState({ mode: 'console', now: base.now, claim: null, footer: '', desk: { v: 9 } });
    expect(s?.mode === 'console' && s.desk).toBeNull();
    const t = parseState({ mode: 'console', now: base.now, claim: null, footer: '', desk: base });
    expect(t?.mode === 'console' && t.desk?.paired?.person.name).toBe('John');
  });
});

const newBox = {
  up: 'up 2 h 14 min',
  cpu: { percent: 7, cores: 16, tone: 'ok' },
  memory: { percent: 18, used: { value: '11.2', unit: 'GB' }, total: '64 GB', tone: 'ok' },
  history: { stepS: 60, cpu: [6, null, 9, 7], memory: [17, null, 18, 18] },
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
const fresh = (box: unknown, g: Record<string, unknown> = {}) =>
  parseDesk({ ...base, glance: { ...base.glance, servers: [], tiles: [], box, ...g } })?.glance?.box;

describe('This Whombat (DK-22, CG-57)', () => {
  it('reads the box’s figures as the runtime wrote them', () => {
    const b = fresh(newBox);
    expect(b?.memory.used).toEqual({ value: '11.2', unit: 'GB' });
    expect(b?.history.cpu).toEqual([6, null, 9, 7]);
    expect(b?.storage.parts.map((p) => p.key)).toEqual(['whombat', 'agent']);
    expect(b?.temp).toEqual({ value: 46, tone: 'ok' });
    expect(b?.network?.down).toBe('2.4 MB/s');
  });

  it('makes way for the first server or home tile', () => {
    expect(fresh(newBox, { servers: base.glance.servers })).toBeNull();
    expect(fresh(newBox, { tiles: [{ icon: 'sun', value: '3.2 kW', label: 'Solar' }] })).toBeNull();
  });

  it('is left out when what it can’t do without is missing; the temperature, network and uptime may be', () => {
    expect(fresh({ ...newBox, storage: undefined })).toBeNull();
    expect(fresh({ ...newBox, memory: { ...newBox.memory, used: { value: '', unit: 'GB' } } })).toBeNull();
    const vm = fresh({ ...newBox, temp: undefined, network: null, up: '' });
    expect(vm?.temp).toBeNull();
    expect(vm?.network).toBeNull();
    expect(vm?.up).toBe('');
  });

  it('keeps the two series the same length, ending now, gaps where a point isn’t a percentage', () => {
    const b = fresh({ ...newBox, history: { stepS: 60, cpu: [1, 2, 3, 'x', 250], memory: [5, 6] } });
    expect(b?.history.cpu).toEqual([null, 100]);
    expect(b?.history.memory).toEqual([5, 6]);
  });

  it('keeps the parts in their order, once each, and none it doesn’t know', () => {
    const parts = [
      { key: 'agent', value: '84 GB', percent: 9 },
      { key: 'photos', value: '1 GB', percent: 1 },
    ];
    expect(fresh({ ...newBox, storage: { ...newBox.storage, parts } })?.storage.parts).toEqual([
      { key: 'agent', value: '84 GB', percent: 9 },
    ]);
  });
});

describe('This Whombat beside servers, and the next four (0.104, DK-39, DK-41, CG-135)', () => {
  const server = (name: string) => ({ name, mark: 'proxmox', state: 'ok', note: 'up 41 d' });
  const tile = (value: string) => ({ icon: 'sun', value, label: 'Solar' });
  const four = ['a', 'b', 'c', 'd'];
  const glance = (g: Record<string, unknown>) =>
    parseDesk({ ...base, glance: { ...base.glance, ...g } })?.glance;

  it('reads This Whombat beside servers or tiles as `self`, never beside nothing', () => {
    expect(glance({ self: newBox })?.self?.up).toBe('up 2 h 14 min');
    expect(glance({ self: newBox })?.box).toBeNull();
    expect(glance({ servers: [], tiles: [tile('3 kW')], self: newBox })?.self?.cpu.percent).toBe(7);
    // A new box's is `box` (DK-22); a `self` there is left out, as a broken one is.
    expect(glance({ servers: [], tiles: [], self: newBox })?.self ?? null).toBeNull();
    expect(glance({ self: { ...newBox, storage: undefined } })?.self ?? null).toBeNull();
  });

  it('is as before from a runtime before 0.104: no `self`, no extras', () => {
    const g = glance({});
    expect(g?.self ?? null).toBeNull();
    expect(g?.extraServers ?? []).toEqual([]);
    expect(g?.extraTiles ?? []).toEqual([]);
  });

  it('takes the next four servers and tiles only beside a full four, at most four more', () => {
    const g = glance({
      servers: four.map(server),
      extraServers: ['e', 'f', 'g', 'h', 'i'].map(server),
      moreServers: 7,
      tiles: four.map(tile),
      extraTiles: [tile('5'), { icon: 'sun' }],
    });
    expect(g?.extraServers?.map((s) => s.name)).toEqual(['e', 'f', 'g', 'h']);
    expect(g?.moreServers).toBe(7);
    expect(g?.extraTiles?.map((t) => t.value)).toEqual(['5']);
    const short = glance({ servers: four.slice(0, 3).map(server), extraServers: [server('e')] });
    expect(short?.extraServers).toEqual([]);
    // The count holds the extra servers at least.
    expect(
      glance({ servers: four.map(server), extraServers: [server('e')], moreServers: 0 })?.moreServers,
    ).toBe(1);
  });
});

describe('a screen without a PIN (DK-18)', () => {
  it('has a PIN unless Whombat says it hasn’t (older runtimes send nothing)', () => {
    expect(parseDesk(base)?.paired?.hasPin).toBe(true);
    expect(parseDesk({ ...base, paired: { ...base.paired, hasPin: false } })?.paired?.hasPin).toBe(false);
    expect(parseDesk({ ...base, paired: { ...base.paired, hasPin: 'no' } })?.paired?.hasPin).toBe(true);
  });
});

describe('the PIN’s length and the camera (DK-26, DK-28, DK-30)', () => {
  const digits = (pinDigits: unknown) =>
    parseDesk({ ...base, paired: { ...base.paired, pinDigits } })?.paired?.pinDigits;
  const unlocked = { state: 'unlocked', until: '2026-10-20T12:34:30Z' };
  const lock = (l: object) => parseDesk({ ...base, lock: l })?.lock;

  it('knows 4 to 6 digits; anything else is the length from before (6)', () => {
    expect(digits(4)).toBe(4);
    expect(digits(6)).toBe(6);
    for (const n of [3, 7, 4.5, '4', null]) expect(digits(n)).toBeUndefined();
  });

  it('shows the camera only while unlocked, and someone there only with the camera on', () => {
    expect(lock({ ...unlocked, camera: true, present: true })).toMatchObject({ camera: true, present: true });
    expect(lock({ ...unlocked, camera: true })).toMatchObject({ camera: true, present: false });
    expect(lock({ ...unlocked, present: true })).toMatchObject({ camera: false, present: false });
    expect(lock({ ...unlocked, camera: 'yes' })).toMatchObject({ camera: false });
    expect(lock({ state: 'locked', camera: true, present: true })).toMatchObject({
      camera: false,
      present: false,
    });
    expect(lock({ state: 'open', camera: true })).toMatchObject({ state: 'locked', camera: false });
    expect(lock(unlocked)).toMatchObject({ camera: false, present: false });
  });
});

describe('the lock that stays and the camera looking (0.107, DK-72, DK-74)', () => {
  const unlocked = { state: 'unlocked', until: '2026-10-20T12:36:00Z' };
  const lock = (l: object) => parseDesk({ ...base, lock: l })?.lock;
  const presence = (p: unknown, paired: unknown = base.paired) =>
    parseDesk({ ...base, paired, presence: p })?.presence;

  it('reads stays only on an unlocked lock, as an explicit true', () => {
    expect(lock({ ...unlocked, stays: true })?.stays).toBe(true);
    expect(lock(unlocked)?.stays).toBe(false);
    expect(lock({ ...unlocked, stays: 'yes' })?.stays).toBe(false);
    expect(lock({ state: 'locked', stays: true })?.stays).toBe(false);
    expect(lock({ state: 'phone', expiresAt: '2026-10-20T12:36:00Z', stays: true })?.stays).toBe(false);
  });

  it('reads the camera’s presence on a paired screen; none without one, from an older runtime or unpaired', () => {
    expect(presence({ camera: true, watching: true, here: true })).toEqual({
      camera: true,
      watching: true,
      here: true,
    });
    expect(presence({ camera: true, watching: 'yes', here: 1 })).toEqual({
      camera: true,
      watching: false,
      here: false,
    });
    expect(presence(undefined)).toBeUndefined();
    expect(presence([true, true, true])).toBeUndefined();
    expect(presence({ camera: true, watching: true, here: true }, null)).toBeUndefined();
    expect(parseDesk(base)).not.toHaveProperty('presence');
  });
});

describe('text', () => {
  it('cuts by characters, not UTF-16 units', () => {
    expect(text('🦘🦘🦘', 2)).toBe('🦘🦘');
    expect(text('  ', 5)).toBeNull();
  });
});

describe('deskErrorCode (CG-56)', () => {
  it('reads the code where the console server writes it', () => {
    // console/internal/web/web.go: every error, the desk's included (consoleapi.deskError), is {"<key>": code}.
    const webGo = readFileSync(new URL('../../../internal/web/web.go', import.meta.url), 'utf8');
    const key =
      /func Error\(w http\.ResponseWriter, status int, msg string\) \{\s*JSON\(w, status, map\[string\]string\{"(\w+)": msg\}\)/.exec(
        webGo,
      )?.[1];
    expect(key).toBe('message');
    for (const code of ['locked', 'busy', 'decided', 'on_phone', 'voice_unavailable']) {
      expect(deskErrorCode(JSON.parse(`{"${key}":"${code}"}\n`))).toBe(code);
    }
  });

  it('takes a code member first, and nothing from anything else', () => {
    expect(deskErrorCode({ code: 'busy', message: 'failed' })).toBe('busy');
    expect(deskErrorCode({ message: 3 })).toBeNull();
    expect(deskErrorCode(null)).toBeNull();
    expect(deskErrorCode('locked')).toBeNull();
    expect(deskErrorCode(['locked'])).toBeNull();
  });
});

describe('server cards and a server’s own screen (0.115, DK-80…DK-88, CG-253)', () => {
  it('know the contracts’ ranges, states, kinds, tones, bounds and the server id’s pattern', () => {
    expect(SERVER_RANGES).toEqual(constList(deskWordsSource, 'DESK_SERVER_RANGES'));
    expect(GUEST_STATES).toEqual(constList(deskWordsSource, 'DESK_GUEST_STATES'));
    expect(GUEST_KINDS).toEqual(constList(deskSocketSource, 'DESK_GUEST_KINDS'));
    expect(ALERT_TONES).toEqual(constList(deskSocketSource, 'DESK_SERVER_ALERT_TONES'));
    expect(deskWordsSource).toContain(`export const DESK_SERVER_ID_RE = ${SERVER_ID_RE.toString()};`);
    expect(deskSocketSource).toContain(`export const DESK_SERVERS = ${DESK_SERVERS};`);
    expect(deskSocketSource).toContain(`export const DESK_SERVER_POINTS = ${SERVER_POINTS};`);
    expect(deskSocketSource).toContain(`export const DESK_SERVER_VOLUMES = ${SERVER_VOLUMES};`);
    expect(deskSocketSource).toContain(`export const DESK_SERVER_GUESTS = ${SERVER_GUESTS};`);
    expect(deskSocketSource).toContain(`export const DESK_SERVER_ALERTS = ${SERVER_ALERTS};`);
  });

  const base = { name: 'pve-01', mark: 'proxmox', state: 'ok', note: 'up 41 d' };

  it('reads a card’s id (the hosts service’s slug, short ones too) and its disk; an older runtime’s has neither', () => {
    expect(parseServer({ ...base, id: 'nas', disk: { value: 88, tone: 'warn' } })).toMatchObject({
      id: 'nas',
      disk: { value: 88, tone: 'warn' },
    });
    expect(parseServer({ ...base, id: 'host.lan:2' })?.id).toBe('host.lan:2');
    for (const id of ['', '../x', 'a/b', '.hidden', 'x'.repeat(129), 7])
      expect(parseServer({ ...base, id })).not.toHaveProperty('id');
    const old = parseServer(base);
    expect(old).not.toHaveProperty('id');
    expect(old?.disk).toBeNull();
  });

  it('reads every server: the cards it understands, at most 24, the rest counted', () => {
    const cards = Array.from({ length: 30 }, (_, i) => ({ ...base, id: `srv-${i}`, name: `srv-${i}` }));
    const a = parseServersAnswer({ v: 1, servers: cards, more: 6 });
    expect(a?.servers).toHaveLength(DESK_SERVERS);
    expect(a?.servers[0]?.id).toBe('srv-0');
    expect(a?.more).toBe(6);
    expect(parseServersAnswer({ v: 1, servers: [{ name: '' }, cards[0]], more: 0 })?.servers).toHaveLength(1);
    expect(parseServersAnswer({ v: 2, servers: [], more: 0 })).toBeNull();
    expect(parseServersAnswer({ v: 1, more: 0 })).toBeNull();
  });

  const page = {
    v: 1,
    now: '2026-10-21T12:34:20Z',
    server: { ...base, id: 'pve-01', cpu: { value: 18, tone: 'ok' } },
    os: 'Proxmox VE 9.0.10',
    up: 'up 41 d',
    cpu: { percent: 18, cores: 16, load: '2.9', tone: 'ok' },
    memory: { percent: 54, used: { value: '69', unit: 'GB' }, total: '128 GB', tone: 'ok' },
    disk: { percent: 33, used: '1.2', total: '3.6 TB', tone: 'ok' },
    temp: { value: 46, limit: 85, tone: 'ok' },
    history: {
      range: '24h',
      stepS: 900,
      cpu: [1, 2, null, 61],
      memory: [50, 52, 54],
      cpuPeak: { percent: 61, at: '2026-10-21T01:10:00Z' },
      memoryAvg: 52,
    },
    volumes: [
      { name: 'local-zfs', note: 'nvme mirror', percent: 41, used: '0.8', total: '1.9 TB', tone: 'ok' },
      { name: '', note: '', percent: 1, used: '1', total: '2', tone: 'ok' },
    ],
    guests: {
      running: 1,
      off: 1,
      items: [
        { name: 'plex', kind: 'vm', state: 'running', cpu: 22, memory: '6.1 GB' },
        { name: 'win11', kind: 'vm', state: 'stopped', cpu: null, memory: '' },
        { name: 'odd', kind: 'jail', state: 'running', cpu: 1, memory: '' },
      ],
    },
    network: { down: '24 MB/s', up: '3.1 MB/s' },
    alerts: {
      count: 0,
      items: [
        { tone: 'bad', title: 'Down' },
        { tone: 'info', title: 'x' },
      ],
    },
  };

  it('reads a server’s screen, leaving out what it doesn’t understand', () => {
    const p = parseServerPage(page, 'pve-01');
    expect(p?.server.id).toBe('pve-01');
    expect(p?.cpu).toEqual({ percent: 18, cores: 16, load: '2.9', tone: 'ok' });
    expect(p?.disk?.used).toBe('1.2');
    // The two series the same length, ending now.
    expect(p?.history.cpu).toEqual([2, null, 61]);
    expect(p?.history.memory).toEqual([50, 52, 54]);
    expect(p?.volumes.map((v) => v.name)).toEqual(['local-zfs']);
    expect(p?.guests?.items.map((g) => g.name)).toEqual(['plex', 'win11']);
    // The count holds the titles sent at least; a tone it doesn't know is left out.
    expect(p?.alerts).toEqual({ count: 1, items: [{ tone: 'bad', title: 'Down' }] });
    expect(parseServerPage({ ...page, guests: null, cpu: null, temp: {} }, 'pve-01')).toMatchObject({
      guests: null,
      cpu: null,
      temp: null,
    });
  });

  it('keeps the latest 96 points of a long series', () => {
    const long = Array.from({ length: 120 }, (_, i) => i % 100);
    const p = parseServerPage({ ...page, history: { ...page.history, cpu: long, memory: long } }, 'pve-01');
    expect(p?.history.cpu).toHaveLength(SERVER_POINTS);
    expect(p?.history.cpu.at(-1)).toBe(19);
  });

  it('refuses another server’s page, a page without its card or its clock, and another version', () => {
    expect(parseServerPage(page, 'pve-02')).toBeNull();
    expect(parseServerPage({ ...page, server: base }, 'pve-01')).toBeNull();
    expect(parseServerPage({ ...page, now: 'soon' }, 'pve-01')).toBeNull();
    expect(parseServerPage({ ...page, v: 2 }, 'pve-01')).toBeNull();
    expect(parseServerPage(null, 'pve-01')).toBeNull();
  });
});
