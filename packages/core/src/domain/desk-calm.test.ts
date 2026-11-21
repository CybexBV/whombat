import { describe, expect, it } from 'vitest';
import { DESK_CALM_WORDS, DESK_WORDS, deskCalmFor } from './desk.js';
import { type DeskCalmInput, type DeskCalmLook, deskPreviewInput } from './desk-calm.js';
import { DEFAULT_DESK_SHOW, DeskCalm, type DeskShow } from './desk-glance.js';

const now = new Date('2026-10-27T14:34:00Z');
const server = (name: string, state: 'ok' | 'warn' | 'bad' | 'off' = 'ok', more = {}) => ({
  id: name,
  name,
  mark: 'proxmox',
  state,
  cpu: 12,
  memory: 40,
  disk: 30,
  spark: [5, 7, 9],
  ...more,
});
const base = (more: Partial<DeskCalmInput> = {}): DeskCalmInput => ({
  assistant: 'Neo',
  now,
  timeZone: 'Europe/Amsterdam',
  asks: [],
  askCount: 0,
  looks: [],
  work: null,
  servers: [server('pve-01'), server('pve-02'), server('nas')],
  activities: [],
  figures: [],
  coming: [],
  services: 14,
  doneCount: 0,
  ...more,
});
const show = (more: Partial<DeskShow> = {}): DeskShow => ({ ...DEFAULT_DESK_SHOW, ...more });
const calm = (input: DeskCalmInput, s = show(), view: 'time' | 'summary' | 'everything' = 'everything') => {
  const out = deskCalmFor(input, s, view);
  // Every answer is a valid contract shape.
  expect(DeskCalm.safeParse(out).success).toBe(true);
  return out;
};

