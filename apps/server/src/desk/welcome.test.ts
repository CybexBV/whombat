import { DESK_DIGEST_ITEMS, DESK_WELCOME_AWAY_S, DESK_WELCOME_SHOW_S, DeskDigest } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { DeskLookLog, DeskWelcome, LOOK_LOG_KEEP_MS, type WelcomeFacts, welcomeItems } from './welcome';

const T0 = Date.parse('2026-10-27T08:00:00.000Z');
const MIN = 60_000;
const AWAY = DESK_WELCOME_AWAY_S * 1_000;

const down = { key: 'server:pve-02', name: 'pve-02', state: 'down' as const, server: 'pve-02' };
const disk = { key: 'server:nas', name: 'nas', state: 'look' as const, server: 'nas' };
const ha = { key: 'connection:con_ha', name: 'Home Assistant', state: 'bad' as const };
const KEYS = ['server:pve-02', 'server:nas', 'connection:con_ha'];

describe('what the runtime saw change (DK-S128)', () => {
  it('starts at the first read, then says what began, got worse and went', () => {
    const log = new DeskLookLog();
    log.observe([disk], KEYS, T0);
    expect(log.changesSince(0)).toEqual([]);
    expect(log.since('server:nas')).toBeUndefined();
    log.observe([disk, down], KEYS, T0 + MIN);
    expect(log.since('server:pve-02')).toBe(new Date(T0 + MIN).toISOString());
    log.observe([{ ...disk, state: 'bad' }, down], KEYS, T0 + 2 * MIN);
    log.observe([{ ...disk, state: 'bad' }], KEYS, T0 + 3 * MIN);
    expect(log.changesSince(T0).map((c) => [c.key, c.icon])).toEqual([
      ['server:nas', 'down'],
      ['server:pve-02', 'up'],
    ]);
    expect(log.changesSince(T0).find((c) => c.icon === 'up')?.text).toContain('pve-02');
    expect(log.since('server:pve-02')).toBeUndefined();
    // Only what changed from then on.
    expect(log.changesSince(T0 + 3 * MIN).map((c) => c.key)).toEqual(['server:pve-02']);
  });

  it('keeps a look whose subject wasn’t read this time, and forgets what is a day old', () => {
    const log = new DeskLookLog();
    log.observe([down, ha], KEYS, T0);
    // The fleet didn't answer: its servers weren't read, so pve-02 didn't come back.
    log.observe([ha], ['connection:con_ha'], T0 + MIN);
    expect(log.changesSince(T0)).toEqual([]);
    log.observe([], KEYS, T0 + 2 * MIN);
    expect(
      log
        .changesSince(T0)
        .map((c) => `${c.key} ${c.icon}`)
        .sort(),
    ).toEqual(['connection:con_ha up', 'server:pve-02 up']);
    log.observe([], KEYS, T0 + LOOK_LOG_KEEP_MS + 2 * MIN);
    expect(log.changesSince(0)).toEqual([]);
  });
});

function facts(over: Partial<WelcomeFacts> = {}): WelcomeFacts {
  return {
    assistant: 'Neo',
    asks: [{ number: 7, title: 'Send the reply to an Acme Desk customer?' }],
    askCount: 1,
    recent: [
      { text: 'Installed the updates on the-falcon', at: new Date(T0 + 50 * MIN).toISOString() },
      { text: 'Renewed the certificate on pve-01', at: new Date(T0 + 20 * MIN).toISOString() },
      { text: 'Turned off the hallway lights', at: new Date(T0 - 5 * MIN).toISOString() },
    ],
    changes: () => [],
    ...over,
  };
}

