import { describe, expect, it } from 'vitest';
import { learningLine, overviewSectionForTab, overviewSections, overviewTiles } from './overview';
import type { HomeSection, HomeThingRow } from './sections';

const NOW = Date.parse('2026-10-19T10:00:00.000Z');
const TZ = 'Europe/Amsterdam';

const row = (patch: Partial<HomeThingRow> = {}): HomeThingRow => ({
  id: 'thing',
  name: 'Thing',
  subtitle: null,
  state: null,
  tone: 'ok',
  figures: [],
  plain: 'Connected',
  used: null,
  line: '',
  glyph: 'plug' as HomeThingRow['glyph'],
  mark: null,
  status: 'ok',
  href: '/things/thing',
  label: 'Thing',
  level: 'connected',
  word: 'Connected',
  reason: null,
  ...patch,
});

describe('Overview’s sections (OVP-01)', () => {
  const sections: HomeSection[] = [
    { kind: 'servers', servers: [{ status: 'ok' } as never] },
    {
      kind: 'things',
      rows: [row({ level: 'needsLook', tone: 'warn' }), row(), row({ level: 'learning', tone: 'learning' })],
      add: true,
    },
    { kind: 'panels', widgets: [{} as never] },
  ];

  it('gives each section its count, dot, anchor and line', () => {
    const fleet = [
      { status: 'ok', guests: [] },
      { status: 'offline', guests: [] },
    ] as never;
    const views = overviewSections(sections, fleet);
    expect(views.map((v) => [v.key, v.count, v.tone, v.anchor])).toEqual([
      ['servers', 2, 'bad', 'overview-servers'],
      ['services', 3, 'warn', 'overview-connections'],
      ['pinned', 1, null, 'overview-pinned'],
    ]);
    expect(views[0]?.summary).toContain('1 offline');
    expect(views[1]?.summary).toContain('1 needs a look');
    expect(views[2]?.summary).toBe('From your chats');
  });

  it('keeps the servers’ section from Home’s without the fleet', () => {
    expect(overviewSections(sections)[0]).toMatchObject({ key: 'servers', count: 1, summary: '' });
  });

  it('maps an old ?tab= to the section to scroll to', () => {
    expect(overviewSectionForTab('services')).toBe('services');
    expect(overviewSectionForTab('connections')).toBe('services');
    expect(overviewSectionForTab('pinned')).toBe('pinned');
    expect(overviewSectionForTab('nope')).toBeNull();
    expect(overviewSectionForTab(undefined)).toBeNull();
  });
});

describe('a connection’s tile (OVP-09)', () => {
  const tiles = (rows: HomeThingRow[], usedAt?: string) =>
    overviewTiles(
      rows,
      rows.map((r) => ({ id: r.id, usedAt })),
      NOW,
      TZ,
      'Dusty',
    );

  it('says why it isn’t fine, without a full stop, worst first', () => {
    const [first, second] = tiles([
      row({ id: 'ok', figures: [{ label: 'Devices', value: '38', note: null }] }),
      row({ id: 'ha', level: 'needsLook', tone: 'warn', status: 'warn', reason: '4 things need a look.' }),
    ]);
    expect(first?.row.id).toBe('ha');
    expect(first?.line).toEqual({ text: '4 things need a look', tone: 'warn' });
    expect(second?.line.tone).toBe('plain');
  });

  it('says a thing is down because of something else, or kept quiet, whatever else it could show', () => {
    const rows = [
      row({ id: 'plex', figures: [{ label: 'Streams', value: '2', note: null }] }),
      row({ id: 'nas', figures: [{ label: 'Disks', value: '4', note: null }] }),
      row({ id: 'ha' }),
    ];
    const cause = { thing: 'server:pve-02', name: 'pve-02', words: 'Not answering while pve-02 is down' };
    const out = overviewTiles(
      rows,
      [
        { id: 'plex', causedBy: cause },
        { id: 'nas', quietUntil: '2026-10-19T21:00:00.000Z' },
        { id: 'ha', quietUntil: '2026-10-19T09:00:00.000Z' },
      ],
      NOW,
      TZ,
      'Dusty',
    );
    const by = new Map(out.map((t) => [t.row.id, t]));
    expect(by.get('plex')).toMatchObject({ held: 'cause', line: { text: cause.words, tone: 'mut' } });
    expect(by.get('nas')).toMatchObject({ held: 'quiet', line: { text: 'Quiet until 23:00', tone: 'mut' } });
    // A quiet time that is over says nothing of it.
    expect(by.get('ha')?.held).toBeNull();
  });

  it('falls back to words the person can act on when nobody said why', () => {
    const [t] = tiles([row({ level: 'notWorking', tone: 'mut', status: 'offline' })]);
    expect(t?.line.tone).toBe('mut');
    expect(t?.line.text).toContain('can’t reach it');
    expect(t?.line.text.endsWith('.')).toBe(false);
  });

  it('says a thing being learned is learned by the assistant', () => {
    const [t] = tiles([row({ level: 'learning', tone: 'learning', status: 'learning', subtitle: 'Daikin' })]);
    expect(t?.line.text).toBe(learningLine('Dusty'));
    expect(t?.line.text).toContain('Dusty');
    expect(t?.what).toBe('Daikin');
  });

  it('says its first two figures in words, what it is in the foot and when it was used', () => {
    const [t] = tiles(
      [
        row({
          subtitle: 'Network',
          figures: [
            { label: 'Devices', value: '38', note: null },
            { label: 'New', value: '1', note: null },
            { label: 'Access points', value: '3', note: null },
          ],
        }),
      ],
      new Date(NOW - 3600_000).toISOString(),
    );
    expect(t?.line).toEqual({ text: '38 devices · 1 new', tone: 'plain' });
    expect(t?.what).toBe('Network');
    expect(t?.used).toBe('Used today');
  });

  it('says its subtitle, else Connected, without inventing a foot', () => {
    const [withSub] = tiles([row({ subtitle: 'AI gateway' })]);
    expect([withSub?.line.text, withSub?.what, withSub?.used]).toEqual(['AI gateway', null, null]);
    const [bare] = tiles([row()]);
    expect([bare?.line.text, bare?.what]).toEqual(['Connected', null]);
  });
});
