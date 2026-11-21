import { describe, expect, it } from 'vitest';
import {
  awayText,
  BAR_ITEMS,
  barShows,
  CLOCKS,
  DEFAULT_BAR,
  DIGEST_ICONS,
  HEADLINE_TONES,
  HERO_TONES,
  MOMENT_KINDS,
  PREVIEW_SCENARIOS,
  parseCalm,
  SHOW_LEVELS,
  STRIP_STATES,
  STRIP_WORK,
  sparkPoints,
  UPDATE_STATES,
} from './calm';
import { constList, deskGlanceSource } from './contractsSource';
import { parseDesk } from './desk';

const calm = (more: Record<string, unknown> = {}) => ({
  headline: { tone: 'ok', text: 'All fine', more: '3 servers are running. Nothing needs you.' },
  clock: 'big',
  also: [],
  moreNeeds: 0,
  moments: [
    { key: 'connection:con_plex', kind: 'activity', name: 'Plex', value: '2 watching', mark: 'plex' },
  ],
  strip: [{ id: 'pve-01', name: 'pve-01', mark: 'proxmox', state: 'ok', spark: [3, 5, 140, -1, 9] }],
  moreStrip: 0,
  bar: { network: 'always', internet: 'matters', battery: 'always', updates: 'off' },
  ...more,
});

describe('the calm glance as the page reads it (CG-350)', () => {
  it('takes what it knows and leaves the rest', () => {
    const c = parseCalm(calm());
    expect(c?.headline.tone).toBe('ok');
    expect(c?.moments.map((m) => m.key)).toEqual(['connection:con_plex']);
    // Points outside 0…100 go; the strip keeps the server.
    expect(c?.strip[0]?.spark).toEqual([3, 5, 9]);
    expect(c?.bar.internet).toBe('matters');
    expect(parseCalm(calm({ headline: { tone: 'great', text: 'All fine' } }))).toBeNull();
    expect(parseCalm(calm({ bar: { network: 'sometimes' } }))?.bar).toEqual(DEFAULT_BAR);
  });

  it('makes the clock small with a hero and drops the moments then', () => {
    const c = parseCalm(
      calm({
        hero: {
          kind: 'look',
          tone: 'bad',
          title: 'pve-02 isn’t answering',
          look: 'server:pve-02',
          server: 'pve-02',
        },
        clock: 'big',
      }),
    );
    expect(c?.clock).toBe('small');
    expect(c?.moments).toEqual([]);
    expect(c?.hero).toMatchObject({ look: 'server:pve-02', server: 'pve-02', ask: null });
  });

  it('keeps Welcome back only with an id and a line', () => {
    expect(
      parseCalm(calm({ digest: { id: 'short', awayS: 60, items: [{ icon: 'done', text: 'x' }] } }))?.digest,
    ).toBeNull();
    const d = parseCalm(
      calm({
        digest: { id: 'dig_abcdefgh', awayS: 7800, items: [{ icon: 'ask', text: 'A question', ask: 3 }] },
      }),
    )?.digest;
    expect(d?.items[0]).toMatchObject({ icon: 'ask', ask: 3 });
  });

  it('reads the state’s name and its calm only while paired', () => {
    const state = parseDesk({
      v: 1,
      now: '2026-10-27T14:34:00Z',
      paired: null,
      lock: { state: 'locked' },
      name: 'Home',
    });
    expect(state?.name).toBeNull();
  });

  it('shows a chip Always, When it matters only while off, never Off', () => {
    expect(barShows('always', false)).toBe(true);
    expect(barShows('matters', false)).toBe(false);
    expect(barShows('matters', true)).toBe(true);
    expect(barShows('off', true)).toBe(false);
  });

  it('says how long in plain words and draws a line to the hour’s own peak', () => {
    expect(awayText(7_800)).toBe('2 h 10 min');
    expect(awayText(45 * 60)).toBe('45 min');
    expect(awayText(3 * 86_400)).toBe('3 days');
    expect(sparkPoints([0, 10], 100, 20)).toBe('0.0,20.0 100.0,12.0');
    expect(sparkPoints([5], 100, 20)).toBe('');
  });

  it('reads a look’s research and its step on the hero, the step only once found (3.5, CG-373)', () => {
    const hero = (more: Record<string, unknown>) =>
      parseCalm(
        calm({
          hero: {
            kind: 'look',
            tone: 'warn',
            title: 'Zigbee stopped working',
            look: 'connection:con_ha',
            ...more,
          },
        }),
      )?.hero;
    expect(hero({ research: 'found', fix: 'Restart Zigbee' })).toMatchObject({
      research: 'found',
      fix: 'Restart Zigbee',
    });
    expect(hero({ research: 'found', fix: 'x'.repeat(40) })?.fix).toHaveLength(32);
    expect(hero({ research: 'fixing', fix: 'Restart Zigbee' })).toMatchObject({
      research: 'fixing',
      fix: null,
    });
    expect(hero({ research: 'pondering', fix: 'Restart Zigbee' })).toMatchObject({
      research: null,
      fix: null,
    });
    expect(hero({})).toMatchObject({ research: null, fix: null });
    const ask = parseCalm(
      calm({
        hero: { kind: 'ask', tone: 'bad', title: 'Restart Plex?', ask: 4, research: 'found', fix: 'Go' },
      }),
    )?.hero;
    expect(ask).toMatchObject({ research: null, fix: null });
    expect(deskGlanceSource).toContain('research: LookResearchState.optional(),');
    expect(deskGlanceSource).toContain('fix: line(LOOK_FIX_LABEL_MAX).optional(),');
  });

  it('copies the contract’s lists', () => {
    const lists: [string, readonly string[]][] = [
      ['DESK_SHOW_LEVELS', SHOW_LEVELS],
      ['DESK_BAR_ITEMS', BAR_ITEMS],
      ['DESK_CLOCKS', CLOCKS],
      ['DESK_HEADLINE_TONES', HEADLINE_TONES],
      ['DESK_HERO_TONES', HERO_TONES],
      ['DESK_MOMENT_KINDS', MOMENT_KINDS],
      ['DESK_STRIP_STATES', STRIP_STATES],
      ['DESK_STRIP_WORK', STRIP_WORK],
      ['DESK_DIGEST_ICONS', DIGEST_ICONS],
      ['DESK_UPDATE_STATES', UPDATE_STATES],
      ['DESK_PREVIEW_SCENARIOS', PREVIEW_SCENARIOS],
    ];
    for (const [name, list] of lists) expect(list, name).toEqual(constList(deskGlanceSource, name));
  });
});