describe('Welcome back’s rows (DK-120, DK-122)', () => {
  it('starts with the question, then what was done since, then what changed', () => {
    const changes = () => [
      { key: 'server:nas', icon: 'look' as const, text: 'nas needs a look', at: T0 + 30 * MIN },
    ];
    const items = welcomeItems(facts({ changes }), T0, 'everything');
    expect(items.map((i) => i.icon)).toEqual(['ask', 'done', 'done', 'look']);
    expect(items[0]).toMatchObject({ ask: 7 });
    expect(items[0]?.text).toContain('Acme Desk');
    // Oldest first, only since they left.
    expect(items[1]?.text).toContain('certificate');
    expect(items[3]).toMatchObject({ look: 'server:nas' });
  });

  it('counts in A summary: no question’s words, no done thing’s', () => {
    const items = welcomeItems(facts({ askCount: 2 }), T0, 'summary');
    expect(items.map((i) => i.icon)).toEqual(['ask', 'done']);
    expect(JSON.stringify(items)).not.toMatch(/Acme Desk|certificate/);
    expect(items[0]?.text).toContain('2');
    expect(items[1]?.text).toContain('2');
  });

  it('counts the done things when they don’t fit, and keeps the changes', () => {
    const recent = Array.from({ length: 6 }, (_, i) => ({
      text: `Thing ${i}`,
      at: new Date(T0 + (i + 1) * MIN).toISOString(),
    }));
    const changes = () =>
      ['a', 'b'].map((n, i) => ({
        key: `server:${n}`,
        icon: 'down' as const,
        text: `${n} went down`,
        at: T0 + i,
      }));
    const items = welcomeItems(facts({ recent, changes }), T0, 'everything');
    expect(items.map((i) => i.icon)).toEqual(['ask', 'done', 'down', 'down']);
    expect(items.length).toBeLessThanOrEqual(DESK_DIGEST_ITEMS);
  });
});

describe('Welcome back’s timing (DK-120, DK-121)', () => {
  let ids = 0;
  const welcome = () => new DeskWelcome(() => `wb_test_${++ids}`);

  it('needs someone seen once since the start, then 30 minutes away', () => {
    const w = welcome();
    w.here(T0, true);
    expect(w.digest(T0, 'everything', true, facts)).toBeNull();
    w.here(T0 + AWAY - 1, true);
    expect(w.digest(T0 + AWAY - 1, 'everything', true, facts)).toBeNull();
    // Nobody counted away before anyone was seen: a restart isn't a return.
    const fresh = welcome();
    fresh.here(T0 + 5 * AWAY, true);
    expect(fresh.digest(T0 + 5 * AWAY, 'everything', true, facts)).toBeNull();
  });

  it('shows once for a minute, how long they were away, and a touch after it showed ends it', () => {
    const w = welcome();
    w.here(T0, true);
    const back = T0 + 2 * 3_600_000;
    w.here(back, true);
    const digest = w.digest(back, 'everything', true, facts);
    expect(DeskDigest.parse(digest)).toMatchObject({ awayS: 7_200 });
    expect(digest?.items.map((i) => i.icon)).toEqual(['ask', 'done', 'done']);
    // The same one while it shows; the face that keeps being seen doesn't end it.
    w.here(back + 5_000, false);
    expect(w.digest(back + 10_000, 'everything', true, facts)?.id).toBe(digest?.id);
    w.here(back + 20_000, true);
    expect(w.digest(back + 20_000, 'everything', true, facts)).toBeNull();
    // Left alone: gone after its minute.
    const v = welcome();
    v.here(T0, false);
    v.here(back, false);
    expect(v.digest(back, 'everything', true, facts)).not.toBeNull();
    expect(v.digest(back + DESK_WELCOME_SHOW_S * 1_000, 'everything', true, facts)).toBeNull();
  });

  it('waits for the lock to let it show, and says nothing when nothing happened or it is off', () => {
    const w = welcome();
    w.here(T0, true);
    const back = T0 + AWAY;
    w.here(back, true);
    // In *Only the time* it isn't drawn: a touch then (typing the PIN) doesn't end it.
    expect(w.digest(back, 'time', true, facts)).not.toBeNull();
    w.here(back + 2_000, true);
    const shown = w.digest(back + 3_000, 'everything', true, facts);
    expect(shown?.items[0]?.text).toContain('Acme Desk');
    const quiet = welcome();
    quiet.here(T0, true);
    quiet.here(back, true);
    expect(
      quiet.digest(back, 'everything', true, () => facts({ askCount: 0, asks: [], recent: [] })),
    ).toBeNull();
    const off = welcome();
    off.here(T0, true);
    off.here(back, true);
    expect(off.digest(back, 'everything', false, facts)).toBeNull();
    expect(off.digest(back + 1_000, 'everything', true, facts)).toBeNull();
  });
});