describe('the calm glance (3.2, CT-1631; DK-112…DK-118)', () => {
  it('says all fine with what runs, a big clock and no hero', () => {
    const out = calm(base());
    expect(out.headline.tone).toBe('ok');
    expect(out.headline.more).toContain('3 servers');
    expect(out.headline.more).toContain('14 services');
    expect(out.hero).toBeUndefined();
    expect(out.clock).toBe('big');
    expect(out.strip.map((s) => s.name)).toEqual(['pve-01', 'pve-02', 'nas']);
    expect(out.strip[0]?.spark).toEqual([5, 7, 9]);
  });

  it('puts a down server first, then the asks, then trouble, and counts the rest', () => {
    const out = calm(
      base({
        asks: [{ number: 7, title: 'Restart Plex on blackbox?' }],
        askCount: 2,
        looks: [
          {
            key: 'connection:con_ha',
            kind: 'connection',
            name: 'Home Assistant',
            state: 'look',
            reason: 'Updates',
          },
          {
            key: 'server:pve-02',
            kind: 'server',
            name: 'pve-02',
            state: 'down',
            server: 'pve-02',
            runsOn: ['Plex', 'Home Assistant', 'Nextcloud', 'UniFi'],
          },
        ],
      }),
    );
    expect(out.headline.tone).toBe('bad');
    expect(out.hero).toMatchObject({ kind: 'look', look: 'server:pve-02', server: 'pve-02' });
    expect(out.hero?.title).toContain('pve-02');
    expect(out.hero?.detail).toContain('2 more');
    expect(out.also.map((a) => a.ask ?? a.look)).toEqual([7, 'connection:con_ha']);
    // The second ask wasn't read: it counts.
    expect(out.moreNeeds).toBe(1);
    expect(out.clock).toBe('small');
    expect(out.moments).toEqual([]);
  });

  it('leaves out what the person turned off, problems too', () => {
    const out = calm(
      base({
        looks: [{ key: 'server:backup', kind: 'server', name: 'backup', state: 'down', server: 'backup' }],
      }),
      show({ items: { 'server:backup': 'off' } }),
    );
    expect(out.hero).toBeUndefined();
    expect(out.headline.tone).toBe('ok');
  });

  it('keeps an ask’s title out of a locked summary and shows only the sentence in Only the time', () => {
    const input = base({
      asks: [{ number: 3, title: 'Send the reply to an Acme Desk customer?' }],
      askCount: 1,
    });
    const summary = calm(input, show(), 'summary');
    expect(summary.hero?.title).not.toContain('Acme Desk');
    expect(summary.hero?.ask).toBe(3);
    const time = calm(input, show(), 'time');
    expect(time.hero).toBeUndefined();
    expect(time.strip).toEqual([]);
    expect(time.headline.tone).toBe('bad');
  });

  it('says a filling disk as a forecast', () => {
    const out = calm(
      base({
        looks: [
          { key: 'server:nas', kind: 'server', name: 'nas', state: 'look', disk: { pct: 88, days: 12 } },
        ],
      }),
    );
    expect(out.headline.tone).toBe('warn');
    expect(out.hero?.detail).toContain('12 days');
  });

  it('draws the strip in the person’s order, hides When it matters servers while fine, and says why one isn’t', () => {
    const input = base({
      servers: [
        server('nas', 'warn', { disk: 88 }),
        server('pve-01'),
        server('pi-hole'),
        server('backup', 'off'),
      ],
    });
    const out = calm(
      input,
      show({ order: ['pve-01'], items: { 'server:pi-hole': 'matters', 'server:backup': 'off' } }),
    );
    expect(out.strip.map((s) => s.name)).toEqual(['pve-01', 'nas']);
    expect(out.strip[1]?.say).toContain('88');
    expect(out.strip[1]?.spark).toBeUndefined();
  });

  it('shows the work on the servers it goes through and says Neo is busy', () => {
    const out = calm(
      base({
        work: {
          title: 'Update the server agents',
          steps: [
            { label: 'pve-01', state: 'done' },
            { label: 'pve-02', state: 'now' },
            { label: 'nas', state: 'next' },
          ],
        },
      }),
    );
    expect(out.headline.tone).toBe('busy');
    expect(out.headline.text).toContain('Neo');
    expect(out.headline.more).toContain('1 of 3');
    expect(out.strip.map((s) => s.work)).toEqual(['done', 'now', 'next']);
    expect(out.moments[0]).toMatchObject({ key: 'work', progress: 33 });
  });

  it('fills the middle with pinned things first, then what’s going on, three at most', () => {
    const out = calm(
      base({
        activities: [
          { key: 'connection:plex', name: 'Plex', value: '2 watching', active: true },
          { key: 'connection:sab', name: 'Downloads', value: 'Nothing queued', active: false },
          { key: 'connection:seerr', name: 'Seerr', value: '2 new requests', active: true },
          { key: 'connection:arr', name: 'Sonarr', value: '1 downloading', active: true },
        ],
        figures: [{ key: 'widget:w1', name: 'Living room', value: '21.4 °C', active: false }],
        coming: [{ name: 'Backups', at: '2026-10-27T15:30:00Z' }],
      }),
      show({ items: { 'widget:w1': 'always' } }),
    );
    expect(out.moments.map((m) => m.key)).toEqual(['widget:w1', 'connection:plex', 'connection:seerr']);
    expect(out.moments[0]).toMatchObject({ kind: 'figure', pinned: true });
  });

  it('shows what’s coming up only when it’s soon, unless pinned', () => {
    const later = base({ coming: [{ name: 'Backups', at: '2026-10-27T22:00:00Z' }] });
    expect(calm(later).moments).toEqual([]);
    expect(calm(later, show({ items: { coming: 'always' } })).moments[0]).toMatchObject({ kind: 'coming' });
    const soon = base({ coming: [{ name: 'Backups', at: '2026-10-27T15:00:00Z' }] });
    expect(calm(soon).moments[0]?.value).toBe('Backups');
  });

  it('counts Done today only while the person keeps it on', () => {
    expect(calm(base({ doneCount: 3 })).doneCount).toBe(3);
    expect(calm(base({ doneCount: 3 }), show({ doneToday: false })).doneCount).toBeUndefined();
  });

  it('previews a server going down and the assistant at work', () => {
    const s = show();
    const wrong = calm(deskPreviewInput(base(), s, 'wrong', DESK_CALM_WORDS));
    expect(wrong.hero?.server).toBe('pve-01');
    // What the assistant found, with its step, so Settings shows the buttons (look-research.md LR-09).
    expect(wrong.hero).toMatchObject({ research: 'found', fix: 'Restart pve-01' });
    expect(wrong.hero?.title).toContain('pve-01');
    expect(wrong.strip[0]).toMatchObject({ name: 'pve-01', state: 'bad' });
    const busy = calm(deskPreviewInput(base(), s, 'busy', DESK_CALM_WORDS));
    expect(busy.headline.tone).toBe('busy');
    expect(busy.headline.more).toContain(DESK_WORDS.calm.sampleWork);
  });
});

describe('a look the assistant looked into, on the hero (3.5; look-research.md LR-09, LR-10)', () => {
  const at = '2026-10-27T14:30:00Z';
  const ha = (research?: DeskCalmLook['research']): DeskCalmLook => ({
    key: 'connection:con_ha',
    kind: 'connection',
    name: 'Home Assistant',
    state: 'bad',
    reason: 'Zigbee isn’t loading.',
    ...(research ? { research } : {}),
  });
  const hero = (look: DeskCalmLook, view: 'summary' | 'everything' = 'everything') =>
    calm(base({ looks: [look] }), show(), view).hero;

  it('keeps the look’s own words without research, or when it failed', () => {
    const before = hero(ha());
    expect(before).toMatchObject({ title: 'Home Assistant needs a look', detail: 'Zigbee isn’t loading.' });
    expect(before?.research).toBeUndefined();
    expect(hero(ha({ key: 'connection:con_ha', state: 'failed', at }))).toEqual(before);
  });

  it('says it is looking, with the reason so far', () => {
    const out = hero(ha({ key: 'connection:con_ha', state: 'looking', at }));
    expect(out).toMatchObject({ research: 'looking', title: 'Home Assistant needs a look' });
    expect(out?.detail).toContain(DESK_WORDS.looks.looking.replace(/\.$/, ''));
    expect(out?.detail).toContain('Zigbee isn’t loading');
    expect(out?.fix).toBeUndefined();
  });

  it('takes the assistant’s title and summary once found, with its step', () => {
    const summary = `${'Zigbee stopped after the update. '.repeat(7)}Restarting it should bring it back.`;
    const out = hero(
      ha({
        key: 'connection:con_ha',
        state: 'found',
        title: 'Zigbee stopped',
        summary,
        fix: 'Restart Zigbee',
        at,
      }),
    );
    expect(out).toMatchObject({ research: 'found', title: 'Zigbee stopped', fix: 'Restart Zigbee' });
    // Cut to the hero's 200 for an older console.
    expect(Array.from(out?.detail ?? '').length).toBeLessThanOrEqual(200);
    expect(
      hero(ha({ key: 'connection:con_ha', state: 'found', title: 'Unplugged', summary: 'Plug it in.', at })),
    ).not.toHaveProperty('fix');
  });

  it('says it is on it while it takes the step, and what works again once fixed', () => {
    const fixing = hero(ha({ key: 'connection:con_ha', state: 'fixing', title: 'Zigbee stopped', at }));
    expect(fixing).toMatchObject({
      research: 'fixing',
      title: 'Zigbee stopped',
      detail: DESK_WORDS.looks.fixing,
    });
    expect(fixing?.fix).toBeUndefined();
    const fixed = hero(
      ha({
        key: 'connection:con_ha',
        state: 'fixed',
        title: 'Zigbee works again',
        summary: 'I restarted it.',
        fix: 'x',
        at,
      }),
    );
    expect(fixed).toMatchObject({
      research: 'fixed',
      title: 'Zigbee works again',
      detail: 'I restarted it.',
    });
    expect(fixed?.fix).toBeUndefined();
  });

  it('keeps the assistant’s words to an unlocked screen or *Everything*', () => {
    const out = hero(
      ha({ key: 'connection:con_ha', state: 'found', title: 'Zigbee stopped', summary: 'S.', at }),
      'summary',
    );
    expect(out?.research).toBeUndefined();
    expect(out?.title).toBe('Home Assistant needs a look');
  });
});
